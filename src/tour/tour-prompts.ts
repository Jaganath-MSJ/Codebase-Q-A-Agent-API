export interface TourEvidenceBlock {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

/** Global marker paired with its evidence — batches carry the file's true position in the shared evidence array, not a locally re-numbered one, so a [n] the model writes always resolves against the same array regardless of which batch produced it. */
export interface MarkedEvidence {
  marker: number;
  block: TourEvidenceBlock;
}

export const TOUR_SECTION_TITLES = [
  'What this project is',
  'How it is organized',
  'How a request flows through it',
  'Where to start reading',
] as const;

const MAP_SYSTEM_PROMPT = [
  'You are describing a codebase to a new engineer, one group of files at a time.',
  'Write 2-4 sentences describing what this group of files is responsible for.',
  'Cite every factual claim with [n], using the exact number shown before each file.',
  'Never invent a number, and never write a file path or line number yourself — only [n].',
].join(' ');

const REDUCE_SYSTEM_PROMPT = [
  'You are writing a short onboarding tour of a codebase from a set of group',
  'summaries, each already containing [n] citations.',
  'Write exactly four sections, each starting with its exact heading alone on',
  'its own line in the form "## <heading>": ' +
    TOUR_SECTION_TITLES.map((t) => `"${t}"`).join(', ') +
    '.',
  '2-5 sentences per section. Reuse only [n] markers that already appear in',
  'the summaries below — never invent a new number or write a path yourself.',
].join(' ');

export interface PromptPair {
  system: string;
  user: string;
}

function formatEvidence({ marker, block }: MarkedEvidence): string {
  return `[${marker}] ${block.path}:${block.startLine}-${block.endLine}\n${block.content}`;
}

export function buildTourMapPrompt(batch: MarkedEvidence[]): PromptPair {
  const context = batch.map(formatEvidence).join('\n\n');
  return {
    system: MAP_SYSTEM_PROMPT,
    user: `FILES:\n${context}\n\nDescribe what this group is responsible for.`,
  };
}

export function buildTourReducePrompt(groupSummaries: string[]): PromptPair {
  const combined = groupSummaries.map((summary, i) => `Group ${i + 1}:\n${summary}`).join('\n\n');
  return {
    system: REDUCE_SYSTEM_PROMPT,
    user: `GROUP SUMMARIES:\n${combined}`,
  };
}

export interface ParsedTourSection {
  title: string;
  body: string;
}

const HEADING_RE = /^##\s+(.+?)\s*$/;
const KNOWN_TITLES = new Set<string>(TOUR_SECTION_TITLES);

/** Tolerant of a model dropping a section or adding extra prose — returns whatever valid `## <heading>` sections it can find, in the order they appeared. */
export function parseTourSections(reduceOutput: string): ParsedTourSection[] {
  const sections: { title: string; lines: string[] }[] = [];

  for (const line of reduceOutput.split('\n')) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      sections.push({ title: heading[1]!, lines: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1]!.lines.push(line);
    }
  }

  return sections
    .filter((s) => KNOWN_TITLES.has(s.title))
    .map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }))
    .filter((s) => s.body.length > 0);
}
