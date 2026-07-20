const axios = require('axios');
const env = require('../../config/env');

/**
 * Peyflex VTU aggregator adapter (airtime, data, cable, electricity, betting).
 * Base URL: https://client.peyflex.com.ng/api
 * Auth header: `Authorization: Token <your_api_token>` — note it's the word
 * "Token", NOT "Bearer" (Django REST Framework convention).
 *
 * Everything below marked CONFIRMED is taken directly from Peyflex's own
 * published API docs/examples and is safe to rely on as-is. Everything
 * marked CONFIRM is a best-effort guess (Peyflex's cable/electricity
 * *purchase* endpoints weren't in what was shared — only their plan-listing
 * and meter-verification endpoints were) — sanity-check those specifically
 * against your Peyflex dashboard before relying on them in production.
 *
 * Until PEYFLEX_API_KEY is set, src/services/vtu.service.js falls back to
 * the built-in sandbox mock automatically, so this file being partially
 * unconfirmed does not break VTU purchases in the meantime.
 */

function client() {
  return axios.create({
    baseURL: env.providers.peyflex.baseUrl,
    headers: {
      Authorization: `Token ${env.providers.peyflex.apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });
}

function ok(data) {
  // CONFIRMED shape (from the airtime/data examples): { "status": "SUCCESS", ... }
  return data?.status === 'SUCCESS' || data?.success === true;
}

function failureMessage(data) {
  return data?.message || data?.details || 'Purchase failed. Please try again.';
}

/**
 * @param {{category:string, provider:string, recipient:string, amount:number, planCode?:string, reference:string}} params
 *   `provider` doubles as Peyflex's "network" identifier for airtime/data —
 *   for airtime this is just the lowercase network name ('mtn','glo',
 *   'airtel','9mobile' — CONFIRMED). For data it must be the SPECIFIC
 *   identifier Peyflex expects for that plan (e.g. 'mtn_data_share',
 *   'mtn_gifting_data', 'glo_data' — CONFIRMED these exist via
 *   GET /data/networks/, but this app's vtu_products.provider currently
 *   stores generic labels like "MTN", not these identifiers). Until
 *   vtu_products is synced to hold Peyflex's real network identifiers in
 *   its `provider`/`code` columns, data purchases through Peyflex will
 *   likely fail with an "invalid network" error from Peyflex even though
 *   this code itself is correct — this is a data-sync gap, not a code bug.
 * @returns {Promise<{success:boolean, externalReference?:string, message:string}>}
 */
async function purchase({ category, provider, recipient, amount, planCode, reference }) {
  try {
    if (category === 'airtime') {
      // CONFIRMED: POST /airtime/topup/ { network, amount, mobile_number }
      const { data } = await client().post('/airtime/topup/', {
        network: provider.toLowerCase(),
        amount,
        mobile_number: recipient,
      });
      if (!ok(data)) return { success: false, message: failureMessage(data) };
      return { success: true, externalReference: String(data.transaction_id ?? data.reference ?? reference), message: data.message || 'Airtime topup successful' };
    }

    if (category === 'data') {
      // CONFIRMED: POST /data/purchase/ { network, mobile_number, plan_code }
      // `network` here MUST be Peyflex's own identifier (see note above),
      // and `plan_code` MUST be one of the codes returned by
      // GET /data/plans/?network=<identifier> — this is the vtu_products.code
      // column mentioned in schema.sql ("provider's internal plan code").
      if (!planCode) return { success: false, message: 'No plan selected for this data purchase.' };
      const { data } = await client().post('/data/purchase/', {
        network: provider,
        mobile_number: recipient,
        plan_code: planCode,
      });
      if (!ok(data)) return { success: false, message: failureMessage(data) };
      return { success: true, externalReference: String(data.transaction_id ?? data.reference ?? reference), message: data.message || 'Data topup successful' };
    }

    if (category === 'cable') {
      // CONFIRM: purchase endpoint not in the docs shared — only
      // GET /cable/providers/ and GET /cable/plans/<provider>/ (plan_code
      // + amount) were confirmed. Guessing POST /cable/purchase/ with a
      // smart-card/IUC number + plan_code, matching the naming convention
      // of the confirmed endpoints. Verify against your dashboard.
      if (!planCode) return { success: false, message: 'No plan selected for this cable purchase.' };
      const { data } = await client().post('/cable/purchase/', {
        provider: provider.toLowerCase(),
        smart_card_number: recipient,
        plan_code: planCode,
      });
      if (!ok(data)) return { success: false, message: failureMessage(data) };
      return { success: true, externalReference: String(data.transaction_id ?? data.reference ?? reference), message: data.message || 'Cable subscription successful' };
    }

    if (category === 'electricity') {
      // CONFIRM: purchase endpoint not in the docs shared — only
      // GET /electricity/plans/ and GET /electricity/verify/ (which uses
      // identifier=electricity, meter, plan, type=prepaid|postpaid) were
      // confirmed. Guessing POST /electricity/purchase/ with the same
      // field names as the confirmed verify endpoint. Verify against your
      // dashboard — in particular whether `type` (prepaid/postpaid) needs
      // to be passed through from the caller rather than hardcoded here.
      const { data } = await client().post('/electricity/purchase/', {
        identifier: 'electricity',
        plan: provider, // disco code, e.g. 'ikeja-electric' — see GET /electricity/plans/
        meter: recipient,
        amount,
        type: 'prepaid',
      });
      if (!ok(data)) return { success: false, message: failureMessage(data) };
      return { success: true, externalReference: String(data.transaction_id ?? data.reference ?? reference), message: data.message || 'Electricity purchase successful' };
    }

    return { success: false, message: `Peyflex does not support the "${category}" category.` };
  } catch (err) {
    const providerMessage = err.response?.data?.message || err.response?.data?.details;
    return { success: false, message: providerMessage || 'Could not reach the VTU provider. Please try again shortly.' };
  }
}

/** CONFIRMED — no auth required. */
async function getAirtimeNetworks() {
  const { data } = await client().get('/airtime/networks/');
  return data;
}

/** CONFIRMED — no auth required. Identifiers here (e.g. 'mtn_data_share') are what `network` must be for data purchases. */
async function getDataNetworks() {
  const { data } = await client().get('/data/networks/');
  return data?.networks ?? [];
}

/** CONFIRMED — no auth required. `network` is one of the identifiers from getDataNetworks(). */
async function getDataPlans(network) {
  const { data } = await client().get('/data/plans/', { params: { network } });
  return data;
}

/** CONFIRMED — no auth required. */
async function getCableProviders() {
  const { data } = await client().get('/cable/providers/');
  return data;
}

/** CONFIRMED — no auth required. e.g. getCablePlans('startimes'). */
async function getCablePlans(providerIdentifier) {
  const { data } = await client().get(`/cable/plans/${providerIdentifier}/`);
  return data?.plans ?? [];
}

/** CONFIRMED — no auth required. */
async function getElectricityPlans() {
  const { data } = await client().get('/electricity/plans/', { params: { identifier: 'electricity' } });
  return data?.plans ?? [];
}

/** CONFIRMED — no auth required. Verify a meter number and get the customer's name back before charging them. */
async function verifyElectricityMeter({ meter, plan, type = 'prepaid' }) {
  const { data } = await client().get('/electricity/verify/', { params: { identifier: 'electricity', meter, plan, type } });
  return data;
}

/** Wallet balance held with Peyflex — useful for an admin dashboard low-balance alert. CONFIRMED endpoint. */
async function getBalance() {
  const { data } = await client().get('/wallet/balance/');
  return data?.balance ?? data?.data?.balance ?? null;
}

module.exports = {
  name: 'peyflex',
  purchase,
  getBalance,
  getAirtimeNetworks,
  getDataNetworks,
  getDataPlans,
  getCableProviders,
  getCablePlans,
  getElectricityPlans,
  verifyElectricityMeter,
};
