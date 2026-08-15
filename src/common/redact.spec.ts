import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact';

describe('redactSecrets', () => {
  it('redacts a classic GitHub PAT embedded in an error message', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const msg = `remote: Invalid username or password.\nfatal: Authentication failed for 'https://${token}@github.com/org/repo.git/'`;
    const result = redactSecrets(msg);
    expect(result).not.toContain(token);
    expect(result).toContain('[REDACTED]');
  });

  it('redacts a fine-grained GitHub PAT', () => {
    const token = `github_pat_${'A'.repeat(22)}`;
    expect(redactSecrets(`token was ${token}`)).toBe('token was [REDACTED]');
  });

  it('redacts multiple occurrences', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const result = redactSecrets(`${token} ... retry with ${token}`);
    expect(result).not.toContain(token);
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it('leaves ordinary text untouched', () => {
    const msg = 'fatal: repository not found';
    expect(redactSecrets(msg)).toBe(msg);
  });
});
