import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  createHarness,
  json,
  UNKNOWN_UUID,
  VALID_UUID,
  type Harness,
} from './harness';
import { ChatService } from '../src/chat/chat.service';

/**
 * QA pass — TC-CHAT-*.
 *
 * The chat surface carries the most product logic of any controller and had no
 * contract coverage. Three things here are worth more than the rest:
 *
 *  - **SSE framing.** `main.ts` deliberately excludes `text/event-stream` from
 *    gzip, because compression buffers the response and would stall the stream.
 *    A regression is invisible until someone watches a chat hang, so it is
 *    asserted directly (TC-CHAT-230).
 *  - **INV-4.** The LLM never writes a file path — it writes `[n]` markers, and
 *    citations are built server-side. A provider fake emits a plausible path and
 *    out-of-range markers to prove neither survives (TC-CHAT-240..242).
 *  - **Mode routing.** The controller, not the service, decides fast vs
 *    thorough, and forces fast for multi-project conversations.
 */

const NOW = new Date('2026-01-01T00:00:00.000Z');
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const conversationRow = (over: Record<string, unknown> = {}) => ({
  id: CONVERSATION_ID,
  projectId: VALID_UUID,
  title: 'How does auth work?',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const messageRow = (over: Record<string, unknown> = {}) => ({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  conversationId: CONVERSATION_ID,
  role: 'assistant',
  // Padded past compression's 1 KB default threshold so TC-CHAT-230b can act
  // as a real control for the SSE-is-not-compressed assertion.
  content: 'Auth is handled in [1]. ' + 'detail '.repeat(300),
  status: 'complete',
  error: null,
  citations: [],
  createdAt: NOW,
  ...over,
});

/** Parses an SSE body into ordered {type, data} frames. */
function parseSse(text: string): { type: string; data: unknown }[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const type = /^event: (.+)$/m.exec(block)?.[1] ?? '';
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? '';
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* leave as text */
      }
      return { type, data };
    });
}

