import { describe, expect, it } from 'vitest';
import {
  evictedExchanges,
  recentWindow,
  toExchanges,
  truncateAnswer,
} from './conversation-context';

function message(id: string, role: string, content = '', status = 'complete') {
  return { id, role, content, status };
}

describe('toExchanges', () => {
  it('pairs strictly alternating user/assistant messages', () => {
    const messages = [
      message('u1', 'user', 'q1'),
      message('a1', 'assistant', 'a1'),
      message('u2', 'user', 'q2'),
      message('a2', 'assistant', 'a2'),
    ];
    expect(toExchanges(messages)).toEqual([
      {
        userMessageId: 'u1',
        assistantMessageId: 'a1',
        question: 'q1',
        answer: 'a1',
        answerStatus: 'complete',
      },
      {
        userMessageId: 'u2',
        assistantMessageId: 'a2',
        question: 'q2',
        answer: 'a2',
        answerStatus: 'complete',
      },
    ]);
  });

  it('returns nothing for an empty or odd-length list', () => {
    expect(toExchanges([])).toEqual([]);
    expect(toExchanges([message('u1', 'user')])).toEqual([]);
  });

  it('carries the assistant status through, for filtering incomplete turns downstream', () => {
    const messages = [
      message('u1', 'user', 'q1'),
      message('a1', 'assistant', '', 'streaming'),
    ];
    expect(toExchanges(messages)[0]!.answerStatus).toBe('streaming');
  });
});

describe('recentWindow', () => {
  const exchanges = toExchanges([
    message('u1', 'user', 'q1'),
    message('a1', 'assistant', 'a1'),
    message('u2', 'user', 'q2'),
    message('a2', 'assistant', 'a2'),
    message('u3', 'user', 'q3'),
    message('a3', 'assistant', 'a3'),
  ]);

  it('takes the last N, oldest first', () => {
    expect(recentWindow(exchanges, 2).map((e) => e.question)).toEqual([
      'q2',
      'q3',
    ]);
  });

  it('returns everything if N exceeds the length', () => {
    expect(recentWindow(exchanges, 10)).toHaveLength(3);
  });

  it('returns none for size <= 0', () => {
    expect(recentWindow(exchanges, 0)).toEqual([]);
  });
});

describe('truncateAnswer', () => {
  it('leaves short text untouched', () => {
    expect(truncateAnswer('short answer')).toBe('short answer');
  });

  it('truncates long text and appends an ellipsis', () => {
    const long = 'a'.repeat(700);
    const result = truncateAnswer(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith('…')).toBe(true);
  });

  it('never splits a trailing [n] marker in half', () => {
    const text = 'x'.repeat(598) + '[12]';
    const result = truncateAnswer(text, 600);
    expect(result).not.toMatch(/\[\d*…$/);
    expect(result).not.toContain('[1…');
  });
});

describe('evictedExchanges', () => {
  const exchanges = toExchanges([
    message('u1', 'user', 'q1'),
    message('a1', 'assistant', 'a1'),
    message('u2', 'user', 'q2'),
    message('a2', 'assistant', 'a2'),
    message('u3', 'user', 'q3'),
    message('a3', 'assistant', 'a3'),
    message('u4', 'user', 'q4'),
    message('a4', 'assistant', 'a4'),
  ]);

  it('returns everything older than the window when nothing is summarized yet', () => {
    expect(evictedExchanges(exchanges, 3, null).map((e) => e.question)).toEqual(
      ['q1'],
    );
  });

  it('returns only newly-evicted exchanges once some are already summarized', () => {
    // window=3 keeps q2,q3,q4; q1 was already folded in via a1.
    expect(evictedExchanges(exchanges, 3, 'a1')).toEqual([]);
  });

  it('returns nothing when the window covers the whole conversation', () => {
    expect(evictedExchanges(exchanges, 10, null)).toEqual([]);
  });

  it('evicts the whole older slice when the watermark is not in the (bounded) tail', () => {
    // computePriorExchanges now loads only messages AFTER the summary watermark,
    // so the watermark's own exchange is absent from the list. evictedExchanges
    // must then treat everything older than the window as newly-evicted (the
    // `idx === -1` branch) — this is what keeps summarization advancing correctly
    // once the per-turn fetch is bounded to the un-summarized tail.
    const tail = toExchanges([
      message('u5', 'user', 'q5'),
      message('a5', 'assistant', 'a5'),
      message('u6', 'user', 'q6'),
      message('a6', 'assistant', 'a6'),
      message('u7', 'user', 'q7'),
      message('a7', 'assistant', 'a7'),
      message('u8', 'user', 'q8'),
      message('a8', 'assistant', 'a8'),
    ]);
    // window=3 keeps q6,q7,q8; the watermark 'a4' predates this tail and isn't in it.
    expect(evictedExchanges(tail, 3, 'a4').map((e) => e.question)).toEqual([
      'q5',
    ]);
  });
});
