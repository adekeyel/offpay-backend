const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireAdminAuth, requireRole } = require('../middleware/auth');
const { authLimiter, otpLimiter } = require('../middleware/rateLimiter');

const authCtrl = require('../controllers/adminAuth.controller');
const kycCtrl = require('../controllers/adminKyc.controller');
const accountsCtrl = require('../controllers/adminAccounts.controller');
const feesCtrl = require('../controllers/adminFees.controller');
const auditCtrl = require('../controllers/adminAudit.controller');
const dashboardCtrl = require('../controllers/adminDashboard.controller');
const supportCtrl = require('../controllers/support.controller');
const txnCtrl = require('../controllers/adminTransactions.controller');
const walletCtrl = require('../controllers/adminWallet.controller');
const fraudCtrl = require('../controllers/adminFraud.controller');
const recoveryCtrl = require('../controllers/adminRecovery.controller');
const notificationsCtrl = require('../controllers/adminNotifications.controller');
const staffCtrl = require('../controllers/adminStaff.controller');
const settingsCtrl = require('../controllers/adminSettings.controller');

// ---- Public admin auth ----
router.post('/auth/login', authLimiter, asyncHandler(authCtrl.login));
router.post('/auth/verify-otp', otpLimiter, asyncHandler(authCtrl.verifyOtp));

// ---- Everything below requires a valid admin session ----
router.use(requireAdminAuth);

// Overview — every role, response is shaped per-role inside the controller
router.get('/dashboard/stats', asyncHandler(dashboardCtrl.stats));

// KYC review — compliance + admin
router.get('/kyc/pending', requireRole('compliance'), asyncHandler(kycCtrl.listPending));
router.get('/kyc/:id', requireRole('compliance'), asyncHandler(kycCtrl.getOne));
router.post('/kyc/:id/approve', requireRole('compliance'), asyncHandler(kycCtrl.approve));
router.post('/kyc/:id/reject', requireRole('compliance'), asyncHandler(kycCtrl.reject));

// Accounts — viewable by most operational roles, mutating actions restricted to compliance/admin
router.get('/users', requireRole('support', 'compliance', 'finance', 'operations', 'fraud', 'recovery'), asyncHandler(accountsCtrl.listUsers));
router.get('/users/:id', requireRole('support', 'compliance', 'finance', 'operations', 'fraud', 'recovery'), asyncHandler(accountsCtrl.getUserDetail));
router.post('/users/:id/actions/:action', requireRole('compliance'), asyncHandler(accountsCtrl.applyAction));
router.post('/users/:id/actions/:actionId/reverse', requireRole('compliance'), asyncHandler(accountsCtrl.reverseAction));

// Transactions — finance, fraud, compliance, admin
router.get('/transactions', requireRole('finance', 'fraud', 'compliance', 'support'), asyncHandler(txnCtrl.list));
router.post('/transactions/:txnId/reverse', requireRole('finance'), asyncHandler(accountsCtrl.reverseTransaction));

// Wallet — search/history viewable by finance+admin, manual credit/debit is super-admin only
router.get('/wallet/search', requireRole('finance'), asyncHandler(walletCtrl.search));
router.get('/wallet/:walletId/history', requireRole('finance'), asyncHandler(walletCtrl.getWalletHistory));
router.post('/wallet/:walletId/adjust', requireRole(), asyncHandler(walletCtrl.adjust));

// Fee configuration — settings, super-admin only
router.get('/fees', requireRole(), asyncHandler(feesCtrl.list));
router.patch('/fees/:id', requireRole(), asyncHandler(feesCtrl.update));

// Platform settings (withdrawal limits, tier requirements, etc.) — super-admin only
router.get('/settings', requireRole(), asyncHandler(settingsCtrl.list));
router.patch('/settings/:key', requireRole(), asyncHandler(settingsCtrl.update));

// Audit logs — compliance + admin
router.get('/audit-logs', requireRole('compliance'), asyncHandler(auditCtrl.list));

// Fraud monitoring — fraud role + admin
router.get('/fraud-alerts', requireRole('fraud'), asyncHandler(fraudCtrl.list));
router.post('/fraud-alerts/:id/action', requireRole('fraud'), asyncHandler(fraudCtrl.takeAction));

// Recovery center — recovery role + admin
router.get('/recovery-requests', requireRole('recovery'), asyncHandler(recoveryCtrl.list));
router.get('/recovery-requests/user/:userId', requireRole('recovery'), asyncHandler(recoveryCtrl.historyForUser));
router.post('/recovery-requests/:id/resolve', requireRole('recovery'), asyncHandler(recoveryCtrl.resolve));

// Support tickets — support + admin
router.get('/support/tickets', requireRole('support'), asyncHandler(supportCtrl.listAllTickets));
router.post('/support/tickets/:id/reply', requireRole('support'), asyncHandler(supportCtrl.replyTicket));

// Internal notifications — everyone can read/mark-read, only super-admin can broadcast
router.get('/notifications', asyncHandler(notificationsCtrl.list));
router.post('/notifications/:id/read', asyncHandler(notificationsCtrl.markRead));
router.post('/notifications', requireRole(), asyncHandler(notificationsCtrl.create));

// Staff directory + role management — super-admin only
router.post('/admins', requireRole(), asyncHandler(authCtrl.createAdmin));
router.get('/staff', requireRole(), asyncHandler(staffCtrl.list));
router.patch('/staff/:id/role', requireRole(), asyncHandler(staffCtrl.updateRole));
router.patch('/staff/:id/status', requireRole(), asyncHandler(staffCtrl.updateStatus));

module.exports = router;
