import { expect, type Page } from '@playwright/test';
import crypto from 'node:crypto';

/** A throwaway account per test file; deleted again in afterAll. */
export function newCredentials() {
  const id = crypto.randomBytes(4).toString('hex');
  return { username: `e2e_${id}`, password: `E2e!${crypto.randomBytes(9).toString('base64url')}9a` };
}

export async function signUp(page: Page, creds: { username: string; password: string }) {
  await page.goto('/signup');
  await page.locator('#username').fill(creds.username);
  await page.locator('#password').fill(creds.password);
  await page.getByTestId('signup-submit-button').click();
  await expect(page.getByTestId('recovery-codes-view')).toBeVisible();
  await page.getByTestId('proceed-to-dashboard-button').click();
  await expect(page.getByText(`Welcome back, ${creds.username}`)).toBeVisible();
}

/** Deletes the signed-in account through the same API the Account page uses. */
export async function deleteAccount(page: Page, password: string) {
  const status = await page.evaluate(async (pw) => {
    const csrf = document.cookie.match(/csrf_token=([^;]+)/)?.[1] ?? '';
    const res = await fetch('/api/backend/v1/account', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ password: pw }),
    });
    return res.status;
  }, password);
  expect([200, 204]).toContain(status);
}

/** A one-page text PDF resume built in memory (no fixture files). */
export function resumePdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const body = `BT /F1 11 Tf 50 760 Td 15 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const BACKEND_RESUME = [
  'Alex Morgan - Backend Engineer',
  'Summary: Backend engineer with 6 years building Python and Node.js services.',
  'Senior Backend Engineer, Ledgerly (2021 - present)',
  '- Built REST APIs in Python (FastAPI) and Node.js (Express) serving 2M requests/day',
  '- Designed PostgreSQL schemas, query tuning, Redis caching',
  '- Containerised services with Docker, deployed on Kubernetes (AWS EKS)',
  'Backend Engineer, Shipfast (2018 - 2021)',
  'Skills: Python, FastAPI, Node.js, TypeScript, PostgreSQL, Redis, Docker, Kubernetes, AWS, REST',
];

export const BACKEND_JOB = [
  'Backend Platform Engineer for our payments team.',
  '',
  'Requirements:',
  '- 4+ years building backend services in Python or Node.js',
  '- PostgreSQL schema design and query tuning',
  '- Docker and Kubernetes in production',
  '- REST API design',
].join('\n');
