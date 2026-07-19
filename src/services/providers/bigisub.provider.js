const axios = require('axios');
const env = require('../../config/env');

/**
 * Bigisub VTU aggregator adapter (airtime, data, cable, electricity).
 *
 * ⚠️ IMPORTANT — read before relying on this in production:
 * Bigisub's API reference (linked from bigisub.ng as "API Docs", hosted at
 * rif.africa/technotronics/api/bigisub) renders its endpoint spec client-side
 * via JavaScript, so it could not be fetched and read while writing this
 * adapter. The request/response shape below follows the convention shared by
 * most Nigerian VTU aggregators (bearer-token auth, JSON body with
 * network/recipient/amount, a caller-supplied idempotency reference) — but
 * the exact endpoint paths, header name, and field names are NOT verified
 * against Bigisub's real API and will likely need small adjustments.
 *
 * To finish this integration:
 *   1. Log into your Bigisub dashboard and open the API Docs / get your
 *      Postman collection.
 *   2. Compare it against the endpoint paths and payload shapes below
 *      (search this file for "CONFIRM").
 *   3. Set BIGISUB_API_KEY (and BIGISUB_BASE_URL if it differs) in your
 *      environment — see src/config/env.js.
 *
 * Until BIGISUB_API_KEY is set, src/services/vtu.service.js falls back to
 * its built-in sandbox mock automatically, so this file being unfinished
 * does not break VTU purchases — it just means they stay mocked.
 */

function client() {
  return axios.create({
    baseURL: env.providers.bigisub.baseUrl,
    // CONFIRM: header name/scheme — some aggregators use `Authorization: Bearer <key>`,
    // others use a custom `api-key` / `Api-Token` header. Adjust to match your dashboard.
    headers: {
      Authorization: `Bearer ${env.providers.bigisub.apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

/**
 * @param {{category:string, provider:string, recipient:string, amount:number, planCode?:string, reference:string}} params
 * @returns {Promise<{success:boolean, externalReference?:string, message:string}>}
 */
async function purchase({ category, provider, recipient, amount, planCode, reference }) {
  // CONFIRM: endpoint path per category — this assumes one unified /vend
  // endpoint distinguished by a `type` field, which is common but not
  // universal; some aggregators use separate /airtime, /data, /cable,
  // /electricity endpoints instead.
  const body = {
    type: category, // 'airtime' | 'data' | 'cable' | 'electricity'
    network: provider,
    recipient,
    amount,
    plan_code: planCode || undefined,
    request_id: reference,
  };

  try {
    const { data } = await client().post('/vend', body);

    // CONFIRM: success/failure field names in Bigisub's actual response.
    const ok = data?.status === 'success' || data?.code === '000' || data?.success === true;
    if (!ok) {
      return { success: false, message: data?.message || data?.description || 'Purchase failed. Please try again.' };
    }

    return {
      success: true,
      externalReference: data?.transaction_id || data?.reference || data?.data?.transactionId,
      message: data?.message || `${category} purchase of ₦${amount} to ${recipient} via ${provider} was successful.`,
    };
  } catch (err) {
    const providerMessage = err.response?.data?.message || err.response?.data?.description;
    return { success: false, message: providerMessage || 'Could not reach the VTU provider. Please try again shortly.' };
  }
}

/** Wallet balance held with Bigisub — useful for an admin dashboard low-balance alert. */
async function getBalance() {
  // CONFIRM: endpoint path — commonly /balance or /wallet.
  const { data } = await client().get('/balance');
  return data?.balance ?? data?.data?.balance ?? null;
}

module.exports = { name: 'bigisub', purchase, getBalance };
