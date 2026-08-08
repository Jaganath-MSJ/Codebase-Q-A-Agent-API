export interface MessageLike {
  id: string;
  role: string;
  content: string;
  status: string;
}

export interface Exchange {
  userMessageId: string;
  assistantMessageId: string;
  question: string;
  answer: string;
  answerStatus: string;
}

const ANSWER_TRUNCATE_LENGTH = 600;

/**
 * Pairs a conversation's messages into (user, assistant) exchanges. Every
 * pair is inserted atomically as user-then-assistant (see
 * `MessagesRepository.createTurn`), so a strictly alternating prefix is
 * always safe to chunk two at a time.
 */
export function toExchanges(messages: MessageLike[]): Exchange[] {
  const exchanges: Exchange[] = [];
  for (let i = 0; i + 1 < messages.length; i += 2) {
    const user = messages[i]!;
    const assistant = messages[i + 1]!;
    if (user.role !== 'user' || assistant.role !== 'assistant') continue;
    exchanges.push({
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      question: user.content,
      answer: assistant.content,
      answerStatus: assistant.status,
    });
  }
  return exchanges;
}

/** The last `size` exchanges, oldest first — `size <= 0` yields none. */
export function recentWindow(exchanges: Exchange[], size: number): Exchange[] {
  return size <= 0 ? [] : exchanges.slice(-size);
}

/** Truncates to ~600 chars without splitting a trailing `[n]` marker in half. */
export function truncateAnswer(text: string, maxLength = ANSWER_TRUNCATE_LENGTH): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength).replace(/\[\d*$/, '');
  return `${truncated}…`;
}

/**
 * Exchanges older than the recent window that haven't been folded into
 * `conversations.summary` yet. Only ever grows from the oldest end, so once
 * `summarizedThroughAssistantId` is found, everything after it is new.
 */
export function evictedExchanges(
  exchanges: Exchange[],
  windowSize: number,
  summarizedThroughAssistantId: string | null,
): Exchange[] {
  const older = exchanges.slice(0, Math.max(0, exchanges.length - windowSize));
  if (!summarizedThroughAssistantId) return older;
  const idx = older.findIndex((ex) => ex.assistantMessageId === summarizedThroughAssistantId);
  return idx === -1 ? older : older.slice(idx + 1);
}
