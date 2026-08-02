import * as path from 'node:path';

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function toNative(p: string): string {
  return p.split('/').join(path.sep);
}

export function resolveInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, toNative(candidate));

  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes root: ${candidate}`);
  }

  return resolved;
}
