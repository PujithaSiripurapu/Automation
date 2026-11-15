// @ts-check
/**
 * Playwright reporter that writes a readable PDF of each run:
 *   test-report/report.pdf   – result banner, booking (order) ID, payment mode, every step
 *                              with pass/fail and time, the error in plain text, and the
 *                              screenshots taken during the run (see snap() in tests/support).
 *   test-report/report.html  – the same report as a web page.
 *   test-report/summary.json – the same facts for the report email (send-report.js).
 *
 * Runs locally and on GitHub Actions. A problem building the PDF is logged and never
 * changes the test result.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'test-report');
const PDF_PATH = path.join(OUT_DIR, 'report.pdf');
const SUMMARY_PATH = path.join(OUT_DIR, 'summary.json');

const stripAnsi = (s = '') => s.replace(/\u001b\[[0-9;]*m/g, '');
const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const secs = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const when = (date, timeZone) =>
  date.toLocaleString('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

class PdfReporter {
  constructor() {
    /** @type {{ test: import('@playwright/test/reporter').TestCase, results: import('@playwright/test/reporter').TestResult[] }[]} */
    this.tests = [];
    this.startTime = new Date();
  }

  onBegin() {
    this.startTime = new Date();
  }

  onTestEnd(test, result) {
    let entry = this.tests.find((t) => t.test === test);
    if (!entry) this.tests.push((entry = { test, results: [] }));
    entry.results.push(result);
  }

  async onEnd(fullResult) {
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const summary = this.buildSummary(fullResult);
      // Screenshots stay in the PDF only; the JSON keeps just their titles.
      fs.writeFileSync(
        SUMMARY_PATH,
        JSON.stringify(summary, (key, value) => (key === 'body' || key === 'path' ? undefined : value), 2),
      );
      await this.writePdf(summary);
      console.log(`\nPDF report: ${path.relative(process.cwd(), PDF_PATH)}  (${summary.status}${summary.bookingId ? `, ${summary.bookingId}` : ''})`);
    } catch (error) {
      console.error(`PDF report could not be created: ${error && error.stack ? error.stack : error}`);
    }
  }

  buildSummary(fullResult) {
    const tests = this.tests.map(({ test, results }) => {
      const last = results[results.length - 1];
      const notes = {};
      for (const a of [...(test.annotations || []), ...(last.annotations || [])]) {
        if (a.description) notes[a.type] = a.description;
      }
      const steps = (last.steps || [])
        .filter((s) => s.category === 'test.step')
        .map((s) => ({ title: s.title, ok: !s.error, duration: s.duration, error: s.error ? stripAnsi(s.error.message) : '' }));
      const failedStep = steps.find((s) => !s.ok);
      const error = last.errors && last.errors.length ? last.errors[0] : last.error;
      const earlierFailures = results.slice(0, -1).map((r, i) => ({
        attempt: i + 1,
        error: stripAnsi((r.errors && r.errors[0] && r.errors[0].message) || (r.error && r.error.message) || r.status),
      }));
      const screenshots = last.attachments
        .filter((a) => a.contentType && a.contentType.startsWith('image/'))
        .map((a) => ({ title: a.name === 'screenshot' ? 'Screen at the moment of failure' : a.name, contentType: a.contentType, path: a.path, body: a.body }));
      return {
        title: test.title,
        outcome: test.outcome(), // expected | unexpected | flaky | skipped
        status: last.status,
        duration: last.duration,
        attempts: results.length,
        bookingId: notes.booking || '',
        paymentMode: notes.payment || '',
        steps,
        failedStep: failedStep ? failedStep.title : '',
        error: error ? stripAnsi(error.message || String(error.value || '')) : '',
        errorLocation: error && error.location ? `${path.relative(process.cwd(), error.location.file)}:${error.location.line}` : '',
        errorSnippet: error && error.snippet ? stripAnsi(error.snippet) : '',
        earlierFailures,
        screenshots,
      };
    });

    const main = tests[0] || {};
    const passed = fullResult.status === 'passed';
    const runUrl =
      process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
        ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : '';
    return {
      status: passed ? 'PASSED' : 'FAILED',
      passedOnRetry: passed && main.outcome === 'flaky',
      bookingId: main.bookingId || '',
      paymentMode: main.paymentMode || '',
      failedStep: main.failedStep || '',
      error: main.error || (fullResult.status === 'timedout' ? 'The whole run timed out.' : ''),
      started: this.startTime.toISOString(),
      startedDubai: when(this.startTime, 'Asia/Dubai'),
      startedIndia: when(this.startTime, 'Asia/Kolkata'),
      duration: fullResult.duration,
      ranOn: process.env.GITHUB_ACTIONS ? 'GitHub Actions' : 'Local computer',
      runUrl,
      site: 'https://dev.utilstop.com',
      tests,
    };
  }

  imageSrc(shot) {
    let data = shot.body;
    if (!data && shot.path && fs.existsSync(shot.path)) data = fs.readFileSync(shot.path);
    return data ? `data:${shot.contentType};base64,${Buffer.from(data).toString('base64')}` : '';
  }

  html(summary) {
    const ok = summary.status === 'PASSED';
    const mode = { cash: 'Cash', card: 'Card (Pay Now, Stripe test card)' }[summary.paymentMode] || summary.paymentMode || '—';
    const sections = summary.tests
      .map((t) => {
        const steps = t.steps
          .map(
            (s, i) => `<tr class="${s.ok ? 'ok' : 'bad'}"><td class="n">${i + 1}</td><td class="mark">${s.ok ? '✓' : '✗'}</td>
              <td>${esc(s.title)}${s.error ? `<div class="err-inline">${esc(s.error.split('\n')[0])}</div>` : ''}</td><td class="t">${secs(s.duration)}</td></tr>`,
          )
          .join('');
        const errorBox = t.error
          ? `<h2>Error</h2><div class="errbox">
              ${t.failedStep ? `<p><b>Failed at step:</b> ${esc(t.failedStep)}</p>` : ''}
              ${t.errorLocation ? `<p><b>Where in the code:</b> ${esc(t.errorLocation)}</p>` : ''}
              <pre>${esc(t.error)}</pre>
              ${t.errorSnippet ? `<pre class="snippet">${esc(t.errorSnippet)}</pre>` : ''}</div>`
          : '';
        const retries = t.earlierFailures.length
          ? `<div class="note">Attempt${t.earlierFailures.length > 1 ? 's' : ''} before the final one failed and ${ok ? 'the retry passed' : 'were retried'}:<ul>${t.earlierFailures
              .map((f) => `<li>Attempt ${f.attempt}: ${esc(f.error.split('\n')[0])}</li>`)
              .join('')}</ul></div>`
          : '';
        const shots = t.screenshots
          .map((s, i) => {
            const src = this.imageSrc(s);
            return src
              ? `<figure class="${s.title.startsWith('Screen at the moment of failure') ? 'failshot' : ''}"><figcaption>${i + 1}. ${esc(s.title)}</figcaption><img src="${src}"></figure>`
              : '';
          })
          .join('');
        return `<h2>Steps</h2><p class="sub">${esc(t.title)}</p>
          <table class="steps"><thead><tr><th>#</th><th></th><th>Step</th><th>Time</th></tr></thead><tbody>${steps || '<tr><td colspan="4">No steps recorded.</td></tr>'}</tbody></table>
          ${retries}${errorBox}
          ${shots ? `<h2 class="pb">Screenshots of the run</h2>${shots}` : ''}`;
      })
      .join('');

    return `<!doctype html><html><head><meta charset="utf-8"><title>Pest Control Automation Report</title><style>
      * { box-sizing: border-box; }
      body { font-family: "Segoe UI", Arial, sans-serif; color: #1f2933; font-size: 12px; margin: 0; }
      h1 { font-size: 20px; margin: 0 0 4px; }
      h2 { font-size: 15px; margin: 22px 0 8px; border-bottom: 2px solid #e4e7eb; padding-bottom: 4px; }
      .sub { color: #616e7c; margin: 0 0 8px; }
      .banner { border-radius: 8px; padding: 16px 20px; color: #fff; background: ${ok ? '#1e8e3e' : '#c62828'}; margin: 12px 0 16px; }
      .banner .big { font-size: 28px; font-weight: 700; letter-spacing: 1px; }
      .banner .small { font-size: 13px; opacity: .95; margin-top: 4px; }
      table { border-collapse: collapse; width: 100%; }
      .facts td { padding: 6px 8px; border-bottom: 1px solid #e4e7eb; vertical-align: top; }
      .facts td:first-child { width: 32%; color: #52606d; font-weight: 600; }
      .facts .id { font-size: 16px; font-weight: 700; }
      .steps th { text-align: left; background: #f5f7fa; padding: 6px 8px; border-bottom: 1px solid #cbd2d9; }
      .steps td { padding: 6px 8px; border-bottom: 1px solid #e4e7eb; vertical-align: top; }
      .steps .n { width: 28px; color: #7b8794; } .steps .mark { width: 22px; font-weight: 700; font-size: 14px; }
      .steps .t { width: 60px; text-align: right; color: #52606d; white-space: nowrap; }
      .steps tr.ok .mark { color: #1e8e3e; } .steps tr.bad { background: #fdecea; } .steps tr.bad .mark { color: #c62828; }
      .err-inline { color: #c62828; margin-top: 3px; }
      .errbox { border: 1px solid #f5c2c0; background: #fdecea; border-radius: 6px; padding: 10px 12px; }
      .errbox p { margin: 0 0 6px; }
      pre { white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; font-size: 10.5px; margin: 6px 0 0; }
      .snippet { background: #fff; border: 1px solid #f5c2c0; padding: 6px; }
      .note { background: #fff8e1; border: 1px solid #ffe08a; border-radius: 6px; padding: 8px 12px; margin-top: 10px; }
      .note ul { margin: 4px 0 0 18px; padding: 0; }
      figure { margin: 0 0 14px; page-break-inside: avoid; }
      figcaption { font-weight: 600; margin-bottom: 4px; }
      figure img { width: 100%; border: 1px solid #cbd2d9; border-radius: 4px; }
      figure.failshot figcaption { color: #c62828; } figure.failshot img { border: 2px solid #c62828; }
      .pb { page-break-before: always; }
      a { color: #1a5fb4; word-break: break-all; }
    </style></head><body>
      <h1>Pest Control Automation Report</h1>
      <div class="sub">UtilStop · Book Pest Control, then cancel it · ${esc(summary.site)}</div>
      <div class="banner"><div class="big">${ok ? '✓ PASSED' : '✗ FAILED'}</div>
        <div class="small">${
          ok
            ? `Booking ${esc(summary.bookingId || '')} was created${summary.paymentMode ? ` with ${esc(mode)}` : ''} and cancelled successfully.${summary.passedOnRetry ? ' (Passed on retry.)' : ''}`
            : `Failed${summary.failedStep ? ` at: ${esc(summary.failedStep)}` : ''}. ${esc((summary.error || '').split('\n')[0])}`
        }</div></div>
      <table class="facts">
        <tr><td>Booking / Order ID</td><td class="id">${esc(summary.bookingId || (ok ? '—' : 'Not created (failed before booking was confirmed)'))}</td></tr>
        <tr><td>Payment mode</td><td>${esc(mode)}</td></tr>
        <tr><td>Result</td><td>${ok ? 'PASSED' : 'FAILED'}${summary.passedOnRetry ? ' (on retry)' : ''}</td></tr>
        <tr><td>Started</td><td>${esc(summary.startedDubai)} (Dubai) · ${esc(summary.startedIndia)} (India)</td></tr>
        <tr><td>Total time</td><td>${secs(summary.duration)}</td></tr>
        <tr><td>Ran on</td><td>${esc(summary.ranOn)}</td></tr>
        ${summary.runUrl ? `<tr><td>GitHub run</td><td><a href="${esc(summary.runUrl)}">${esc(summary.runUrl)}</a></td></tr>` : ''}
      </table>
      ${sections}
    </body></html>`;
  }

  async writePdf(summary) {
    const { chromium } = require('@playwright/test');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const html = this.html(summary);
      fs.writeFileSync(path.join(OUT_DIR, 'report.html'), html); // same report, viewable in a browser
      await page.setContent(html, { waitUntil: 'load' });
      await page.pdf({
        path: PDF_PATH,
        format: 'A4',
        printBackground: true,
        margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate:
          '<div style="font-size:8px;color:#7b8794;width:100%;text-align:center;">Pest Control Automation Report · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      });
    } finally {
      await browser.close();
    }
  }
}

module.exports = PdfReporter;
