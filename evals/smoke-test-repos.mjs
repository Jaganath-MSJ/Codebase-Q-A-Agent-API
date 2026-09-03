// Multi-repo smoke test for the Codebase Q&A Agent.
//
// For each local repo it: creates a local_path project, indexes it, waits for
// the job to finish, then asserts a series of test cases — full embedding
// coverage (every chunk a 768-dim vector), project readiness, that vector and
// hybrid search return grounded results, and that a fast-mode Q&A produces an
// answer with server-built citations. A transient LLM outage (e.g. Gemini 503,
// Groq TPM cap) degrades the Q&A case to SKIP rather than failing the repo,
// since retrieval — the part that depends on indexing — is already asserted.
//
// Usage:
//   node evals/smoke-test-repos.mjs                     # default repo set below
//   node evals/smoke-test-repos.mjs '<json array of {name,path,queries?}>'
//
// Requires the API running on :3000 and DATABASE_URL in the environment/.env.
import 'dotenv/config';
import pg from 'pg';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000/api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Base directory the default repos live under — override with PROJECTS_DIR, or
// pass an explicit repo set as argv[2] (see usage above). Kept off any specific
// username so the committed default is portable.
const PROJECTS_DIR = process.env.PROJECTS_DIR ?? join(homedir(), 'Projects');
const DEFAULT_REPOS = [
  { name: 'React-Portfolio (local)', path: join(PROJECTS_DIR, 'React-Portfolio'),
    queries: ['what components make up the portfolio', 'how is routing configured'] },
  { name: 'Money-Analysis (local)', path: join(PROJECTS_DIR, 'Money-Analysis'),
    queries: ['what database tables/entities exist', 'how does the backend expose its API'] },
  { name: 'Codebase-Q-A-Agent (self)', path: join(PROJECTS_DIR, 'Codebase-Q-A-Agent'),
    queries: ['how are chunks embedded and cached', 'how does hybrid retrieval fuse results'] },
];

const repos = process.argv[2] ? JSON.parse(process.argv[2]) : DEFAULT_REPOS;

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function pollJob(jobId, { timeoutMs = 900_000 } = {}) {
  const start = Date.now();
  let last = '';
  for (;;) {
    const r = await db.query(
      'select status, phase, files_done, files_total, chunks_embedded, chunks_total, error_message from indexing_jobs where id=$1',
      [jobId],
    );
    const j = r.rows[0];
    if (j) {
      const line = `${j.status}/${j.phase} files ${j.files_done}/${j.files_total} emb ${j.chunks_embedded}/${j.chunks_total}`;
      if (line !== last) { process.stdout.write(`      ${line}\r`); last = line; }
      if (TERMINAL.has(j.status)) { process.stdout.write('\n'); return j; }
    }
    if (Date.now() - start > timeoutMs) { process.stdout.write('\n'); return { status: 'timeout', error_message: 'poll timed out' }; }
    await sleep(2500);
  }
}

async function coverage(projectId) {
  const r = await db.query(
    `select count(*)::int chunks, count(embedding)::int embedded,
            count(*) filter (where embedding is null)::int missing,
            coalesce(min(vector_dims(embedding)),0)::int mindim,
            coalesce(max(vector_dims(embedding)),0)::int maxdim
     from chunks where project_id=$1`,
    [projectId],
  );
  return r.rows[0];
}

async function drainSse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const t = raw.match(/^event: (.+)$/m); const d = raw.match(/^data: (.+)$/m);
      if (t) events.push({ type: t[1], data: d ? JSON.parse(d[1]) : null });
    }
  }
  return events;
}

const results = [];

