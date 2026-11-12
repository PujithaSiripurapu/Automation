const nodemailer = require('nodemailer');
const fs = require('fs');
const archiverModule = require('archiver');
const archiver = archiverModule.default || archiverModule;

// TEST_STATUS is the test step outcome from the workflow: success | failure.
const status = { success: 'PASSED', failure: 'FAILED' }[process.env.TEST_STATUS] ?? process.env.TEST_STATUS;

async function sendReport() {
    const output = fs.createWriteStream('report.zip');
    const archive = archiver('zip');

    archive.pipe(output);
    archive.directory('playwright-report/', false);
    await archive.finalize();

    await new Promise((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
    });

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT),
        secure: true,
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
    console.error('Email failed:', error);
    process.exitCode = 1;
});