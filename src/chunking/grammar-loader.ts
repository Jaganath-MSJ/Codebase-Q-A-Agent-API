import { Parser, Language } from 'web-tree-sitter';
import { TreeSitterChunker, GrammarLang } from './tree-sitter.chunker';

const GRAMMAR_WASM: Record<GrammarLang, string> = {
  typescript: '@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm',
  tsx: '@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm',
  javascript: '@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm',
  python: '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm',
};

/** The only I/O in the chunking capability: loading the WASM grammars once at startup. */
export async function createTreeSitterChunker(): Promise<TreeSitterChunker> {
  await Parser.init();

  const entries = await Promise.all(
    (Object.entries(GRAMMAR_WASM) as [GrammarLang, string][]).map(
      async ([lang, moduleSpecifier]) => [lang, await Language.load(require.resolve(moduleSpecifier))] as const,
    ),
  );

  return new TreeSitterChunker(Object.fromEntries(entries));
}
