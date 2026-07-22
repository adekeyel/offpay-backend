require('dotenv').config();

function required(name, fallback = undefined) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    console.warn(`⚠️  Missing environment variable: ${name}`);
  }
  return val;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  appName: process.env.APP_NAME || 'OffPay',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',

  // Used to encrypt BVN (and any other field-level-encrypted PII) at rest.
  // Any length string works -- it's hashed down to a 32-byte key internally,
  // see src/utils/encryption.js. Set a long random value in production.
  encryptionKey: required('ENCRYPTION_KEY', 'dev_encryption_key_change_me'),

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET', 'dev_access_secret_change_me'),
    refreshSecret: required('JWT_REFRESH_SECRET', 'dev_refresh_secret_change_me'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '180d',
  },

  offline: {
    tokenSecret: required('OFFLINE_TOKEN_SECRET', 'dev_offline_secret_change_me'),
    ttlHours: parseInt(process.env.OFFLINE_TOKEN_TTL_HOURS || '48', 10),
    lockPercent: parseFloat(process.env.OFFLINE_LOCK_PERCENT || '60'),
    availablePercent: parseFloat(process.env.OFFLINE_AVAILABLE_PERCENT || '40'),
  },

  security: {
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10),
    otpLength: parseInt(process.env.OTP_LENGTH || '6', 10),
    otpExpiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10),
    otpMaxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10),
    // TEMPORARY tester-onboarding aid: returns the OTP code directly in the
    // register API response instead of relying on email delivery, which only
    // works for the developer's own address until a domain is verified with
    // the email provider. Turn this OFF (unset, or set to 'false') before any
    // real launch -- it defeats the purpose of email verification while on.
    exposeOtpInResponse: process.env.EXPOSE_OTP_IN_RESPONSE === 'true',
    // Online transfers at or above this amount require OTP/2FA verification
    // (Google Authenticator code if google2fa_enabled, otherwise an emailed
    // code if email2fa_withdrawals_enabled — see security.service.js) even
    // if the user hasn't turned on Transfer Protection. With Transfer
    // Protection on, every online transfer requires it regardless of amount.
    // Never enforced on offline-queued transfers — see offlineVoucher.controller.js.
    largeTransferOtpThreshold: parseFloat(process.env.LARGE_TRANSFER_OTP_THRESHOLD || '100000'),
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'OffPay <no-reply@offpay.app>',
    // Only forces console-only logging when explicitly asked for (local dev).
    // Previously this defaulted to TRUE unless MOCK_OTP_CONSOLE was set to
    // the exact string 'false' — which meant setting RESEND_API_KEY alone
    // was NOT enough to actually email OTPs; you also had to remember to
    // set this separately, or every OTP silently stayed console-only. See
    // mailer.service.js's deliver(), which now decides mock vs. real
    // delivery based on whether a real provider is actually configured.
    forceMockConsole: process.env.MOCK_OTP_CONSOLE === 'true',
  },

  // Resend's HTTPS API — used in preference to raw SMTP, since Railway (and several
  // other PaaS hosts) block outbound SMTP ports on Free/Trial/Hobby plans and only
  // allow email via an HTTPS-based provider API.
  resend: {
    apiKey: process.env.RESEND_API_KEY,
    // Works immediately with zero setup, but Resend only delivers mail sent from
    // this address to the account's own signup email until a domain is verified
    // at resend.com/domains — swap this once you have one.
    from: process.env.RESEND_FROM_EMAIL || 'OffPay <onboarding@resend.dev>',
  },

  providers: {
    primary: process.env.PRIMARY_PROVIDER || 'flutterwave',
    flutterwave: {
      secretKey: process.env.FLW_SECRET_KEY,
      publicKey: process.env.FLW_PUBLIC_KEY,
      encryptionKey: process.env.FLW_ENCRYPTION_KEY,
      baseUrl: process.env.FLW_BASE_URL || 'https://api.flutterwave.com/v3',
      // The "Secret Hash" set on your Flutterwave dashboard's Webhooks page
      // (Settings > Webhooks). Every real webhook Flutterwave sends carries
      // this same value in the `verif-hash` header — if this is unset on
      // Railway, EVERY genuine webhook gets rejected with a 401 before your
      // code even looks at it, and deposits will never credit. Routed
      // through required() so a missing value is now flagged at startup in
      // Railway logs instead of failing silently on every webhook call.
      webhookHash: required('FLW_WEBHOOK_HASH'),
    },
    paystack: {
      secretKey: process.env.PAYSTACK_SECRET_KEY,
      publicKey: process.env.PAYSTACK_PUBLIC_KEY,
      baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
    },
    monnify: {
      apiKey: process.env.MONNIFY_API_KEY,
      secretKey: process.env.MONNIFY_SECRET_KEY,
      contractCode: process.env.MONNIFY_CONTRACT_CODE,
      sourceAccountNumber: process.env.MONNIFY_SOURCE_ACCOUNT_NUMBER,
      baseUrl: process.env.MONNIFY_BASE_URL || 'https://api.monnify.com',
    },
    // VTU aggregator (airtime/data/cable/electricity) — see
    // src/services/providers/bigisub.provider.js. The exact request/response
    // shape below is a best-effort placeholder (Bigisub's own API reference
    // at rif.africa/technotronics/api/bigisub renders its spec client-side
    // in JS, so it could not be fetched and read programmatically while
    // writing this) — confirm the real endpoint paths, header name, and
    // field names against your Bigisub dashboard/Postman collection before
    // relying on this in production. Until BIGISUB_API_KEY is set, VTU
    // purchases keep using the built-in sandbox mock, so leaving it unset is
    // always safe.
    bigisub: {
      apiKey: process.env.BIGISUB_API_KEY,
      baseUrl: process.env.BIGISUB_BASE_URL || 'https://bigisub.ng/api',
    },
    // Peyflex VTU aggregator — see src/services/providers/peyflex.provider.js.
    // Base URL and the `Authorization: Token <key>` header scheme are
    // confirmed from Peyflex's own public Postman docs; the purchase
    // endpoint paths/field names are a best-effort placeholder (that part
    // of their docs renders client-side and couldn't be read programmatically)
    // — confirm against your Peyflex dashboard/Postman collection before
    // relying on this in production. Until PEYFLEX_API_KEY is set, VTU
    // purchases keep using the built-in sandbox mock, so leaving it unset
    // is always safe.
    peyflex: {
      apiKey: process.env.PEYFLEX_API_KEY,
      baseUrl: process.env.PEYFLEX_BASE_URL || 'https://client.peyflex.com.ng/api',
    },
  },

  uploads: {
    maxMb: parseInt(process.env.MAX_UPLOAD_MB || '5', 10),
    adMaxMb: parseInt(process.env.AD_MAX_UPLOAD_MB || '15', 10),
  },

  // Persistent file storage for passport photos, NIN slips, utility bills, and
  // ad media. Railway's filesystem is EPHEMERAL — anything written to local
  // disk (the old behaviour, see src/middleware/upload.js history) is wiped
  // on every redeploy/restart, which is why those images used to appear
  // "broken" after a redeploy. Setting these three variables switches uploads
  // over to Cloudinary, which stores the file permanently on Cloudinary's own
  // storage and gives back a permanent HTTPS URL to save in the database. If
  // these are left unset, uploads silently fall back to local disk (fine for
  // local development only — do NOT rely on this in production on Railway).
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
};

