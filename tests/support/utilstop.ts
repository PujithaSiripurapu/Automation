import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect as baseExpect, type Page } from '@playwright/test';

// dev.utilstop.com is a Vite dev server; lazy pages can take well over 5s to render.
const expect = baseExpect.configure({ timeout: 30_000 });

export const phone = process.env.TEST_PHONE ?? '551234567';
export const otp = process.env.TEST_OTP ?? '123456';

// Saved login session: the site rate-limits OTP requests per number, so only log in
// with OTP when this session is missing or expired.
export const authFile = path.join(__dirname, '..', '..', 'playwright', '.auth', 'uae-user.dev.utilstop.com.json');

/**
 * `test` that loads the saved login session (checked per test, so a session saved by an
 * earlier spec in the same run is picked up) and keeps the browser on Dubai time.
 */
export const test = base.extend({
  storageState: async ({}, use) => {
    await use(fs.existsSync(authFile) ? authFile : undefined);
  },
  timezoneId: 'Asia/Dubai',
});

// Longest Retry-After we are willing to wait out when /api/generateOTP is rate-limited.
const maxOtpWaitSeconds = Number(process.env.TEST_MAX_OTP_WAIT ?? 600);

// Clicks "Send OTP". The server rate-limits OTP requests per phone number (HTTP 429 with
// Retry-After); wait it out once if it is short, otherwise fail with a clear message.
async function requestOtp(page: Page) {
  for (let attempt = 1; ; attempt++) {
    const responsePromise = page.waitForResponse((r) => r.url().includes('/api/generateOTP'));
    await page.getByRole('button', { name: 'Send OTP' }).click();
    const response = await responsePromise;
    if (response.status() !== 429) {
      expect(response.ok(), `/api/generateOTP failed with HTTP ${response.status()}`).toBe(true);
      return;
    }

    const retryAfter = Number(response.headers()['retry-after'] ?? 0);
    if (attempt > 1 || !retryAfter || retryAfter > maxOtpWaitSeconds) {
      throw new Error(
        `OTP rate limit (HTTP 429) for ${phone}: server says retry after ${retryAfter || '?'}s. ` +
        'Too many logins with this number recently (other CI runs / workflows?) — try again later.',
      );
    }
    console.log(`OTP rate-limited; waiting ${retryAfter}s before asking again`);
    base.setTimeout(base.info().timeout + (retryAfter + 60) * 1000);
    await page.waitForTimeout((retryAfter + 5) * 1000);
  }
}

/** Opens `url`; if the saved session is missing or expired, logs in with OTP and comes back. */
export async function openLoggedIn(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const logout = page.getByRole('button', { name: 'Logout' });
  if (await logout.waitFor({ timeout: 15_000 }).then(() => true, () => false)) return;

  expect(otp, 'Set TEST_OTP to the temporary test OTP').toMatch(/^\d{6}$/);
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const countryPicker = page.getByRole('heading', { name: 'Select your country' });
  if (await countryPicker.isVisible()) {
    await page.getByRole('button', { name: /United Arab Emirates.*\+971/ }).click();
    await expect(countryPicker).toBeHidden();
  }

  await page.getByRole('textbox', { name: 'Enter Phone number' }).fill(phone);
  await requestOtp(page);

  const otpInputs = page.locator('input[maxlength="1"]');
  await expect(otpInputs).toHaveCount(otp.length);
  for (const [index, digit] of [...otp].entries()) {
    await otpInputs.nth(index).fill(digit);
  }

  await page.getByRole('button', { name: 'Verify OTP' }).click();
  await expect(logout).toBeVisible();
  await page.context().storageState({ path: authFile });

  if (!page.url().includes(url)) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Today's calendar date in Dubai, as a UTC-midnight Date (read it with getUTC*), so the
// result does not depend on the machine's timezone (UTC on CI runners).
function dubaiToday() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dubai', year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
}

/** Picks today (Dubai time) + `daysAhead` in the booking calendar popup. */
export async function pickDateDaysAhead(page: Page, daysAhead: number) {
  const today = dubaiToday();
  const target = new Date(today);
  target.setUTCDate(target.getUTCDate() + daysAhead);

  await page.getByRole('button', { name: /^\d{2} \w{3,4} \d{4}$/ }).click();
  const monthsAhead =
    (target.getUTCFullYear() - today.getUTCFullYear()) * 12 + target.getUTCMonth() - today.getUTCMonth();
  for (let i = 0; i < monthsAhead; i++) {
    await page.getByRole('button', { name: 'Next month' }).click();
  }
  await page.getByRole('button', { name: String(target.getUTCDate()), exact: true }).click();

  // e.g. "22 Nov 2026" (accept "Sept" too: newer ICU builds format September that way).
  const day = String(target.getUTCDate()).padStart(2, '0');
  const label = new RegExp(`^${day} ${MONTHS[target.getUTCMonth()]}t? ${target.getUTCFullYear()}$`);
  await expect(page.getByRole('button', { name: label })).toBeVisible();
}

// Pest Control requires at least one photo of the affected area.
const pestPhotoFile = path.join(__dirname, '..', 'fixtures', 'pest-photo.png');

/** After "Continue →" on the Items step: attach the mandatory photo and move on to Choose your Pro. */
export async function addPestPhoto(page: Page) {
  const infoDialog = page.getByRole('dialog', { name: 'Add Information' });
  await expect(infoDialog).toBeVisible();
  const fileChooserPromise = page.waitForEvent('filechooser');
  await infoDialog.getByRole('button', { name: 'Gallery' }).click();
  await (await fileChooserPromise).setFiles(pestPhotoFile);
  await infoDialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(infoDialog).toBeHidden();
  await expect(page.getByText('Please add photos to continue')).toBeHidden();

  // Depending on the build, the dialog's Continue either advances or returns to the Items step.
  const chooseProHeading = page.getByRole('heading', { name: 'Choose your Pro' });
  if (!(await chooseProHeading.waitFor({ timeout: 5_000 }).then(() => true, () => false))) {
    await page.getByRole('button', { name: 'Continue →' }).click();
  }
}
