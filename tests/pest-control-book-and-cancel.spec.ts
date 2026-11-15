import { expect as baseExpect, type Page } from '@playwright/test';
import { addPestPhoto, openLoggedIn, pickDateDaysAhead, test } from './support/utilstop';

/**
 * End-to-end: UAE customer logs in (phone + OTP), books Pest Control for a future date,
 * then opens My Bookings and cancels that same booking.
 *
 * Runs on GitHub Actions: on every push (playwright.yml) and every 2 hours (pest-book-cancel.yml).
 *
 * Env overrides: TEST_PHONE, TEST_OTP, TEST_PEST_TYPE, TEST_DAYS_AHEAD.
 */

// dev.utilstop.com is a Vite dev server; lazy pages can take well over 5s to render.
const expect = baseExpect.configure({ timeout: 30_000 });

// Headed (visible browser) locally; headless on CI (no display) or when HEADLESS=1.
test.use({ headless: process.env.HEADLESS === '1' || !!process.env.CI });

const pestType = process.env.TEST_PEST_TYPE ?? 'Cockroaches';
// Cancel Booking is only offered when the service is more than 24h away, so keep this >= 2.
const daysAhead = Number(process.env.TEST_DAYS_AHEAD ?? 7);

// The dev API rate-limits endpoints (e.g. /api/services_web: 30 requests / 15 min).
// Track 429s so a failure caused by the server's rate limit is reported as such.
const rateLimited = new Set<string>();
let servicesWebCalls = 0;

test.beforeEach(async ({ page }) => {
  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('/api/')) return;
    if (url.includes('/api/services_web')) servicesWebCalls++;
    if (response.status() === 429) rateLimited.add(url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*/, ''));
  });
});

test.afterEach(async ({}, testInfo) => {
  testInfo.annotations.push({ type: 'services_web calls', description: String(servicesWebCalls) });
  console.log(`services_web calls this run: ${servicesWebCalls}`);
  if (rateLimited.size) {
    const note = `dev API rate limit (HTTP 429) hit on: ${[...rateLimited].join(', ')} — wait ~15 min`;
    testInfo.annotations.push({ type: 'rate-limit', description: note });
    console.error(note);
  }
});

function bookingCard(page: Page, displayBookingId: string) {
  return page.getByRole('link', { name: new RegExp(`Booking ID: .*${displayBookingId}\\b`) });
}

