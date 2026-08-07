// Postgres migration (see /home/carole/.claude/plans/abundant-dreaming-flurry.md,
// Phase 4) — candidates/jobRequisitions/email_templates now live in Postgres.
const { knex } = require('../../functions/Database/pgDBFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');
const { sendEmail } = require('../../services/emailService');
const { renderTemplate } = require('../../services/emailTemplateService');

// direction: 'onEnter' | 'onExit' — called from the stage-move handler after writing
// stageHistory. The `db` param was always unused (dead ever since Mongo — every real
// read here already went through the shared DB helpers, not the raw handle) — dropped
// rather than carried forward as `dbo`/`knex` nobody reads.
async function fireAutoActions(application, stage, direction) {
  const actions = (stage.autoActions || []).filter((a) => a.trigger === direction);
  if (!actions.length) return;

  const [candidate, requisition] = await Promise.all([
    knex('candidates').where({ id: String(application.candidateId) }).first(),
    knex('job_requisitions').where({ id: String(application.requisitionId) }).first(),
  ]);

  for (const action of actions) {
    try {
      if (action.action === 'notifyHiringManager' && requisition?.hiringManagerId) {
        await notifyUser(requisition.hiringManagerId, {
          title: 'Candidate Moved',
          body: `${candidate ? `${candidate.firstName} ${candidate.lastName}` : 'A candidate'} moved to "${stage.name}" for ${requisition.title}.`,
          type: 'recruitment',
        });
      }

      if (action.action === 'emailCandidate' && candidate?.email) {
        const template = action.templateId
          ? await knex('email_templates').where({ id: String(action.templateId) }).first()
          : null;
        const tokens = {
          candidateName: `${candidate.firstName} ${candidate.lastName}`,
          jobTitle: requisition?.title || '',
          companyName: process.env.COMPANY_NAME || 'Workfola',
        };
        await sendEmail({
          to: candidate.email,
          subject: template ? renderTemplate(template.subject, tokens) : `Update on your application for ${tokens.jobTitle}`,
          html: template
            ? renderTemplate(template.body, tokens)
            : `<p>Dear ${tokens.candidateName},</p><p>Your application has moved to the "${stage.name}" stage.</p><p>Regards,<br/>${tokens.companyName}</p>`,
        });
      }

      if (action.action === 'autoReject') {
        await knex('applications').where({ id: application.id }).update({
          status: 'rejected', rejectionReason: 'Automatically rejected by pipeline rule.', updatedAt: new Date(),
        });
      }
    } catch {
      // Non-critical — never let an automation failure block the stage move
    }
  }
}

module.exports = { fireAutoActions };
