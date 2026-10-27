import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, POLL_INTERVAL_S, POLL_TIMEOUT_S, S3_REWRITE_FROM, S3_REWRITE_TO } from './config.js';

// Fixtures are loaded once in the init context. Synthetic data only.
export const FIXTURES = {
  text: { file: open('../../fixtures/text_1p.pdf', 'b'), name: 'text_1p.pdf', mime: 'application/pdf' },
  docx: {
    file: open('../../fixtures/docx_1p.docx', 'b'),
    name: 'docx_1p.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  scan1: { file: open('../../fixtures/scan_1p.pdf', 'b'), name: 'scan_1p.pdf', mime: 'application/pdf' },
  scan5: { file: open('../../fixtures/scan_5p.pdf', 'b'), name: 'scan_5p.pdf', mime: 'application/pdf' },
};

// OCR fixtures are reported separately because SPEC §6 sets a different target for them.
export const FIXTURE_CLASS = { text: 'text', docx: 'text', scan1: 'ocr', scan5: 'ocr', heavy: 'ocr' };

const JD_TEMPLATE =
  'Senior Backend Engineer. Build and operate Python and Node.js services on PostgreSQL, Redis and Docker. ' +
  'Design REST APIs, own CI/CD pipelines, mentor engineers, and improve reliability with observability tooling. ' +
  'Required: Python, TypeScript, PostgreSQL, Docker. Nice to have: Kubernetes, AWS, Kafka.';

export const ingestionE2E = new Trend('ingestion_e2e', true);
export const matchE2E = new Trend('match_e2e', true);
export const analysisE2E = new Trend('analysis_e2e', true);
export const pipelineTimeouts = new Counter('pipeline_timeouts');
export const pipelineFailures = new Counter('pipeline_failures');

/** Picks a fixture key using integer weights, e.g. { text: 50, docx: 25, scan1: 20, scan5: 5 }. */
export function pickFixture(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [key, w] of Object.entries(weights)) {
    if ((r -= w) < 0) return key;
  }
  return Object.keys(weights)[0];
}

function poll(fn, name) {
  const deadline = Date.now() + POLL_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const outcome = fn();
    if (outcome !== undefined) return outcome;
    sleep(POLL_INTERVAL_S);
  }
  pipelineTimeouts.add(1, { stage: name });
  return null;
}

/**
 * Full browser-equivalent upload: presign, PUT to object storage, complete, then poll until
 * PARSED. Returns { resumeId, status } or null. Records ingestion_e2e tagged by fixture class.
 */
export function uploadAndParse(headers, fixtureKey, fx = FIXTURES[fixtureKey]) {
  const started = Date.now();

  const presign = http.post(
    `${BASE_URL}/v1/resumes/upload-url`,
    JSON.stringify({ filename: fx.name, mimeType: fx.mime, sizeBytes: fx.file.byteLength }),
    { headers, tags: { name: 'upload_url' } }
  );
  if (!check(presign, { 'upload-url 201/200': (r) => r.status === 201 || r.status === 200 })) return null;

  const resumeId = presign.json('resumeId');
  const signedUrl = presign.json('uploadUrl');
  const signedHost = signedUrl.split('/')[2];
  const put = http.put(signedUrl.replace(S3_REWRITE_FROM, S3_REWRITE_TO), fx.file, {
    headers: { 'Content-Type': fx.mime, Host: signedHost },
    tags: { name: 's3_put' },
  });
  if (!check(put, { 's3 PUT 200': (r) => r.status === 200 })) return null;

  const complete = http.post(`${BASE_URL}/v1/resumes/${resumeId}/complete`, '{}', {
    headers,
    tags: { name: 'upload_complete' },
  });
  if (!check(complete, { 'complete 200/202': (r) => r.status === 200 || r.status === 202 })) return null;

  const status = poll(() => {
    const res = http.get(`${BASE_URL}/v1/resumes/${resumeId}`, { headers, tags: { name: 'resume_poll' } });
    const s = res.status === 200 ? res.json('status') : null;
    if (s === 'PARSED' || s === 'FAILED') return s;
    return undefined;
  }, 'ingestion');

  if (status === 'PARSED') {
    ingestionE2E.add(Date.now() - started, { type: FIXTURE_CLASS[fixtureKey], fixture: fixtureKey });
  } else if (status === 'FAILED') {
    pipelineFailures.add(1, { stage: 'ingestion', fixture: fixtureKey });
  }
  check(status, { 'resume reached PARSED': (s) => s === 'PARSED' });
  return status ? { resumeId, status } : null;
}

