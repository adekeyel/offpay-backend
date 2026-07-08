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

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET', 'dev_access_secret_change_me'),
    refreshSecret: required('JWT_REFRESH_SECRET', 'dev_refresh_secret_change_me'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
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
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'OffPay <no-reply@offpay.app>',
    mockConsole: process.env.MOCK_OTP_CONSOLE !== 'false',
  },

  providers: {
    primary: process.env.PRIMARY_PROVIDER || 'flutterwave',
    flutterwave: {
      secretKey: process.env.FLW_SECRET_KEY,
      publicKey: process.env.FLW_PUBLIC_KEY,
      encryptionKey: process.env.FLW_ENCRYPTION_KEY,
      baseUrl: process.env.FLW_BASE_URL || 'https://api.flutterwave.com/v3',
    },
    paystack: {
      secretKey: process.env.PAYSTACK_SECRET_KEY,
      publicKey: process.env.PAYSTACK_PUBLIC_KEY,
      baseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
    },
  },

  uploads: {
    maxMb: parseInt(process.env.MAX_UPLOAD_MB || '5', 10),
  },
};
