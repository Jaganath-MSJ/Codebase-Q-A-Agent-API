import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { existsSync, statSync, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { CredentialsService } from '../credentials/credentials.service';
import { FilesRepository } from '../db/repositories/files.repository';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { StorageRepository } from '../db/repositories/storage.repository';
import { ProjectRow } from '../db/schema';
import { CreateProjectDto, FileViewDto, ProjectStorageDto } from '../contracts';
import { resolveInside } from '../common/paths';
import { readSourceFile } from '../common/read-file';
import { resolveUploadPath } from '../common/upload-id';
import { ConfigService } from '../config/config.service';

// Neon's free tier, per docs/architecture.md and the "Postgres is 0.5 GB"
// invariant — the number the storage report measures usage against.
const DATABASE_BUDGET_BYTES = 512 * 1024 * 1024;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly credentialsService: CredentialsService,
    private readonly storageRepository: StorageRepository,
    private readonly config: ConfigService,
    private readonly filesRepository: FilesRepository,
  ) {}

  async create(dto: CreateProjectDto): Promise<ProjectRow> {
    const sourceKind = dto.sourceKind ?? 'local_path';

    // Fails fast at creation time rather than at first-index time — the
    // upload is a one-shot handle (ZipUploadAdapter deletes it after
    // extraction), so a typo'd or already-consumed uploadId should surface
    // immediately, not after the user has already named and submitted the
    // project. `sourceRef` is otherwise unvalidated client JSON body input —
    // resolveUploadPath rejects anything that isn't a real uploadId shape
    // before it ever reaches the filesystem, so it can't be used to probe
    // for or read an arbitrary file elsewhere on disk as though it were an
    // uploaded zip.
    if (sourceKind === 'zip_upload') {
      let uploadPath: string;
      try {
        uploadPath = resolveUploadPath(
          path.join(this.config.dataDir, 'uploads'),
          dto.sourceRef,
        );
      } catch {
        throw new BadRequestException(`Not a valid uploadId: ${dto.sourceRef}`);
      }
      if (!existsSync(uploadPath)) {
        throw new BadRequestException(
          `Upload ${dto.sourceRef} not found — upload the zip first`,
        );
      }
    }

    // DEF-018. CLAUDE.md is explicit that `workspace_path`/`source_ref` for a
    // local_path project is a **native absolute** machine path — it is the root
    // every repo-relative path in the system resolves against. Nothing enforced
    // it, so a relative ref was accepted and indexed happily, resolved against
    // whatever the API process's cwd happened to be. The row then means
    // something different the moment the server is started from elsewhere: the
    // file viewer 404s, or — where two roots share a relative path — serves a
    // *different* file under a citation that still looks valid.
    //
    // Validated here rather than in the DTO because the rule is conditional on
    // `sourceKind`, which is exactly the shape the zip_upload check above
    // already has. Same reasoning as that check, too: a typo should cost a 400
    // now, not a queued job that fails minutes later.
    if (sourceKind === 'local_path') {
      if (!path.isAbsolute(dto.sourceRef)) {
        throw new BadRequestException(
          `local_path requires an absolute path, got: ${dto.sourceRef}`,
        );
      }
      let stats: Stats;
      try {
        stats = statSync(dto.sourceRef);
      } catch {
        throw new BadRequestException(
          `Local path does not exist or is not readable: ${dto.sourceRef}`,
        );
      }
      if (!stats.isDirectory()) {
        throw new BadRequestException(
          `Local path is not a directory: ${dto.sourceRef}`,
        );
      }
    }

    if (sourceKind === 'git_private' && !dto.token) {
      throw new BadRequestException('git_private requires a token');
    }

    const project = await this.projectsRepository.create({
      name: dto.name,
      sourceKind,
      sourceRef: dto.sourceRef,
      defaultBranch: dto.branch,
    });

    // Stored only after the project row exists, so the credential's FK has
    // something to point at — the token itself is encrypted before it ever
    // reaches CredentialsRepository, never passed through in plaintext form.
    if (sourceKind === 'git_private') {
      await this.credentialsService.setCredential(
        project.id,
        'github_pat',
        dto.token!,
      );
    }

    return project;
  }

  async findAll(): Promise<ProjectRow[]> {
    return this.projectsRepository.findAll();
  }

  async getStorage(projectId: string): Promise<ProjectStorageDto> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const [
      { chunkCount, contentBytes, vectorBytes },
      { databaseBytes, chunksIndexBytes },
    ] = await Promise.all([
      this.storageRepository.getProjectBytes(projectId),
      this.storageRepository.getDatabaseTotals(),
    ]);

    return {
      chunkCount,
      contentBytes,
      vectorBytes,
      sharedIndexBytes: chunksIndexBytes,
      databaseBytes,
      databaseBudgetBytes: DATABASE_BUDGET_BYTES,
      databaseUsedPercent: (databaseBytes / DATABASE_BUDGET_BYTES) * 100,
    };
  }

  /**
   * Reads straight from disk and re-derives the range independently of the
   * stored citation snapshot — a stale line-range mismatch becomes visible
   * here rather than looking plausible.
   */
  async getFile(
    projectId: string,
    relPath: string,
    startLine: number,
    endLine: number,
    context: number,
    ifNoneMatch?: string,
  ): Promise<{ etag: string; dto: FileViewDto | null }> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    // Three gates, in this order, and the order matters.
    //
    // 1. Containment. Pure path arithmetic, no I/O. Kept first so a path that
    //    escapes the root keeps answering 400 "escapes the project root" — that
    //    is an established contract with its own tests, and it says something
    //    different from "not found".
    //
    // `workspacePath` is where the adapter actually put the files on disk —
    // for git_url that's `data/workspaces/<id>`, not the clone URL in
    // `sourceRef`.
    //
    // DEF-032. This used to be a bare `?? project.sourceRef`, on the assumption
    // that a null `workspacePath` "only happens for a project that has never
    // been indexed, which has no citations to view yet". A live `git_url`
    // project falsified both halves at once: four rendered citations, and a
    // null `workspacePath`.
    //
    // The fallback is only meaningful for `local_path`, whose `sourceRef` is a
    // native absolute directory (the INV-2 exception). For every other kind it
    // is a GitHub URL or an upload id — not a path at all — and feeding one to
    // `path.resolve` does not fail, it fabricates:
    //
    //   path.resolve('https://github.com/u/r')
    //     -> '<cwd>/https:/github.com/u/r'
    //
    // which then passes the containment check (it is an ordinary string under
    // cwd) and ENOENTs one line later. So the user got "File is no longer
    // readable (ENOENT) — re-index the project" for a project where nothing had
    // ever been materialised: the wrong cause, and a remedy that does not
    // obviously apply, on a project that otherwise reports `ready` and whose
    // search works.
    const root =
      project.workspacePath ??
      (project.sourceKind === 'local_path' ? project.sourceRef : null);
    if (!root) {
      // Deliberately says nothing about `sourceRef` — INV-2, and the DEF-004
      // lesson: a clone URL can carry a token, and an upload id is noise.
      throw new NotFoundException(
        `This project has not been indexed yet, so its files cannot be viewed. ` +
          `Index it and try again.`,
      );
    }
    let absPath: string;
    try {
      absPath = resolveInside(root, relPath);
    } catch {
      throw new BadRequestException(
        `Path escapes the project root: ${relPath}`,
      );
    }

    // 2. Membership — DEF-015. Containment is not membership: proving a path
    //    cannot escape the root says nothing about whether the project actually
    //    indexed it. Without this the route served every readable file under the
    //    root, including the ones the walker deliberately excludes, so a project
    //    rooted at a repository holding an `.env` handed out its database URL
    //    and API keys over a plain GET.
    //
    //    Ahead of the ETag so a stale validator cannot answer 304 for a path
    //    that is not viewable at all, and ahead of every `fs` call so an
    //    unindexed path never reaches the filesystem.
    //
    //    A NUL byte is screened out before the query rather than handed to the
    //    driver: Postgres rejects NUL inside a text parameter outright
    //    (`report_invalid_encoding_int`), so passing one through would turn
    //    hostile input into an unhandled driver error and a bare 500. No
    //    indexed path can contain one — the column could not store it — so
    //    "not indexed" is both the true and the safe answer.
    const indexed =
      !relPath.includes('\0') &&
      (await this.filesRepository.existsByPath(projectId, relPath));
    if (!indexed) {
      throw new NotFoundException(
        `File not in this project's index: ${relPath}`,
      );
    }

    // 3. Freshness. Strong validator (Phase 13.6): file content is immutable
    //    within an index, so headRevision (the content-tree hash, bumped on
    //    every re-index) plus the exact view coordinates uniquely identify this
    //    response. A matching If-None-Match lets us answer 304 without reading.
    const marker = project.headRevision ?? '';
    const etag = `"${createHash('sha256')
      .update(`${marker}|${relPath}|${startLine}|${endLine}|${context}`)
      .digest('hex')
      .slice(0, 32)}"`;
    if (ifNoneMatch && ifNoneMatch === etag) return { etag, dto: null };

    let lines: string[];
    try {
      ({ lines } = await readSourceFile(absPath));
    } catch (err) {
      // DEF-016. This catch handled exactly one errno, so every other fs
      // failure escaped as a bare 500 "Internal server error" — no diagnosis
      // for the client, and an error-rate spike for something that is often
      // just a stale index.
      //
      // The membership gate above now rejects paths the project never indexed,
      // which removes the easy ways to trigger this from outside. What remains
      // is an indexed file whose on-disk state has since changed, and those are
      // ordinary conditions rather than server faults:
      //
      //   ENOENT   deleted since indexing
      //   EISDIR   replaced by a directory since indexing
      //   ENOTDIR  a parent path segment became a file
      //   EACCES / EPERM   permissions changed since indexing
      //   ELOOP    replaced by a symlink cycle
      //
      // All map to 404: from the client's point of view the file it was told
      // about is no longer viewable, and the remedy for every one of them is
      // the same — re-index. Distinguishing them further would leak host
      // filesystem detail (the DEF-004 lesson) without changing what anyone
      // does about it. The message names the cause for the server log without
      // embedding the absolute path.
      //
      // Anything NOT in this list is genuinely unexpected and still becomes a
      // 500, on purpose: an EIO or an ENOMEM is a server fault and should look
      // like one rather than being flattened into "not found".
      const code = (err as NodeJS.ErrnoException).code;
      const STALE_INDEX_CODES = new Set([
        'ENOENT',
        'EISDIR',
        'ENOTDIR',
        'EACCES',
        'EPERM',
        'ELOOP',
        'ENAMETOOLONG',
        'ERR_INVALID_ARG_VALUE',
      ]);
      if (code && STALE_INDEX_CODES.has(code)) {
        throw new NotFoundException(
          `File is no longer readable (${code}) — re-index the project: ${relPath}`,
        );
      }
      throw err;
    }

    const contextStart = Math.max(1, startLine - context);
    const contextEnd = Math.min(lines.length, endLine + context);

    return {
      etag,
      dto: {
        path: relPath,
        startLine,
        endLine,
        contextStart,
        contextEnd,
        lines: lines.slice(contextStart - 1, contextEnd),
      },
    };
  }
}
