import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { CredentialsService } from './credentials.service';
import type { CredentialsRepository } from '../db/repositories/credentials.repository';
import type { ConfigService } from '../config/config.service';

/**
 * QA pass — TC-CRED-*.
 *
 * `crypto.util.spec.ts` already covers the primitives. This covers the service
 * wrapped around them, where the risk is different: what leaves the module.
 * `getToken` is the single place plaintext escapes; `getMeta` must never be a
 * second one.
 *
 * `CREDENTIAL_KEY` is unset in the developer `.env`, so every test generates a
 * throwaway key in-process. The suite never reads or writes `.env`.
 */

interface Row {
  projectId: string;
  kind: string;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  createdAt: Date;
}

const PROJECT_ID = 'p-1';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function fakeRepo() {
  const rows = new Map<string, Row>();
  const repo = {
    upsert: (input: Omit<Row, 'createdAt'>) => {
      rows.set(input.projectId, {
        ...input,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      return Promise.resolve();
    },
    findByProjectId: (projectId: string) =>
      Promise.resolve(rows.get(projectId) ?? null),
    deleteByProjectId: (projectId: string) =>
      Promise.resolve(rows.delete(projectId)),
  } as unknown as CredentialsRepository;
  return { repo, rows };
}

function fakeConfig(credentialKey: string): ConfigService {
  return { credentialKey } as unknown as ConfigService;
}

describe('CredentialsService', () => {
  let repo: CredentialsRepository;
  let rows: Map<string, Row>;
  let service: CredentialsService;
  let key: string;

  beforeEach(() => {
    ({ repo, rows } = fakeRepo());
    key = randomBytes(32).toString('base64');
    service = new CredentialsService(repo, fakeConfig(key));
  });

  describe('TC-CRED-001..005 — round trip', () => {
    it('TC-CRED-001 stores and retrieves a token', async () => {
      await service.setCredential(PROJECT_ID, 'github', TOKEN);
      expect(await service.getToken(PROJECT_ID)).toBe(TOKEN);
    });

    it('TC-CRED-002 returns null when no credential exists', async () => {
      // "Not configured" is an expected state, not an error — a git_url project
      // that was never made private has no row.
      expect(await service.getToken('unknown-project')).toBeNull();
    });

    it('TC-CRED-003 keeps projects isolated', async () => {
      await service.setCredential('p-1', 'github', 'token-one');
      await service.setCredential('p-2', 'github', 'token-two');
      expect(await service.getToken('p-1')).toBe('token-one');
      expect(await service.getToken('p-2')).toBe('token-two');
    });

    it('TC-CRED-004 replaces rather than duplicating on re-entry', async () => {
      await service.setCredential(PROJECT_ID, 'github', 'old-token');
      await service.setCredential(PROJECT_ID, 'github', 'new-token');
      expect(rows.size).toBe(1);
      expect(await service.getToken(PROJECT_ID)).toBe('new-token');
    });

    it('TC-CRED-005 round-trips a token containing unicode and punctuation', async () => {
      const awkward = 'tok:en/with+slashes=and✨';
      await service.setCredential(PROJECT_ID, 'github', awkward);
      expect(await service.getToken(PROJECT_ID)).toBe(awkward);
    });
  });

  describe('TC-CRED-010..014 — what must never leak (SEC)', () => {
    it('TC-CRED-010 never stores the plaintext token', async () => {
      await service.setCredential(PROJECT_ID, 'github', TOKEN);
      const stored = rows.get(PROJECT_ID)!;
      const asText = Buffer.concat([
        stored.ciphertext,
        stored.iv,
        stored.authTag,
      ]).toString('utf8');
      expect(asText).not.toContain(TOKEN);
      expect(asText).not.toContain('ghp_');
    });

    it('TC-CRED-011 getMeta returns no ciphertext and no plaintext', async () => {
      await service.setCredential(PROJECT_ID, 'github', TOKEN);
      const meta = await service.getMeta(PROJECT_ID);

      expect(Object.keys(meta!).sort()).toEqual(['createdAt', 'kind']);
      expect(JSON.stringify(meta)).not.toContain(TOKEN);
    });

    it('TC-CRED-012 getMeta returns null when no credential exists', async () => {
      expect(await service.getMeta('unknown-project')).toBeNull();
    });

    it('TC-CRED-013 encrypts the same token differently each time', async () => {
      await service.setCredential('p-1', 'github', TOKEN);
      const first = rows.get('p-1')!.ciphertext;
      await service.setCredential('p-2', 'github', TOKEN);
      const second = rows.get('p-2')!.ciphertext;
      expect(first.equals(second)).toBe(false);
    });

    it('TC-CRED-014 cannot decrypt a row written under a different key', async () => {
      await service.setCredential(PROJECT_ID, 'github', TOKEN);

      const rotated = new CredentialsService(
        repo,
        fakeConfig(randomBytes(32).toString('base64')),
      );
      // Losing CREDENTIAL_KEY means re-entering every token — the stored rows
      // become undecryptable rather than silently returning wrong plaintext.
      await expect(rotated.getToken(PROJECT_ID)).rejects.toThrow();
    });
  });

  describe('TC-CRED-020..023 — key validation', () => {
    it('TC-CRED-020 rejects a missing CREDENTIAL_KEY on write', async () => {
      const unset = new CredentialsService(repo, fakeConfig(''));
      await expect(
        unset.setCredential(PROJECT_ID, 'github', TOKEN),
      ).rejects.toThrow(/32 bytes/);
    });

    it('TC-CRED-021 rejects a short CREDENTIAL_KEY on write', async () => {
      const short = new CredentialsService(
        repo,
        fakeConfig(randomBytes(16).toString('base64')),
      );
      await expect(
        short.setCredential(PROJECT_ID, 'github', TOKEN),
      ).rejects.toThrow(/32 bytes/);
    });

    it('TC-CRED-022 does not write a row when the key is invalid', async () => {
      const unset = new CredentialsService(repo, fakeConfig(''));
      await expect(
        unset.setCredential(PROJECT_ID, 'github', TOKEN),
      ).rejects.toThrow();
      expect(rows.size).toBe(0);
    });

    it('TC-CRED-023 does not validate the key when there is no row to decrypt', async () => {
      // getToken short-circuits on a missing row BEFORE touching the key, so an
      // unconfigured server can still answer "no credential" rather than
      // erroring. Pinned because the ordering is load-bearing.
      const unset = new CredentialsService(repo, fakeConfig(''));
      await expect(unset.getToken('unknown-project')).resolves.toBeNull();
    });
  });

  describe('TC-CRED-030..032 — deletion', () => {
    it('TC-CRED-030 deletes an existing credential and reports true', async () => {
      await service.setCredential(PROJECT_ID, 'github', TOKEN);
      expect(await service.deleteCredential(PROJECT_ID)).toBe(true);
      expect(await service.getToken(PROJECT_ID)).toBeNull();
    });

    it('TC-CRED-031 reports false when there was nothing to delete', async () => {
      expect(await service.deleteCredential('unknown-project')).toBe(false);
    });

    it('TC-CRED-032 is idempotent', async () => {
      await service.setCredential(PROJECT_ID, 'github', TOKEN);
      expect(await service.deleteCredential(PROJECT_ID)).toBe(true);
      expect(await service.deleteCredential(PROJECT_ID)).toBe(false);
    });
  });
});
