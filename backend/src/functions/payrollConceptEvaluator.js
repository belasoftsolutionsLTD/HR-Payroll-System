// Evaluates a payroll Concept's calculation `type` (fixed/variable/percentage/formula/
// bracket) into a concrete amount for one employee, given the pay-context values
// available at that point in the payroll lock (basic_salary/gross_salary/
// adjusted_gross/hours_worked).
//
// The formula type deliberately avoids dynamic code execution (no eval, no runtime
// function construction) — it's a tiny allowlisted recursive-descent parser over
// +,-,*,/,(,) and exactly four named variables, so a concept's formula string can
// never execute arbitrary code.

const { calcBracketAmount } = require('./bracketCalculator');

const ALLOWED_VARIABLES = ['basic_salary', 'gross_salary', 'adjusted_gross', 'hours_worked'];

// ── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(formula) {
  const tokens = [];
  const src = String(formula || '');
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('+-*/()'.includes(ch)) { tokens.push({ type: ch, value: ch }); i++; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`Invalid number literal "${raw}"`);
      tokens.push({ type: 'number', value: Number(raw) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[a-zA-Z_]/.test(src[j])) j++;
      tokens.push({ type: 'identifier', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in formula`);
  }
  return tokens;
}

// ── Recursive-descent parser + evaluator ────────────────────────────────────
// expression := term (('+'|'-') term)*
// term       := factor (('*'|'/') factor)*
// factor     := ('+'|'-')? factor | primary
// primary    := number | identifier | '(' expression ')'

function evaluateFormula(formula, context = {}, warnings = []) {
  const tokens = tokenize(formula);
  let pos = 0;

  const peek = () => tokens[pos];
  const consume = (type) => {
    const t = tokens[pos];
    if (!t || t.type !== type) throw new Error(`Expected "${type}" at position ${pos}`);
    pos++;
    return t;
  };

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of formula');
    if (t.type === 'number') { pos++; return t.value; }
    if (t.type === 'identifier') {
      pos++;
      if (!ALLOWED_VARIABLES.includes(t.value)) {
        warnings.push(`Unknown variable "${t.value}" — treated as 0`);
        return 0;
      }
      const val = context[t.value];
      return typeof val === 'number' && !Number.isNaN(val) ? val : 0;
    }
    if (t.type === '(') {
      pos++;
      const val = parseExpression();
      consume(')');
      return val;
    }
    throw new Error(`Unexpected token "${t.value}"`);
  }

  function parseFactor() {
    if (peek()?.type === '-') { pos++; return -parseFactor(); }
    if (peek()?.type === '+') { pos++; return parseFactor(); }
    return parsePrimary();
  }

  function parseTerm() {
    let val = parseFactor();
    while (peek() && (peek().type === '*' || peek().type === '/')) {
      const op = consume(peek().type).type;
      const rhs = parseFactor();
      if (op === '*') {
        val *= rhs;
      } else if (rhs === 0) {
        warnings.push('Division by zero — treated as 0');
        val = 0;
      } else {
        val /= rhs;
      }
    }
    return val;
  }

  function parseExpression() {
    let val = parseTerm();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = consume(peek().type).type;
      const rhs = parseTerm();
      val = op === '+' ? val + rhs : val - rhs;
    }
    return val;
  }

  if (tokens.length === 0) throw new Error('Empty formula');
  const result = parseExpression();
  if (pos !== tokens.length) throw new Error('Unexpected trailing tokens in formula');
  return result;
}

// ── Concept amount resolution ───────────────────────────────────────────────
//
// concept: a payroll_concepts document (type, percentageOf, percentageValue, formula, brackets,
//          plus the optional statutory-tax fields cap/flatCredit — see applyCapAndCredit above)
// assignment: the employee_compensations document (amount — used for type:'fixed'/'variable')
// context: { basic_salary, gross_salary, adjusted_gross, hours_worked }
//
// Returns { amount, warnings }. Never throws — a malformed formula/bracket config
// degrades to 0 with a warning rather than blocking an entire payroll run over one
// employee's bad concept data (matches the existing "never crash the whole run over
// one employee's bad data" philosophy already used for payroll readiness checks).
// Applied to the raw (pre-rounding) result of percentage/bracket/formula types, in this
// order: cap first (matches taxCalculator.js's existing clamp-then-adjust convention for
// NSSF/SHA/AHL-style capped statutory deductions), then flatCredit (a flat post-calculation
// credit floored at zero — e.g. PAYE's personal relief). Both fields are optional/absent on
// every concept created before this extension, so this is a no-op for all existing concepts.
function applyCapAndCredit(raw, concept) {
  const capped = typeof concept.cap === 'number' ? Math.min(raw, concept.cap) : raw;
  return typeof concept.flatCredit === 'number' ? Math.max(0, capped - concept.flatCredit) : capped;
}

function evaluateConceptAmount(concept, assignment, context = {}) {
  const warnings = [];
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  try {
    switch (concept?.type) {
      case 'fixed':
      case 'variable':
        return { amount: round2(Number(assignment?.amount) || 0), warnings };

      case 'percentage': {
        const base = context[concept.percentageOf];
        if (typeof base !== 'number') {
          warnings.push(`percentageOf "${concept.percentageOf}" is not available in this context — treated as 0`);
          return { amount: 0, warnings };
        }
        const pct = Number(concept.percentageValue) || 0;
        return { amount: round2(applyCapAndCredit(base * (pct / 100), concept)), warnings };
      }

      case 'formula': {
        if (!concept.formula) {
          warnings.push('No formula defined — treated as 0');
          return { amount: 0, warnings };
        }
        const raw = evaluateFormula(concept.formula, context, warnings);
        return { amount: round2(applyCapAndCredit(Math.max(0, raw), concept)), warnings };
      }

      case 'bracket': {
        const base = context[concept.percentageOf || 'adjusted_gross'];
        if (typeof base !== 'number') {
          warnings.push('Bracket base amount not available in this context — treated as 0');
          return { amount: 0, warnings };
        }
        const raw = calcBracketAmount(base, concept.brackets || []);
        return { amount: round2(applyCapAndCredit(raw, concept)), warnings };
      }

      default:
        warnings.push(`Unknown concept type "${concept?.type}" — treated as 0`);
        return { amount: 0, warnings };
    }
  } catch (err) {
    warnings.push(`Evaluation error: ${err.message} — treated as 0`);
    return { amount: 0, warnings };
  }
}

module.exports = { evaluateFormula, evaluateConceptAmount, ALLOWED_VARIABLES };
