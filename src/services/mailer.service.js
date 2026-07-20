const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('../utils/logger');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.port === 465,
    auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
    // Without these, an unreachable/blocked SMTP host (common on PaaS platforms
    // that block outbound mail ports) hangs the whole request for minutes with
    // no error, instead of failing fast so we can fall back to console logging.
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  });
  return transporter;
}

/**
 * Sends via Resend's HTTPS API. Preferred over SMTP because several PaaS hosts
 * (Railway included, on Free/Trial/Hobby plans) block outbound SMTP ports
 * entirely and only allow HTTPS-based provider APIs.
 * Returns true on success, throws on failure (caller decides how to fall back).
 */
async function sendViaResendApi({ to, subject, text }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.resend.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.resend.from, to: [to], subject, text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend API responded ${res.status}: ${body.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sends a plain-text email using, in order of preference:
 *   1. Resend's HTTPS API (if RESEND_API_KEY is set) — works on hosts that block SMTP.
 *   2. Raw SMTP (if SMTP_HOST/SMTP_USER are set) — for local dev or SMTP-friendly hosts.
 *   3. Console log fallback — so the app is runnable/demo-able with zero setup, and so
 *      a delivery failure never blocks the underlying request (registration/login).
 */
async function deliver(to, subject, text) {
  const hasRealProvider = Boolean(env.resend.apiKey) || Boolean(env.smtp.host && env.smtp.user);

  if (env.smtp.forceMockConsole || !hasRealProvider) {
    logger.info(`[MOCK EMAIL to ${to}] ${subject}: ${text}`);
    if (!hasRealProvider && !env.smtp.forceMockConsole) {
      logger.warn(
        `No email provider configured (RESEND_API_KEY or SMTP_HOST/SMTP_USER) — "${to}" did NOT receive this email, it only appears in this log. Set RESEND_API_KEY on Railway to actually deliver it.`
      );
    }
    return { mocked: true };
  }

  if (env.resend.apiKey) {
    try {
      await sendViaResendApi({ to, subject, text });
      return { mocked: false, provider: 'resend' };
    } catch (err) {
      logger.warn('Resend API send failed, falling back:', err.message);
      // fall through to SMTP (if configured) or console below
    }
  }

  if (env.smtp.host && env.smtp.user) {
    try {
      await getTransporter().sendMail({ from: env.smtp.from, to, subject, text });
      return { mocked: false, provider: 'smtp' };
    } catch (err) {
      logger.warn('SMTP send failed, falling back to console log:', err.message);
    }
  }

  logger.info(`[FALLBACK EMAIL to ${to}] ${subject}: ${text}`);
  return { mocked: true };
}

/** Sends OTP via email (register/login verification codes). */
async function sendOtpEmail(to, code, purpose) {
  const subject = `Your OffPay verification code`;
  const text = `Your ${purpose.replace('_', ' ')} code is ${code}. It expires in ${env.security.otpExpiryMinutes} minutes. Never share this code with anyone — OffPay staff will never ask for it.`;
  return deliver(to, subject, text);
}

async function sendGenericEmail(to, subject, text) {
  return deliver(to, subject, text);
}

module.exports = { sendOtpEmail, sendGenericEmail };
