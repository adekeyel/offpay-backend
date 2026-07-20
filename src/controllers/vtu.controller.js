const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const walletService = require('../services/wallet.service');
const feeService = require('../services/fee.service');
const vtuService = require('../services/vtu.service');
const auditService = require('../services/audit.service');
const fraudService = require('../services/fraud.service');
const cashbackService = require('../services/cashback.service');

const AIRTIME_PROVIDERS = ['MTN', 'Glo', 'Airtel', '9mobile'];
const CABLE_PROVIDERS = ['DStv', 'GOtv', 'Startimes'];
const ELECTRICITY_PROVIDERS = ['EKEDC', 'IKEDC', 'AEDC', 'PHED', 'KEDCO'];

/** Providers for airtime/electricity (free amount), and data/cable plans with fixed prices. */
async function listProducts(req, res) {
  const { category } = req.params;
  if (category === 'airtime') {
    return res.json({ success: true, data: { providers: AIRTIME_PROVIDERS, plans: [] } });
  }
  if (category === 'electricity') {
    return res.json({ success: true, data: { providers: ELECTRICITY_PROVIDERS, plans: [] } });
  }
  if (category === 'data') {
    const { rows } = await query(`SELECT * FROM vtu_products WHERE category = 'data' AND active = true ORDER BY provider, amount`);
    return res.json({ success: true, data: { providers: AIRTIME_PROVIDERS, plans: rows } });
  }
  if (category === 'cable') {
    const { rows } = await query(`SELECT * FROM vtu_products WHERE category = 'cable' AND active = true ORDER BY provider, amount`);
    return res.json({ success: true, data: { providers: CABLE_PROVIDERS, plans: rows } });
  }
  throw ApiError.badRequest('Unknown VTU category.');
}

async function purchase(req, res) {
  const { category, provider, recipient, amount, productId } = req.body;
  if (!['airtime', 'data', 'cable', 'electricity'].includes(category)) throw ApiError.badRequest('Invalid category.');
  if (!provider || !recipient) throw ApiError.badRequest('provider and recipient are required.');

  let finalAmount = parseFloat(amount);
  let productName = null;
  let planCode = null;
  if (['data', 'cable'].includes(category)) {
    if (!productId) throw ApiError.badRequest('productId is required for data/cable purchases.');
    const { rows } = await query('SELECT * FROM vtu_products WHERE id = $1 AND active = true', [productId]);
    if (!rows.length) throw ApiError.badRequest('Selected plan is not available.');
    finalAmount = parseFloat(rows[0].amount);
    productName = rows[0].name;
    // vtu_products.code = "provider's internal plan code" (see schema.sql) —
    // required by Peyflex's data/cable purchase endpoints as `plan_code`.
    // This was being looked up here but never actually forwarded to the
    // provider call below, so a real aggregator that requires a plan code
    // (Peyflex does) would silently fail on every data/cable purchase.
    planCode = rows[0].code;
  }
  if (!finalAmount || finalAmount <= 0) throw ApiError.badRequest('A valid amount is required.');

  const { rows: walletRows } = await query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
  const wallet = walletRows[0];
  if (!wallet) throw ApiError.notFound('Wallet not found.');
  if (wallet.is_frozen) throw ApiError.forbidden('Your wallet is frozen. Contact support.');

  const fee = await feeService.calculateFee('vtu_purchase', finalAmount);
  const total = finalAmount + fee;
  if (parseFloat(wallet.balance) < total) throw ApiError.badRequest('Insufficient balance.');

  const providerResult = await vtuService.purchase({ category, provider, recipient, amount: finalAmount, planCode });
  if (!providerResult.success) throw ApiError.badRequest(providerResult.message || 'Purchase failed. Please try again.');

  const result = await withTransaction(async (client) => {
    const txn = await walletService.debitWallet(client, {
      walletId: wallet.id,
      amount: finalAmount,
      fee,
      type: 'vtu_purchase',
      provider: 'internal',
      narration: `${category[0].toUpperCase()}${category.slice(1)} — ${provider}${productName ? ` (${productName})` : ''} — ${recipient}`,
      counterparty: { name: provider, number: recipient },
    });

    const { rows: orderRows } = await client.query(
      `INSERT INTO vtu_orders (user_id, transaction_id, category, provider, product_name, recipient, amount, status, external_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'success',$8) RETURNING *`,
      [req.user.id, txn.id, category, provider, productName, recipient, finalAmount, providerResult.externalReference]
    );

    // Flat ₦2 cashback on airtime ≥ ₦200 — computed server-side from the
    // real confirmed amount, credited to the Rewards balance (cashback_ledger),
    // not the spendable wallet.
    let cashback = null;
    if (category === 'airtime') {
      const cashbackAmount = cashbackService.calculateAirtimeCashback(finalAmount);
      if (cashbackAmount > 0) {
        cashback = await cashbackService.creditCashback(client, {
          userId: req.user.id, amount: cashbackAmount, source: 'airtime_purchase', referenceId: orderRows[0].id,
        });
      }
    }

    return { txn, order: orderRows[0], cashback };
  });

  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'VTU_PURCHASE', targetType: 'vtu_order', targetId: result.order.id, ipAddress: req.ip });
  fraudService.evaluateTransaction(result.txn, req.user.id);

  const cashbackNote = result.cashback ? ` You earned ₦${result.cashback.amount} cashback.` : '';
  res.status(201).json({ success: true, message: `${providerResult.message}${cashbackNote}`, data: result });
}

async function history(req, res) {
  const { rows } = await query(
    `SELECT * FROM vtu_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ success: true, data: rows });
}

module.exports = { listProducts, purchase, history };
