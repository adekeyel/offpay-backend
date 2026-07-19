const axios = require('axios');
const env = require('../../config/env');

const client = () => axios.create({
  baseURL: env.providers.flutterwave.baseUrl,
  headers: { Authorization: `Bearer ${env.providers.flutterwave.secretKey}` },
  timeout: 15000,
});

/** Creates a dedicated virtual account (NUBAN) for a user. */
async function createVirtualAccount({ email, bvn, fullName, phone, txRef }) {
  const { data } = await client().post('/virtual-account-numbers', {
    email,
    bvn,
    tx_ref: txRef,
    phonenumber: phone,
    firstname: fullName.split(' ')[0],
    lastname: fullName.split(' ').slice(1).join(' ') || fullName.split(' ')[0],
    narration: `OffPay - ${fullName}`,
    is_permanent: true,
  });
  return {
    provider: 'flutterwave',
    accountNumber: data.data.account_number,
    bankName: data.data.bank_name,
    providerRef: data.data.flw_ref || data.data.order_ref,
  };
}

/** Initiates a bank transfer payout (withdrawal to an external bank). */
async function initiateTransfer({ amount, bankCode, accountNumber, narration, reference, currency = 'NGN' }) {
  const { data } = await client().post('/transfers', {
    account_bank: bankCode,
    account_number: accountNumber,
    amount,
    narration,
    currency,
    reference,
  });
  return { provider: 'flutterwave', providerRef: data.data.id, status: data.data.status };
}

/** Resolves an account number to confirm the account holder's name before sending money. */
async function resolveAccount({ accountNumber, bankCode }) {
  const { data } = await client().post('/accounts/resolve', { account_number: accountNumber, account_bank: bankCode });
  return { accountName: data.data.account_name, accountNumber: data.data.account_number };
}

/** Fetches the list of supported banks (Nigeria by default). */
async function listBanks(country = 'NG') {
  const { data } = await client().get(`/banks/${country}`);
  return data.data.map((b) => ({ name: b.name, code: b.code }));
}

async function verifyTransaction(txRef) {
  const { data } = await client().get(`/transactions/verify_by_reference?tx_ref=${txRef}`);
  return data.data;
}

/**
 * Issues a real virtual card via Flutterwave Issuing.
 *
 * IMPORTANT — verify before relying on this in production:
 *   1. Card Issuing is a separate, gated Flutterwave product. It is NOT
 *      automatically enabled on a standard merchant account just because you
 *      have a valid secret key — Flutterwave has to explicitly turn it on
 *      for your business (contact your Flutterwave account manager /
 *      support). Until that's done, this call will fail with a real error
 *      (e.g. "You cannot create cards at this time") — that's expected, not
 *      a bug in this code.
 *   2. The exact request field names below reflect Flutterwave's v3 Issuing
 *      API pattern as documented at the time this was written. Issuing
 *      endpoints are less standardized than core payments and can differ
 *      slightly per merchant agreement — confirm the current schema in your
 *      own Flutterwave dashboard's API reference (Issuing section) before
 *      going live, and adjust field names here if they've changed.
 *   3. `bvn` is included for the compliance/KYC trail OffPay requires before
 *      issuing a card (per your own KYC-approval gate), passed via `meta`
 *      since Issuing's top-level schema is not guaranteed to accept it
 *      directly — check whether your dashboard's docs expose a first-class
 *      field for it and move it up if so.
 */
async function issueCard({ userId, bvn, email, fullName, amount = 0, currency = 'NGN' }) {
  const { data } = await client().post('/virtual-cards', {
    currency,
    amount,
    debit_currency: currency,
    billing_name: fullName,
    meta: { offpay_user_id: userId, bvn },
  });

  const card = data.data;
  return {
    provider: 'flutterwave',
    providerCardId: card.id || card.card_id,
    maskedPan: card.masked_pan || `${(card.card_pan_first_6 || '').slice(0, 4)} ${(card.card_pan_first_6 || '').slice(4)}** **** ${card.last_4 || card.card_pan_last_4}`,
    last4: card.last_4 || card.card_pan_last_4,
    brand: (card.card_type || 'verve').toLowerCase(),
    expiryMonth: card.expiration ? parseInt(card.expiration.split('/')[0], 10) : null,
    expiryYear: card.expiration ? 2000 + parseInt(card.expiration.split('/')[1], 10) : null,
  };
}

module.exports = { name: 'flutterwave', createVirtualAccount, initiateTransfer, resolveAccount, listBanks, verifyTransaction, issueCard };
