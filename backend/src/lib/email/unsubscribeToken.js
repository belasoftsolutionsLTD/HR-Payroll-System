const crypto = require('crypto');

// A stable, verifiable, per-user unsubscribe token with no DB storage or extra
// generation step — an HMAC of the user's own _id, keyed on the same server secret
// already used to sign auth tokens. Nobody can forge another user's link (they'd need
// JWT_SECRET), and it never expires or needs rotating, unlike the one-time
// crypto.randomBytes tokens used for password reset.
const generateUnsubscribeToken = (userId) =>
  crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(userId)).digest('hex');

const verifyUnsubscribeToken = (userId, token) => {
  if (!token) return false;
  const expected = generateUnsubscribeToken(userId);
  // Constant-time comparison — this guards a real account setting, not just a cosmetic toggle.
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = { generateUnsubscribeToken, verifyUnsubscribeToken };
