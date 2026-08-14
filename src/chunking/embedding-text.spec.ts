import { describe, expect, it } from 'vitest';
import { buildEmbeddingText } from './embedding-text';

describe('buildEmbeddingText', () => {
  it('prepends path, symbol, and line range as a comment header', () => {
    const text = buildEmbeddingText({
      path: 'src/auth/auth.service.ts',
      symbol: 'AuthService.validateUser',
      startLine: 41,
      endLine: 88,
      content: 'async validateUser() {}',
    });
    expect(text).toBe(
      '// src/auth/auth.service.ts (AuthService.validateUser) lines 41-88\nasync validateUser() {}',
    );
  });

  it('omits the parenthesized symbol when there is none', () => {
    const text = buildEmbeddingText({
      path: 'src/index.ts',
      symbol: null,
      startLine: 1,
      endLine: 3,
      content: 'import x from "y";',
    });
    expect(text).toBe('// src/index.ts lines 1-3\nimport x from "y";');
  });
});
