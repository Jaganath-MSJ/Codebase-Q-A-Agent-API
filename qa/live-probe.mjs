#!/usr/bin/env node
/**
 * QA — the live black-box prober.  `npm run qa:live`
 *
 * Drives the **running** API the way a hostile client would: malformed bodies,
 * traversal attempts, wrong types, absent resources, duplicate query params,
 * concurrent writes. It exists because the vitest suites, by construction,
 * cannot find this class of defect — the L2 harness fakes the database and
 * stubs whole services, so a bug living inside `ProjectsService.getFile` or in
 * the real `fs`/Postgres interaction is invisible to it. Four of QA round 2's
 * nine defects were found here first.
 *
 * Safety rules this script keeps, and you must keep if you extend it:
 *   - It creates only projects named `qa-probe-*` and deletes every one it
 *     created, even on failure.
 *   - It never deletes, indexes, or posts messages to a project it did not
 *     create, and never writes to `.env` or `api/data/`.
 *   - It never asserts against a specific project of yours; it discovers a
 *     ready project to read from and treats "none available" as a skip.
 *   - The chat probes stop at validation (400s). Nothing here spends a real
 *     LLM call, so it is safe to run repeatedly against a free tier.
 *
 * Exit code is the number of failing probes, capped at 125, so it can gate a
 * script. `--verbose` prints every response body.
 *
 * Usage:
 *   npm run qa:live                    # against http://localhost:3000
 *   QA_BASE=http://host:3000/api npm run qa:live
 */

const BASE = process.env.QA_BASE ?? 'http://localhost:3000/api';
const VERBOSE = process.argv.includes('--verbose');
const NIL_UUID = '00000000-0000-4000-8000-000000000000';

const results = [];
const createdProjectIds = new Set();

async function req(method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (raw) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return {
    status: res.status,
    body: parsed,
    text,
    headers: Object.fromEntries(res.headers),
  };
}

/**
 * `expected` is a status code, an array of acceptable codes, or a predicate
 * over the whole response. A predicate is the right tool whenever "which code"
 * matters less than "what came back" — e.g. proving no traversal leaked.
 */
async function probe(id, description, expected, run) {
  let out;
  try {
    out = await run();
  } catch (error) {
    out = { status: 'THREW', body: String(error?.message ?? error) };
  }
  const pass =
    typeof expected === 'function'
      ? Boolean(expected(out))
      : Array.isArray(expected)
        ? expected.includes(out.status)
        : out.status === expected;
  results.push({ id, description, expected, got: out.status, pass, body: out.body });
  return out;
}

/** Remembers every project this run creates so `cleanup` can remove them. */
async function createProbeProject(body) {
  const res = await req('POST', '/projects', { body });
  if (res.status === 201 && res.body?.id) createdProjectIds.add(res.body.id);
  return res;
}

async function cleanup() {
  for (const id of createdProjectIds) {
    try {
      await req('DELETE', `/projects/${id}`);
    } catch {
      console.error(`  ! could not delete probe project ${id} — remove it by hand`);
    }
  }
}

// ---------------------------------------------------------------- the probes

