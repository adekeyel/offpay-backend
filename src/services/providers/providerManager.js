const env = require('../../config/env');
const flutterwave = require('./flutterwave.provider');
const paystack = require('./paystack.provider');
const monnify = require('./monnify.provider');
const logger = require('../../utils/logger');

const PROVIDERS = { flutterwave, paystack, monnify };

/** A provider is only usable if its credentials are actually configured — an unconfigured provider is skipped entirely rather than attempted and failed. */
function isConfigured(name) {
  const c = env.providers[name];
  if (!c) return false;
  if (name === 'flutterwave') return Boolean(c.secretKey);
  if (name === 'paystack') return Boolean(c.secretKey);
  if (name === 'monnify') return Boolean(c.apiKey && c.secretKey && c.contractCode);
  return false;
}

/**
 * Order: configured PRIMARY_PROVIDER first, then whatever else is configured
 * (in a fixed, deterministic order), so behavior doesn't depend on object
 * key iteration order. Unconfigured providers are dropped entirely — we
 * never attempt a call we know will fail for lack of credentials.
 */
function orderedProviders(operationName) {
  const allNames = ['flutterwave', 'paystack', 'monnify'];
  const primaryName = allNames.includes(env.providers.primary) ? env.providers.primary : 'flutterwave';
  const rest = allNames.filter((n) => n !== primaryName);
  const candidateNames = [primaryName, ...rest];

  return candidateNames
    .filter(isConfigured)
    // Only include providers that actually implement this operation (e.g.
    // issueCard — Monnify/Paystack don't offer card issuing at all, so they
    // should never even be attempted for it, not fail loudly at call time).
    .filter((name) => typeof PROVIDERS[name][operationName] === 'function')
    .map((name) => PROVIDERS[name]);
}

/**
 * Runs `operation` against the first eligible (configured + supports this
 * operation) provider; if it throws, automatically retries against the next
 * one. If no provider is configured/eligible at all, or all of them fail,
 * throws a clear, real error — this deliberately never falls back to fake
 * placeholder data.
 */
async function withFallback(operationName, args) {
  const providers = orderedProviders(operationName);
  if (!providers.length) {
    throw new Error(`No payment provider is configured and available for '${operationName}'. Check your provider API keys on Railway.`);
  }

  let lastError;
  for (const provider of providers) {
    try {
      const result = await provider[operationName](args);
      return { ...result, providerUsed: provider.name };
    } catch (err) {
      lastError = err;
      logger.warn(`Provider ${provider.name} failed for ${operationName}: ${err.message}. ${provider === providers[providers.length - 1] ? 'No more providers to try.' : 'Falling back...'}`);
    }
  }

  throw new Error(`All available payment providers failed for ${operationName}: ${lastError?.message}`);
}

module.exports = {
  createVirtualAccount: (args) => withFallback('createVirtualAccount', args),
  initiateTransfer: (args) => withFallback('initiateTransfer', args),
  resolveAccount: (args) => withFallback('resolveAccount', args),
  listBanks: (args) => withFallback('listBanks', args),
  verifyTransaction: (args) => withFallback('verifyTransaction', args),
  issueCard: (args) => withFallback('issueCard', args),
};