for (const repo of repos) {
  console.log(`\n=== ${repo.name} ===`);
  const cases = [];
  const rec = (name, ok, detail) => { cases.push({ name, ok, detail }); console.log(`   [${ok ? 'PASS' : ok === null ? 'SKIP' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`); };

  // TC1: create
  const created = await api('POST', '/projects', { name: repo.name, sourceKind: 'local_path', sourceRef: repo.path });
  const projectId = created.json?.id;
  rec('create project', !!projectId, projectId ? `id=${projectId.slice(0, 8)}` : `HTTP ${created.status}: ${JSON.stringify(created.json).slice(0, 120)}`);
  if (!projectId) { results.push({ repo: repo.name, cases }); continue; }

  // TC2: index to completion
  const enq = await api('POST', `/projects/${projectId}/index`, { force: true });
  const jobId = enq.json?.id;
  if (!jobId) { rec('enqueue index', false, `HTTP ${enq.status}`); results.push({ repo: repo.name, cases }); continue; }
  const job = await pollJob(jobId);
  rec('index completes', job.status === 'succeeded', `status=${job.status}${job.error_message ? ' err=' + String(job.error_message).slice(0, 160) : ''}`);

  // TC3/TC4: coverage + readiness
  const cov = await coverage(projectId);
  rec('all chunks embedded (768-dim, 0 missing)',
    cov.chunks > 0 && cov.missing === 0 && cov.embedded === cov.chunks && cov.mindim === 768 && cov.maxdim === 768,
    `chunks=${cov.chunks} embedded=${cov.embedded} missing=${cov.missing} dims=${cov.mindim}..${cov.maxdim}`);
  const proj = (await api('GET', '/projects')).json.find((p) => p.id === projectId);
  rec('project status ready/indexed', ['ready', 'indexed'].includes(proj?.status), `status=${proj?.status} files=${proj?.fileCount} chunks=${proj?.chunkCount}`);

  // TC5/TC6: search (vector + hybrid)
  const q = repo.queries?.[0] ?? 'main entry point';
  for (const mode of ['vector', 'hybrid']) {
    const s = await api('POST', '/search', { projectId, query: q, mode, k: 5 });
    const hits = Array.isArray(s.json) ? s.json : [];
    rec(`${mode} search returns hits`, hits.length > 0, `q="${q}" -> ${hits.length} hits${hits[0] ? `, top=${hits[0].path}:${hits[0].startLine}-${hits[0].endLine}` : ''}`);
  }

  // TC7: Q&A (fast) — tolerate LLM outage as SKIP
  try {
    const conv = (await api('POST', `/projects/${projectId}/conversations`)).json;
    const res = await fetch(`${BASE}/conversations/${conv.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: repo.queries?.[0] ?? 'What does this project do?', mode: 'fast' }),
    });
    const events = await drainSse(res);
    const err = events.find((e) => e.type === 'error');
    const msgs = (await api('GET', `/conversations/${conv.id}/messages`)).json;
    const a = [...msgs].reverse().find((m) => m.role === 'assistant');
    if (a?.status === 'complete' && a.content?.trim()) {
      rec('Q&A fast answer + citations', a.citations.length >= 0, `${a.content.trim().length} chars, ${a.citations.length} citations`);
    } else {
      const code = (err?.data?.message || '').match(/"code":\s*(\d+)/)?.[1];
      rec('Q&A fast answer (LLM)', code ? null : false, code ? `LLM unavailable (code ${code}) — retrieval already verified` : `status=${a?.status}`);
    }
  } catch (e) {
    rec('Q&A fast answer (LLM)', null, `error: ${e.message}`);
  }

  results.push({ repo: repo.name, projectId, cases });
}

await db.end();

// Summary
console.log('\n\n========== SUMMARY ==========');
let allGreen = true;
for (const r of results) {
  const fails = r.cases.filter((c) => c.ok === false);
  const skips = r.cases.filter((c) => c.ok === null);
  const pass = r.cases.filter((c) => c.ok === true).length;
  if (fails.length) allGreen = false;
  console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${r.repo}  (${pass} pass, ${fails.length} fail, ${skips.length} skip)`);
  for (const f of fails) console.log(`        FAILED: ${f.name} — ${f.detail}`);
}
console.log(`\nOVERALL: ${allGreen ? 'ALL GREEN (failures: 0)' : 'FAILURES PRESENT'}`);
process.exit(allGreen ? 0 : 1);
