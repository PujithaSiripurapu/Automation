import { expect as baseExpect } from '@playwright/test';
import { openLoggedIn, test } from './support/utilstop';

// dev.utilstop.com is a Vite dev server; lazy pages can take well over 5s to render.
const expect = baseExpect.configure({ timeout: 20_000 });

test('UAE customer can book Cleaning Service with cash', async ({ page }) => {
  test.setTimeout(180_000);

  // Reuses the saved login session; only requests an OTP when it is missing or expired.
  await openLoggedIn(page, '/services/cleaning-services/book');
  await expect(page).toHaveURL(/\/services\/cleaning-services\/book\/?$/);
  await expect(page.getByRole('heading', { name: /Cleaning Service/i }).first()).toBeVisible();

  await page.getByRole('button', { name: /Next: Schedule/ }).click();
  await expect(page.getByRole('heading', { name: 'When do you need us?' })).toBeVisible();
  await page.getByRole('button', { name: /^\d{1,2}:\d{2} (AM|PM) –/ }).first().click();
  await page.getByRole('button', { name: /Next: Details/ }).click();

  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  const serviceTypeDialog = page.getByRole('heading', { name: 'Select Type' }).locator('xpath=../..');
  await serviceTypeDialog.getByRole('button', { name: 'Add', exact: true }).first().click();
  await serviceTypeDialog.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('button', { name: 'Continue →' }).click();
  await page.getByRole('button', { name: /Skip/ }).click();
  await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible();
  await page.getByRole('button', { name: /Proceed to payment/ }).click();

  await expect(page.getByRole('heading', { name: 'Complete Payment' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByText('Cash Handling Fee')).toBeVisible();

  // Desktop pay button reads "Pay AED <total>"; the "Pay Now" option button has no amount
  // and does not submit the booking.
  await page.getByRole('button', { name: /^Pay\b.*\d/ }).click();
  await expect(page).toHaveURL(/\/booking\/[^/]+\/success/, { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Booking Confirmed' })).toBeVisible();

  await page.goto('/account/bookings', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Cleaning Service', { exact: true }).first()).toBeVisible();
});
