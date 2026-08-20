export interface ChangeEvidenceBlock {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ChangedFileDiff {
  path: string;
  insertions: number;
  deletions: number;
  patch: string;
}

export interface PromptPair {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = [
  'You are reviewing the most recent commit in a codebase for a developer who is about to build on top of it.',
  'Summarize what changed, then flag anything that looks risky given the surrounding code — a caller that',
  'was not updated, a test that no longer matches the new behavior, an edge case the diff does not handle.',
  'The DIFF section is the change itself, already visible to the reader — do not cite it.',
  'Cite every factual claim about the surrounding code (CONTEXT) with [n], where n is a number shown there.',
  'Never invent a number, and never write a file path or line number yourself — only [n].',
  'If nothing in CONTEXT looks risky, say so plainly rather than inventing a concern.',
].join(' ');

function formatDiff(file: ChangedFileDiff): string {
  return `--- ${file.path} (+${file.insertions}/-${file.deletions}) ---\n${file.patch}`;
}

// This orchestrator owns its own evidence formatting rather than importing
// chat/prompt.builder.ts's — same reasoning tour-prompts.ts's formatEvidence
// already follows: each orchestrator's prompt module stays self-contained,
// not coupled to a sibling orchestrator's internals.
function formatEvidence(block: ChangeEvidenceBlock, i: number): string {
  return `[${i + 1}] ${block.path}:${block.startLine}-${block.endLine}\n${block.content}`;
}

export function buildChangeAnalysisPrompt(
  commit: { hash: string; message: string },
  changedFiles: ChangedFileDiff[],
  evidence: ChangeEvidenceBlock[],
): PromptPair {
  const user = [
    `COMMIT ${commit.hash}: ${commit.message}`,
    `DIFF:\n${changedFiles.map(formatDiff).join('\n\n')}`,
    `CONTEXT (current code of the changed files, and callers of the symbols they define):\n${evidence.map(formatEvidence).join('\n\n')}`,
    'Summarize the change, then flag anything that looks risky given what surrounds it.',
  ].join('\n\n');

  return { system: SYSTEM_PROMPT, user };
}