test('UAE customer books Pest Control for a future date, then cancels it from My Bookings', async ({ page }) => {
  test.setTimeout(300_000);
  expect(daysAhead, 'TEST_DAYS_AHEAD must be >= 2 so the booking can be cancelled').toBeGreaterThanOrEqual(2);

  await test.step('Login with UAE phone number and OTP', async () => {
    await openLoggedIn(page, '/services/pest-control/book');
  });

  await test.step(`Location: saved address, date (+${daysAhead} days) and time slot`, async () => {
    await expect(
      page.getByRole('heading', { name: 'Pest Control', level: 1 }).or(page.getByText('Service not found.')),
    ).toBeVisible();
    await expect(page.getByText('Service not found.'), 'Pest Control did not load (dev API rate limit?)').toBeHidden();

    const addressDialog = page.getByRole('heading', { name: 'Saved Addresses' }).locator('xpath=../..');
    // If the click lands before saved addresses have loaded, the app opens the empty
    // "Add Address" form instead; close it and try again until the saved list shows.
    const addAddressForm = page.getByRole('button', { name: '← Add Address' });
    await expect(async () => {
      if (await addressDialog.isVisible()) return;
      if (await addAddressForm.isVisible()) {
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(addAddressForm).toBeHidden();
      }
      await page.getByRole('button', { name: /Select your service location/ }).click({ timeout: 5_000 });
      await expect(addressDialog).toBeVisible({ timeout: 5_000 });
    }, 'Saved Addresses dialog did not open').toPass({ intervals: [2_000], timeout: 60_000 });
    await expect(addressDialog.getByText('Dubai').first(), 'Account needs at least one saved Dubai address').toBeVisible();
    await addressDialog.getByText('Dubai').first().click();
    await expect(page.getByRole('heading', { name: 'Saved Addresses' })).toBeHidden();

    await pickDateDaysAhead(page, daysAhead);

    await page.getByRole('button', { name: /^\d{1,2}:\d{2} (AM|PM) –/ }).first().click();
    await page.getByRole('button', { name: /Next: Details/ }).click();
  });

  await test.step(`Items: ${pestType} - first property type`, async () => {
    await expect(page.getByRole('heading', { name: 'Service details' })).toBeVisible();
    const pestImage = page.getByRole('img', { name: pestType, exact: true });
    // The service list occasionally comes back empty; going Back and Next refetches it.
    await expect(async () => {
      if (!(await pestImage.isVisible())) {
        await page.getByRole('button', { name: 'Back', exact: true }).click();
        await page.getByRole('button', { name: /Next: Details/ }).click();
      }
      await expect(pestImage).toBeVisible({ timeout: 15_000 });
    }, 'Service types did not load on the Items step').toPass({ timeout: 60_000 });

    await page.locator('div')
      .filter({ has: pestImage })
      .filter({ has: page.getByRole('button', { name: 'Add', exact: true }) })
      .last()
      .getByRole('button', { name: 'Add', exact: true })
      .click();

    const typeDialog = page.getByRole('heading', { name: 'Select Type' }).locator('xpath=../..');
    await typeDialog.getByRole('button', { name: 'Add', exact: true }).first().click();
    await typeDialog.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue →' }).click();

    // Photos are mandatory: Continue opens "Add Information" asking for a gallery photo.
    await addPestPhoto(page);
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

  await test.step('Payment: Cash', async () => {
    await expect(
      page.getByRole('heading', { name: 'Complete Payment' }),
      'Payment summary did not load (dev API /getPaymentByCartID may be failing)',
    ).toBeVisible();
    await page.getByRole('button', { name: 'Cash', exact: true }).click();
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
    test.info().annotations.push({ type: 'booking', description: displayBookingId });
    console.log(`Booked ${displayBookingId}`);
  });

  await test.step(`My Bookings: open ${displayBookingId}`, async () => {
    // In-app navigation (no full page reload) keeps rate-limited API calls down.
    await page.getByRole('banner').getByRole('link', { name: 'My Bookings' }).click();
    await expect(page.getByRole('heading', { name: 'My Bookings', level: 1 })).toBeVisible();
    await expect(bookingCard(page, displayBookingId)).toBeVisible({ timeout: 60_000 });
    await bookingCard(page, displayBookingId).click();

    await expect(page.getByRole('heading', { name: 'Track Your Service' })).toBeVisible();
    await page.getByRole('link', { name: 'View Booking Details' }).click();
    await expect(page).toHaveURL(/\/booking\/[^/]+\/details/);
    await expect(page.getByText(`Booking ID: ${displayBookingId}`)).toBeVisible();
  });

  await test.step(`Cancel booking ${displayBookingId}`, async () => {
    // Only offered while Booked/Confirmed/Agent Assigned, >24h before service, and no OTP issued.
    const cancelButton = page.getByRole('button', { name: 'Cancel Booking', exact: true });
    await expect(cancelButton, 'Cancel Booking not offered for this booking').toBeVisible();
    await cancelButton.click();

    const confirmDialog = page.getByRole('heading', { name: 'Cancel booking', exact: true }).locator('xpath=..');
    await expect(confirmDialog.getByText('Are you sure want to cancel the booking?')).toBeVisible();
    await confirmDialog.getByRole('button', { name: 'Yes', exact: true }).click();

    // On success the app returns to My Bookings.
    await expect(page).toHaveURL(/\/account\/bookings/);
    await expect(bookingCard(page, displayBookingId)).toContainText('Cancelled', { timeout: 60_000 });
    console.log(`Cancelled ${displayBookingId}`);
  });
});
