const DENYLIST_PREFIXES = ['.git/', 'node_modules/', 'dist/', 'build/', '.next/', 'coverage/'];

const ALLOWED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.rb',
  '.php',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.md',
  '.mdx',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.html',
  '.css',
  '.scss',
  '.sql',
  '.sh',
]);

export const MAX_FILE_BYTES = 256 * 1024;

export function isDenylisted(relPath: string): boolean {
  return DENYLIST_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

export function hasAllowedExtension(relPath: string): boolean {
  const lastDot = relPath.lastIndexOf('.');
  const lastSlash = relPath.lastIndexOf('/');
  if (lastDot === -1 || lastDot < lastSlash) return false;

  const ext = relPath.slice(lastDot).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}