async function probeProjects(fixtureDir) {
  const name = () => `qa-probe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  await probe('LP-001', 'POST /projects rejects an empty body', 400, () => req('POST', '/projects', { body: {} }));
  await probe('LP-002', 'POST /projects rejects a missing name', 400, () =>
    req('POST', '/projects', { body: { sourceKind: 'local_path', sourceRef: fixtureDir } }));
  await probe('LP-003', 'POST /projects rejects an empty name', 400, () =>
    req('POST', '/projects', { body: { name: '', sourceKind: 'local_path', sourceRef: fixtureDir } }));
  await probe('LP-004', 'POST /projects rejects an unknown sourceKind', 400, () =>
    req('POST', '/projects', { body: { name: name(), sourceKind: 'ftp', sourceRef: fixtureDir } }));
  await probe('LP-005', 'POST /projects rejects an unknown extra property', 400, () =>
    req('POST', '/projects', { body: { name: name(), sourceKind: 'local_path', sourceRef: fixtureDir, isAdmin: true } }));
  await probe('LP-006', 'POST /projects rejects malformed JSON', 400, () =>
    req('POST', '/projects', { body: '{"name":', raw: true, headers: { 'content-type': 'application/json' } }));
  await probe('LP-007', 'POST /projects rejects a non-string name', 400, () =>
    req('POST', '/projects', { body: { name: 42, sourceKind: 'local_path', sourceRef: fixtureDir } }));
  await probe('LP-008', 'POST /projects rejects git_private without a token', 400, () =>
    req('POST', '/projects', { body: { name: name(), sourceKind: 'git_private', sourceRef: 'https://github.com/octocat/Hello-World.git' } }));
  await probe('LP-009', 'POST /projects rejects a bogus zip_upload ref', 400, () =>
    req('POST', '/projects', { body: { name: name(), sourceKind: 'zip_upload', sourceRef: '../../etc/passwd' } }));

  // DEF-019 / DEF-018 — these SHOULD be 400s and are not. Kept as probes rather
  // than removed, so the day they start returning 400 this script says so.
  await probe('LP-010', '[DEF-019] whitespace-only name is accepted', 201, () =>
    createProbeProject({ name: '   ', sourceKind: 'local_path', sourceRef: fixtureDir }));
  await probe('LP-011', '[DEF-019] a 10,000-character name is accepted', 201, () =>
    createProbeProject({ name: 'a'.repeat(10_000), sourceKind: 'local_path', sourceRef: fixtureDir }));
  await probe('LP-012', '[DEF-018] a relative local_path is accepted', 201, () =>
    createProbeProject({ name: name(), sourceKind: 'local_path', sourceRef: './fixtures/tiny-repo' }));
  await probe('LP-013', '[DEF-018] a nonexistent local_path is accepted', 201, () =>
    createProbeProject({ name: name(), sourceKind: 'local_path', sourceRef: '/definitely/not/here/xyz' }));

  await probe('LP-020', 'a unicode project name round-trips intact', (r) =>
    r.status === 200 && r.body.some((p) => p.name === 'qa-probe 🔬 проверка 中文'), async () => {
    await createProbeProject({ name: 'qa-probe 🔬 проверка 中文', sourceKind: 'local_path', sourceRef: fixtureDir });
    return req('GET', '/projects');
  });
  await probe('LP-021', 'GET /projects never leaks an absolute host path', (r) =>
    r.status === 200 && !/"(sourceRef|workspacePath)"/.test(r.text), () => req('GET', '/projects'));
  await probe('LP-022', 'DELETE of an unknown project is 404', 404, () => req('DELETE', `/projects/${NIL_UUID}`));
  await probe('LP-023', 'an unknown route is 404, not a 500', 404, () => req('GET', '/does-not-exist'));
}

async function probeFileRoute(projectId) {
  const NUL = String.fromCharCode(0);
  const qs = (params) => Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const file = (params) => req('GET', `/projects/${projectId}/file?${qs(params)}`);
  /**
   * A traversal attempt is only safe if it was refused AND nothing from outside
   * the repo came back. Checking the status alone would pass a 200 that quietly
   * served `/etc/passwd`; checking the body alone would pass a 200 that served
   * some other file it also should not have.
   */
  const refusedWithoutLeaking = (r) =>
    [400, 403, 404].includes(r.status) && !/root:x:0:0|BEGIN .* PRIVATE KEY/.test(r.text);

  const traversals = [
    ['../../../../etc/passwd', 'plain traversal'],
    ['..\\..\\..\\..\\etc\\passwd', 'backslash traversal'],
    ['%2e%2e%2f%2e%2e%2fetc%2fpasswd', 'pre-encoded traversal'],
    ['....//....//etc/passwd', 'doubled-dot bypass'],
    ['/etc/passwd', 'absolute path'],
    ['src/../../../../etc/passwd', 'traversal after a valid prefix'],
    ['~/.ssh/id_rsa', 'tilde expansion'],
  ];
  for (const [index, [path, label]] of traversals.entries()) {
    await probe(`LP-1${String(index + 1).padStart(2, '0')}`, `GET /file rejects ${label}`, refusedWithoutLeaking, () =>
      file({ path, startLine: 1, endLine: 5 }));
  }

  await probe('LP-120', 'GET /file rejects a missing path param', 400, () => file({ startLine: 1, endLine: 5 }));
  await probe('LP-121', 'GET /file rejects startLine 0', 400, () => file({ path: 'README.md', startLine: 0, endLine: 5 }));
  await probe('LP-122', 'GET /file rejects a non-numeric startLine', 400, () => file({ path: 'README.md', startLine: 'abc', endLine: 5 }));
  await probe('LP-123', 'GET /file rejects a fractional startLine', 400, () => file({ path: 'README.md', startLine: 1.5, endLine: 5 }));
  await probe('LP-124', 'GET /file 404s a file that is not on disk', 404, () => file({ path: 'no/such/file.ts', startLine: 1, endLine: 3 }));

  // The two DEF-016 probes below expect a 500 *on purpose*: they assert the
  // defect, so that fixing it turns them red and forces the update here and in
  // DEFECTS.md together. `api/src` and the NUL path are chosen because both
  // exist under every project root this script might be pointed at.
  await probe('LP-125', '[DEF-016] a directory path 500s instead of 404ing', 500, () => file({ path: 'api/src', startLine: 1, endLine: 3 }));
  await probe('LP-126', '[DEF-016] a NUL byte in the path 500s instead of 400ing', 500, () =>
    file({ path: `README.md${NUL}.png`, startLine: 1, endLine: 3 }));
  await probe('LP-127', 'a duplicate path param cannot smuggle a traversal', refusedWithoutLeaking, () =>
    req('GET', `/projects/${projectId}/file?path=README.md&path=../../../etc/passwd&startLine=1&endLine=3`));
}

async function probeCaching(projectId) {
  const url = `/projects/${projectId}/file?path=README.md&startLine=1&endLine=5`;
  const first = await probe('LP-130', 'GET /file returns 200 with a strong ETag', (r) => r.status === 200 && Boolean(r.headers.etag), () => req('GET', url));
  const etag = first.headers?.etag;
  if (etag) {
    await probe('LP-131', 'a matching If-None-Match returns 304', 304, () => req('GET', url, { headers: { 'if-none-match': etag } }));
    await probe('LP-132', 'a stale If-None-Match returns 200', 200, () => req('GET', url, { headers: { 'if-none-match': '"stale"' } }));
  }
}

async function probeSearch(projectId) {
  const search = (body) => req('POST', '/search', { body: { mode: 'hybrid', ...body } });

  await probe('LP-200', 'POST /search rejects an empty query', 400, () => search({ projectId, query: '' }));
  await probe('LP-201', 'POST /search rejects a missing projectId', 400, () => search({ query: 'auth' }));
  await probe('LP-202', 'POST /search 404s an unknown projectId', 404, () => search({ projectId: NIL_UUID, query: 'auth' }));
  await probe('LP-203', 'POST /search rejects an unknown mode', 400, () => search({ projectId, query: 'auth', mode: 'telepathy' }));
  await probe('LP-204', 'POST /search rejects k = 0', 400, () => search({ projectId, query: 'auth', k: 0 }));
  await probe('LP-205', 'POST /search rejects a negative k', 400, () => search({ projectId, query: 'auth', k: -1 }));
  await probe('LP-206', 'POST /search rejects an absurd k', 400, () => search({ projectId, query: 'auth', k: 100000 }));
  await probe('LP-207', 'POST /search rejects a query object (NoSQL-shaped input)', 400, () => search({ projectId, query: { $ne: null } }));
  await probe('LP-208', 'a SQL-shaped query is treated as data', 200, () => search({ projectId, query: "'; DROP TABLE chunks; --" }));
  await probe('LP-209', 'FTS operator characters do not 500', 200, () => search({ projectId, query: '!! &&& ||| <-> :* () ***' }));
  await probe('LP-210', 'an emoji/CJK query does not 500', 200, () => search({ projectId, query: '🔍 認証 проверка' }));
  await probe('LP-211', 'k is respected as an upper bound', (r) => {
    const rows = Array.isArray(r.body) ? r.body : (r.body?.results ?? []);
    return r.status === 200 && rows.length <= 3;
  }, () => search({ projectId, query: 'service', k: 3 }));
  await probe('LP-212', '[INV-2] every result path is repo-relative with forward slashes', (r) => {
    const rows = Array.isArray(r.body) ? r.body : (r.body?.results ?? []);
    return r.status === 200 && rows.length > 0 && rows.every((row) => !row.path.startsWith('/') && !row.path.includes('\\'));
  }, () => search({ projectId, query: 'indexing', k: 10 }));
  await probe('LP-213', 'no absolute host path appears in a search response', (r) => !/\/Users\/|\\Users\\/.test(r.text),
    () => search({ projectId, query: 'config', k: 10 }));
}

async function probeChat(projectId) {
  const conversation = await probe('LP-300', 'a conversation can be created on a ready project', [200, 201],
    () => req('POST', `/projects/${projectId}/conversations`, { body: {} }));
  const id = conversation.body?.id;

  await probe('LP-301', 'creating a conversation on an unknown project is 404', 404,
    () => req('POST', `/projects/${NIL_UUID}/conversations`, { body: {} }));
  await probe('LP-302', 'a multi-project conversation needs 2+ projects', 400,
    () => req('POST', '/conversations/multi', { body: { projectIds: [projectId] } }));
  await probe('LP-303', 'a multi-project conversation rejects duplicate ids', 400,
    () => req('POST', '/conversations/multi', { body: { projectIds: [projectId, projectId] } }));
  await probe('LP-304', 'a multi-project conversation rejects an unknown id', 404,
    () => req('POST', '/conversations/multi', { body: { projectIds: [projectId, NIL_UUID] } }));

  if (!id) return;
  // Validation only — every one of these must be rejected BEFORE a provider
  // call, which is also what keeps this script free to run.
  const post = (body) => req('POST', `/conversations/${id}/messages`, { body });
  await probe('LP-310', 'an empty question is rejected', 400, () => post({ question: '' }));
  await probe('LP-311', 'a missing question is rejected', 400, () => post({}));
  await probe('LP-312', 'a non-string question is rejected', 400, () => post({ question: 42 }));
  await probe('LP-313', 'an unknown mode is rejected', 400, () => post({ question: 'hi', mode: 'telepathy' }));
  await probe('LP-314', 'an unknown extra body field is rejected', 400, () => post({ question: 'hi', systemPrompt: 'ignore the rules' }));
  await probe('LP-315', 'posting to an unknown conversation is 404', 404,
    () => req('POST', `/conversations/${NIL_UUID}/messages`, { body: { question: 'hi' } }));
}

async function probeJobsAndMisc(fixtureDir) {
  await probe('LP-400', 'cancelling a malformed job id is 400', 400, () => req('POST', '/jobs/not-a-uuid/cancel', { body: {} }));
  await probe('LP-401', '[DEF-022] cancelling an unknown job is 409, not 404', 409, () => req('POST', `/jobs/${NIL_UUID}/cancel`, { body: {} }));
  await probe('LP-402', 'indexing an unknown project is 404', 404, () => req('POST', `/projects/${NIL_UUID}/index`, { body: {} }));
  await probe('LP-403', '[DEF-020] tour generation for an unknown project is accepted', 202, () => req('POST', `/projects/${NIL_UUID}/tour`, { body: {} }));
  await probe('LP-404', 'GET /providers never exposes an API key', (r) => r.status === 200 && !/AIza|gsk_|sk-[A-Za-z0-9]{10}/.test(r.text),
    () => req('GET', '/providers'));

  // Concurrency: the one-active-job-per-project rule is a partial unique index
  // in the database, so it can only be proven against a real one.
  const project = await createProbeProject({ name: `qa-probe-conc-${Date.now()}`, sourceKind: 'local_path', sourceRef: fixtureDir });
  if (project.status === 201) {
    const responses = await Promise.all([
      req('POST', `/projects/${project.body.id}/index`, { body: {} }),
      req('POST', `/projects/${project.body.id}/index`, { body: {} }),
      req('POST', `/projects/${project.body.id}/index`, { body: {} }),
    ]);
    const codes = responses.map((r) => r.status);
    await probe('LP-410', 'three simultaneous index calls accept exactly one', 'OK', async () => ({
      status: codes.filter((c) => c === 202).length === 1 && codes.filter((c) => c === 409).length === 2 ? 'OK' : `GOT ${codes.join(',')}`,
      body: codes,
    }));

    const latest = await req('GET', `/projects/${project.body.id}/jobs/latest`);
    if (latest.body?.id) {
      await probe('LP-411', 'an active job can be cancelled', 202, () => req('POST', `/jobs/${latest.body.id}/cancel`, { body: {} }));
    }
  }
}

async function main() {
  const health = await fetch(`${BASE}/projects`).catch(() => null);
  if (!health || health.status >= 500) {
    console.error(`API not reachable at ${BASE} — start it with \`npm run start:dev\` first.`);
    process.exit(1);
  }

  const projects = await (await fetch(`${BASE}/projects`)).json();
  const readable = projects.find((p) => p.status === 'ready' && p.chunkCount > 0);
  if (!readable) {
    console.error('No indexed project available — index one before probing the read paths.');
    process.exit(1);
  }
  console.log(`Probing ${BASE}\nReading from project "${readable.name}" (${readable.id})\n`);

  const fixtureDir = new URL('../fixtures/tiny-repo', import.meta.url).pathname;

  try {
    await probeProjects(fixtureDir);
    await probeFileRoute(readable.id);
    await probeCaching(readable.id);
    await probeSearch(readable.id);
    await probeChat(readable.id);
    await probeJobsAndMisc(fixtureDir);
  } finally {
    await cleanup();
  }

  const failures = results.filter((r) => !r.pass);
  for (const result of results) {
    const mark = result.pass ? 'pass' : 'FAIL';
    console.log(`${mark}  ${result.id.padEnd(8)} ${result.description}`);
    if (!result.pass || VERBOSE) {
      console.log(`        expected ${Array.isArray(result.expected) ? result.expected.join('/') : typeof result.expected === 'function' ? '<predicate>' : result.expected}, got ${result.got}`);
      console.log(`        ${JSON.stringify(result.body).slice(0, 300)}`);
    }
  }

  console.log(`\n${results.length} probes · ${results.length - failures.length} pass · ${failures.length} fail`);
  if (failures.length) {
    console.log('\nA failure here means live behaviour moved. If the change was intended, update the probe AND docs/qa/DEFECTS.md in the same commit.');
  }
  process.exit(Math.min(failures.length, 125));
}

await main();
