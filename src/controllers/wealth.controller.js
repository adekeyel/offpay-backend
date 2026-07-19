const { query, withTransaction } = require('../config/db');
const ApiError = require('../utils/ApiError');
const walletService = require('../services/wallet.service');
const auditService = require('../services/audit.service');

async function listProducts(req, res) {
  const { rows } = await query('SELECT * FROM wealth_products WHERE active = true ORDER BY type');
  res.json({ success: true, data: rows });
}

/** All of the user's wealth accounts across every product. */
async function listMyAccounts(req, res) {
  const { rows } = await query(
    `SELECT wa.*, wp.name AS product_name, wp.type, wp.interest_rate
     FROM wealth_accounts wa JOIN wealth_products wp ON wp.id = wa.wealth_product_id
     WHERE wa.user_id = $1 ORDER BY wa.created_at DESC`,
    [req.user.id]
  );
  res.json({ success: true, data: rows });
}

/** Opens a new wealth account and makes the optional opening deposit in one step. */
async function openAccount(req, res) {
  const { wealthProductId, amount, targetAmount, targetDate, tenorDays } = req.body;
  if (!wealthProductId) throw ApiError.badRequest('wealthProductId is required.');

  const { rows: productRows } = await query('SELECT * FROM wealth_products WHERE id = $1 AND active = true', [wealthProductId]);
  if (!productRows.length) throw ApiError.badRequest('Product not available.');
  const product = productRows[0];

  const openingDeposit = parseFloat(amount || 0);
  if (openingDeposit > 0 && openingDeposit < parseFloat(product.min_amount)) {
    throw ApiError.badRequest(`Minimum amount for ${product.name} is ₦${product.min_amount}.`);
  }
  if (product.type === 'target' && (!targetAmount || !targetDate)) {
    throw ApiError.badRequest('targetAmount and targetDate are required for Target Savings.');
  }

  let maturityDate = null;
  if (product.lock_days > 0) {
    const days = tenorDays && tenorDays > 0 ? tenorDays : product.lock_days;
    maturityDate = new Date(Date.now() + days * 86400000);
  }

  const result = await withTransaction(async (client) => {
    const { rows: accountRows } = await client.query(
      `INSERT INTO wealth_accounts (user_id, wealth_product_id, target_amount, target_date, maturity_date)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, wealthProductId, targetAmount || null, targetDate || null, maturityDate]
    );
    const account = accountRows[0];

    if (openingDeposit > 0) {
      await depositInternal(client, req.user.id, account, openingDeposit);
    }

    const { rows: refreshed } = await client.query('SELECT * FROM wealth_accounts WHERE id = $1', [account.id]);
    return refreshed[0];
  });

  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'WEALTH_ACCOUNT_OPENED', targetType: 'wealth_account', targetId: result.id, ipAddress: req.ip });
  res.status(201).json({ success: true, data: result });
}

async function depositInternal(client, userId, account, amount) {
  const { rows: walletRows } = await client.query('SELECT * FROM wallets WHERE user_id = $1', [userId]);
  const wallet = walletRows[0];
  if (parseFloat(wallet.balance) < amount) throw ApiError.badRequest('Insufficient balance.');

  const txn = await walletService.debitWallet(client, {
    walletId: wallet.id, amount, fee: 0, type: 'wealth_deposit', provider: 'internal', narration: 'Wealth deposit',
  });
  await client.query('INSERT INTO wealth_transactions (wealth_account_id, type, amount, transaction_id) VALUES ($1,$2,$3,$4)', [account.id, 'deposit', amount, txn.id]);
  await client.query('UPDATE wealth_accounts SET balance = balance + $1, updated_at = now() WHERE id = $2', [amount, account.id]);
}

async function deposit(req, res) {
  const { amount } = req.body;
  if (!amount || amount <= 0) throw ApiError.badRequest('A valid amount is required.');

  const { rows } = await query('SELECT * FROM wealth_accounts WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rows.length) throw ApiError.notFound('Wealth account not found.');
  if (rows[0].status !== 'active') throw ApiError.badRequest('This account is not active.');

  await withTransaction((client) => depositInternal(client, req.user.id, rows[0], parseFloat(amount)));
  const { rows: updated } = await query('SELECT * FROM wealth_accounts WHERE id = $1', [req.params.id]);
  res.json({ success: true, data: updated[0] });
}

/** Withdraws from a wealth account back to the main wallet — blocked before maturity for locked (Fixed Savings-style) products. */
async function withdraw(req, res) {
  const { amount } = req.body;
  if (!amount || amount <= 0) throw ApiError.badRequest('A valid amount is required.');

  const { rows } = await query(
    `SELECT wa.*, wp.lock_days, wp.name AS product_name FROM wealth_accounts wa
     JOIN wealth_products wp ON wp.id = wa.wealth_product_id WHERE wa.id = $1 AND wa.user_id = $2`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) throw ApiError.notFound('Wealth account not found.');
  const account = rows[0];

  if (account.lock_days > 0 && account.maturity_date && new Date(account.maturity_date) > new Date()) {
    throw ApiError.forbidden(`${account.product_name} is locked until ${new Date(account.maturity_date).toDateString()}.`);
  }
  const withdrawAmount = parseFloat(amount);
  if (withdrawAmount > parseFloat(account.balance)) throw ApiError.badRequest('Insufficient wealth account balance.');

  const result = await withTransaction(async (client) => {
    const { rows: walletRows } = await client.query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
    const wallet = walletRows[0];

    const txn = await walletService.creditWallet(client, {
      walletId: wallet.id, amount: withdrawAmount, type: 'wealth_withdrawal', provider: 'internal', narration: `Withdrawal from ${account.product_name}`,
    });
    await client.query('INSERT INTO wealth_transactions (wealth_account_id, type, amount, transaction_id) VALUES ($1,$2,$3,$4)', [account.id, 'withdrawal', withdrawAmount, txn.id]);
    const { rows: updated } = await client.query('UPDATE wealth_accounts SET balance = balance - $1, updated_at = now() WHERE id = $2 RETURNING *', [withdrawAmount, account.id]);
    return updated[0];
  });

  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'WEALTH_WITHDRAWAL', targetType: 'wealth_account', targetId: account.id, ipAddress: req.ip });
  res.json({ success: true, data: result });
}

module.exports = { listProducts, listMyAccounts, openAccount, deposit, withdraw };
