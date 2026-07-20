const crypto = require('crypto');
const env = require('../config/env');
const bigisub = require('./providers/bigisub.provider');
const peyflex = require('./providers/peyflex.provider');

/**
 * Mocked VTU aggregator call, used automatically whenever no real VTU
 * provider's API key is set. Every real VTU platform (Peyflex, Bigisub,
 * VTpass, Baxi, Reloadly, Flutterwave Bills) exposes basically this same
 * shape: category + provider + recipient + amount -> success/failure + a
 * reference — so once peyflex.provider.js / bigisub.provider.js are
 * confirmed against their real APIs (see the warnings at the top of those
 * files), nothing else in the app needs to change.
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
  const reference = `OP-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // Peyflex is preferred when configured; falls back to Bigisub if only
  // that's configured; falls back to the mock if neither is. Swap this
  // order (or add a per-category preference) once you know which of the
  // two you actually want live for which service.
  if (env.providers.peyflex.apiKey) {
    return peyflex.purchase({ category, provider, recipient, amount, planCode, reference });
  }
  if (env.providers.bigisub.apiKey) {
    return bigisub.purchase({ category, provider, recipient, amount, planCode, reference });
  }
  return mockPurchase({ category, provider, recipient, amount, planCode });
}

module.exports = { purchase };
