/**
 * Sends push notifications via Expo's push service. Uses Node 18's built-in
 * fetch — no SDK dependency needed for this simple a use case.
 * Docs: https://docs.expo.dev/push-notifications/sending-notifications/
 */
async function sendPushNotification(expoPushToken, { title, body, data }) {
  if (!expoPushToken) return { skipped: true, reason: 'no token on file for this device' };

  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to: expoPushToken, title, body, data, sound: 'default' }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { skipped: false, error: json };
    return { skipped: false, result: json };
  } catch (err) {
    // Push delivery failure should never break the underlying transaction —
    // the user will still see the update next time they open the app.
    return { skipped: false, error: err.message };
  }
}

module.exports = { sendPushNotification };
