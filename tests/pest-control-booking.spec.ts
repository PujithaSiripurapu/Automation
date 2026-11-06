import fs from 'node:fs';
import path from 'node:path';
import { test, expect as baseExpect, type Page } from '@playwright/test';

// dev.utilstop.com is a Vite dev server; lazy pages can take well over 5s to render.
const expect = baseExpect.configure({ timeout: 20_000 });

// Saved login session — the site rate-limits OTP requests per number, so only log in
// with OTP when this session is missing or expired.
const authFile = path.join(__dirname, '..', 'playwright', '.auth', 'uae-user.dev.utilstop.com.json');
test.use({ storageState: fs.existsSync(authFile) ? authFile : undefined });

const phone = process.env.TEST_PHONE ?? '551234567';
const otp = process.env.TEST_OTP ?? '123456';
// Leave unset to apply the first coupon the payment page suggests.
const couponCode = process.env.TEST_COUPON;
const pestType = process.env.TEST_PEST_TYPE ?? 'Cockroaches';
const daysAhead = Number(process.env.TEST_DAYS_AHEAD ?? 7);
// Stripe test-mode Visa
const card = {
  number: process.env.TEST_CARD_NUMBER ?? '4242424242424242',
  expiry: process.env.TEST_CARD_EXPIRY ?? '12/34',
  cvc: process.env.TEST_CARD_CVC ?? '123',
  country: process.env.TEST_CARD_COUNTRY ?? 'United Arab Emirates',
};

async function login(page: Page) {
  await page.goto('/account', { waitUntil: 'domcontentloaded' });
  const logout = page.getByRole('button', { name: 'Logout' });
  if (await logout.waitFor({ timeout: 10_000 }).then(() => true, () => false)) return;

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  const countryPicker = page.getByRole('heading', { name: 'Select your country' });
  if (await countryPicker.isVisible()) {
    await page.getByRole('button', { name: /United Arab Emirates.*\+971/ }).click();
    await expect(countryPicker).toBeHidden();
  }

  await page.getByRole('textbox', { name: 'Enter Phone number' }).fill(phone);
  await page.getByRole('button', { name: 'Send OTP' }).click();
  await expect(page.getByText('Too many OTP requests'), 'OTP rate limit hit; wait and retry').toBeHidden();

  const otpInputs = page.locator('input[maxlength="1"]');
  await expect(otpInputs).toHaveCount(otp.length);
  for (const [index, digit] of [...otp].entries()) {
    await otpInputs.nth(index).fill(digit);
  }

  await page.getByRole('button', { name: 'Verify OTP' }).click();
  await expect(logout).toBeVisible();
  await page.context().storageState({ path: authFile });
}

function bookingCard(page: Page, displayBookingId: string) {
  return page.getByRole('link', { name: new RegExp(`Booking ID: .*${displayBookingId}\\b`) });
}

// My Bookings -> booking card -> "View Booking Details"
async function openBookingDetails(page: Page, displayBookingId: string) {
  await page.goto('/account/bookings', { waitUntil: 'domcontentloaded' });
  await bookingCard(page, displayBookingId).click();
  await expect(page.getByRole('heading', { name: 'Track Your Service' })).toBeVisible();

  await page.getByRole('link', { name: 'View Booking Details' }).click();
  await expect(page).toHaveURL(/\/booking\/[^/]+\/details/);
  await expect(page.getByText(`Booking ID: ${displayBookingId}`)).toBeVisible();
}

