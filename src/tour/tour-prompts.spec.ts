import { describe, expect, it } from 'vitest';
import {
  buildTourMapPrompt,
  buildTourReducePrompt,
  parseTourSections,
  TOUR_SECTION_TITLES,
  type MarkedEvidence,
} from './tour-prompts';

describe('buildTourMapPrompt', () => {
  it('shows each block under its true global marker, not a local re-numbering', () => {
    const batch: MarkedEvidence[] = [
      { marker: 7, block: { path: 'src/a.ts', startLine: 1, endLine: 3, content: 'export const a = 1;' } },
      { marker: 12, block: { path: 'src/b.ts', startLine: 5, endLine: 8, content: 'export const b = 2;' } },
    ];
    const { user } = buildTourMapPrompt(batch);
    expect(user).toContain('[7] src/a.ts:1-3');
    expect(user).toContain('[12] src/b.ts:5-8');
  });
});

describe('buildTourReducePrompt', () => {
  it('numbers each group and asks for all four section titles', () => {
    const { system, user } = buildTourReducePrompt(['first summary [1].', 'second summary [2].']);
    expect(user).toContain('Group 1:\nfirst summary [1].');
    expect(user).toContain('Group 2:\nsecond summary [2].');
    for (const title of TOUR_SECTION_TITLES) {
      expect(system).toContain(title);
    }
  });
});

describe('parseTourSections', () => {
  it('parses all four sections in order', () => {
    const output = [
      '## What this project is',
      'A codebase Q&A agent [1].',
      '',
      '## How it is organized',
      'Split into api and web [2].',
      '',
      '## How a request flows through it',
      'A question is retrieved then answered [3].',
      '',
      '## Where to start reading',
      'Start at main.ts [1].',
    ].join('\n');

    const sections = parseTourSections(output);
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.title)).toEqual([...TOUR_SECTION_TITLES]);
    expect(sections[0]!.body).toBe('A codebase Q&A agent [1].');
  });

  it('drops an unknown heading and keeps the recognized ones', () => {
    const output = ['## Something else', 'stray text', '## What this project is', 'real content'].join(
      '\n',
    );
    const sections = parseTourSections(output);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe('What this project is');
  });

  it('drops a recognized heading with an empty body', () => {
    const output = ['## What this project is', '', '## How it is organized', 'content'].join('\n');
    const sections = parseTourSections(output);
    expect(sections.map((s) => s.title)).toEqual(['How it is organized']);
  });

  it('returns an empty array for text with no headings at all', () => {
    expect(parseTourSections('just some prose')).toEqual([]);
  });
});
