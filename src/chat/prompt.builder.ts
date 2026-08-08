export interface EvidenceBlock {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface RecentExchange {
  question: string;
  answer: string;
}

export interface ConversationContext {
  summary?: string | null;
  recentExchanges: RecentExchange[];
}

export const SYSTEM_PROMPT = [
  'Cite every factual claim with [n], where n is a number shown in CONTEXT.',
  'Never invent a number, and never write a file path or line number yourself — only [n].',
  'If CONTEXT does not contain the answer, say exactly what is missing.',
  'Prefer pointing at where something happens, then briefly why.',
  'Quote at most 5 lines.',
].join(' ');

function formatExchanges(exchanges: RecentExchange[]): string {
  return exchanges.map((ex) => `Q: ${ex.question}\nA: ${ex.answer}`).join('\n\n');
}

export function buildUserPrompt(
  evidence: EvidenceBlock[],
  question: string,
  context?: ConversationContext,
): string {
  const parts: string[] = [];

  if (context?.summary) {
    parts.push(`EARLIER IN THIS CONVERSATION:\n${context.summary}`);
  }
  if (context?.recentExchanges.length) {
    parts.push(`RECENT TURNS:\n${formatExchanges(context.recentExchanges)}`);
  }

  const contextBlock = evidence
    .map((block, i) => `[${i + 1}] ${block.path}:${block.startLine}-${block.endLine}\n${block.content}`)
    .join('\n\n');
  parts.push(`CONTEXT:\n${contextBlock}`);
  parts.push(`QUESTION:\n${question}`);

  return parts.join('\n\n');
}

const CONDENSATION_SYSTEM_PROMPT = [
  'Rewrite the follow-up question as a single, fully standalone question by',
  'resolving every pronoun and implicit reference against the recent turns.',
  'Output only the rewritten question and nothing else — no preamble, no quotes.',
].join(' ');

export interface CondensationPrompt {
  system: string;
  user: string;
}

/** Condensation is for retrieval only — the model is later shown the original question, not this one. */
export function buildCondensationPrompt(
  recentExchanges: RecentExchange[],
  question: string,
): CondensationPrompt {
  return {
    system: CONDENSATION_SYSTEM_PROMPT,
    user: `RECENT TURNS:\n${formatExchanges(recentExchanges)}\n\nFOLLOW-UP QUESTION:\n${question}\n\nSTANDALONE QUESTION:`,
  };
}

const SUMMARY_SYSTEM_PROMPT = [
  'Summarize this codebase Q&A conversation concisely: what was asked, what',
  'the answers concluded, and any code areas discussed by name.',
  'Output only the updated summary paragraph, nothing else.',
].join(' ');

export interface SummaryPrompt {
  system: string;
  user: string;
}

/** Folds only the newly-evicted exchanges into the existing summary — never a full re-summarization. */
export function buildSummaryPrompt(
  existingSummary: string | null | undefined,
  newExchanges: RecentExchange[],
): SummaryPrompt {
  const turns = formatExchanges(newExchanges);
  const user = existingSummary
    ? `EXISTING SUMMARY:\n${existingSummary}\n\nNEW TURNS TO FOLD IN:\n${turns}\n\nUPDATED SUMMARY:`
    : `TURNS TO SUMMARIZE:\n${turns}\n\nSUMMARY:`;

  return { system: SUMMARY_SYSTEM_PROMPT, user };
}
