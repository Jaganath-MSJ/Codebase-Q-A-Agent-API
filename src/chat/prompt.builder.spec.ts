import { describe, expect, it } from 'vitest';
import { buildCondensationPrompt, buildSummaryPrompt, buildUserPrompt, formatEvidenceBlock } from './prompt.builder';

const evidence = [{ path: 'src/a.ts', startLine: 1, endLine: 3, content: 'export const a = 1;' }];

describe('formatEvidenceBlock', () => {
  it('numbers each block starting at 1 with a path:start-end header', () => {
    const twoBlocks = [
      ...evidence,
      { path: 'src/b.ts', startLine: 5, endLine: 8, content: 'export const b = 2;' },
    ];
    expect(formatEvidenceBlock(twoBlocks)).toBe(
      '[1] src/a.ts:1-3\nexport const a = 1;\n\n[2] src/b.ts:5-8\nexport const b = 2;',
    );
  });
});

describe('buildUserPrompt', () => {
  it('omits summary/recent-turns sections when there is no conversation context', () => {
    const prompt = buildUserPrompt(evidence, 'what is a?');
    expect(prompt).not.toContain('EARLIER IN THIS CONVERSATION');
    expect(prompt).not.toContain('RECENT TURNS');
    expect(prompt).toContain('CONTEXT:');
    expect(prompt).toContain('QUESTION:\nwhat is a?');
  });

  it('embeds formatEvidenceBlock\'s exact output inside CONTEXT', () => {
    const prompt = buildUserPrompt(evidence, 'what is a?');
    expect(prompt).toContain(`CONTEXT:\n${formatEvidenceBlock(evidence)}`);
  });

  it('includes the summary and recent turns when provided', () => {
    const prompt = buildUserPrompt(evidence, 'and b?', {
      summary: 'The user asked about constant a.',
      recentExchanges: [{ question: 'what is a?', answer: 'a is 1 [1].' }],
    });
    expect(prompt).toContain('EARLIER IN THIS CONVERSATION:\nThe user asked about constant a.');
    expect(prompt).toContain('RECENT TURNS:\nQ: what is a?\nA: a is 1 [1].');
  });

  it('omits the recent-turns section when the list is empty, even with a summary', () => {
    const prompt = buildUserPrompt(evidence, 'and b?', { summary: 'summary text', recentExchanges: [] });
    expect(prompt).toContain('EARLIER IN THIS CONVERSATION');
    expect(prompt).not.toContain('RECENT TURNS');
  });

  it('includes the project overview before conversation context, and omits it when absent', () => {
    const withOverview = buildUserPrompt(evidence, 'what is a?', {
      overview: 'tiny-repo — TypeScript. 3 files.',
      summary: 'prior summary',
      recentExchanges: [],
    });
    expect(withOverview).toContain('PROJECT OVERVIEW:\ntiny-repo — TypeScript. 3 files.');
    expect(withOverview.indexOf('PROJECT OVERVIEW')).toBeLessThan(
      withOverview.indexOf('EARLIER IN THIS CONVERSATION'),
    );

    const withoutOverview = buildUserPrompt(evidence, 'what is a?', { recentExchanges: [] });
    expect(withoutOverview).not.toContain('PROJECT OVERVIEW');
  });
});

describe('buildCondensationPrompt', () => {
  it('embeds the recent turns and the raw follow-up question', () => {
    const { user } = buildCondensationPrompt(
      [{ question: 'what does validateUser do?', answer: 'It checks the password [1].' }],
      'and what would break if I removed that?',
    );
    expect(user).toContain('Q: what does validateUser do?');
    expect(user).toContain('FOLLOW-UP QUESTION:\nand what would break if I removed that?');
  });
});

describe('buildSummaryPrompt', () => {
  it('asks for a fresh summary when none exists yet', () => {
    const { user } = buildSummaryPrompt(null, [{ question: 'q1', answer: 'a1' }]);
    expect(user).toContain('TURNS TO SUMMARIZE:');
    expect(user).not.toContain('EXISTING SUMMARY');
  });

  it('folds new turns into the existing summary rather than starting over', () => {
    const { user } = buildSummaryPrompt('prior summary', [{ question: 'q2', answer: 'a2' }]);
    expect(user).toContain('EXISTING SUMMARY:\nprior summary');
    expect(user).toContain('NEW TURNS TO FOLD IN:\nQ: q2\nA: a2');
  });
});
