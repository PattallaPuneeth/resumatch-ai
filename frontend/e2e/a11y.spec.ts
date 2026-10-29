import { expect, test } from '@playwright/test';
import axe from 'axe-core';
import { deleteAccount, newCredentials, signUp } from './helpers';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  // Emulate reduced motion so animations don't leave elements semi-transparent during a11y color sampling
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

async function checkA11y(page: any, pageName: string) {
  await page.evaluate(axe.source);
  const results = await page.evaluate(async () => {
    // @ts-ignore
    return await window.axe.run(document, {
      resultTypes: ['violations'],
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
      },
    });
  });

  const violations = results.violations.filter(
    (v: any) => v.impact === 'critical' || v.impact === 'serious'
  );

  if (violations.length > 0) {
    console.error(`A11y critical/serious violations on ${pageName}:`, JSON.stringify(violations, null, 2));
  }

  expect(
    violations,
    `Found ${violations.length} serious/critical a11y violations on ${pageName}`
  ).toEqual([]);
}

test('landing page (/) has 0 serious or critical a11y violations', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await checkA11y(page, 'Landing Page (/)');
});

test('login page (/login) has 0 serious or critical a11y violations', async ({ page }) => {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await checkA11y(page, 'Login Page (/login)');
});

test('signup page (/signup) has 0 serious or critical a11y violations', async ({ page }) => {
  await page.goto('/signup');
  await page.waitForLoadState('networkidle');
  await checkA11y(page, 'Signup Page (/signup)');
});

test.describe('authenticated pages a11y', () => {
  const creds = newCredentials();

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    await page.locator('#username').fill(creds.username);
    await page.locator('#password').fill(creds.password);
    await page.locator('button[type=submit]').click();
    const signedIn = await page
      .getByText(`Welcome back, ${creds.username}`)
      .waitFor({ timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (signedIn) await deleteAccount(page, creds.password);
    await page.close();
  });

  test('dashboard, analyze, and account pages have 0 serious or critical a11y violations', async ({ page }) => {
    await signUp(page, creds);

    // 1. Dashboard
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');
    await checkA11y(page, 'Dashboard Page (/dashboard)');

    // 2. Analyze
    await page.goto('/analyze');
    await page.waitForLoadState('networkidle');
    await checkA11y(page, 'Analyze Page (/analyze)');

    // 3. Account
    await page.goto('/account');
    await page.waitForLoadState('networkidle');
    await checkA11y(page, 'Account Page (/account)');
  });
});
