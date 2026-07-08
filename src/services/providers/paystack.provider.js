const axios = require('axios');
const env = require('../../config/env');

const client = () => axios.create({
  baseURL: env.providers.paystack.baseUrl,
  headers: { Authorization: `Bearer ${env.providers.paystack.secretKey}` },
  timeout: 15000,
});

/** Creates a dedicated virtual account (DVA) for a user. Requires a Paystack customer first. */
async function createVirtualAccount({ email, fullName, phone }) {
  const { data: customer } = await client().post('/customer', {
    email,
    first_name: fullName.split(' ')[0],
    last_name: fullName.split(' ').slice(1).join(' ') || fullName.split(' ')[0],
    phone,
  });

  const { data: dva } = await client().post('/dedicated_account', {
    customer: customer.data.customer_code,
    preferred_bank: 'wema-bank',
  });

  return {
    provider: 'paystack',
    accountNumber: dva.data.account_number,
    bankName: dva.data.bank.name,
    providerRef: dva.data.id,
  };
}

/** Initiates a bank transfer payout (withdrawal to an external bank). */
async function initiateTransfer({ amount, bankCode, accountNumber, narration, reference }) {
  const { data: recipient } = await client().post('/transferrecipient', {
    type: 'nuban',
    name: narration || 'OffPay transfer',
    account_number: accountNumber,
    bank_code: bankCode,
    currency: 'NGN',
  });

  const { data } = await client().post('/transfer', {
    source: 'balance',
    amount: Math.round(amount * 100), // kobo
    recipient: recipient.data.recipient_code,
    reason: narration,
    reference,
  });
  return { provider: 'paystack', providerRef: data.data.transfer_code, status: data.data.status };
}

async function resolveAccount({ accountNumber, bankCode }) {
  const { data } = await client().get(`/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
  return { accountName: data.data.account_name, accountNumber: data.data.account_number };
}

async function listBanks() {
  const { data } = await client().get('/bank?country=nigeria');
  return data.data.map((b) => ({ name: b.name, code: b.code }));
}

async function verifyTransaction(reference) {
  const { data } = await client().get(`/transaction/verify/${reference}`);
  return data.data;
}

module.exports = { name: 'paystack', createVirtualAccount, initiateTransfer, resolveAccount, listBanks, verifyTransaction };
