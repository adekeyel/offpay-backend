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
  });
  return transporter;
}

/**
 * Sends OTP via email. Falls back to console logging when SMTP creds are absent
 * or MOCK_OTP_CONSOLE=true, so the whole app is runnable/demo-able with zero setup.
 */
async function sendOtpEmail(to, code, purpose) {
  const subject = `Your OffPay verification code`;
  const text = `Your ${purpose.replace('_', ' ')} code is ${code}. It expires in ${env.security.otpExpiryMinutes} minutes. Never share this code with anyone — OffPay staff will never ask for it.`;

  if (env.smtp.mockConsole || !env.smtp.host || !env.smtp.user) {
    logger.info(`[MOCK EMAIL to ${to}] ${subject}: ${text}`);
    return { mocked: true };
  }

  try {
    await getTransporter().sendMail({ from: env.smtp.from, to, subject, text });
    return { mocked: false };
  } catch (err) {
    logger.warn('Email send failed, falling back to console log:', err.message);
    logger.info(`[FALLBACK EMAIL to ${to}] ${subject}: ${text}`);
    return { mocked: true, error: err.message };
  }
}

async function sendGenericEmail(to, subject, text) {
  if (env.smtp.mockConsole || !env.smtp.host || !env.smtp.user) {
    logger.info(`[MOCK EMAIL to ${to}] ${subject}: ${text}`);
    return;
  }
  await getTransporter().sendMail({ from: env.smtp.from, to, subject, text });
}

module.exports = { sendOtpEmail, sendGenericEmail };
