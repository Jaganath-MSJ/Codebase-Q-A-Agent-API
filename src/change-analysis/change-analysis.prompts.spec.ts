import { describe, expect, it } from 'vitest';
import { buildChangeAnalysisPrompt } from './change-analysis.prompts';

describe('buildChangeAnalysisPrompt', () => {
  it('embeds the commit, the diff, and the numbered evidence context', () => {
    const { user } = buildChangeAnalysisPrompt(
      { hash: 'abc123', message: 'Fix validateUser' },
      [{ path: 'src/auth.service.ts', insertions: 3, deletions: 1, patch: '@@ -1,3 +1,5 @@\n-old\n+new' }],
      [{ path: 'src/index.ts', startLine: 1, endLine: 12, content: 'main();' }],
    );

    expect(user).toContain('COMMIT abc123: Fix validateUser');
    expect(user).toContain('--- src/auth.service.ts (+3/-1) ---');
    expect(user).toContain('@@ -1,3 +1,5 @@');
    expect(user).toContain('[1] src/index.ts:1-12\nmain();');
  });

  it('produces an empty CONTEXT block when there is no evidence to cite', () => {
    const { user } = buildChangeAnalysisPrompt({ hash: 'abc123', message: 'Bump a version' }, [], []);
    expect(user).toContain('CONTEXT (current code of the changed files, and callers of the symbols they define):\n');
  });
});
