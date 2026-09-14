import { Parser, Language, Node } from 'web-tree-sitter';
import type { Chunk, Chunker } from './chunker.interface';
import {
  LineWindowChunker,
  TARGET_LINES,
  MIN_CHUNK_LINES,
} from './line-window.chunker';

export type GrammarLang = 'typescript' | 'tsx' | 'javascript' | 'python';

const EXTENSION_TO_GRAMMAR: Record<string, GrammarLang> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
};

interface Region {
  startLine: number;
  endLine: number;
  symbol?: string;
  /**
   * Set on every piece produced by deliberately splitting an oversized node
   * (a class's methods; a function's own line-window sub-chunks) so
   * `mergeTinyAdjacent` never re-merges them — doing so would silently undo
   * the split that made them fit the target size in the first place.
   */
  protected?: boolean;
}

interface TopLevelNode {
  startLine: number;
  endLine: number;
  symbol: string;
  kind: 'class' | 'function';
  node: Node;
}

function isClassNode(type: string, lang: GrammarLang): boolean {
  return lang === 'python'
    ? type === 'class_definition'
    : type === 'class_declaration';
}

function isFunctionNode(type: string, lang: GrammarLang): boolean {
  return lang === 'python'
    ? type === 'function_definition'
    : type === 'function_declaration';
}

/** `export const helper = (a, b) => {...}` / `const helper = function (a, b) {...}`. */
function isArrowConstCandidate(node: Node, lang: GrammarLang): boolean {
  if (lang === 'python') return false;
  if (
    node.type !== 'lexical_declaration' &&
    node.type !== 'variable_declaration'
  )
    return false;
  if (node.namedChildCount !== 1) return false;
  const value = node.namedChild(0)?.childForFieldName('value');
  return (
    value?.type === 'arrow_function' || value?.type === 'function_expression'
  );
}

