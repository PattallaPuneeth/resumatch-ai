/**
 * Match throughput benchmark through the real API (no k6 needed).
 *
 *   node scripts/bench/match_throughput.mjs --users 4 --per-user 6 --label "1 worker"
 *
 * Each throwaway user uploads one resume and creates job posts; then every user's matches are
 * enqueued at the same moment and polled until each result exists. Several users are used
 * because the API allows 20 job creations and 20 matches per minute (counted per client IP, so
 * keep users x per-user at 20 or less per run, and leave a minute between runs). Reports throughput
 * (completed matches per second over the batch) and per-match latency (enqueue -> result)
 * p50/p95. Every account is deleted at the end. Run once per worker count to measure scaling.
 */
import crypto from 'node:crypto';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3000') + '/api/backend';
const USERS = Number(args.users || 3);
const PER_USER = Number(args['per-user'] || 6);
const LABEL = args.label || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];

function client() {
  const jar = new Map();
  return async function api(path, { method = 'GET', body } = {}) {
    // The backend's CSRF check requires a trusted Origin, as a browser would send
    const headers = { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), Origin: new URL(BASE).origin };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jar.has('csrf_token')) headers['X-CSRF-Token'] = jar.get('csrf_token');
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

function pdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (m) => '\\' + m);
  const body = `BT /F1 11 Tf 50 760 Td 15 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(out + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`, 'latin1');
}

const RESUME = () => pdf([`Alex Morgan - Backend Engineer (ref ${RUN}-${crypto.randomBytes(2).toString('hex')})`, 'Backend engineer with 6 years of Python and Node.js services.',
  'Built REST APIs in Python (FastAPI) and Node.js (Express).', 'Designed PostgreSQL schemas and tuned queries; Redis caching.',
  'Containerised services with Docker and Kubernetes on AWS.', 'Skills: Python, Node.js, TypeScript, PostgreSQL, Redis, Docker, Kubernetes, AWS']);
const STACKS = ['Python', 'Node.js', 'Go', 'Java', 'TypeScript', 'Rust'];
// Unique text per run: the worker caches embeddings and reranker scores by text, so repeating
// the same documents across runs would measure the cache instead of the pipeline
const RUN = crypto.randomBytes(3).toString('hex');

async function setUp(u) {
  const api = client();
  const password = `Bench!${crypto.randomBytes(9).toString('base64url')}9a`;
  const reg = await api('/v1/auth/register', { method: 'POST', body: { username: `bench_${crypto.randomBytes(4).toString('hex')}`, password } });
  if (reg.status >= 300) throw new Error(`register ${reg.status}`);
  const user = { api, password, jobs: [] };
  const resume = RESUME();
  const up = await api('/v1/resumes/upload-url', { method: 'POST', body: { filename: 'bench.pdf', mimeType: 'application/pdf', sizeBytes: resume.length } });
  if (!up.body?.uploadUrl) throw new Error(`upload-url ${up.status}`);
  await fetch(up.body.uploadUrl, { method: 'PUT', headers: up.body.headers, body: resume });
  await api(`/v1/resumes/${up.body.resumeId}/complete`, { method: 'POST', body: {} });
  user.resumeId = up.body.resumeId;
  for (let i = 0; i < 120; i++) {
    if ((await api(`/v1/resumes/${user.resumeId}`)).body?.status === 'PARSED') break;
    await sleep(500);
  }
  for (let i = 0; i < PER_USER; i++) {
    const j = await api('/v1/jobs', { method: 'POST', body: {
      title: `Backend Engineer ${u}-${i}`, company: `Bench Co ${u}-${i}`,
      rawDescription: `Backend engineer ${u}-${i} for our platform team (ref ${RUN}).\n\nRequirements:\n- 4+ years building services in ${STACKS[(u + i) % STACKS.length]}\n- PostgreSQL and REST API design\n- Docker and Kubernetes in production`,
    } });
    if (j.status >= 300) throw new Error(`create job ${j.status}`);
    user.jobs.push(j.body.id);
  }
  return user;
}

const users = [];
let ok = false;
try {
  for (let u = 0; u < USERS; u++) users.push(await setUp(u));
  await sleep(5000); // let the embedding jobs finish so the batch measures matching only

  const start = Date.now();
  const enqueued = new Map();
  const done = new Map();
  await Promise.all(users.flatMap((user) => user.jobs.map(async (id) => {
    const r = await user.api(`/v1/jobs/${id}/match`, { method: 'POST', body: { resumeId: user.resumeId } });
    if (r.status >= 300) throw new Error(`match ${r.status}`);
    enqueued.set(id, Date.now());
  })));
  const total = USERS * PER_USER;
  while (done.size < total && Date.now() - start < 15 * 60_000) {
    await Promise.all(users.flatMap((user) => user.jobs.filter((id) => !done.has(id)).map(async (id) => {
      if ((await user.api(`/v1/jobs/${id}/matches/${user.resumeId}`)).status === 200) done.set(id, Date.now());
    })));
    await sleep(250);
  }
  const elapsed = (Math.max(...done.values()) - start) / 1000;
  const lat = [...done].map(([id, t]) => (t - enqueued.get(id)) / 1000);
  console.log(JSON.stringify({
    label: LABEL, matches: total, completed: done.size, failed: total - done.size,
    seconds: Number(elapsed.toFixed(1)), throughput_per_s: Number((done.size / elapsed).toFixed(3)),
    latency_p50_s: Number(pct(lat, 50).toFixed(1)), latency_p95_s: Number(pct(lat, 95).toFixed(1)),
  }));
  ok = true;
} finally {
  for (const user of users) await user.api('/v1/account', { method: 'DELETE', body: { password: user.password } });
  if (!ok) process.exitCode = 1;
}
