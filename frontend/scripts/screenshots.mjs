/**
 * Captures the README screenshots from the running stack (docker compose up):
 *   cd frontend && node scripts/screenshots.mjs
 * Uses a throwaway account that is deleted at the end. Output: docs/images/*.png
 */
import { chromium, devices } from '@playwright/test';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/images');
const user = `shot_${crypto.randomBytes(4).toString('hex')}`;
const password = `Shot!${crypto.randomBytes(9).toString('base64url')}9a`;

function resumePdf(lines) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const body = `BT /F1 11 Tf 50 760 Td 15 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const RESUME = [
  'Alex Morgan - Backend Engineer',
  'Summary: Backend engineer with 6 years building Python and Node.js services.',
  'Senior Backend Engineer, Ledgerly (2021 - present)',
  '- Built REST APIs in Python (FastAPI) and Node.js (Express) serving 2M requests/day',
  '- Designed PostgreSQL schemas, query tuning, Redis caching',
  '- Containerised services with Docker, deployed on Kubernetes (AWS EKS)',
  'Skills: Python, FastAPI, Node.js, TypeScript, PostgreSQL, Redis, Docker, Kubernetes, AWS, REST',
];
const JOB = 'Backend Platform Engineer for our payments team.\n\nRequirements:\n- 4+ years building backend services in Python or Node.js\n- PostgreSQL schema design and query tuning\n- Docker and Kubernetes in production\n- REST API design\n\nNice to have:\n- Kafka or RabbitMQ';

const browser = await chromium.launch();
try {
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
  const page = await desktop.newPage();

  await page.goto(`${BASE}/`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}/landing.png` });

  await page.goto(`${BASE}/signup`);
  await page.locator('#username').fill(user);
  await page.locator('#password').fill(password);
  await page.getByTestId('signup-submit-button').click();
  await page.getByTestId('proceed-to-dashboard-button').click();
  await page.getByText(`Welcome back, ${user}`).waitFor();

  await page.locator('input[type=file]').setInputFiles({ name: 'alex_morgan_resume.pdf', mimeType: 'application/pdf', buffer: resumePdf(RESUME) });
  await page.getByRole('button', { name: 'Start Upload' }).click();
  await page.getByTestId('badge-parsed').waitFor({ timeout: 60_000 });

  await page.goto(`${BASE}/analyze`);
  await page.getByTestId('mode-b-btn').click();
  await page.getByPlaceholder('e.g. Senior Backend Engineer').fill('Backend Platform Engineer');
  await page.getByPlaceholder('e.g. Acme Corporation').fill('Northwind Pay');
  await page.locator('textarea').first().fill(JOB);
  await page.getByRole('button', { name: 'Match & Analyze JD' }).click();
  const results = page.getByTestId('mode-b-results');
  await results.waitFor({ timeout: 90_000 });
  // The sticky header would be painted over an element screenshot
  await page.addStyleTag({ content: 'header{position:static !important}' });
  await page.waitForTimeout(1500);
  await results.screenshot({ path: `${OUT}/match-result.png` });

  const phone = await browser.newContext({ ...devices['Pixel 7'], storageState: await desktop.storageState() });
  const p2 = await phone.newPage();
  await p2.goto(`${BASE}/dashboard`);
  await p2.getByText('alex_morgan_resume.pdf').first().waitFor();
  await p2.addStyleTag({ content: 'header{position:static !important}' });
  await p2.getByText('Your Resumes').scrollIntoViewIfNeeded();
  await p2.waitForTimeout(800);
  await p2.screenshot({ path: `${OUT}/phone-dashboard.png` });

  // Clean up the throwaway account
  await page.evaluate(async (pw) => {
    const csrf = document.cookie.match(/csrf_token=([^;]+)/)?.[1] ?? '';
    await fetch('/api/backend/v1/account', {
      method: 'DELETE', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ password: pw }),
    });
  }, password);
  console.log(`screenshots written to ${OUT}`);
} finally {
  await browser.close();
}