function nodeRange(node: Node): { startLine: number; endLine: number } {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function findTopLevelStructuralNodes(
  root: Node,
  lang: GrammarLang,
): TopLevelNode[] {
  const results: TopLevelNode[] = [];

  for (const topNode of root.namedChildren) {
    if (!topNode) continue;
    const inner =
      topNode.type === 'export_statement'
        ? (topNode.childForFieldName('declaration') ?? topNode)
        : topNode;
    const { startLine, endLine } = nodeRange(topNode);

    if (isClassNode(inner.type, lang)) {
      const name = inner.childForFieldName('name')?.text;
      if (name)
        results.push({
          startLine,
          endLine,
          symbol: name,
          kind: 'class',
          node: inner,
        });
      continue;
    }
    if (isFunctionNode(inner.type, lang)) {
      const name = inner.childForFieldName('name')?.text;
      if (name)
        results.push({
          startLine,
          endLine,
          symbol: name,
          kind: 'function',
          node: inner,
        });
      continue;
    }
    if (isArrowConstCandidate(inner, lang)) {
      const name = inner.namedChild(0)?.childForFieldName('name')?.text;
      if (name)
        results.push({
          startLine,
          endLine,
          symbol: name,
          kind: 'function',
          node: inner,
        });
    }
  }

  return results;
}

/** Direct method-shaped children of a class body, in source order. */
function collectMethods(
  classNode: Node,
  className: string,
  lang: GrammarLang,
): Region[] {
  const body = classNode.childForFieldName('body');
  if (!body) return [];

  const wantedType =
    lang === 'python' ? 'function_definition' : 'method_definition';
  const methods: Region[] = [];

  // Python's class body is a `block` one level below the class_definition's
  // `body` field; JS/TS's `class_body` holds method_definition directly.
  const container = lang === 'python' ? (body.namedChild(0) ?? body) : body;

  for (const child of container.namedChildren) {
    if (!child || child.type !== wantedType) continue;
    const name = child.childForFieldName('name')?.text;
    if (!name) continue;
    const { startLine, endLine } = nodeRange(child);
    methods.push({ startLine, endLine, symbol: `${className}.${name}` });
  }

  return methods;
}

/**
 * Splits a region into line-window sub-chunks when it exceeds the target
 * size, else returns it unchanged. `forceProtected` marks even an
 * already-small region as protected — used for a class's methods, each of
 * which is a deliberately separated unit regardless of its own size.
 */
function splitIfOversized(
  lines: string[],
  region: Region,
  forceProtected = false,
): Region[] {
  const size = region.endLine - region.startLine + 1;
  if (size <= 0) return [];
  if (size <= TARGET_LINES)
    return [{ ...region, protected: forceProtected || region.protected }];

  const subLines = lines.slice(region.startLine - 1, region.endLine);
  return new LineWindowChunker().chunk(subLines).map((c) => ({
    startLine: c.startLine + region.startLine - 1,
    endLine: c.endLine + region.startLine - 1,
    symbol: region.symbol,
    protected: true,
  }));
}

/**
 * Fills the gaps before, between, and after `subRegions` within
 * [regionStart, regionEnd] with line-window-chunked "context" regions, and
 * splits any region (structural or gap) that's still oversized. `subRegions`
 * must be sorted and non-overlapping, which every caller here guarantees by
 * construction (they come directly from a single AST child-list walk).
 */
function regionize(
  lines: string[],
  regionStart: number,
  regionEnd: number,
  subRegions: Region[],
  gapSymbol: string | undefined,
  protectSubRegions = false,
): Region[] {
  const result: Region[] = [];
  let cursor = regionStart;

  for (const sub of subRegions) {
    if (sub.startLine > cursor) {
      result.push(
        ...splitIfOversized(lines, {
          startLine: cursor,
          endLine: sub.startLine - 1,
          symbol: gapSymbol,
        }),
      );
    }
    result.push(...splitIfOversized(lines, sub, protectSubRegions));
    cursor = sub.endLine + 1;
  }

  if (cursor <= regionEnd) {
    result.push(
      ...splitIfOversized(lines, {
        startLine: cursor,
        endLine: regionEnd,
        symbol: gapSymbol,
      }),
    );
  }

  return result;
}

function expandClass(
  lines: string[],
  classNode: Node,
  className: string,
  lang: GrammarLang,
): Region[] {
  const { startLine, endLine } = nodeRange(classNode);
  const size = endLine - startLine + 1;
  if (size <= TARGET_LINES) return [{ startLine, endLine, symbol: className }];

  const methods = collectMethods(classNode, className, lang);
  return regionize(lines, startLine, endLine, methods, className, true);
}

/**
 * Merges adjacent regions when at least one side is under MIN_CHUNK_LINES
 * and the combination still fits within TARGET_LINES — a lone tiny gap
 * (a handful of import lines, a blank-line-separated one-liner) shouldn't
 * become its own chunk when folding it into its neighbor is free.
 *
 * Never merges a `protected` region: those are pieces of a class or
 * function that were deliberately split because the whole didn't fit the
 * target size, and re-merging them (even just two of several) would
 * silently walk that split back.
 */
function mergeTinyAdjacent(regions: Region[]): Region[] {
  if (regions.length === 0) return [];

  const merged: Region[] = [regions[0]!];
  for (let i = 1; i < regions.length; i++) {
    const prev = merged[merged.length - 1]!;
    const curr = regions[i]!;
    const contiguous = curr.startLine === prev.endLine + 1;
    const prevSize = prev.endLine - prev.startLine + 1;
    const currSize = curr.endLine - curr.startLine + 1;
    const combinedSize = curr.endLine - prev.startLine + 1;
    const eligible = !prev.protected && !curr.protected;

    if (
      eligible &&
      contiguous &&
      (prevSize < MIN_CHUNK_LINES || currSize < MIN_CHUNK_LINES) &&
      combinedSize <= TARGET_LINES
    ) {
      merged[merged.length - 1] = {
        startLine: prev.startLine,
        endLine: curr.endLine,
        symbol:
          [prev.symbol, curr.symbol].filter(Boolean).join(', ') || undefined,
      };
    } else {
      merged.push(curr);
    }
  }

  return merged;
}

/**
 * Structural chunking via tree-sitter: chunks at function/class/method
 * boundaries, splits an oversized node at its own natural sub-boundaries
 * (a class's methods; anything else via the line-window heuristic on just
 * that node's range), merges tiny adjacent chunks, and fills the gaps
 * (imports, top-level statements) with line-window chunks. Falls back to
 * pure line-window chunking for any file whose language has no loaded
 * grammar — this is why LineWindowChunker is still exported and tested on
 * its own.
 */
export class TreeSitterChunker implements Chunker {
  private readonly parser = new Parser();
  private readonly fallback = new LineWindowChunker();

  constructor(
    private readonly languages: Partial<Record<GrammarLang, Language>>,
  ) {}

  chunk(lines: string[], lang?: string | null): Chunk[] {
    const grammarLang: GrammarLang | undefined = lang
      ? EXTENSION_TO_GRAMMAR[lang.toLowerCase()]
      : undefined;
    if (!grammarLang || lines.length === 0) return this.fallback.chunk(lines);

    const language = this.languages[grammarLang];
    if (!language) return this.fallback.chunk(lines);

    this.parser.setLanguage(language);
    const tree = this.parser.parse(lines.join('\n'));
    if (!tree) return this.fallback.chunk(lines);

    const topLevel = findTopLevelStructuralNodes(tree.rootNode, grammarLang);
    const subRegions = topLevel.flatMap((n) =>
      n.kind === 'class'
        ? expandClass(lines, n.node, n.symbol, grammarLang)
        : splitIfOversized(lines, {
            startLine: n.startLine,
            endLine: n.endLine,
            symbol: n.symbol,
          }),
    );

    const regions = mergeTinyAdjacent(
      regionize(lines, 1, lines.length, subRegions, undefined),
    );

    return regions.map((r, ord) => ({
      ord,
      startLine: r.startLine,
      endLine: r.endLine,
      symbol: r.symbol,
      content: lines.slice(r.startLine - 1, r.endLine).join('\n'),
    }));
  }
}