// Booking Details -> "Complete Payment" -> Stripe card form -> "Confirm Payment"
async function completeCardPayment(page: Page, displayBookingId: string) {
  await openBookingDetails(page, displayBookingId);
  await expect(page.getByText('Cash', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Complete Payment' }).click();

  // Stripe renders several same-titled iframes; use the one holding the card fields.
  const stripeFrames = page.locator('iframe[title="Secure payment input frame"]');
  let stripe = stripeFrames.first().contentFrame();
  await expect(async () => {
    for (let i = 0; i < await stripeFrames.count(); i++) {
      const frame = stripeFrames.nth(i).contentFrame();
      if (await frame.getByRole('textbox', { name: 'Card number' }).count()) {
        stripe = frame;
        return;
      }
    }
    throw new Error('Stripe card form not loaded yet');
  }).toPass({ timeout: 30_000 });

  await stripe.getByRole('textbox', { name: 'Card number' }).fill(card.number);
  await stripe.getByRole('textbox', { name: 'Expiration date' }).fill(card.expiry);
  await stripe.getByRole('textbox', { name: 'Security code' }).fill(card.cvc);
  await stripe.getByRole('combobox', { name: 'Country', exact: true }).selectOption({ label: card.country });

  await page.getByRole('button', { name: 'Confirm Payment' }).click();

  await expect(page).toHaveURL(/\/booking\/[^/]+\/success/, { timeout: 90_000 });
  await expect(page.getByRole('heading', { name: 'Payment Completed' })).toBeVisible();
  await expect(page.getByText('now fully paid')).toBeVisible();
}

test('UAE customer books Pest Control with cash + coupon, then pays by card', async ({ page }) => {
  test.setTimeout(240_000);
  expect(otp, 'Set TEST_OTP to the temporary test OTP').toMatch(/^\d{6}$/);

  await test.step('Login with UAE phone number and OTP', async () => {
    await login(page);
  });

  await test.step('Location: saved address, date and time slot', async () => {
    await page.goto('/services/pest-control/book', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Pest Control', level: 1 })).toBeVisible();

    const addressDialog = page.getByRole('heading', { name: 'Saved Addresses' }).locator('xpath=../..');
    // The first click can land before the page is interactive; retry until the dialog opens.
    await expect(async () => {
      if (!(await addressDialog.isVisible())) {
        await page.getByRole('button', { name: /Select your service location/ }).click();
      }
      await expect(addressDialog).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await expect(addressDialog.getByText('Dubai').first(), 'Account needs at least one saved address').toBeVisible({ timeout: 15_000 });
    await addressDialog.getByText('Dubai').first().click();
    await expect(page.getByRole('heading', { name: 'Saved Addresses' })).toBeHidden();

    // Future date: today + daysAhead, via the calendar popup
    const target = new Date();
    target.setDate(target.getDate() + daysAhead);
    await page.getByRole('button', { name: /^\d{2} \w{3} \d{4}$/ }).click();
    if (target.getMonth() !== new Date().getMonth()) {
      await page.getByRole('button', { name: 'Next month' }).click();
    }
    await page.getByRole('button', { name: String(target.getDate()), exact: true }).click();
    const expectedLabel = target.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    await expect(page.getByRole('button', { name: expectedLabel })).toBeVisible();

    await page.getByRole('button', { name: /^\d{1,2}:\d{2} (AM|PM) –/ }).first().click();
    await page.getByRole('button', { name: /Next: Details/ }).click();
  });

  await test.step(`Items: ${pestType} - first property type`, async () => {
    await expect(page.getByRole('heading', { name: 'Service details' })).toBeVisible();
    await expect(
      page.getByRole('img', { name: pestType, exact: true }),
      'Service types did not load on the Items step',
    ).toBeVisible({ timeout: 30_000 });
    await page.locator('div')
      .filter({ has: page.getByRole('img', { name: pestType, exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Add', exact: true }) })
      .last()
      .getByRole('button', { name: 'Add', exact: true })
      .click();

    const typeDialog = page.getByRole('heading', { name: 'Select Type' }).locator('xpath=../..');
    await typeDialog.getByRole('button', { name: 'Add', exact: true }).first().click();
    await typeDialog.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue →' }).click();
  });

  await test.step('Choose Pro: fixed price, let UtilStop choose', async () => {
    await expect(page.getByRole('heading', { name: 'Choose your Pro' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Fixed Price' })).toBeChecked();
    await page.getByRole('button', { name: /Let UtilStop choose for you/ }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
  });

  await test.step('Review booking', async () => {
    await expect(page.getByRole('heading', { name: 'Review your booking' })).toBeVisible();
    await expect(page.getByText(new RegExp(`${pestType} - `))).toBeVisible();
    await page.getByRole('button', { name: /Proceed to payment/ }).click();
  });

  await test.step('Payment: choose Cash', async () => {
    await expect(
      page.getByRole('heading', { name: 'Complete Payment' }),
      'Payment summary did not load (dev API /getPaymentByCartID may be failing)',
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
    await expect(page.getByText('Cash Handling Fee')).toBeVisible();
  });

  await test.step('Payment: apply coupon', async () => {
    if (couponCode) {
      await page.getByPlaceholder('Enter Coupon Code').fill(couponCode);
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
    } else {
      // First-coupon suggestion card ("<CODE> - <x> OFF ... Apply")
      const suggestion = page.getByRole('button', { name: / OFF.*Apply$/ });
      await expect(suggestion, 'No coupon offered; set TEST_COUPON').toBeVisible();
      await suggestion.click();
    }
    await expect(page.getByText('Coupon code is not correct or Coupon is expired!')).toBeHidden();
    await expect(page.getByText(/^Coupon \(.+\)$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    // A 100% coupon forces Cash on its own; either way Cash must still be selected.
    await expect(page.getByText('Cash Handling Fee')).toBeVisible();
  });

  let displayBookingId = '';
  await test.step('Complete booking', async () => {
    // Desktop pay button reads "Pay AED <total>"; the "Pay Now" option button has no amount.
    await page.getByRole('button', { name: /^Pay\b.*\d/ }).click();

    await expect(page).toHaveURL(/\/booking\/[^/]+\/success/, { timeout: 90_000 });
    await expect(page.getByRole('heading', { name: 'Booking Confirmed' })).toBeVisible();
    await expect(page.getByText('Your Booking has been successfully scheduled')).toBeVisible();

    // Shows the encrypted id until booking details load, then the display id (PC_…)
    const idLine = page.getByText(/^Booking ID: /);
    await expect(idLine).toHaveText(/^Booking ID: PC_\d+$/);
    displayBookingId = (await idLine.textContent())!.replace('Booking ID:', '').trim();
  });

  test.info().annotations.push({ type: 'booking', description: displayBookingId });

  await test.step('My Bookings: complete payment with card', async () => {
    await completeCardPayment(page, displayBookingId);
  });
});
