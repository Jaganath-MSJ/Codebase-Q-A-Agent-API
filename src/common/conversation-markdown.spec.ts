import { describe, expect, it } from 'vitest';
import {
  buildCitationLink,
  buildConversationMarkdown,
  renderAnswerMarkdown,
  type ExportCitation,
  type ExportProject,
} from './conversation-markdown';

const githubProject: ExportProject = {
  name: 'Tiny Repo',
  sourceKind: 'git_url',
  sourceRef: 'https://github.com/octocat/tiny-repo.git',
  headRevision: 'abc123',
};

const localProject: ExportProject = {
  name: 'Local Repo',
  sourceKind: 'local_path',
  sourceRef: 'D:/code/tiny-repo',
  headRevision: 'contenthash456',
};

const citation: ExportCitation = {
  marker: 1,
  filePath: 'src/auth.service.ts',
  startLine: 10,
  endLine: 20,
  used: true,
};

describe('buildCitationLink', () => {
  it('builds a GitHub permalink for a git_url project, stripping a trailing .git', () => {
    expect(buildCitationLink(githubProject, citation)).toBe(
      'https://github.com/octocat/tiny-repo/blob/abc123/src/auth.service.ts#L10-L20',
    );
  });

  it('returns null for a local_path project — headRevision has no resolvable remote', () => {
    expect(buildCitationLink(localProject, citation)).toBeNull();
  });

  it('returns null when headRevision is missing, even for a git_url project', () => {
    expect(
      buildCitationLink({ ...githubProject, headRevision: null }, citation),
    ).toBeNull();
  });
});

describe('renderAnswerMarkdown', () => {
  const citations = [citation];
  const linkFor = (c: ExportCitation) => buildCitationLink(githubProject, c);

  it('replaces a resolvable marker with a markdown link', () => {
    expect(renderAnswerMarkdown('Auth lives in [1].', citations, linkFor)).toBe(
      'Auth lives in [1](https://github.com/octocat/tiny-repo/blob/abc123/src/auth.service.ts#L10-L20).',
    );
  });

  it('leaves an unresolved marker as plain bracket text', () => {
    expect(renderAnswerMarkdown('See [1] and [99].', citations, linkFor)).toBe(
      'See [1](https://github.com/octocat/tiny-repo/blob/abc123/src/auth.service.ts#L10-L20) and [99].',
    );
  });

  it('never links a marker-shaped token inside a fenced code block', () => {
    const content = 'Here:\n```\narr[1] = 2;\n```\nNo real citation.';
    expect(renderAnswerMarkdown(content, citations, linkFor)).toBe(content);
  });

  it('falls back to a plain marker (no link) when the project has no resolvable remote', () => {
    const localLinkFor = (c: ExportCitation) =>
      buildCitationLink(localProject, c);
    expect(
      renderAnswerMarkdown('Auth lives in [1].', citations, localLinkFor),
    ).toBe('Auth lives in [1].');
  });
});

describe('buildConversationMarkdown', () => {
  it('renders a Q&A transcript with a Sources line for cited markers, skipping uncited ones', () => {
    const markdown = buildConversationMarkdown({
      conversationTitle: 'Where is auth handled?',
      project: githubProject,
      messages: [
        { role: 'user', content: 'Where is auth handled?', citations: [] },
        {
          role: 'assistant',
          content: 'Auth lives in [1].',
          citations: [
            citation,
            {
              marker: 2,
              filePath: 'src/unused.ts',
              startLine: 1,
              endLine: 5,
              used: false,
            },
          ],
        },
      ],
    });

    expect(markdown).toBe(
      [
        '# Where is auth handled?',
        '',
        'Project: Tiny Repo',
        '',
        '## You',
        '',
        'Where is auth handled?',
        '',
        '## Assistant',
        '',
        'Auth lives in [1](https://github.com/octocat/tiny-repo/blob/abc123/src/auth.service.ts#L10-L20).',
        '',
        '**Sources:** [[1] src/auth.service.ts:10-20](https://github.com/octocat/tiny-repo/blob/abc123/src/auth.service.ts#L10-L20)',
        '',
      ].join('\n'),
    );
  });

  it('falls back to "Conversation" when the title is null', () => {
    const markdown = buildConversationMarkdown({
      conversationTitle: null,
      project: githubProject,
      messages: [],
    });
    expect(markdown.startsWith('# Conversation\n')).toBe(true);
  });
});
