/**
 * Wraps an async Express route handler and forwards any rejected promise to next().
 * Usage: router.get('/path', AsyncHandler(async (req, res) => { ... }))
 */
const AsyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = AsyncHandler;
