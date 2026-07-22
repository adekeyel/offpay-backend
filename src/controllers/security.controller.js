const QRCode = require('qrcode');
const ApiError = require('../utils/ApiError');
const securityService = require('../services/security.service');
const auditService = require('../services/audit.service');

async function getSettings(req, res) {
  const settings = await securityService.getSettings(req.user.id);
  res.json({ success: true, data: settings });
}

async function updateTransferProtection(req, res) {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') throw ApiError.badRequest('enabled (boolean) is required.');
  await securityService.setTransferProtection(req.user.id, enabled);
  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'SECURITY_TRANSFER_PROTECTION', targetType: 'user', targetId: req.user.id, meta: { enabled }, ipAddress: req.ip });
  res.json({ success: true, message: `Transfer protection ${enabled ? 'enabled' : 'disabled'}.` });
}

async function updateBiometrics(req, res) {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') throw ApiError.badRequest('enabled (boolean) is required.');
  await securityService.setBiometrics(req.user.id, enabled);
  res.json({ success: true, message: `Biometrics ${enabled ? 'enabled' : 'disabled'}.` });
}

/** Step 1: generate an unconfirmed secret + QR code for the user to scan. */
async function startGoogle2fa(req, res) {
  const { secret, otpauthUrl } = await securityService.startGoogle2faSetup(req.user.id, req.user.email);
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
  res.json({ success: true, data: { secret, otpauthUrl, qrDataUrl } });
}

/** Step 2: confirm the 6-digit code from the authenticator app to actually turn it on. */
async function confirmGoogle2fa(req, res) {
  const { code } = req.body;
  if (!code) throw ApiError.badRequest('code is required.');
  await securityService.confirmGoogle2faSetup(req.user.id, code);
  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'SECURITY_GOOGLE_2FA_ENABLED', targetType: 'user', targetId: req.user.id, ipAddress: req.ip });
  res.json({ success: true, message: 'Google 2FA enabled for withdrawals.' });
}

async function disableGoogle2fa(req, res) {
  await securityService.disableGoogle2fa(req.user.id);
  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'SECURITY_GOOGLE_2FA_DISABLED', targetType: 'user', targetId: req.user.id, ipAddress: req.ip });
  res.json({ success: true, message: 'Google 2FA disabled.' });
}

async function updateEmail2fa(req, res) {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') throw ApiError.badRequest('enabled (boolean) is required.');
  await securityService.setEmail2faWithdrawals(req.user.id, enabled);
  await auditService.logAction({ actorType: 'user', actorId: req.user.id, action: 'SECURITY_EMAIL_2FA_WITHDRAWALS', targetType: 'user', targetId: req.user.id, meta: { enabled }, ipAddress: req.ip });
  res.json({ success: true, message: `Email 2FA for withdrawals ${enabled ? 'enabled' : 'disabled'}.` });
}

/** Sends the emailed transfer OTP — the client calls this right before submitting a transfer that needs it (email method only; Google 2FA users just read the code off their app). */
async function requestTransferOtp(req, res) {
  await securityService.requestTransferOtp({ userId: req.user.id, email: req.user.email });
  res.json({ success: true, message: 'A verification code has been sent to your email.' });
}

module.exports = {
  getSettings,
  updateTransferProtection,
  updateBiometrics,
  startGoogle2fa,
  confirmGoogle2fa,
  disableGoogle2fa,
  updateEmail2fa,
  requestTransferOtp,
};