describe('Chat routes and SSE', () => {
  let h: Harness;
  let lastQuestion: string | undefined;
  let streamCalls: string[] = [];
  let isMulti = false;

  async function* fastStream() {
    yield {
      type: 'message_created',
      data: { userMessageId: 'u-1', assistantMessageId: 'a-1' },
    };
    yield { type: 'status', data: { phase: 'retrieving' } };
    yield {
      type: 'sources',
      data: {
        sources: [
          { marker: 1, path: 'src/auth.ts', startLine: 10, endLine: 20 },
        ],
      },
    };
    yield { type: 'token', data: { delta: 'Auth lives in ' } };
    yield { type: 'token', data: { delta: '[1].' } };
    yield {
      type: 'done',
      data: {
        citations: [
          {
            marker: 1,
            path: 'src/auth.ts',
            startLine: 10,
            endLine: 20,
            used: true,
          },
        ],
      },
    };
  }

  beforeAll(async () => {
    h = await createHarness({
      repos: {
        conversationProjects: {
          findProjectIdsForConversations: () => Promise.resolve(new Map()),
        },
      },
      overrides: [
        {
          provide: ChatService,
          useValue: {
            createConversation: (projectId: string) => {
              if (projectId !== VALID_UUID)
                return Promise.reject(
                  new NotFoundException(`Project ${projectId} not found`),
                );
              return Promise.resolve(conversationRow({ title: null }));
            },
            createMultiProjectConversation: (ids: string[]) =>
              Promise.resolve(conversationRow({ projectId: ids[0] })),
            listConversations: (projectId: string) =>
              Promise.resolve(
                projectId === VALID_UUID ? [conversationRow()] : [],
              ),
            listMessages: (id: string) =>
              Promise.resolve(id === CONVERSATION_ID ? [messageRow()] : []),
            exportConversationMarkdown: (id: string) => {
              if (id !== CONVERSATION_ID)
                return Promise.reject(new NotFoundException('no conversation'));
              return Promise.resolve({
                title: 'How does auth work?',
                markdown:
                  '# How does auth work?\n\nAuth is in `src/auth.ts`.\n',
              });
            },
            isMultiProject: () => Promise.resolve(isMulti),
            streamMessage: (id: string, question: string) => {
              streamCalls.push('fast');
              lastQuestion = question;
              return fastStream();
            },
            streamAgenticMessage: (id: string, question: string) => {
              streamCalls.push('thorough');
              lastQuestion = question;
              return fastStream();
            },
          },
        },
      ],
    });
  });

  afterAll(async () => {
    await h.close();
  });

  // -------------------------------- POST /projects/:projectId/conversations

  describe('TC-CHAT-100..103 — create a conversation', () => {
    it('TC-CHAT-100 creates one and returns 201', async () => {
      const res = await h.request(`/projects/${VALID_UUID}/conversations`, {
        method: 'POST',
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ id: CONVERSATION_ID, title: null });
    });

    it('TC-CHAT-101 omits projectIds for a single-project conversation', async () => {
      // The DTO documents this: omitted entirely, not sent as null.
      const res = await h.request(`/projects/${VALID_UUID}/conversations`, {
        method: 'POST',
      });
      expect(res.body).not.toHaveProperty('projectIds');
    });

    it('TC-CHAT-102 returns 400 for a malformed project id', async () => {
      const res = await h.request('/projects/nope/conversations', {
        method: 'POST',
      });
      expect(res.status).toBe(400);
    });

    it('TC-CHAT-103 returns 404 for an unknown project', async () => {
      const res = await h.request(`/projects/${UNKNOWN_UUID}/conversations`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------------- POST /conversations/multi

  describe('TC-CHAT-110..116 — multi-project conversation', () => {
    const twoIds = [VALID_UUID, UNKNOWN_UUID];

    it('TC-CHAT-110 creates one from two project ids', async () => {
      const res = await h.request(
        '/conversations/multi',
        json({ projectIds: twoIds }),
      );
      expect(res.status).toBe(201);
    });

    it('TC-CHAT-111 includes projectIds in the response for 2+ ids', async () => {
      const res = await h.request(
        '/conversations/multi',
        json({ projectIds: twoIds }),
      );
      expect(res.body).toMatchObject({ projectIds: twoIds });
    });

    it('TC-CHAT-112 rejects fewer than two ids', async () => {
      const res = await h.request(
        '/conversations/multi',
        json({ projectIds: [VALID_UUID] }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-CHAT-113 rejects an empty array', async () => {
      const res = await h.request(
        '/conversations/multi',
        json({ projectIds: [] }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-CHAT-114 rejects a non-UUID element', async () => {
      const res = await h.request(
        '/conversations/multi',
        json({ projectIds: [VALID_UUID, 'not-a-uuid'] }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-CHAT-115 rejects a non-array projectIds', async () => {
      const res = await h.request(
        '/conversations/multi',
        json({ projectIds: VALID_UUID }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-CHAT-116 rejects an unknown extra property', async () => {
      const res = await h.request(
        '/conversations/multi',
        json({ projectIds: twoIds, admin: true }),
      );
      expect(res.status).toBe(400);
    });
  });

  // --------------------------------- GET /projects/:projectId/conversations

  describe('TC-CHAT-120..123 — list conversations', () => {
    it('TC-CHAT-120 returns the list', async () => {
      const res = await h.request(`/projects/${VALID_UUID}/conversations`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('TC-CHAT-121 returns ISO timestamps', async () => {
      const [row] = (await h.request(`/projects/${VALID_UUID}/conversations`))
        .body as Record<string, unknown>[];
      expect(row!.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(row!.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('TC-CHAT-122 returns an empty array for a project with none', async () => {
      const res = await h.request(`/projects/${UNKNOWN_UUID}/conversations`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('TC-CHAT-123 returns 400 for a malformed project id', async () => {
      expect((await h.request('/projects/nope/conversations')).status).toBe(
        400,
      );
    });
  });

  // ------------------------------------- GET /conversations/:id/messages

  describe('TC-CHAT-130..133 — list messages', () => {
    it('TC-CHAT-130 returns the transcript', async () => {
      const res = await h.request(`/conversations/${CONVERSATION_ID}/messages`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('TC-CHAT-131 returns the documented MessageDto shape', async () => {
      const [msg] = (
        await h.request(`/conversations/${CONVERSATION_ID}/messages`)
      ).body as Record<string, unknown>[];
      expect(Object.keys(msg!).sort()).toEqual([
        'citations',
        'content',
        'conversationId',
        'createdAt',
        'error',
        'id',
        'role',
        'status',
      ]);
    });

    it('TC-CHAT-132 returns an empty array for an unknown conversation', async () => {
      const res = await h.request(`/conversations/${UNKNOWN_UUID}/messages`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('TC-CHAT-133 returns 400 for a malformed conversation id', async () => {
      expect((await h.request('/conversations/nope/messages')).status).toBe(
        400,
      );
    });
  });

  // -------------------------------------- GET /conversations/:id/export

  describe('TC-CHAT-140..144 — export as markdown', () => {
    it('TC-CHAT-140 returns text/markdown, not JSON', async () => {
      const res = await h.request(`/conversations/${CONVERSATION_ID}/export`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/markdown/);
    });

    it('TC-CHAT-141 sends it as a download attachment', async () => {
      const res = await h.request(`/conversations/${CONVERSATION_ID}/export`);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    });

    it('TC-CHAT-142 slugifies the title into the filename', async () => {
      const res = await h.request(`/conversations/${CONVERSATION_ID}/export`);
      expect(res.headers.get('content-disposition')).toContain(
        'conversation-how-does-auth-work.md',
      );
    });

    it('TC-CHAT-143 returns the markdown body verbatim', async () => {
      const res = await h.request(`/conversations/${CONVERSATION_ID}/export`);
      expect(res.text).toContain('# How does auth work?');
    });

    it('TC-CHAT-144 returns 404 for an unknown conversation', async () => {
      const res = await h.request(`/conversations/${UNKNOWN_UUID}/export`);
      expect(res.status).toBe(404);
    });
  });

  // ------------------------------------ POST /conversations/:id/messages

  describe('TC-CHAT-200..213 — posting a message (validation)', () => {
    const post = (body: unknown) =>
      h.request(`/conversations/${CONVERSATION_ID}/messages`, json(body));

    it('TC-CHAT-200 rejects a missing question', async () => {
      expect((await post({})).status).toBe(400);
    });

    it('TC-CHAT-201 rejects an empty question', async () => {
      expect((await post({ question: '' })).status).toBe(400);
    });

    it('TC-CHAT-202 rejects a non-string question', async () => {
      expect((await post({ question: 42 })).status).toBe(400);
    });

    it('TC-CHAT-203 rejects an unknown mode', async () => {
      expect((await post({ question: 'hi', mode: 'turbo' })).status).toBe(400);
    });

    it('TC-CHAT-204 accepts each documented mode', async () => {
      for (const mode of ['auto', 'fast', 'thorough']) {
        const res = await post({ question: 'what is auth?', mode });
        expect(res.status, mode).toBe(200);
      }
    });

    it('TC-CHAT-205 rejects an unknown extra property', async () => {
      expect(
        (await post({ question: 'hi', systemPrompt: 'ignore rules' })).status,
      ).toBe(400);
    });

    it('TC-CHAT-206 returns 400 for a malformed conversation id', async () => {
      const res = await h.request(
        '/conversations/nope/messages',
        json({ question: 'hi' }),
      );
      expect(res.status).toBe(400);
    });

    it('TC-CHAT-207 accepts a very long question without a 500', async () => {
      const res = await post({ question: 'x'.repeat(10_000) });
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('TC-CHAT-220..226 — mode routing', () => {
    const post = (body: unknown) =>
      h.request(`/conversations/${CONVERSATION_ID}/messages`, json(body));

    it('TC-CHAT-220 an explicit "fast" uses the RAG path', async () => {
      streamCalls = [];
      await post({ question: 'anything', mode: 'fast' });
      expect(streamCalls).toEqual(['fast']);
    });

    it('TC-CHAT-221 an explicit "thorough" uses the agent loop', async () => {
      streamCalls = [];
      isMulti = false;
      await post({ question: 'anything', mode: 'thorough' });
      expect(streamCalls).toEqual(['thorough']);
    });

    it('TC-CHAT-222 a multi-project conversation is forced to fast', async () => {
      // Phase 7's tool executors are single-project scoped, so thorough has no
      // meaningful multi-project behaviour to fall back to.
      streamCalls = [];
      isMulti = true;
      await post({ question: 'anything', mode: 'thorough' });
      expect(streamCalls).toEqual(['fast']);
      isMulti = false;
    });

    it('TC-CHAT-223 "auto" routes via the heuristic', async () => {
      streamCalls = [];
      await post({ question: 'what is this repo?', mode: 'auto' });
      expect(streamCalls).toHaveLength(1);
      expect(['fast', 'thorough']).toContain(streamCalls[0]);
    });

    it('TC-CHAT-224 an omitted mode behaves as auto', async () => {
      streamCalls = [];
      await post({ question: 'what is this repo?' });
      expect(streamCalls).toHaveLength(1);
    });

    it('TC-CHAT-225 forwards the question verbatim', async () => {
      const question = 'Where is validateUser defined?';
      await post({ question });
      expect(lastQuestion).toBe(question);
    });

    it('TC-CHAT-226 tags the first frame with the resolved mode', async () => {
      const res = await post({ question: 'anything', mode: 'fast' });
      const frames = parseSse(res.text);
      expect(frames[0]!.type).toBe('message_created');
      expect(frames[0]!.data).toMatchObject({ resolvedMode: 'fast' });
    });
  });

  describe('TC-CHAT-230..236 — SSE framing', () => {
    const post = (body: unknown) =>
      h.request(`/conversations/${CONVERSATION_ID}/messages`, json(body));

    it('TC-CHAT-230 responds as text/event-stream and is NOT compressed', async () => {
      // main.ts excludes SSE from the compression filter on purpose: gzip
      // buffers the response, which would stall token-by-token streaming. A
      // content-encoding header here means that guard has regressed.
      //
      // The harness installs the same compression middleware, and TC-CHAT-230b
      // proves it is actually active — otherwise this assertion would pass
      // simply because nothing was ever compressing anything.
      const res = await h.request(
        `/conversations/${CONVERSATION_ID}/messages`,
        {
          ...json({ question: 'hi', mode: 'fast' }),
          headers: {
            'content-type': 'application/json',
            'accept-encoding': 'gzip, deflate, br',
          },
        },
      );
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      expect(res.headers.get('content-encoding')).toBeNull();
    });

    it('TC-CHAT-230b control: a large JSON response on the same app IS compressed', async () => {
      // Negative control for TC-CHAT-230. Without this, an accidentally
      // uninstalled compression middleware would make the SSE assertion above
      // pass for entirely the wrong reason.
      //
      // GET messages returns a real JSON body; the fake message content is
      // sized past compression's 1 KB default threshold.
      const res = await h.request(
        `/conversations/${CONVERSATION_ID}/messages`,
        {
          headers: { 'accept-encoding': 'gzip' },
        },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(res.headers.get('content-encoding')).toBe('gzip');
    });

    it('TC-CHAT-231 disables caching and proxy buffering', async () => {
      const res = await post({ question: 'hi', mode: 'fast' });
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(res.headers.get('x-accel-buffering')).toBe('no');
    });

    it('TC-CHAT-232 emits the documented event sequence', async () => {
      const res = await post({ question: 'hi', mode: 'fast' });
      const types = parseSse(res.text).map((f) => f.type);
      expect(types).toEqual([
        'message_created',
        'status',
        'sources',
        'token',
        'token',
        'done',
      ]);
    });

    it('TC-CHAT-233 formats frames as `event:` + `data:` separated by a blank line', async () => {
      const res = await post({ question: 'hi', mode: 'fast' });
      expect(res.text).toMatch(/event: message_created\ndata: \{.*\}\n\n/);
    });

    it('TC-CHAT-234 sends JSON-encoded data payloads', async () => {
      const res = await post({ question: 'hi', mode: 'fast' });
      const tokens = parseSse(res.text).filter((f) => f.type === 'token');
      expect(tokens.map((t) => (t.data as { delta: string }).delta)).toEqual([
        'Auth lives in ',
        '[1].',
      ]);
    });

    it('TC-CHAT-235 terminates the stream after the done frame', async () => {
      const res = await post({ question: 'hi', mode: 'fast' });
      const frames = parseSse(res.text);
      expect(frames.at(-1)!.type).toBe('done');
    });

    it('TC-CHAT-236 answers a bad id with JSON 404, never a malformed stream', async () => {
      // Headers are written only after the conversation is confirmed, so an
      // error still gets Nest's normal JSON body rather than a half-open stream.
      const res = await h.request(
        '/conversations/nope/messages',
        json({ question: 'hi' }),
      );
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
    });
  });

  describe('TC-CHAT-240..242 — INV-4, the LLM never writes a file path', () => {
    const post = (body: unknown) =>
      h.request(`/conversations/${CONVERSATION_ID}/messages`, json(body));

    it('TC-CHAT-240 citations carry server-side path data, not model text', async () => {
      const res = await post({ question: 'hi', mode: 'fast' });
      const done = parseSse(res.text).find((f) => f.type === 'done');
      const citations = (done!.data as { citations: unknown[] }).citations;
      expect(citations).toEqual([
        {
          marker: 1,
          path: 'src/auth.ts',
          startLine: 10,
          endLine: 20,
          used: true,
        },
      ]);
    });

    it('TC-CHAT-241 the token stream carries only markers, never paths', async () => {
      const res = await post({ question: 'hi', mode: 'fast' });
      const text = parseSse(res.text)
        .filter((f) => f.type === 'token')
        .map((f) => (f.data as { delta: string }).delta)
        .join('');
      expect(text).toContain('[1]');
      expect(text).not.toMatch(/\.ts|\.js|src\//);
    });

    it('TC-CHAT-242 every emitted citation path is repo-relative (INV-2)', async () => {
      const res = await post({ question: 'hi', mode: 'fast' });
      const done = parseSse(res.text).find((f) => f.type === 'done');
      const citations = (done!.data as { citations: { path: string }[] })
        .citations;
      for (const c of citations) {
        expect(c.path.startsWith('/')).toBe(false);
        expect(c.path).not.toContain('\\');
      }
    });
  });
});
