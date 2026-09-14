// Extension -> display label, restricted to extensions that meaningfully
// signal "this is the language of the project" (excludes markup/config/doc
// extensions, which still count toward totalFiles but shouldn't win the
// language histogram just for being numerous).
const LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  rb: 'Ruby',
  php: 'PHP',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  hpp: 'C++',
  cs: 'C#',
};

// dependency name -> display label. Deliberately scoped to the npm/Node
// ecosystem, since that's the only one this project itself runs on — "the
// equivalent for other ecosystems" (pip, cargo, go.mod, ...) is a real gap,
// not silently handled.
const FRAMEWORK_LABELS: Record<string, string> = {
  '@nestjs/core': 'NestJS',
  react: 'React',
  'react-dom': 'React',
  next: 'Next.js',
  vue: 'Vue',
  '@angular/core': 'Angular',
  express: 'Express',
  fastify: 'Fastify',
  koa: 'Koa',
  'drizzle-orm': 'Drizzle ORM',
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
  typeorm: 'TypeORM',
  sequelize: 'Sequelize',
  mongoose: 'Mongoose',
  pg: 'PostgreSQL',
  mysql2: 'MySQL',
  redis: 'Redis',
  ioredis: 'Redis',
  graphql: 'GraphQL',
  '@trpc/server': 'tRPC',
  vite: 'Vite',
  tailwindcss: 'Tailwind CSS',
  vitest: 'Vitest',
  jest: 'Jest',
};

export interface OverviewFileEntry {
  relPath: string;
  lang: string | null;
}

interface RepoOverviewFacts {
  name: string;
  totalFiles: number;
  topLanguage: string | null;
  topDirs: { dir: string; count: number }[];
  frameworks: string[];
  scripts: string[];
  readmeExcerpt: string | null;
}

export function mostCommonLanguage(files: OverviewFileEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const file of files) {
    const label = file.lang ? LANGUAGE_LABELS[file.lang] : undefined;
    if (!label) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [label, count] of counts) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Groups files by directory truncated to at most two path segments, so
 * `src/indexing/foo.ts` and `src/indexing/bar.ts` both count under
 * `src/indexing`, while `src/App.tsx` counts under `src`. Root-level files
 * (no directory at all) don't contribute — there's no directory to name.
 */
export function topLevelDirCounts(
  files: OverviewFileEntry[],
  limit: number,
): { dir: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const segments = file.relPath.split('/');
    if (segments.length < 2) continue;
    const dir = segments.slice(0, Math.min(2, segments.length - 1)).join('/');
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
    .slice(0, limit);
}

function majorVersion(range: string): string | null {
  const match = /(\d+)(?:\.\d+)*/.exec(range);
  return match ? match[1]! : null;
}

export function detectFrameworks(
  dependencies: Record<string, string>,
): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const [dep, label] of Object.entries(FRAMEWORK_LABELS)) {
    if (seen.has(label)) continue;
    const range = dependencies[dep];
    if (!range) continue;
    seen.add(label);
    const version = majorVersion(range);
    results.push(version ? `${label} ${version}` : label);
  }
  return results;
}

const MAX_README_CHARS = 500;

/** Drops a leading `# Title` line, then returns the first real paragraph, whitespace-collapsed and capped. */
export function firstParagraph(markdown: string): string | null {
  const lines = markdown.split('\n');
  const body = /^#+\s/.test(lines[0] ?? '')
    ? lines.slice(1).join('\n')
    : markdown;

  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !/^#+\s/.test(p));

  const first = paragraphs[0];
  if (!first) return null;

  const collapsed = first.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_README_CHARS
    ? `${collapsed.slice(0, MAX_README_CHARS)}…`
    : collapsed;
}

export function renderOverviewDigest(facts: RepoOverviewFacts): string {
  const lines: string[] = [];
  const langSuffix = facts.topLanguage ? ` — ${facts.topLanguage}.` : '.';
  lines.push(`${facts.name}${langSuffix} ${facts.totalFiles} files.`);

  if (facts.topDirs.length > 0) {
    lines.push(
      `Top dirs: ${facts.topDirs.map((d) => `${d.dir} (${d.count})`).join(', ')}.`,
    );
  }
  if (facts.frameworks.length > 0) {
    lines.push(`Detected: ${facts.frameworks.join(', ')}.`);
  }
  if (facts.scripts.length > 0) {
    lines.push(`Scripts: ${facts.scripts.join(', ')}.`);
  }

  const header = lines.join('\n');
  return facts.readmeExcerpt ? `${header}\n\n${facts.readmeExcerpt}` : header;
}
