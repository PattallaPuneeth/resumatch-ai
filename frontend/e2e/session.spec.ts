import { expect, test } from '@playwright/test';
import { deleteAccount, newCredentials, signUp } from './helpers';

test.describe.configure({ mode: 'serial' });

test('a logged-out visitor makes no failing API calls', async ({ page }) => {
  const failed: string[] = [];
  page.on('response', (res) => {
    if (res.url().includes('/api/backend/') && res.status() >= 400) failed.push(`${res.status()} ${res.url()}`);
  });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Log in' }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(failed).toEqual([]);
});

test.describe('signed-in session', () => {
  const creds = newCredentials();

  test('sign up lands on the dashboard', async ({ page }) => {
    await signUp(page, creds);
  });

  test('the session survives an expired access token (refresh through the proxy)', async ({ page, context }) => {
    await page.goto('/login');
    await page.locator('#username').fill(creds.username);
    await page.locator('#password').fill(creds.password);
    await page.locator('button[type=submit]').click();
    await expect(page.getByText(`Welcome back, ${creds.username}`)).toBeVisible();

    // The access token lives 15 minutes; dropping it is what expiry looks like to the browser.
    // Regression: the refresh cookie was scoped to /v1/auth and never reached the proxied
    // /api/backend/v1/auth/refresh, so this reload logged the user out.
    const cookies = await context.cookies();
    await context.clearCookies({ name: 'access_token' });
    expect(cookies.some((c) => c.name === 'refresh_token' && c.path === '/api/backend/v1/auth')).toBe(true);

    await page.goto('/dashboard');
    await expect(page.getByText(`Welcome back, ${creds.username}`)).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard$/);

    await deleteAccount(page, creds.password);
  });
});
