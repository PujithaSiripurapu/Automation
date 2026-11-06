import { test, expect } from '@playwright/test';

test('UAE customer can book Cleaning Service with cash', async ({ page }) => {
  const phone = process.env.TEST_PHONE ?? '551234567';
  const otp = process.env.TEST_OTP ?? '123456';

  expect(otp, 'Set TEST_OTP to the temporary test OTP').toMatch(/^\d{6}$/);

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const countryPicker = page.getByRole('heading', { name: 'Select your country' });
  if (await countryPicker.isVisible()) {
    await page.getByRole('button', { name: /United Arab Emirates.*\+971/ }).click();
    await expect(countryPicker).toBeHidden();
  }

  await page.getByRole('textbox', { name: 'Enter Phone number' }).fill(phone!);
  await page.getByRole('button', { name: 'Send OTP' }).click();

  const otpInputs = page.locator('input[maxlength="1"]');
  await expect(otpInputs).toHaveCount(otp!.length);
  for (const [index, digit] of [...otp!].entries()) {
    await otpInputs.nth(index).fill(digit);
  }

  await page.getByRole('button', { name: 'Verify OTP' }).click();
  await expect(page.locator('a[href="/account"]').first()).toBeVisible();

  await page.goto('/services/cleaning-services/book', { waitUntil: 'domcontentloaded' });
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

  await expect(page.getByRole('heading', { name: 'Complete Payment' })).toBeVisible();
  await page.getByRole('button', { name: 'Cash', exact: true }).click();
  await expect(page.getByText('Cash Handling Fee')).toBeVisible();

  await page.getByRole('button', { name: 'Pay Now', exact: true }).last().click();
  await page.goto('/account/bookings', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Cleaning Service', { exact: true }).first()).toBeVisible();
});