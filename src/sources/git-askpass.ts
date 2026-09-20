import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const ASKPASS_TOKEN_ENV_VAR = 'CQA_GIT_ASKPASS_TOKEN';

const IS_WINDOWS = process.platform === 'win32';

/**
 * The entire helper, per platform. Compared against on every call — see below.
 *
 * Windows gets a `.cmd`: directly executable via CreateProcess, no shebang and
 * no execute bit involved. POSIX gets a `/bin/sh` script, which needs both —
 * `printf` rather than `echo` so a token beginning with `-` is emitted
 * literally instead of being read as a flag.
 */
const HELPER = IS_WINDOWS
  ? {
      name: 'git-askpass.cmd',
      body: `@echo %${ASKPASS_TOKEN_ENV_VAR}%\r\n`,
      mode: 0o600,
    }
  : {
      name: 'git-askpass.sh',
      body: `#!/bin/sh\nprintf '%s\\n' "$${ASKPASS_TOKEN_ENV_VAR}"\n`,
      mode: 0o700,
    };

/**
 * A tiny reusable helper git invokes as its own child process whenever it
 * needs a credential, per GIT_ASKPASS. It never contains a token itself —
 * only a reference to the env var name the token travels through, set for
 * the duration of a single clone/fetch call and never written to disk.
 *
 * DEF-036: this was `.cmd`-only, from when the project targeted Windows. git
 * on macOS and Linux spawns GIT_ASKPASS as a program, so a batch file written
 * 0644 failed with EACCES and no private repository could authenticate. The
 * helper is now written in the host's own terms, and on POSIX the mode is part
 * of what "correct" means.
 */
export async function ensureAskpassScript(dataDir: string): Promise<string> {
  const scriptPath = path.join(dataDir, HELPER.name);

  // Compares CONTENT, not mere existence (DEF-009). This path is handed to git
  // as GIT_ASKPASS and executed as a child process, so "a file is here" is the
  // wrong question — the right one is "is the correct helper here". Whatever is
  // on disk is replaced when it does not match, which also self-heals a
  // truncated or half-written script from an interrupted run.
  //
  // Not a privilege boundary: DATA_DIR is application-owned on a single-user
  // machine, and anything able to write there could edit this source instead.
  // The check is here so the code means what it reads as meaning.
  let current: string | null;
  try {
    current = await readFile(scriptPath, 'utf8');
  } catch {
    current = null;
  }

  // On POSIX, correct content in a non-executable file is still a broken
  // helper — the exact shape DEF-036 shipped as. Mode is checked alongside.
  let executable = true;
  if (!IS_WINDOWS && current !== null) {
    try {
      executable = ((await stat(scriptPath)).mode & 0o100) !== 0;
    } catch {
      executable = false;
    }
  }

  if (current !== HELPER.body || !executable) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(scriptPath, HELPER.body, {
      encoding: 'utf8',
      mode: HELPER.mode,
    });
    // `writeFile`'s mode applies only when the file is created, so an existing
    // helper with the right bytes and the wrong bits needs this explicitly.
    if (!IS_WINDOWS) await chmod(scriptPath, HELPER.mode);
  }
  return scriptPath;
}
