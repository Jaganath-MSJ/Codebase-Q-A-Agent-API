import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const ASKPASS_TOKEN_ENV_VAR = 'CQA_GIT_ASKPASS_TOKEN';

/** The entire helper. Compared against on every call — see below. */
const ASKPASS_SCRIPT_BODY = `@echo %${ASKPASS_TOKEN_ENV_VAR}%\r\n`;

/**
 * A tiny reusable helper git invokes as its own child process whenever it
 * needs a credential, per GIT_ASKPASS. It never contains a token itself —
 * only a reference to the env var name the token travels through, set for
 * the duration of a single clone/fetch call and never written to disk.
 * Windows-only by design (this project's whole environment is): a `.cmd`
 * file is directly executable via CreateProcess, no interpreter shebang
 * needed, which a `.js`/`.sh` helper would require on this platform.
 */
export async function ensureAskpassScript(dataDir: string): Promise<string> {
  const scriptPath = path.join(dataDir, 'git-askpass.cmd');

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

  if (current !== ASKPASS_SCRIPT_BODY) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(scriptPath, ASKPASS_SCRIPT_BODY, 'utf8');
  }
  return scriptPath;
}
