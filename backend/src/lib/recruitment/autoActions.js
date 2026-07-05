const { ObjectId } = require('mongodb');
const { findOne, updateOne } = require('../../functions/Database/commonDBFunctions');
const { notifyUser } = require('../../functions/HR/notifyUser');
const { sendEmail } = require('../../services/emailService');
const { renderTemplate } = require('./emailTemplateHelpers');

// direction: 'onEnter' | 'onExit' — called from the stage-move handler after writing stageHistory
async function fireAutoActions(application, stage, db, direction) {
  const actions = (stage.autoActions || []).filter((a) => a.trigger === direction);
  if (!actions.length) return;

  const [candidate, requisition] = await Promise.all([
    findOne('candidates', { _id: new ObjectId(application.candidateId) }),
    findOne('jobRequisitions', { _id: new ObjectId(application.requisitionId) }),
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
          ? await findOne('emailTemplates', { _id: new ObjectId(action.templateId) })
          : null;
        const tokens = {
          candidateName: `${candidate.firstName} ${candidate.lastName}`,
          jobTitle: requisition?.title || '',
          companyName: process.env.COMPANY_NAME || 'Bella ERP',
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
        await updateOne('applications', { _id: application._id }, {
          $set: { status: 'rejected', rejectionReason: 'Automatically rejected by pipeline rule.', updatedAt: new Date() },
        });
      }
    } catch {
      // Non-critical — never let an automation failure block the stage move
    }
  }
}

module.exports = { fireAutoActions };
