const env = require('../../config/env');
const flutterwave = require('./flutterwave.provider');
const paystack = require('./paystack.provider');
const monnify = require('./monnify.provider');
const logger = require('../../utils/logger');
const ApiError = require('../../utils/ApiError');

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
 * Pulls the most specific message an upstream provider gave us out of an
 * axios error, instead of the generic "Request failed with status code 400"
 * axios itself produces. Flutterwave/Paystack/Monnify all return a JSON body
 * with a human-readable `message` field on error responses — that's the one
 * worth surfacing to the admin/user, not the HTTP status line.
 */
function upstreamMessage(err) {
  return err.response?.data?.message || err.response?.data?.error || err.message || 'Unknown error';
}

/**
 * Runs `operation` against the first eligible (configured + supports this
 * operation) provider; if it throws, automatically retries against the next
 * one. If no provider is configured/eligible at all, or all of them fail,
 * throws a clear ApiError (502 Bad Gateway, since the failure is upstream,
 * not this API's fault) — this deliberately never falls back to fake
 * placeholder data, and never leaves the caller with a generic "Something
 * went wrong" 500 that hides what actually happened.
 */
async function withFallback(operationName, args) {
  const providers = orderedProviders(operationName);
  if (!providers.length) {
    throw ApiError.badGateway(
      `No payment provider is configured for '${operationName}'. Check your provider API keys (FLW_SECRET_KEY / PAYSTACK_SECRET_KEY / MONNIFY_*) on Railway.`
    );
  }

  let lastMessage;
  for (const provider of providers) {
    try {
      const result = await provider[operationName](args);
      // listBanks (and any future array-returning operation) must stay an
      // array — spreading an array into `{...result, providerUsed}` silently
      // turns it into a plain object with numeric-string keys (`{0: {...},
      // 1: {...}, providerUsed: 'flutterwave'}`), which is where
      // "liveBanks.filter is not a function" in bank.controller.js came
      // from. Attach providerUsed as a non-enumerable property instead so
      // the array stays an array (and doesn't show up if the result is ever
      // JSON.stringified without it).
      if (Array.isArray(result)) {
        Object.defineProperty(result, 'providerUsed', { value: provider.name, enumerable: false });
        return result;
      }
      return { ...result, providerUsed: provider.name };
    } catch (err) {
      lastMessage = upstreamMessage(err);
      logger.warn(`Provider ${provider.name} failed for ${operationName}: ${lastMessage}. ${provider === providers[providers.length - 1] ? 'No more providers to try.' : 'Falling back...'}`);
    }
  }

  throw ApiError.badGateway(`Could not complete this request: ${lastMessage}`);
}

module.exports = {
  createVirtualAccount: (args) => withFallback('createVirtualAccount', args),
  initiateTransfer: (args) => withFallback('initiateTransfer', args),
  resolveAccount: (args) => withFallback('resolveAccount', args),
  listBanks: (args) => withFallback('listBanks', args),
  verifyTransaction: (args) => withFallback('verifyTransaction', args),
  issueCard: (args) => withFallback('issueCard', args),
};
