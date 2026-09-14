import * as path from 'node:path';

export interface RankableFile {
  path: string;
  /** First chunk's content — long enough to hold a typical import block and file header. */
  content: string;
}

const ENTRY_POINT_BASENAMES = new Set([
  'main.ts',
  'main.js',
  'index.ts',
  'index.js',
  'app.module.ts',
  'app.ts',
  'server.ts',
  'cli.ts',
]);

const CONFIG_BASENAME_RE =
  /^(package\.json|tsconfig.*\.json|drizzle\.config\.(ts|js)|.*\.config\.(ts|js|mjs|cjs)|schema\.ts|\.env\.example)$/i;

const DOC_EXT_RE = /\.mdx?$/i;

// Relative-specifier imports only (`./x`, `../x`) — bare/package imports
// aren't files in this repo, so they can't contribute to in-repo fan-in.
const RELATIVE_IMPORT_RE = /(?:from\s+|require\(\s*)['"](\.[^'"]+)['"]/g;

const ENTRY_POINT_BONUS = 100;
const ROOT_DOC_BONUS = 60;
const NESTED_DOC_BONUS = 20;
const CONFIG_BONUS = 40;
const IMPORT_WEIGHT = 5;
const MAX_IMPORT_BONUS = 50;
const SAME_DIR_WEIGHT = 2;
const MAX_DIR_BONUS = 20;

function basename(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

function isRootLevel(relPath: string): boolean {
  return !relPath.includes('/');
}

export function isEntryPoint(relPath: string): boolean {
  return ENTRY_POINT_BASENAMES.has(basename(relPath));
}

export function isConfigFile(relPath: string): boolean {
  return CONFIG_BASENAME_RE.test(basename(relPath));
}

export function isDocFile(relPath: string): boolean {
  return DOC_EXT_RE.test(relPath);
}

/** Directory truncated to at most two path segments — same grouping the overview digest uses. */
function twoSegmentDir(relPath: string): string | null {
  const segments = relPath.split('/');
  if (segments.length < 2) return null;
  return segments.slice(0, Math.min(2, segments.length - 1)).join('/');
}

function resolveRelativeImport(
  fromDir: string,
  specifier: string,
  known: Set<string>,
): string | null {
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/** How many other files, in this same set, import each file — a heuristic fan-in signal, not exact. */
export function countInboundImports(
  files: RankableFile[],
): Map<string, number> {
  const known = new Set(files.map((f) => f.path));
  const counts = new Map<string, number>();

  for (const file of files) {
    const dir = path.posix.dirname(file.path);
    for (const match of file.content.matchAll(RELATIVE_IMPORT_RE)) {
      const resolved = resolveRelativeImport(dir, match[1]!, known);
      if (resolved && resolved !== file.path) {
        counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
      }
    }
  }

  return counts;
}

export function scoreFile(
  file: RankableFile,
  importCount: number,
  sameDirCount: number,
): number {
  let score = 0;
  if (isEntryPoint(file.path)) score += ENTRY_POINT_BONUS;
  if (isDocFile(file.path))
    score += isRootLevel(file.path) ? ROOT_DOC_BONUS : NESTED_DOC_BONUS;
  if (isConfigFile(file.path)) score += CONFIG_BONUS;
  score += Math.min(importCount * IMPORT_WEIGHT, MAX_IMPORT_BONUS);
  score += Math.min(sameDirCount * SAME_DIR_WEIGHT, MAX_DIR_BONUS);
  return score;
}

/** Ranks by heuristic importance (entry point, doc, config, import fan-in, directory centrality) and returns the top `limit` paths, most important first. */
export function rankFiles(files: RankableFile[], limit: number): string[] {
  const importCounts = countInboundImports(files);

  const dirCounts = new Map<string, number>();
  for (const file of files) {
    const dir = twoSegmentDir(file.path);
    if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }

  const scored = files.map((file) => {
    const dir = twoSegmentDir(file.path);
    return {
      path: file.path,
      score: scoreFile(
        file,
        importCounts.get(file.path) ?? 0,
        dir ? (dirCounts.get(dir) ?? 0) : 0,
      ),
    };
  });

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}
