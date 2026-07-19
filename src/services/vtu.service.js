const crypto = require('crypto');
const env = require('../config/env');
const bigisub = require('./providers/bigisub.provider');

/**
 * Mocked VTU aggregator call, used automatically whenever BIGISUB_API_KEY
 * isn't set. Every real VTU platform (Bigisub, VTpass, Baxi, Reloadly,
 * Flutterwave Bills) exposes basically this same shape: category + provider
 * + recipient + amount -> success/failure + a reference — so once
 * bigisub.provider.js is confirmed against the real API (see the warning at
 * the top of that file), nothing else in the app needs to change.
 */
async function mockPurchase({ category, provider, recipient, amount }) {
  // Simulate a brief provider round-trip.
  await new Promise((r) => setTimeout(r, 300));

  // Simulate the one realistic failure mode worth showing in a demo: an
  // obviously-invalid recipient number.
  if (category !== 'electricity' && !/^0\d{10}$/.test(recipient) && category !== 'cable') {
    return { success: false, message: 'Invalid recipient number.' };
  }

  return {
    success: true,
    externalReference: `VTU-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    message: `${category} purchase of ₦${amount} to ${recipient} via ${provider} was successful (mocked).`,
  };
}

async function purchase({ category, provider, recipient, amount, planCode }) {
  if (!env.providers.bigisub.apiKey) {
    return mockPurchase({ category, provider, recipient, amount, planCode });
  }
  const reference = `OP-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  return bigisub.purchase({ category, provider, recipient, amount, planCode, reference });
}

module.exports = { purchase };
