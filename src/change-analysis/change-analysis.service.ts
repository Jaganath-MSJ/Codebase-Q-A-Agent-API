import { Inject, Injectable, Logger } from '@nestjs/common';
import { ProjectsRepository } from '../db/repositories/projects.repository';
import { ChunksRepository } from '../db/repositories/chunks.repository';
import { RetrievalService } from '../retrieval/retrieval.service';
import type { ChangeAnalysisRecord } from '../db/schema';
import { CHAT_PROVIDER_TOKEN } from '../llm/llm.module';
import type { ChatProvider } from '../llm/chat-provider.interface';
import { parseCitations } from '../common/citation-parser';
import { lastCommitDiff } from '../sources/git-clone';
import {
  buildChangeAnalysisPrompt,
  type ChangedFileDiff,
  type ChangeEvidenceBlock,
} from './change-analysis.prompts';
import type { ChangeAnalysisStatus } from '../contracts';

// A commit touching an unusually large number of files (a formatter run, a
// dependency bump) would otherwise blow up evidence size and cost for
// something not worth summarizing file-by-file — bounded, not silently
// dropped: `changedFiles` on the stored record always lists every file the
// commit actually touched, even past this cap.
const MAX_FILES = 20;
// Per changed file, how many callers `find_references` contributes as
// additional context — the file's own current chunks are never capped.
const MAX_CALLERS_PER_FILE = 5;

@Injectable()
export class ChangeAnalysisService {
  private readonly logger = new Logger(ChangeAnalysisService.name);

  // Projects whose generation is in flight — dedupes the client's ~3s GET poll.
  private readonly inFlight = new Set<string>();
  // The revision each project was last generated FOR (once it completed) — lets a
  // GET that still finds no fresh analysis report 'absent' instead of re-triggering
  // forever and driving the client's poll without end (Phase 13.5).
  private readonly attemptedRevision = new Map<string, string>();

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly chunksRepository: ChunksRepository,
    private readonly retrievalService: RetrievalService,
    @Inject(CHAT_PROVIDER_TOKEN) private readonly chatProvider: ChatProvider,
  ) {}

  /**
   * The analysis plus whether one is coming, so the client knows when to stop
   * polling (Phase 13.5). Only git projects ever generate; a non-git project
   * therefore reports 'absent' immediately. Otherwise: 'generating' while an
   * attempt is in flight, 'ready' once a fresh one lands, 'absent' once an
   * attempt for this revision finished producing nothing.
   */
  async getAnalysisStatus(
    projectId: string,
  ): Promise<{ analysis: ChangeAnalysisRecord | null; status: ChangeAnalysisStatus }> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project) return { analysis: null, status: 'absent' };
    const analysis = project.changeAnalysis ?? null;

    if (analysis && project.headRevision && analysis.revision === project.headRevision) {
      return { analysis, status: 'ready' };
    }
    if (this.inFlight.has(projectId)) return { analysis, status: 'generating' };

    const isGit = project.sourceKind === 'git_url' || project.sourceKind === 'git_private';
    const canGenerate = isGit && project.status === 'ready' && !!project.headRevision;
    if (canGenerate && this.attemptedRevision.get(projectId) !== project.headRevision) {
      this.ensureGenerating(projectId, project.headRevision!);
      return { analysis, status: 'generating' };
    }
    return { analysis, status: 'absent' };
  }

  private ensureGenerating(projectId: string, revision: string): void {
    if (this.inFlight.has(projectId)) return;
    this.inFlight.add(projectId);
    this.generate(projectId)
      .catch((err) => this.logger.error(`Change analysis failed for project ${projectId}: ${String(err)}`))
      .finally(() => {
        this.inFlight.delete(projectId);
        this.attemptedRevision.set(projectId, revision);
      });
  }

  async generate(projectId: string, force = false): Promise<void> {
    const project = await this.projectsRepository.findById(projectId);
    if (!project || project.status !== 'ready' || !project.headRevision) return;
    // Only git_url/git_private clones carry real git history — local_path is
    // just a folder (no guaranteed .git) and zip_upload is an extracted
    // archive; both are handled the same way Conversation export's GitHub
    // permalinks were: gated out entirely, not given a degraded fallback.
    if (project.sourceKind !== 'git_url' && project.sourceKind !== 'git_private') return;
    if (!force && project.changeAnalysis?.revision === project.headRevision) return;
    if (!project.workspacePath) return;

    const commit = await lastCommitDiff(project.workspacePath);
    if (!commit) return; // no prior commit to diff against yet

    const changedFiles = commit.files.filter((f) => !f.binary).slice(0, MAX_FILES);
    if (changedFiles.length === 0) return;

    const diffs: ChangedFileDiff[] = changedFiles.map((f) => ({
      path: f.path,
      insertions: f.insertions,
      deletions: f.deletions,
      patch: f.patch,
    }));

    const evidence: ChangeEvidenceBlock[] = [];
    const seen = new Set<string>();
    const addEvidence = (block: ChangeEvidenceBlock) => {
      const key = `${block.path}:${block.startLine}-${block.endLine}`;
      if (seen.has(key)) return;
      seen.add(key);
      evidence.push(block);
    };

    for (const file of changedFiles) {
      const chunks = await this.chunksRepository.findByPath(projectId, file.path);
      for (const chunk of chunks) {
        addEvidence({ path: file.path, startLine: chunk.startLine, endLine: chunk.endLine, content: chunk.content });
      }

      const symbol = chunks[0]?.symbol;
      if (!symbol) continue;
      const callers = await this.retrievalService.findReferences(projectId, symbol);
      for (const caller of callers.slice(0, MAX_CALLERS_PER_FILE)) {
        if (caller.path === file.path) continue; // the file's own chunks are already included above
        addEvidence({ path: caller.path, startLine: caller.startLine, endLine: caller.endLine, content: caller.content });
      }
    }

    if (evidence.length === 0) return;

    const { system, user } = buildChangeAnalysisPrompt(
      { hash: commit.hash, message: commit.message },
      diffs,
      evidence,
    );
    const result = await this.chatProvider.complete({ system, user });

    const record: ChangeAnalysisRecord = {
      commitHash: commit.hash,
      commitMessage: commit.message,
      changedFiles: commit.files.map((f) => f.path),
      summary: result.text,
      citations: parseCitations(result.text, evidence),
      generatedAt: new Date().toISOString(),
      revision: project.headRevision,
    };

    await this.projectsRepository.update(projectId, { changeAnalysis: record });
  }
}
