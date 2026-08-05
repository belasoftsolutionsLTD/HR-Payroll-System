const logger = require('../logger');

// Cloudflare Turnstile bot-protection check for the login form. Deliberately a no-op
// (returns true) when TURNSTILE_SECRET_KEY isn't set — same posture as emailService's
// getTransporter() when SMTP isn't configured — so local/dev environments that haven't
// registered a Turnstile site+secret key pair keep working without a captcha gate.
// Sign up free at https://dash.cloudflare.com/?to=/:account/turnstile to get real keys.
const verifyTurnstile = async (token, remoteIp) => {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json();
    return !!data.success;
  } catch (err) {
    logger.error('Turnstile verification request failed', { error: err.message });
    return false;
  }
};

module.exports = { verifyTurnstile };
