export const DENYLIST_PREFIXES = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'target/',
  'vendor/',
  '.next/',
  'coverage/',
  '__pycache__/',
  '.venv/',
];

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

const FILENAME_DENYLIST = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);
const FILENAME_DENYLIST_PATTERNS = [
  /\.min\.js$/,
  /\.map$/,
  /\.snap$/,
  /\.generated\./,
];

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_LINE_LENGTH = 2000;

export function isDenylisted(relPath: string): boolean {
  return DENYLIST_PREFIXES.some((prefix) => relPath.startsWith(prefix));
}

function extractExtension(relPath: string): string | null {
  const lastDot = relPath.lastIndexOf('.');
  const lastSlash = relPath.lastIndexOf('/');
  if (lastDot === -1 || lastDot < lastSlash) return null;
  return relPath.slice(lastDot).toLowerCase();
}

/**
 * `'unknown'` (no extension, e.g. `Makefile`, `Dockerfile`) is deliberately
 * not a hard rejection — those files fall through to binary detection instead
 * of being excluded just for lacking an extension.
 */
export function classifyExtension(
  relPath: string,
): 'allowed' | 'denied' | 'unknown' {
  const ext = extractExtension(relPath);
  if (ext === null) return 'unknown';
  return ALLOWED_EXTENSIONS.has(ext) ? 'allowed' : 'denied';
}

export function hasAllowedExtension(relPath: string): boolean {
  return classifyExtension(relPath) === 'allowed';
}

export function isFilenameDenylisted(relPath: string): boolean {
  const lastSlash = relPath.lastIndexOf('/');
  const basename = lastSlash === -1 ? relPath : relPath.slice(lastSlash + 1);
  if (FILENAME_DENYLIST.has(basename)) return true;
  return FILENAME_DENYLIST_PATTERNS.some((pattern) => pattern.test(basename));
}

export function hasExcessiveLineLength(
  text: string,
  maxLength = MAX_LINE_LENGTH,
): boolean {
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      if (i - lineStart > maxLength) return true;
      lineStart = i + 1;
    }
  }
  return false;
}
