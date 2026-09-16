import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureAskpassScript, ASKPASS_TOKEN_ENV_VAR } from './git-askpass';

/**
 * QA pass — TC-ASK-*.
 *
 * This script is how a GitHub token reaches `git` without ever appearing in a
 * clone URL or on a command line. The security property is narrow and absolute:
 * **the file written to disk must never contain the token**, only the name of
 * the environment variable carrying it.
 */

describe('ensureAskpassScript', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'qa-askpass-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('TC-ASK-001..004 — creation', () => {
    it('TC-ASK-001 writes the script and returns its path', async () => {
      const scriptPath = await ensureAskpassScript(dataDir);
      expect(scriptPath).toBe(path.join(dataDir, 'git-askpass.cmd'));
      await expect(stat(scriptPath)).resolves.toBeDefined();
    });

    it('TC-ASK-002 creates the data directory if it does not exist', async () => {
      const nested = path.join(dataDir, 'deep', 'nested');
      const scriptPath = await ensureAskpassScript(nested);
      await expect(stat(scriptPath)).resolves.toBeDefined();
    });

    it('TC-ASK-003 is idempotent across calls', async () => {
      const first = await ensureAskpassScript(dataDir);
      const second = await ensureAskpassScript(dataDir);
      expect(second).toBe(first);
    });

    it('TC-ASK-004 does not rewrite an existing script', async () => {
      const scriptPath = await ensureAskpassScript(dataDir);
      const before = (await stat(scriptPath)).mtimeMs;
      await new Promise((r) => setTimeout(r, 10));
      await ensureAskpassScript(dataDir);
      expect((await stat(scriptPath)).mtimeMs).toBe(before);
    });
  });

  describe('TC-ASK-010..014 — the token never touches disk (SEC)', () => {
    it('TC-ASK-010 writes only an env-var reference, never a literal token', async () => {
      const scriptPath = await ensureAskpassScript(dataDir);
      const content = await readFile(scriptPath, 'utf8');

      expect(content).toContain(`%${ASKPASS_TOKEN_ENV_VAR}%`);
      expect(content).not.toMatch(/ghp_|github_pat_|gho_/);
    });

    it('TC-ASK-011 keeps the script tiny — no room for embedded secrets', async () => {
      const scriptPath = await ensureAskpassScript(dataDir);
      const content = await readFile(scriptPath, 'utf8');
      expect(content.trim()).toBe(`@echo %${ASKPASS_TOKEN_ENV_VAR}%`);
    });

    it('TC-ASK-012 is byte-identical no matter what is in the environment', async () => {
      // The script is static: nothing about the current process's env can be
      // interpolated into it at write time.
      const a = await readFile(await ensureAskpassScript(dataDir), 'utf8');

      const other = await mkdtemp(path.join(tmpdir(), 'qa-askpass-2-'));
      process.env[ASKPASS_TOKEN_ENV_VAR] = 'ghp_a_real_looking_secret_value';
      try {
        const b = await readFile(await ensureAskpassScript(other), 'utf8');
        expect(b).toBe(a);
        expect(b).not.toContain('ghp_a_real_looking_secret_value');
      } finally {
        delete process.env[ASKPASS_TOKEN_ENV_VAR];
        await rm(other, { recursive: true, force: true });
      }
    });

    it('TC-ASK-013 uses @echo so the command itself is not printed', async () => {
      // Without the leading `@`, cmd echoes the command line — which on some
      // terminals would surface the expanded value.
      const content = await readFile(
        await ensureAskpassScript(dataDir),
        'utf8',
      );
      expect(content.startsWith('@echo')).toBe(true);
    });

    it('TC-ASK-014 uses CRLF line endings, as cmd.exe requires', async () => {
      const content = await readFile(
        await ensureAskpassScript(dataDir),
        'utf8',
      );
      expect(content.endsWith('\r\n')).toBe(true);
    });
  });

  it('TC-ASK-020 [DEFECT-009 fixed] replaces an existing file whose content is wrong', async () => {
    // Was existence-only: `existsSync` short-circuited before any content
    // check, so whatever sat at this path was handed to git as GIT_ASKPASS and
    // executed. Not a privilege boundary — DATA_DIR is app-owned on a
    // single-user machine — but the check now asks the question it reads as
    // asking: is the CORRECT helper present?
    const scriptPath = path.join(dataDir, 'git-askpass.cmd');
    await writeFile(scriptPath, '@echo tampered\r\n', 'utf8');

    const returned = await ensureAskpassScript(dataDir);

    expect(returned).toBe(scriptPath);
    expect(await readFile(scriptPath, 'utf8')).toBe(
      `@echo %${ASKPASS_TOKEN_ENV_VAR}%\r\n`,
    );
  });

  it('TC-ASK-021 [DEFECT-009 fix guard] rewrites a truncated script', async () => {
    // The practical payoff, beyond tamper-resistance: a half-written file from
    // an interrupted run used to persist forever, because it existed.
    const scriptPath = path.join(dataDir, 'git-askpass.cmd');
    await writeFile(scriptPath, '@echo %CQA', 'utf8');

    await ensureAskpassScript(dataDir);

    expect(await readFile(scriptPath, 'utf8')).toBe(
      `@echo %${ASKPASS_TOKEN_ENV_VAR}%\r\n`,
    );
  });

  it('TC-ASK-022 [DEFECT-009 fix guard] leaves a correct script untouched', async () => {
    // The check must not rewrite on every call — that would be a needless disk
    // write on the hot path of every private clone and fetch.
    const scriptPath = path.join(dataDir, 'git-askpass.cmd');
    await ensureAskpassScript(dataDir);
    const first = await stat(scriptPath);

    await ensureAskpassScript(dataDir);

    expect((await stat(scriptPath)).mtimeMs).toBe(first.mtimeMs);
  });
});
