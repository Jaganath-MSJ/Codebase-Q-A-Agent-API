import { describe, expect, it } from 'vitest';
import { buildJudgePrompt, parseJudgeVerdict } from './judge';

describe('buildJudgePrompt', () => {
  it('includes the evidence, question, answer, and an answerability note', () => {
    const { user } = buildJudgePrompt({
      question: 'Where is validateUser implemented?',
      answer: 'It is implemented in [1].',
      evidence: [{ path: 'src/auth.service.ts', startLine: 1, endLine: 34, content: 'export function validateUser() {}' }],
      expectUnanswerable: false,
    });

    expect(user).toContain('[1] src/auth.service.ts:1-34');
    expect(user).toContain('Where is validateUser implemented?');
    expect(user).toContain('It is implemented in [1].');
    expect(user).toContain('IS answerable');
  });

  it('notes when the question is not actually answerable', () => {
    const { user } = buildJudgePrompt({
      question: 'Where is the billing logic?',
      answer: 'The evidence does not show any billing logic.',
      evidence: [],
      expectUnanswerable: true,
    });

    expect(user).toContain('not actually answerable');
  });
});

describe('parseJudgeVerdict', () => {
  it('parses a well-formed JSON verdict', () => {
    const verdict = parseJudgeVerdict(
      '{"grounded": true, "allClaimsCited": true, "handledUnknownCorrectly": true, "reasoning": "looks right"}',
    );
    expect(verdict).toEqual({
      grounded: true,
      allClaimsCited: true,
      handledUnknownCorrectly: true,
      reasoning: 'looks right',
    });
  });

  it('tolerates a ```json fence the model added despite instructions', () => {
    const verdict = parseJudgeVerdict(
      '```json\n{"grounded": false, "allClaimsCited": true, "handledUnknownCorrectly": false, "reasoning": "hallucinated"}\n```',
    );
    expect(verdict?.grounded).toBe(false);
    expect(verdict?.reasoning).toBe('hallucinated');
  });

  it('returns null for invalid JSON', () => {
    expect(parseJudgeVerdict('not json at all')).toBeNull();
  });

  it('returns null when a required field is missing or the wrong type', () => {
    expect(parseJudgeVerdict('{"grounded": true}')).toBeNull();
    expect(parseJudgeVerdict('{"grounded": "yes", "allClaimsCited": true, "handledUnknownCorrectly": true, "reasoning": "x"}')).toBeNull();
  });
});
