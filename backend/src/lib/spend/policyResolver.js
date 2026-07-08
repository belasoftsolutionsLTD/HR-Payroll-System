const { findMany } = require('../../functions/Database/commonDBFunctions');

// Shared by expense_policies and procurement_policies — both use the same
// `appliesTo: { roles?, departments?, employeeIds? }` targeting shape. More specific
// targeting wins: an explicit employeeId match beats a role match beats a department
// match. If nothing targets this employee specifically, fall back to the policy marked
// isDefault, then to any active policy — so a fresh/unmigrated DB with a single
// untargeted policy doc (the shape this app shipped with before targeting existed)
// still resolves correctly with zero migration required.
const specificity = (appliesTo, employeeId, role, department) => {
  if (appliesTo?.employeeIds?.some((id) => String(id) === String(employeeId))) return 3;
  if (appliesTo?.roles?.includes(role)) return 2;
  if (appliesTo?.departments?.includes(department)) return 1;
  return 0;
};

const resolvePolicy = async (collection, { employeeId, role, department }) => {
  const policies = await findMany(collection, { isActive: { $ne: false } }, {});
  if (!policies.length) return null;

  let best = null;
  let bestScore = -1;
  for (const p of policies) {
    const score = specificity(p.appliesTo, employeeId, role, department);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  if (bestScore > 0) return best;

  return policies.find((p) => p.isDefault) || policies[0];
};

module.exports = { resolvePolicy };
