import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
 *
 * The helper's *shape* is platform-specific (DEF-036) — a `.cmd` batch file on
 * Windows, an executable `/bin/sh` script elsewhere — so the expectations below
 * are parameterised. The security assertions are not: they hold on both.
 */

const IS_WINDOWS = process.platform === 'win32';

const EXPECTED = IS_WINDOWS
  ? {
      name: 'git-askpass.cmd',
      body: `@echo %${ASKPASS_TOKEN_ENV_VAR}%\r\n`,
      reference: `%${ASKPASS_TOKEN_ENV_VAR}%`,
    }
  : {
      name: 'git-askpass.sh',
      body: `#!/bin/sh\nprintf '%s\\n' "$${ASKPASS_TOKEN_ENV_VAR}"\n`,
      reference: `"$${ASKPASS_TOKEN_ENV_VAR}"`,
    };

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
      expect(scriptPath).toBe(path.join(dataDir, EXPECTED.name));
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

      expect(content).toContain(EXPECTED.reference);
      expect(content).not.toMatch(/ghp_|github_pat_|gho_/);
    });

    it('TC-ASK-011 keeps the script tiny — no room for embedded secrets', async () => {
      const scriptPath = await ensureAskpassScript(dataDir);
      const content = await readFile(scriptPath, 'utf8');
      expect(content).toBe(EXPECTED.body);
      expect(content.length).toBeLessThan(80);
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

    it('TC-ASK-013 does not let the helper echo its own command line', async () => {
      const content = await readFile(
        await ensureAskpassScript(dataDir),
        'utf8',
      );
      if (IS_WINDOWS) {
        // Without the leading `@`, cmd echoes the command line — which on some
        // terminals would surface the expanded value.
        expect(content.startsWith('@echo')).toBe(true);
      } else {
        // sh does not trace by default; the risk is a helper that turns it on.
        expect(content).not.toMatch(/set\s+-[a-z]*x/);
      }
    });

    it('TC-ASK-014 uses the line ending its interpreter requires', async () => {
      const content = await readFile(
        await ensureAskpassScript(dataDir),
        'utf8',
      );
      if (IS_WINDOWS) {
        expect(content.endsWith('\r\n')).toBe(true);
      } else {
        // A CR would end up inside the token `sh` prints.
        expect(content).not.toContain('\r');
      }
    });
  });

  it('TC-ASK-020 [DEFECT-009 fixed] replaces an existing file whose content is wrong', async () => {
    // Was existence-only: `existsSync` short-circuited before any content
    // check, so whatever sat at this path was handed to git as GIT_ASKPASS and
    // executed. Not a privilege boundary — DATA_DIR is app-owned on a
    // single-user machine — but the check now asks the question it reads as
    // asking: is the CORRECT helper present?
    const scriptPath = path.join(dataDir, EXPECTED.name);
    await writeFile(scriptPath, 'tampered\n', 'utf8');

    const returned = await ensureAskpassScript(dataDir);

    expect(returned).toBe(scriptPath);
    expect(await readFile(scriptPath, 'utf8')).toBe(EXPECTED.body);
  });

  it('TC-ASK-021 [DEFECT-009 fix guard] rewrites a truncated script', async () => {
    // The practical payoff, beyond tamper-resistance: a half-written file from
    // an interrupted run used to persist forever, because it existed.
    const scriptPath = path.join(dataDir, EXPECTED.name);
    await writeFile(scriptPath, EXPECTED.body.slice(0, 10), 'utf8');

    await ensureAskpassScript(dataDir);

    expect(await readFile(scriptPath, 'utf8')).toBe(EXPECTED.body);
  });

  it('TC-ASK-022 [DEFECT-009 fix guard] leaves a correct script untouched', async () => {
    // The check must not rewrite on every call — that would be a needless disk
    // write on the hot path of every private clone and fetch.
    const scriptPath = path.join(dataDir, EXPECTED.name);
    await ensureAskpassScript(dataDir);
    const first = await stat(scriptPath);

    await ensureAskpassScript(dataDir);

    expect((await stat(scriptPath)).mtimeMs).toBe(first.mtimeMs);
  });
});

describe('TC-ASK-030..033 — the helper must be runnable on THIS platform (DEF-036)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-askpass-exec-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('TC-ASK-032 runs as git would run it, and prints the token', async () => {
    // The whole point of GIT_ASKPASS: git spawns this path as a child process
    // with a prompt argument and reads the credential off stdout. If it is not
    // executable in this host's own terms, a private clone cannot authenticate.
    // Before DEF-036 this failed EACCES on every non-Windows machine.
    const scriptPath = await ensureAskpassScript(dir);

    const out = execFileSync(scriptPath, ['Password for https://github.com:'], {
      env: { ...process.env, [ASKPASS_TOKEN_ENV_VAR]: 'ghp_exec_probe_value' },
      encoding: 'utf8',
      shell: IS_WINDOWS,
    });

    expect(out.trim()).toBe('ghp_exec_probe_value');
  });

  it('TC-ASK-034 emits a leading-dash token literally, not as a flag', async () => {
    // `echo -n ...` would swallow it; `printf '%s\n'` does not.
    const scriptPath = await ensureAskpassScript(dir);

    const out = execFileSync(scriptPath, ['Password:'], {
      env: { ...process.env, [ASKPASS_TOKEN_ENV_VAR]: '-n' },
      encoding: 'utf8',
      shell: IS_WINDOWS,
    });

    expect(out.trim()).toBe('-n');
  });

  it('TC-ASK-030 is owner-executable on a POSIX host', async () => {
    if (IS_WINDOWS) return;
    const scriptPath = await ensureAskpassScript(dir);
    expect((await stat(scriptPath)).mode & 0o100).toBe(0o100);
  });

  it('TC-ASK-031 is a shell script on POSIX, a batch file on Windows', async () => {
    const scriptPath = await ensureAskpassScript(dir);
    const body = await readFile(scriptPath, 'utf8');

    if (IS_WINDOWS) {
      expect(scriptPath.endsWith('.cmd')).toBe(true);
      expect(body.startsWith('@echo')).toBe(true);
    } else {
      expect(scriptPath.endsWith('.sh')).toBe(true);
      expect(body.startsWith('#!/bin/sh')).toBe(true);
    }
  });

  it('TC-ASK-033 repairs a helper whose content is right but mode is wrong', async () => {
    if (IS_WINDOWS) return;
    // DEF-009 compares content. Content alone is not enough once the file has
    // to be executable — a 0644 helper with perfect content still cannot run.
    const scriptPath = await ensureAskpassScript(dir);
    const body = await readFile(scriptPath, 'utf8');
    await writeFile(scriptPath, body, { encoding: 'utf8', mode: 0o644 });

    await ensureAskpassScript(dir);

    expect((await stat(scriptPath)).mode & 0o100).toBe(0o100);
  });
});
