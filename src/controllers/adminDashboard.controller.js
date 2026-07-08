const { query } = require('../config/db');

const FINANCE_ROLES = ['admin', 'finance'];

/**
 * High-level KPIs for the admin overview page.
 * Every role sees the operational counters and charts. Only super admin ("admin")
 * and finance see the treasury-level numbers (total wallet balance, fee revenue) —
 * everyone else only sees today's transaction volume as their "balance for the day".
 */
async function stats(req, res) {
  const canSeeFinance = FINANCE_ROLES.includes(req.admin.role);

  const [
    { rows: userCount }, { rows: activeToday }, { rows: txnCount }, { rows: todayTxn },
    { rows: statusToday }, { rows: pendingKyc }, { rows: openTickets }, { rows: fraudAlerts },
    { rows: dailyTxns }, { rows: dailyVolume }, { rows: userGrowth }, { rows: tierDist },
    { rows: todayVolume },
  ] = await Promise.all([
    query(`SELECT COUNT(*) FROM users`),
    query(`SELECT COUNT(*) FROM users WHERE last_login_at::date = now()::date`),
    query(`SELECT COUNT(*) FROM transactions`),
    query(`SELECT COUNT(*) FROM transactions WHERE created_at::date = now()::date`),
    query(`SELECT status, COUNT(*) FROM transactions WHERE created_at::date = now()::date GROUP BY status`),
    query(`SELECT COUNT(*) FROM users WHERE kyc_status = 'pending'`),
    query(`SELECT COUNT(*) FROM support_tickets WHERE status = 'open'`),
    query(`SELECT COUNT(*) FROM fraud_alerts WHERE status = 'open'`),
    query(`SELECT created_at::date AS date, COUNT(*) FROM transactions WHERE created_at > now() - interval '14 days' GROUP BY date ORDER BY date`),
    query(`SELECT created_at::date AS date, COALESCE(SUM(amount),0) AS amount FROM transactions WHERE status = 'success' AND created_at > now() - interval '14 days' GROUP BY date ORDER BY date`),
    query(`SELECT created_at::date AS date, COUNT(*) FROM users WHERE created_at > now() - interval '14 days' GROUP BY date ORDER BY date`),
    query(`SELECT kyc_tier, COUNT(*) FROM users GROUP BY kyc_tier ORDER BY kyc_tier`),
    query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE status = 'success' AND created_at::date = now()::date`),
  ]);

  const statusMap = { success: 0, failed: 0, reversed: 0, pending: 0 };
  statusToday.forEach((r) => { statusMap[r.status] = parseInt(r.count, 10); });

  const data = {
    totalUsers: parseInt(userCount[0].count, 10),
    activeToday: parseInt(activeToday[0].count, 10),
    totalTransactions: parseInt(txnCount[0].count, 10),
    todayTransactions: parseInt(todayTxn[0].count, 10),
    successful: statusMap.success,
    failedOrReversed: statusMap.failed + statusMap.reversed,
    pending: statusMap.pending,
    pendingKyc: parseInt(pendingKyc[0].count, 10),
    openTickets: parseInt(openTickets[0].count, 10),
    fraudAlerts: parseInt(fraudAlerts[0].count, 10),
    todayVolume: parseFloat(todayVolume[0].total),
    charts: {
      dailyTransactions: dailyTxns.map((r) => ({ date: r.date, count: parseInt(r.count, 10) })),
      dailyVolume: dailyVolume.map((r) => ({ date: r.date, amount: parseFloat(r.amount) })),
      userGrowth: userGrowth.map((r) => ({ date: r.date, count: parseInt(r.count, 10) })),
      kycTierDistribution: tierDist.map((r) => ({ tier: `Tier ${r.kyc_tier}`, count: parseInt(r.count, 10) })),
    },
  };

  if (canSeeFinance) {
    const [{ rows: walletTotal }, { rows: weekVol }, { rows: monthVol }, { rows: feeDay }, { rows: feeWeek }, { rows: feeMonth }] = await Promise.all([
      query(`SELECT COALESCE(SUM(balance),0) AS total_balance, COUNT(*) AS wallet_count FROM wallets`),
      query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE status = 'success' AND created_at > now() - interval '7 days'`),
      query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE status = 'success' AND created_at > now() - interval '30 days'`),
      query(`SELECT COALESCE(SUM(fee),0) AS total FROM transactions WHERE status = 'success' AND created_at::date = now()::date`),
      query(`SELECT COALESCE(SUM(fee),0) AS total FROM transactions WHERE status = 'success' AND created_at > now() - interval '7 days'`),
      query(`SELECT COALESCE(SUM(fee),0) AS total FROM transactions WHERE status = 'success' AND created_at > now() - interval '30 days'`),
    ]);

    data.finance = {
      totalWalletBalance: parseFloat(walletTotal[0].total_balance),
      walletCount: parseInt(walletTotal[0].wallet_count, 10),
      volume: { day: data.todayVolume, week: parseFloat(weekVol[0].total), month: parseFloat(monthVol[0].total) },
      feeRevenue: { day: parseFloat(feeDay[0].total), week: parseFloat(feeWeek[0].total), month: parseFloat(feeMonth[0].total) },
    };
  }

  res.json({ success: true, data });
}

module.exports = { stats };
