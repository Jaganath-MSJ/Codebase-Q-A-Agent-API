import * as path from 'node:path';

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function toNative(p: string): string {
  return p.split('/').join(path.sep);
}

// A repo-relative candidate must be neither absolute nor climbing out of the
// root in EITHER OS's path grammar. Checking both flavors makes the containment
// guard host-independent: on a POSIX host, `path` alone treats a Windows
// drive-absolute (`C:\...`, `C:/...`), a UNC (`\\server\share`), or a `..\..`
// backslash traversal as ordinary nested segments and would silently accept
// them — and a Windows host has the mirror blind spot for POSIX-absolute input
// like `/etc/passwd`. Since every path in the DB/API is a forward-slash
// repo-relative path, any absolute or upward form is hostile regardless of the
// host the server happens to run on.
function escapesRoot(flavor: path.PlatformPath, candidate: string): boolean {
  // A non-empty parsed root means the candidate is anchored to a filesystem
  // root in this grammar. This is deliberately broader than isAbsolute(): it
  // also catches Windows *drive-relative* forms like `C:foo` and `C:..\..\x`,
  // which isAbsolute() reports false for (no slash after the drive letter means
  // "relative to that drive's cwd") yet which still refer off the intended root.
  // Covered in one check: POSIX-absolute (`/…`), drive-absolute (`C:\…`, `C:/…`),
  // drive-relative (`C:…`), and UNC shares (`\\server\share`).
  if (flavor.parse(candidate).root !== '') return true;
  const normalized = flavor.normalize(candidate);
  return normalized === '..' || normalized.startsWith('..' + flavor.sep);
}

export function resolveInside(root: string, candidate: string): string {
  if (
    escapesRoot(path.posix, candidate) ||
    escapesRoot(path.win32, candidate)
  ) {
    throw new Error(`Path escapes root: ${candidate}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, toNative(candidate));

  // Final host-native containment check — belt-and-suspenders for any edge the
  // grammar checks above miss on this particular platform.
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(resolvedRoot + path.sep)
  ) {
    throw new Error(`Path escapes root: ${candidate}`);
  }

  return resolved;
}
