import { MARKER_RE } from './citation-parser';

export interface ExportProject {
  name: string;
  sourceKind: string;
  sourceRef: string;
  headRevision: string | null;
}

export interface ExportCitation {
  marker: number;
  filePath: string;
  startLine: number;
  endLine: number;
  used: boolean;
}

export interface ExportMessage {
  role: string;
  content: string;
  citations: ExportCitation[];
}

/**
 * A GitHub permalink is only meaningful when there's an actual GitHub remote
 * to point at — `local_path`/`zip_upload` projects' `headRevision` is a
 * content-tree hash, not a commit a browser can resolve against any origin.
 */
export function buildCitationLink(
  project: ExportProject,
  citation: ExportCitation,
): string | null {
  const isGitHub =
    project.sourceKind === 'git_url' || project.sourceKind === 'git_private';
  if (!isGitHub || !project.headRevision) return null;

  const repoUrl = project.sourceRef.replace(/\.git\/?$/, '').replace(/\/$/, '');
  return `${repoUrl}/blob/${project.headRevision}/${citation.filePath}#L${citation.startLine}-L${citation.endLine}`;
}

function replaceMarkers(
  text: string,
  byMarker: Map<number, ExportCitation>,
  linkFor: (citation: ExportCitation) => string | null,
): string {
  return text.replace(
    MARKER_RE,
    (
      whole,
      bracketList: string | undefined,
      singleMarker: string | undefined,
    ) => {
      const markers = bracketList
        ? bracketList.split(',').map((n) => Number(n.trim()))
        : [Number(singleMarker)];

      return markers
        .map((marker) => {
          const citation = byMarker.get(marker);
          if (!citation) return `[${marker}]`;
          const url = linkFor(citation);
          return url ? `[${marker}](${url})` : `[${marker}]`;
        })
        .join(' ');
    },
  );
}

const FENCE_SPLIT_RE = /(```[\s\S]*?```)/g;

/**
 * Replaces `[n]`/`【n】` markers in an answer with markdown links, same
 * fence-skipping as `parseCitations` so a literal `arr[1]` inside a code
 * block in the answer is never mistaken for a citation.
 */
export function renderAnswerMarkdown(
  content: string,
  citations: ExportCitation[],
  linkFor: (citation: ExportCitation) => string | null,
): string {
  const byMarker = new Map(citations.map((c) => [c.marker, c]));

  // Odd-indexed elements from splitting on a capturing group are the fenced
  // blocks themselves — left untouched — even-indexed ones are prose.
  return content
    .split(FENCE_SPLIT_RE)
    .map((part, i) =>
      i % 2 === 1 ? part : replaceMarkers(part, byMarker, linkFor),
    )
    .join('');
}

function buildSourcesLine(
  citations: ExportCitation[],
  linkFor: (citation: ExportCitation) => string | null,
): string | null {
  const cited = citations
    .filter((c) => c.used)
    .sort((a, b) => a.marker - b.marker);
  if (cited.length === 0) return null;

  const parts = cited.map((c) => {
    const label = `[${c.marker}] ${c.filePath}:${c.startLine}-${c.endLine}`;
    const url = linkFor(c);
    return url ? `[${label}](${url})` : label;
  });

  return `**Sources:** ${parts.join(' · ')}`;
}

export function buildConversationMarkdown(input: {
  conversationTitle: string | null;
  project: ExportProject;
  messages: ExportMessage[];
}): string {
  const { conversationTitle, project, messages } = input;
  const linkFor = (citation: ExportCitation) =>
    buildCitationLink(project, citation);

  const lines: string[] = [
    `# ${conversationTitle ?? 'Conversation'}`,
    '',
    `Project: ${project.name}`,
    '',
  ];

  for (const message of messages) {
    if (message.role === 'user') {
      lines.push('## You', '', message.content, '');
      continue;
    }

    lines.push(
      '## Assistant',
      '',
      renderAnswerMarkdown(message.content, message.citations, linkFor),
      '',
    );
    const sourcesLine = buildSourcesLine(message.citations, linkFor);
    if (sourcesLine) lines.push(sourcesLine, '');
  }

  return lines.join('\n');
}
