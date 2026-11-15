const nodemailer = require('nodemailer');
const fs = require('fs');
// archiver v8 exports archive classes instead of the old archiver('zip') factory.
const { ZipArchive } = require('archiver');

// TEST_STATUS is the test step outcome from the workflow: success | failure.
const status = { success: 'PASSED', failure: 'FAILED' }[process.env.TEST_STATUS] ?? process.env.TEST_STATUS;
// PAYMENT_MODE is the mode this run booked with: cash | card.
const payment = { cash: 'Cash', card: 'Card' }[process.env.PAYMENT_MODE] ?? process.env.PAYMENT_MODE;

const REQUIRED_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'REPORT_TO'];

// Secrets pasted into GitHub often pick up stray spaces, newlines or quotes around the value.
for (const name of REQUIRED_ENV) {
    if (process.env[name]) process.env[name] = process.env[name].trim().replace(/^(["'])(.*)\1$/, '$2').trim();
}

async function zipReport(sourceDir, zipPath) {
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    // Listen before finalize() so the 'close' event cannot be missed.
    const done = new Promise((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
    });

    archive.pipe(output);
    archive.directory(sourceDir, false);
    await archive.finalize();
    await done;
}

async function sendReport() {
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
    // No email settings at all: email isn't set up yet, so skip with a warning instead of
    // failing a run whose test passed. Only some missing: a typo, so still fail.
    if (missing.length === REQUIRED_ENV.length) {
        console.log(`::warning::Report email skipped: add ${REQUIRED_ENV.join(', ')} as GitHub Actions repository secrets to get it.`);
        return false;
    }
    if (missing.length) {
        throw new Error(`Missing email settings: ${missing.join(', ')} (add them as GitHub Actions secrets)`);
    }
    if (!fs.existsSync('playwright-report')) {
        throw new Error('playwright-report/ not found — run the tests with the html reporter first');
    }

    await zipReport('playwright-report/', 'report.zip');

    const port = Number(process.env.SMTP_PORT);
    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465, // 465 = implicit TLS; 587/25 upgrade via STARTTLS
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD
        }
    });

    await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.REPORT_TO,
        subject: `Pest Control Automation Report${payment ? ` (${payment})` : ''}${status ? ` - ${status}` : ''}`,
        text: [
            'Hello Team, please find the latest Playwright execution report attached.',
            status && `Result: ${status}`,
            payment && `Payment mode: ${payment}`,
            process.env.RUN_URL && `Run details: ${process.env.RUN_URL}`,
        ].filter(Boolean).join('\n\n'),
        attachments: [{
            filename: 'QA-Report.zip',
            path: 'report.zip'
        }]
    });

    console.log('Email report sent successfully!');
    return true;
}

sendReport().catch(error => {
    console.error('Email failed:', error.message ?? error);
    const hint = {
        ENOTFOUND: 'SMTP_HOST is not a mail server name. Use just the host, e.g. smtp.gmail.com, smtp.mail.yahoo.com or smtp.office365.com (no email address, https:// or port).',
        EAUTH: 'SMTP_USER / SMTP_PASSWORD were rejected. Use the full email address and an app password, not your normal password.',
        ETIMEDOUT: 'Could not reach the mail server. Check SMTP_PORT: 587 for Gmail/Outlook, 465 for Yahoo.',
        ECONNREFUSED: 'The mail server refused the connection. Check SMTP_HOST and SMTP_PORT (587 or 465).',
        ESOCKET: 'TLS problem talking to the mail server. Check SMTP_PORT: 587 for Gmail/Outlook, 465 for Yahoo.',
    }[/ENOTFOUND/.test(error.message) ? 'ENOTFOUND' : error.code];
    if (hint) console.error(`::error::${hint}`);
    process.exitCode = 1;
});
