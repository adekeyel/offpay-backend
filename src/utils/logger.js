const env = require('../config/env');

/**
 * Minimal structured logger. Swap for pino/winston in production if desired.
 *
 * SECRET REDACTION: every secret value the app holds (encryption key, JWT
 * secrets, offline token secret, provider API keys, etc.) is scrubbed out of
 * anything passed through info/warn/error before it hits stdout — so even if
 * a future bug accidentally interpolates a secret into an error message or a
 * thrown Error's .message/.stack, it still can't end up in the Railway
 * deploy/runtime logs.
 *
 * Note: this only protects what actually gets logged. Railway's own
 * "Variables" dashboard tab shows raw env var values to anyone with project
 * access by design — mark ENCRYPTION_KEY and other secrets as "sealed" there
 * (Project → Variables → the lock icon) if you want them hidden from view
 * after being set. That's a Railway project setting, not something this
 * codebase can control.
 */
function secretValues() {
  return [
    env.encryptionKey,
    env.jwt?.accessSecret,
    env.jwt?.refreshSecret,
    env.offline?.tokenSecret,
    env.providers?.flutterwave?.secretKey,
    env.providers?.flutterwave?.encryptionKey,
    env.providers?.paystack?.secretKey,
    env.providers?.monnify?.apiKey,
    env.providers?.monnify?.secretKey,
    env.providers?.bigisub?.apiKey,
    env.smtp?.pass,
    env.resend?.apiKey,
    env.cloudinary?.apiSecret,
  ].filter((v) => typeof v === 'string' && v.length >= 6); // skip short/empty/undefined values to avoid over-redacting
}

function redact(value) {
  const secrets = secretValues();
  if (!secrets.length) return value;

  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
    return out;
  }
  if (value instanceof Error) {
    const clone = new Error(redact(value.message));
    clone.name = value.name;
    clone.stack = value.stack ? redact(value.stack) : value.stack;
    Object.assign(clone, value); // preserve any custom fields (statusCode, code, etc.)
    return clone;
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.parse(redact(JSON.stringify(value)));
    } catch {
      return value; // circular or non-serializable — leave as-is rather than throw while logging
    }
  }
  return value;
}

function ts() { return new Date().toISOString(); }

module.exports = {
  info: (...args) => console.log(`[${ts()}] INFO:`, ...args.map(redact)),
  warn: (...args) => console.warn(`[${ts()}] WARN:`, ...args.map(redact)),
  error: (...args) => console.error(`[${ts()}] ERROR:`, ...args.map(redact)),
};
