// Marginal/progressive bracket calculator — each bracket's `limit` is the WIDTH of
// income consumed at that bracket's rate (not a cumulative ceiling), and rates are
// stored as percentages (e.g. 10 = 10%). A bracket with `limit: null` is the
// catch-all top bracket and consumes whatever remains.
//
// Shared calculation core behind PAYE-style progressive tax brackets (taxCalculator.js)
// and the payroll Concepts "bracket" calculation type — same math, two different
// callers. Deliberately unrounded — callers round after any further adjustment
// (e.g. taxCalculator.js subtracts personal relief before rounding).
const calcBracketAmount = (amount, brackets = []) => {
  let total = 0;
  let rem = amount;
  for (const b of brackets) {
    if (rem <= 0) break;
    const rate = (b.rate || 0) / 100;
    if (b.limit) {
      const consumed = Math.min(rem, b.limit);
      total += consumed * rate;
      rem -= consumed;
    } else {
      total += rem * rate;
      rem = 0;
    }
  }
  return total;
};

module.exports = { calcBracketAmount };