/** Creates a job description. A unique marker per call defeats the LLM cache on purpose. */
export function createJob(headers, marker) {
  const res = http.post(
    `${BASE_URL}/v1/jobs`,
    JSON.stringify({
      title: 'Senior Backend Engineer',
      company: 'Loadtest Corp',
      rawDescription: `${JD_TEMPLATE} Reference ${marker}.`,
    }),
    { headers, tags: { name: 'job_create' } }
  );
  check(res, { 'job create 201/200': (r) => r.status === 201 || r.status === 200 });
  return res.status === 201 || res.status === 200 ? res.json('id') : null;
}

/** Triggers match scoring and polls until a finalScore exists. Records match_e2e. */
export function matchAndWait(headers, jobId, resumeId) {
  const started = Date.now();
  const trigger = http.post(`${BASE_URL}/v1/jobs/${jobId}/match`, JSON.stringify({ resumeId }), {
    headers,
    tags: { name: 'match_trigger' },
  });
  if (!check(trigger, { 'match trigger 202/200': (r) => r.status === 202 || r.status === 200 })) return null;

  const score = poll(() => {
    const res = http.get(`${BASE_URL}/v1/jobs/${jobId}/matches/${resumeId}`, {
      headers,
      tags: { name: 'match_poll' },
      // 404 just means "not scored yet"; don't count it in http_req_failed.
      responseCallback: http.expectedStatuses(200, 404),
    });
    if (res.status === 200 && res.json('finalScore') !== undefined && res.json('finalScore') !== null) {
      return res.json('finalScore');
    }
    return undefined;
  }, 'match');

  if (score !== null) matchE2E.add(Date.now() - started);
  check(score, { 'match scored': (s) => s !== null });
  return score;
}

/** Triggers structured analysis and polls until the analysis row exists. Records analysis_e2e. */
export function analyzeAndWait(headers, jobId, resumeId, idempotencyKey) {
  const started = Date.now();
  const extra = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
  const trigger = http.post(`${BASE_URL}/v1/jobs/${jobId}/analysis`, JSON.stringify({ resumeId }), {
    headers: { ...headers, ...extra },
    tags: { name: 'analysis_trigger' },
  });
  if (!check(trigger, { 'analysis trigger 202/200': (r) => r.status === 202 || r.status === 200 })) {
    return { trigger, result: null };
  }

  const result = poll(() => {
    const res = http.get(`${BASE_URL}/v1/jobs/${jobId}/analysis/${resumeId}`, {
      headers,
      tags: { name: 'analysis_poll' },
      // 404 just means "not ready yet"; don't count it in http_req_failed.
      responseCallback: http.expectedStatuses(200, 404),
    });
    return res.status === 200 ? res.json() : undefined;
  }, 'analysis');

  if (result) analysisE2E.add(Date.now() - started, { llm_status: String(result.llmStatus) });
  check(result, { 'analysis stored': (r) => r !== null });
  return { trigger, result };
}

// Per-VU parsed resume reused by match/analysis iterations (module scope is per VU).
let vuResumeId = null;

/** Returns this VU's parsed resume, uploading the text fixture on first use. */
export function ensureResume(headers) {
  if (!vuResumeId) {
    const r = uploadAndParse(headers, 'text');
    if (r && r.status === 'PARSED') vuResumeId = r.resumeId;
  }
  return vuResumeId;
}

/** Read-heavy dashboard traffic: list resumes, usage, match history. */
export function browse(headers, resumeId) {
  const list = http.get(`${BASE_URL}/v1/resumes`, { headers, tags: { name: 'resume_list' } });
  check(list, { 'resume list 200': (r) => r.status === 200 });
  const usage = http.get(`${BASE_URL}/v1/usage`, { headers, tags: { name: 'usage' } });
  check(usage, { 'usage 200': (r) => r.status === 200 });
  if (resumeId) {
    const hist = http.get(`${BASE_URL}/v1/resumes/${resumeId}/matches`, { headers, tags: { name: 'match_history' } });
    check(hist, { 'match history 200': (r) => r.status === 200 });
  }
}

/** Reads the analyses meter's `used` value; tolerant of the meters shape (object or array). */
export function analysesUsed(headers) {
  const res = http.get(`${BASE_URL}/v1/usage`, { headers, tags: { name: 'usage' } });
  const meters = res.json('meters');
  if (Array.isArray(meters)) {
    const m = meters.find((x) => x.meter === 'analyses' || x.name === 'analyses');
    return m ? m.used : null;
  }
  return meters && meters.analyses ? meters.analyses.used : null;
}
