// Send-to-PocketBook: emails the nightly digest EPUB as an attachment to the
// device's own username@pbsync.com address (see leesmap-plan.md). Unlike the
// X4's OPDS pull, PocketBook Cloud downloads mail sent to that address
// automatically once the device has WiFi — no on-device browsing step.
//
// PocketBook only delivers mail from a white-listed sender (the contact
// address you registered Send-to-PocketBook with is trusted by default); an
// unrecognised sender gets a one-time confirmation email instead of the file
// being delivered. Set SMTP_FROM to that registered address, or confirm the
// prompt PocketBook sends after the first attempt.

import nodemailer from 'nodemailer';
import { env } from './config.js';

export function isConfigured() {
  return Boolean(env.pocketbookEmail && env.smtpHost && env.smtpUser && env.smtpPass);
}

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUser, pass: env.smtpPass },
    });
  }
  return transporter;
}

// Mail one EPUB to the configured PocketBook device address. Throws on
// failure — callers decide whether that should affect anything else.
export async function sendToPocketbook(buffer, filename, title) {
  await getTransporter().sendMail({
    from: env.smtpFrom,
    to: env.pocketbookEmail,
    subject: title || filename,
    text: 'Automatisch verstuurd door Leesmap.',
    attachments: [{ filename, content: buffer, contentType: 'application/epub+zip' }],
  });
}
