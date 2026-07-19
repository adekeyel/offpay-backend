const { query } = require('../config/db');
const ApiError = require('../utils/ApiError');

/**
 * Called once by the native app after generating its Ed25519 keypair
 * on-device (private key stays in the device's secure keystore/keychain —
 * never sent anywhere). Registers the public key so this backend can later
 * verify offline-transfer vouchers signed by this device.
 */
async function registerDeviceKey(req, res) {
  const { deviceId, publicKey, platform } = req.body;
  if (!deviceId || !publicKey) throw ApiError.badRequest('deviceId and publicKey are required.');

  await query(
    `INSERT INTO devices (user_id, device_id, public_key, platform, last_seen_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (user_id, device_id) DO UPDATE SET public_key = $3, platform = $4, last_seen_at = now()`,
    [req.user.id, deviceId, publicKey, platform || null]
  );
  res.json({ success: true, message: 'Device key registered.' });
}

/** Called whenever the app obtains/refreshes its Expo push token. */
async function registerPushToken(req, res) {
  const { deviceId, expoPushToken, platform } = req.body;
  if (!deviceId || !expoPushToken) throw ApiError.badRequest('deviceId and expoPushToken are required.');

  await query(
    `INSERT INTO devices (user_id, device_id, expo_push_token, platform, last_seen_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (user_id, device_id) DO UPDATE SET expo_push_token = $3, platform = COALESCE($4, devices.platform), last_seen_at = now()`,
    [req.user.id, deviceId, expoPushToken, platform || null]
  );
  res.json({ success: true, message: 'Push token registered.' });
}

module.exports = { registerDeviceKey, registerPushToken };
