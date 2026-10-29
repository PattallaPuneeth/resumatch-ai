import { expect, test } from '@playwright/test';

// Runs in the "phone" project only (see playwright.config.ts)
test('public pages do not scroll sideways on a phone', async ({ page }) => {
  for (const path of ['/', '/login', '/signup']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
});
