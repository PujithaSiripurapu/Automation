const nodemailer = require('nodemailer');
const fs = require('fs');
// archiver v8 exports archive classes instead of the old archiver('zip') factory.
const { ZipArchive } = require('archiver');

// TEST_STATUS is the test step outcome from the workflow: success | failure.
const status = { success: 'PASSED', failure: 'FAILED' }[process.env.TEST_STATUS] ?? process.env.TEST_STATUS;

const REQUIRED_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'REPORT_TO'];

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
        subject: `Pest Control Automation Report${status ? ` - ${status}` : ''}`,
        text: [
            'Hello Team, please find the latest Playwright execution report attached.',
            status && `Result: ${status}`,
            process.env.RUN_URL && `Run details: ${process.env.RUN_URL}`,
        ].filter(Boolean).join('\n\n'),
        attachments: [{
            filename: 'QA-Report.zip',
            path: 'report.zip'
        }]
    });

    console.log('Email report sent successfully!');
}

sendReport().catch(error => {
    console.error('Email failed:', error.message ?? error);
    process.exitCode = 1;
});
