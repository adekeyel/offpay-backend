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

module.exports = { name: 'flutterwave', createVirtualAccount, initiateTransfer, resolveAccount, listBanks, verifyTransaction };
