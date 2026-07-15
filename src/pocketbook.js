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

// Second device (Marieke's reader). PocketBook ties the registered
// contact/sender address to one account, so this needs its own sender
// identity (a second mailbox) rather than reusing SMTP_FROM — see
// .env.example for the SMTP_*_MARIEKE setup.
export function isConfiguredMarieke() {
  return Boolean(
    env.pocketbookEmailMarieke && env.smtpHost && env.smtpUserMarieke && env.smtpPassMarieke
  );
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

let transporterMarieke;
function getTransporterMarieke() {
  if (!transporterMarieke) {
    transporterMarieke = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUserMarieke, pass: env.smtpPassMarieke },
    });
  }
  return transporterMarieke;
}

async function mail(transport, from, to, buffer, filename, title) {
  await transport.sendMail({
    from,
    to,
    subject: title || filename,
    text: 'Automatisch verstuurd door Leesmap.',
    attachments: [{ filename, content: buffer, contentType: 'application/epub+zip' }],
  });
}

// Mail one EPUB to the configured PocketBook device address. Throws on
// failure — callers decide whether that should affect anything else.
export async function sendToPocketbook(buffer, filename, title) {
  await mail(getTransporter(), env.smtpFrom, env.pocketbookEmail, buffer, filename, title);
}

export async function sendToPocketbookMarieke(buffer, filename, title) {
  await mail(
    getTransporterMarieke(),
    env.smtpFromMarieke,
    env.pocketbookEmailMarieke,
    buffer,
    filename,
    title
  );
}
