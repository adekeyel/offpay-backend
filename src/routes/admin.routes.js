const express = require('express');
const router = express.Router();
const asyncHandler = require('../utils/asyncHandler');
const { requireAdminAuth, requireRole } = require('../middleware/auth');
const { adminAuthLimiter, otpLimiter } = require('../middleware/rateLimiter');

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
const loansCtrl = require('../controllers/adminLoans.controller');
const cardsCtrl = require('../controllers/adminCards.controller');
const adsCtrl = require('../controllers/adminAds.controller');
const productsCtrl = require('../controllers/adminProducts.controller');
const { adUpload, persistAdUpload } = require('../middleware/adUpload');

// ---- Public admin auth ----
router.post('/auth/login', adminAuthLimiter, asyncHandler(authCtrl.login));
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

// Tier upgrade review — support + compliance + admin (every tier request must
// be reviewed and approved by one of these roles before kyc_tier changes)
router.get('/kyc/tier-upgrades/pending', requireRole('support', 'compliance'), asyncHandler(kycCtrl.listPendingTierUpgrades));
router.post('/kyc/tier-upgrades/:id/approve', requireRole('support', 'compliance'), asyncHandler(kycCtrl.approveTierUpgrade));
router.post('/kyc/tier-upgrades/:id/reject', requireRole('support', 'compliance'), asyncHandler(kycCtrl.rejectTierUpgrade));

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

// Loan and wealth product interest rates — super-admin only
router.get('/loan-products', requireRole(), asyncHandler(productsCtrl.listLoanProducts));
router.patch('/loan-products/:id', requireRole(), asyncHandler(productsCtrl.updateLoanProduct));
router.get('/wealth-products', requireRole(), asyncHandler(productsCtrl.listWealthProducts));
router.patch('/wealth-products/:id', requireRole(), asyncHandler(productsCtrl.updateWealthProduct));

// Loan requests — Tier 3 only, require admin approval before any funds move
router.get('/loans/pending', requireRole('finance'), asyncHandler(loansCtrl.listPending));
router.get('/loans', requireRole('finance'), asyncHandler(loansCtrl.listAll));
router.post('/loans/:id/approve', requireRole('finance'), asyncHandler(loansCtrl.approve));
router.post('/loans/:id/reject', requireRole('finance'), asyncHandler(loansCtrl.reject));

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
router.get('/support/tickets/:id', requireRole('support'), asyncHandler(supportCtrl.getTicketThreadAdmin));
router.post('/support/tickets/:id/reply', requireRole('support'), asyncHandler(supportCtrl.replyTicket));

// Help-center content (category tiles + FAQs shown on the app's Support
// page). Any support/admin staff can view for review purposes; only
// super-admin can create/edit/delete, matching the fee-config and
// broadcast-to-users pattern elsewhere in this file.
router.get('/support/topics', requireRole('support'), asyncHandler(supportCtrl.adminListTopics));
router.post('/support/topics', requireRole(), asyncHandler(supportCtrl.adminCreateTopic));
router.put('/support/topics/:id', requireRole(), asyncHandler(supportCtrl.adminUpdateTopic));
router.delete('/support/topics/:id', requireRole(), asyncHandler(supportCtrl.adminDeleteTopic));

router.get('/support/faqs', requireRole('support'), asyncHandler(supportCtrl.adminListFaqs));
router.post('/support/faqs', requireRole(), asyncHandler(supportCtrl.adminCreateFaq));
router.put('/support/faqs/:id', requireRole(), asyncHandler(supportCtrl.adminUpdateFaq));
router.delete('/support/faqs/:id', requireRole(), asyncHandler(supportCtrl.adminDeleteFaq));

// Internal notifications — everyone can read/mark-read, only super-admin can broadcast
router.get('/notifications', asyncHandler(notificationsCtrl.list));
router.post('/notifications/:id/read', asyncHandler(notificationsCtrl.markRead));
router.post('/notifications', requireRole(), asyncHandler(notificationsCtrl.create));
router.post('/user-notifications/broadcast', requireRole(), asyncHandler(notificationsCtrl.broadcastToUsers));

// Card visibility (masked only — see adminCards.controller.js) — super admin, support, compliance, operations
router.get('/users/:userId/cards', requireRole('support', 'compliance', 'operations'), asyncHandler(cardsCtrl.getUserCards));

// Ads — super-admin only
router.get('/ads', requireRole(), asyncHandler(adsCtrl.list));
router.post('/ads', requireRole(), adUpload.single('media'), persistAdUpload, asyncHandler(adsCtrl.create));
router.patch('/ads/:id', requireRole(), asyncHandler(adsCtrl.update));
router.delete('/ads/:id', requireRole(), asyncHandler(adsCtrl.remove));

// Staff directory + role management — super-admin only
router.post('/admins', requireRole(), asyncHandler(authCtrl.createAdmin));
router.get('/staff', requireRole(), asyncHandler(staffCtrl.list));
router.patch('/staff/:id/role', requireRole(), asyncHandler(staffCtrl.updateRole));
router.patch('/staff/:id/status', requireRole(), asyncHandler(staffCtrl.updateStatus));

module.exports = router;
