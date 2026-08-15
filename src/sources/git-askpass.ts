import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export const ASKPASS_TOKEN_ENV_VAR = 'CQA_GIT_ASKPASS_TOKEN';

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
  if (!existsSync(scriptPath)) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(scriptPath, `@echo %${ASKPASS_TOKEN_ENV_VAR}%\r\n`, 'utf8');
  }
  return scriptPath;
}
