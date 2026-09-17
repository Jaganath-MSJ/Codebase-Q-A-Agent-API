import { readFile } from 'node:fs/promises';

interface ReadResult {
  text: string;
  lines: string[];
}

export function toLines(raw: string): ReadResult {
  // A UTF-8 BOM is an encoding marker, not content, and `readFile(…, 'utf8')`
  // leaves it in place. Stripped here, once, for the same reason CRLF is: every
  // line number in the system derives from the `lines` array below, so a stray
  // U+FEFF on line 1 would reach the embedded chunk text and the file viewer
  // while being invisible on screen. Windows editors write it routinely.
  //
  // Only a LEADING BOM is removed — mid-file it is a legitimate zero-width
  // no-break space and deleting it would corrupt the line. (DEF-001)
  // Written as `\uFEFF`, never as a literal BOM byte: a literal would make git
  // classify this file as binary, costing every future diff and blame on it.
  let normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  // Classic-Mac CR-only line endings, handled ONLY when the file uses CR
  // exclusively — no LF survived the pass above (DEF-002).
  //
  // The tempting one-character version of this fix, `/\r\n?/g`, is WRONG and
  // would be a worse bug than the one it closes. A lone CR inside a file that
  // already uses LF is *data*, not a terminator — it can sit inside a string or
  // a here-doc — and rewriting it would split one source line into two, shifting
  // every line number after it. Every line number in the system derives from the
  // array below, so that corrupts citations and the viewer in a way nothing
  // downstream can detect.
  //
  // Scoping it to files with no LF at all makes the change unambiguous: if
  // there is no LF, CR is the only thing a terminator could be.
  if (!normalized.includes('\n') && normalized.includes('\r')) {
    normalized = normalized.replace(/\r/g, '\n');
  }

  if (normalized === '') {
    return { text: normalized, lines: [] };
  }

  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    lines.pop();
  }

  return { text: normalized, lines };
}

export async function readSourceFile(absPath: string): Promise<ReadResult> {
  const raw = await readFile(absPath, 'utf8');
  return toLines(raw);
}
