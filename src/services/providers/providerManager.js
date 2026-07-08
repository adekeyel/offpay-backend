const env = require('../../config/env');
const flutterwave = require('./flutterwave.provider');
const paystack = require('./paystack.provider');
const logger = require('../../utils/logger');

const PROVIDERS = { flutterwave, paystack };

function orderedProviders() {
  const primaryName = env.providers.primary === 'paystack' ? 'paystack' : 'flutterwave';
  const secondaryName = primaryName === 'flutterwave' ? 'paystack' : 'flutterwave';
  return [PROVIDERS[primaryName], PROVIDERS[secondaryName]];
}

/**
 * Runs `operation` against the primary provider; if it throws, automatically
 * retries against the secondary provider. This gives OffPay resilience against
 * a single provider's downtime without any code changes at the call site.
 *
 * As you scale or obtain your own settlement license, add a new adapter file
 * under services/providers/ implementing the same method signatures
 * (createVirtualAccount, initiateTransfer, resolveAccount, listBanks,
 * verifyTransaction) and register it in PROVIDERS above.
 */
async function withFallback(operationName, args) {
  const providers = orderedProviders();
  let lastError;

  for (const provider of providers) {
    try {
      const result = await provider[operationName](args);
      return { ...result, providerUsed: provider.name };
    } catch (err) {
      lastError = err;
      logger.warn(`Provider ${provider.name} failed for ${operationName}: ${err.message}. ${provider === providers[0] ? 'Falling back...' : 'No more providers to try.'}`);
    }
  }

  throw new Error(`All payment providers failed for ${operationName}: ${lastError?.message}`);
}

module.exports = {
  createVirtualAccount: (args) => withFallback('createVirtualAccount', args),
  initiateTransfer: (args) => withFallback('initiateTransfer', args),
  resolveAccount: (args) => withFallback('resolveAccount', args),
  listBanks: (args) => withFallback('listBanks', args),
  verifyTransaction: (args) => withFallback('verifyTransaction', args),
};
