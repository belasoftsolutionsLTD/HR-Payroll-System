/**
 * Sends a standardised JSON response.
 * @param {import('express').Response} res
 * @param {number} statusCode
 * @param {boolean} success
 * @param {string} message
 * @param {*} [data]
 */
const returnFunction = (res, statusCode, success, message, data = null) => {
  const payload = { success, message };
  if (data !== null && data !== undefined) payload.data = data;
  return res.status(statusCode).json(payload);
};

module.exports = returnFunction;
