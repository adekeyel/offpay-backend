const axios = require('axios');
const env = require('../../config/env');

// Monnify authenticates via a short-lived OAuth2 token (Basic auth to get it,
// then Bearer for everything else) rather than a static secret key header
// like Flutterwave/Paystack. We cache the token in memory and refresh it a
// little before it actually expires.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const basicAuth = Buffer.from(`${env.providers.monnify.apiKey}:${env.providers.monnify.secretKey}`).toString('base64');
  const { data } = await axios.post(
    `${env.providers.monnify.baseUrl}/api/v1/auth/login`,
    {},
    { headers: { Authorization: `Basic ${basicAuth}` }, timeout: 15000 }
  );

  cachedToken = data.responseBody.accessToken;
  // expiresIn is seconds; refresh 60s early to avoid a request racing an expiry.
  cachedTokenExpiry = Date.now() + (data.responseBody.expiresIn - 60) * 1000;
  return cachedToken;
}

async function client() {
  const token = await getAccessToken();
  return axios.create({
    baseURL: env.providers.monnify.baseUrl,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
}

/** Creates a dedicated virtual account (NUBAN) for a user via Monnify's reserved-account product. */
async function createVirtualAccount({ email, bvn, fullName, phone, txRef }) {
  const c = await client();
  const { data } = await c.post('/api/v2/bank-transfer/reserved-accounts', {
    accountReference: txRef,
    accountName: fullName,
    currencyCode: 'NGN',
    contractCode: env.providers.monnify.contractCode,
    customerEmail: email,
    customerName: fullName,
    bvn,
    getAllAvailableBanks: false,
  });

  const account = data.responseBody.accounts[0];
  return {
    provider: 'monnify',
    accountNumber: account.accountNumber,
    bankName: account.bankName,
    providerRef: data.responseBody.accountReference,
  };
}

/** Initiates a bank transfer payout (withdrawal to an external bank). */
async function initiateTransfer({ amount, bankCode, accountNumber, narration, reference }) {
  const c = await client();
  const { data } = await c.post('/api/v2/disbursements/single', {
    amount,
    reference,
    narration,
    destinationBankCode: bankCode,
    destinationAccountNumber: accountNumber,
    currency: 'NGN',
    sourceAccountNumber: env.providers.monnify.sourceAccountNumber,
  });
  return { provider: 'monnify', providerRef: String(data.responseBody.reference), status: data.responseBody.status };
}

/** Resolves an account number to confirm the account holder's name before sending money. */
async function resolveAccount({ accountNumber, bankCode }) {
  const c = await client();
  const { data } = await c.get(`/api/v1/disbursements/account/validate?accountNumber=${accountNumber}&bankCode=${bankCode}`);
  return { accountName: data.responseBody.accountName, accountNumber: data.responseBody.accountNumber };
}

/** Fetches the list of supported banks. */
async function listBanks() {
  const c = await client();
  const { data } = await c.get('/api/v1/banks');
  return data.responseBody.map((b) => ({ name: b.name, code: b.code }));
}

async function verifyTransaction(txRef) {
  const c = await client();
  const { data } = await c.get(`/api/v2/transactions/${txRef}`);
  return data.responseBody;
}

// Monnify does not offer a card-issuing product — deliberately no issueCard
// export here. providerManager's card-issuance path only calls providers
// that implement it (currently just Flutterwave) and throws a real error
// if none succeed, rather than pretending Monnify supports this.

module.exports = { name: 'monnify', createVirtualAccount, initiateTransfer, resolveAccount, listBanks, verifyTransaction };
