import { describe, expect, it } from 'vitest';
import { classifyMode } from './mode-router';

describe('classifyMode', () => {
  it.each([
    ['what would break if I deleted validateUser?', 'thorough'],
    ['what breaks if I change the auth flow?', 'thorough'],
    ['trace the request through the system', 'thorough'],
    ['is this function called everywhere?', 'thorough'],
    ['find all the places this is used', 'thorough'],
    ['why does this fail intermittently?', 'thorough'],
    ['how does the auth flow work end to end?', 'thorough'],
    ['is there any unused code in the auth module?', 'thorough'],
    ['is there dead code here?', 'thorough'],
    ['what is the impact of removing this function?', 'thorough'],
  ] as const)('escalates "%s" to thorough', (question, expected) => {
    expect(classifyMode(question)).toBe(expected);
  });

  it.each([
    ['where is user authentication handled?', 'fast'],
    ['what does validateUser do?', 'fast'],
    ['show me the auth service', 'fast'],
  ] as const)('keeps "%s" on fast', (question, expected) => {
    expect(classifyMode(question)).toBe(expected);
  });
});
