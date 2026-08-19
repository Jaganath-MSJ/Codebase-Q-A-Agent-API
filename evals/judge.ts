import { formatEvidenceBlock } from '../src/chat/prompt.builder';

export interface JudgeEvidence {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface JudgePrompt {
  system: string;
  user: string;
}

export interface JudgeVerdict {
  grounded: boolean;
  allClaimsCited: boolean;
  handledUnknownCorrectly: boolean;
  reasoning: string;
}

const JUDGE_SYSTEM_PROMPT = [
  'You are grading one answer from a codebase Q&A tool against the evidence it was given.',
  'Respond with ONLY a single JSON object, no markdown fences, no prose before or after it,',
  'matching exactly this shape:',
  '{"grounded": boolean, "allClaimsCited": boolean, "handledUnknownCorrectly": boolean, "reasoning": string}',
  '"grounded": every factual claim in the answer is actually supported by the evidence — no invented behavior.',
  '"allClaimsCited": every non-trivial factual claim carries a [n] marker pointing at the evidence.',
  '"handledUnknownCorrectly": if the evidence does not contain the answer, the answer says so instead of',
  'guessing; if the evidence does contain the answer, the answer actually attempts one instead of refusing.',
  '"reasoning": one short sentence justifying the three verdicts above.',
].join(' ');

/** The evidence, question, and answer the judge grades — same shape shown to the model that generated the answer. */
export function buildJudgePrompt(input: {
  question: string;
  answer: string;
  evidence: JudgeEvidence[];
  expectUnanswerable: boolean;
}): JudgePrompt {
  const user = [
    `EVIDENCE:\n${formatEvidenceBlock(input.evidence)}`,
    `QUESTION:\n${input.question}`,
    `ANSWER:\n${input.answer}`,
    input.expectUnanswerable
      ? 'Note: this question is not actually answerable from the evidence above.'
      : 'Note: this question IS answerable from the evidence above.',
  ].join('\n\n');

  return { system: JUDGE_SYSTEM_PROMPT, user };
}

const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

/** Parses the judge's raw response text, tolerating an accidental ```json fence. Returns null on any malformed response, rather than throwing. */
export function parseJudgeVerdict(raw: string): JudgeVerdict | null {
  const trimmed = raw.trim();
  const unfenced = FENCE_RE.exec(trimmed)?.[1] ?? trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const { grounded, allClaimsCited, handledUnknownCorrectly, reasoning } = parsed as Record<string, unknown>;
  if (
    typeof grounded !== 'boolean' ||
    typeof allClaimsCited !== 'boolean' ||
    typeof handledUnknownCorrectly !== 'boolean' ||
    typeof reasoning !== 'string'
  ) {
    return null;
  }

  return { grounded, allClaimsCited, handledUnknownCorrectly, reasoning };
}
