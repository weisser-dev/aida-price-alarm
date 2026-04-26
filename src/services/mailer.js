const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!config.smtp.host) return null;

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
  });
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    console.log('--- [mailer] SMTP nicht konfiguriert, Mail wird nur geloggt ---');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text);
    console.log('---------------------------------------------------------------');
    return { mocked: true };
  }
  return t.sendMail({ from: config.smtp.from, to, subject, text, html });
}

module.exports = { sendMail };
