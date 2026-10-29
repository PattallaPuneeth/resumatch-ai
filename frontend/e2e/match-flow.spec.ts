import { expect, test } from '@playwright/test';
import { BACKEND_JOB, BACKEND_RESUME, deleteAccount, newCredentials, resumePdf, signUp } from './helpers';

test.describe.configure({ mode: 'serial' });

const creds = newCredentials();

test.afterAll(async ({ browser }) => {
  // Clean up the throwaway account even if a test failed half-way
  const page = await browser.newPage();
  await page.goto('/login');
  await page.locator('#username').fill(creds.username);
  await page.locator('#password').fill(creds.password);
  await page.locator('button[type=submit]').click();
  // isVisible() does not wait, so wait explicitly; a failed sign-up leaves nothing to delete
  const signedIn = await page
    .getByText(`Welcome back, ${creds.username}`)
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (signedIn) await deleteAccount(page, creds.password);
  await page.close();
});

test('upload, live status, match: the verdict agrees with the score and history updates', async ({ page }) => {
  await signUp(page, creds);

  // 1. Upload: the status must turn to Parsed by itself (no Refresh click)
  await page.locator('input[type=file]').setInputFiles({
    name: 'e2e_backend_resume.pdf',
    mimeType: 'application/pdf',
    buffer: resumePdf(BACKEND_RESUME),
  });
  await page.getByRole('button', { name: 'Start Upload' }).click();
  await expect(page.getByTestId('badge-parsed')).toBeVisible({ timeout: 60_000 });

  // 2. Match against a job post
  await page.goto('/analyze');
  await expect(page.getByTestId('resume-select-dropdown')).toContainText('e2e_backend_resume.pdf');
  await expect(page.getByText(/Target Job Matches \(0\)/)).toBeVisible();
  await page.getByTestId('mode-b-btn').click();
  await page.getByPlaceholder('e.g. Senior Backend Engineer').fill('Backend Platform Engineer');
  await page.getByPlaceholder('e.g. Acme Corporation').fill('E2E Payments');
  await page.locator('textarea').first().fill(BACKEND_JOB);
  await page.getByRole('button', { name: 'Match & Analyze JD' }).click();

  const verdict = page.getByTestId('mode-b-verdict-band');
  await expect(verdict).toBeVisible({ timeout: 90_000 });

  // 3. The verdict must follow the score's band (regression: it always said "Moderate")
  const scoreText = (await page.getByTestId('mode-b-match-score').innerText()).replace(/[^0-9.]/g, '');
  const score = Number(scoreText);
  expect(score).toBeGreaterThan(0);
  const expected = score >= 75 ? 'Strong Match' : score >= 45 ? 'Moderate Match' : 'Low Match';
  await expect(verdict).toContainText(expected);

  // 4. Match history updates without a reload
  const history = page.getByRole('region', { name: /Target Job Matches/ });
  await expect(history).toContainText('Target Job Matches (1)');
  await expect(history).toContainText('E2E Payments');
});
