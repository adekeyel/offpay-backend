const rateLimit = require('express-rate-limit');

// General API limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});

// Tighter limiter for customer auth endpoints (register, login, unlock,
// recovery-request) to blunt brute force / credential stuffing.
//
// IMPORTANT: this must stay a SEPARATE instance from adminAuthLimiter below.
// express-rate-limit's default in-memory store is per-middleware-instance,
// keyed by IP — reusing the same `rateLimit(...)` object across both the
// customer auth routes and the admin login route means every request to
// EITHER group draws from one shared 10-per-15-minute bucket per IP. In
// practice that meant testing the customer app's register/login screens a
// few times (very normal while debugging) could exhaust the whole bucket
// and then lock the admin panel out too, even on its very first login
// attempt from that IP that day. Two independent instances below fixes
// that: each route group gets its own counter.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in a few minutes.' },
});

// Admin login gets its own counter — see the note on authLimiter above for why.
const adminAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again in a few minutes.' },
});

// Very tight limiter for OTP verification specifically
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP attempts. Please request a new code.' },
});

module.exports = { apiLimiter, authLimiter, adminAuthLimiter, otpLimiter };
