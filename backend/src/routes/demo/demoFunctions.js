const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { findOne, findMany, insertOne } = require('../../functions/Database/commonDBFunctions');
const returnFunction = require('../../functions/returnFunction');
const { GUEST } = require('../../constants/roles');
const { ensureDemoRecruitmentData } = require('../../lib/demo/seedDemoRecruitment');

const DEMO_EMAIL = 'demo-guest@workfola.internal';

// Every visitor who clicks "View Demo" shares the same single guest account —
// there's nothing per-visitor to isolate since the data behind it is 100% fake
// and read-only, so a dedicated account per click would just be bookkeeping
// with no safety benefit.
const ensureDemoUser = async () => {
  const existing = await findOne('users', { email: DEMO_EMAIL }, { projection: { _id: 1 } });
  if (existing) return existing._id;
  // Never actually used to log in (demoLogin issues a token directly, bypassing
  // /api/auth/login entirely) — hashed so a stray login attempt against this email
  // fails cleanly via bcrypt.compare rather than erroring on a null hash.
  const hashed = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
  const result = await insertOne('users', {
    name: 'Demo Guest',
    email: DEMO_EMAIL,
    password: hashed,
    role: GUEST,
    employeeId: null,
    department: null,
    mustResetPassword: false,
    isActive: true,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return result.insertedId;
};

// Public, unauthenticated — the entire point of "View Demo" is zero friction.
// Rate-limited (see demo.js) since it's an unauthenticated token-issuing endpoint.
const demoLogin = async (req, res) => {
  const [userId] = await Promise.all([ensureDemoUser(), ensureDemoRecruitmentData()]);
  const accessToken = jwt.sign(
    { userId: userId.toString() },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }, // short-lived — this is a sales walkthrough, not a session to persist
  );
  return returnFunction(res, 200, true, 'Demo session started.', { token: accessToken });
};

// The only read endpoint the guest role can reach. Deliberately takes no id from the
// caller — there is exactly one demo requisition, so there's nothing to parameterize
// and therefore nothing for a guest to tamper with to reach other data.
const getDemoPipeline = async (req, res) => {
  const requisition = await findOne('jobRequisitions', { isDemoData: true });
  if (!requisition) return returnFunction(res, 404, false, 'Demo data not seeded yet.');

  const applications = await findMany('applications', { isDemoData: true, requisitionId: requisition._id }, { sort: { createdAt: -1 } });
  const candidateIds = [...new Set(applications.map((a) => String(a.candidateId)))];
  const candidates = candidateIds.length
    ? await findMany('candidates', { _id: { $in: candidateIds.map((id) => new ObjectId(id)) } })
    : [];
  const candidateMap = Object.fromEntries(candidates.map((c) => [String(c._id), c]));

  const enriched = applications.map((a) => ({
    ...a,
    candidate: candidateMap[String(a.candidateId)] || null,
  }));
  const byStage = {};
  enriched.forEach((a) => {
    if (!byStage[a.currentStageId]) byStage[a.currentStageId] = [];
    byStage[a.currentStageId].push(a);
  });

  return returnFunction(res, 200, true, 'OK', { requisition, applications: enriched, byStage });
};

module.exports = { demoLogin, getDemoPipeline };
