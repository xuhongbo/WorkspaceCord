import { truncate } from '../utils.ts';
import type { SessionNextProofContract } from '../types.ts';

export interface MonitorDecisionLike {
  rationale: string;
  steering: string;
  acceptedEvidence: string[];
  missingEvidence: string[];
  requiredNextProof: string[];
  disallowedDrift: string[];
}

export function buildMonitorPrompt(
  goal: string,
  latestOutput: string,
  reportJson: string,
  iteration: number,
  previousContract?: SessionNextProofContract,
): string {
  const sections = [
    'You are a monitor reviewing whether a worker fully satisfied the original request.',
    '',
    `Original request:`,
    goal,
    '',
    `Iteration: ${iteration}`,
    '',
    'Latest worker summary:',
    latestOutput || '(none)',
    '',
    'Worker progress report (JSON):',
    reportJson,
  ];

  if (previousContract) {
    sections.push(
      '',
      'Previous proof contract:',
      JSON.stringify(previousContract, null, 2),
    );
  }

  sections.push(
    '',
    'Return JSON only in this schema:',
    '{',
    '  "status": "complete" | "continue" | "blocked",',
    '  "confidence": "high" | "medium" | "low",',
    '  "rationale": "Short explanation tied to the original request",',
    '  "steering": "Concrete next instructions for the worker. Empty string only when status is complete.",',
    '  "completionSummary": "Short summary of what is complete. Empty string unless status is complete.",',
    '  "acceptedEvidence": ["..."],',
    '  "missingEvidence": ["..."],',
    '  "requiredNextProof": ["..."],',
    '  "disallowedDrift": ["..."],',
    '  "blockingReason": "..."',
    '}',
  );

  return sections.join('\n');
}

export function buildSteeringPrompt(
  goal: string,
  decision: MonitorDecisionLike,
  iteration: number,
  proofContract?: SessionNextProofContract,
): string {
  const parts = [
    `Continue working on the same task. This is monitored continuation pass ${iteration}.`,
    '',
    'Original request:',
    goal,
    '',
    `Monitor rationale: ${decision.rationale || 'The task is not complete yet.'}`,
  ];

  if (decision.steering) {
    parts.push('', 'Required next steps:', decision.steering);
  }
  if (decision.acceptedEvidence.length > 0) {
    parts.push('', 'Evidence already accepted:', ...decision.acceptedEvidence.map((item) => `- ${item}`));
  }
  if (decision.missingEvidence.length > 0) {
    parts.push('', 'Evidence still missing:', ...decision.missingEvidence.map((item) => `- ${item}`));
  }
  if (decision.requiredNextProof.length > 0) {
    parts.push('', 'Your next pass must prove:', ...decision.requiredNextProof.map((item) => `- ${item}`));
  }
  if (decision.disallowedDrift.length > 0) {
    parts.push('', 'Avoid this drift until the missing proof is produced:', ...decision.disallowedDrift.map((item) => `- ${item}`));
  }
  if (proofContract) {
    if (proofContract.requiredArtifacts.length > 0) {
      parts.push('', 'Required artifacts for this pass:', ...proofContract.requiredArtifacts.map((item) => `- ${item}`));
    }
    if (proofContract.requiredValidation.length > 0) {
      parts.push('', 'Required validation for this pass:', ...proofContract.requiredValidation.map((item) => `- ${item}`));
    }
    parts.push('', `Stop condition: ${proofContract.stopCondition}`);
  }

  parts.push(
    '',
    'Do not restate what is already done. Use the current repo/session state and focus only on the remaining gap. Do not stop until the remaining work is addressed or you hit a true blocker.',
  );

  return parts.join('\n');
}

export function buildAskUserReviewPrompt(
  goal: string,
  questionsJson: string,
  latestOutput: string,
): string {
  return [
    'You are deciding whether a worker question actually requires a human.',
    '',
    'Return JSON only in this schema:',
    '{',
    '  "shouldAskHuman": true | false,',
    '  "rationale": "Short explanation",',
    '  "autoResponse": "If shouldAskHuman is false, provide the answer or direction the worker should use. Empty string otherwise."',
    '}',
    '',
    'Rules:',
    '- Ask the human only when there is a real, non-obvious branching decision that materially affects how to fulfill the original request.',
    '- If one option is clearly better for fulfilling the original request, do not ask the human; provide the answer directly.',
    '- If the worker is asking for permission or direction it can infer from the goal, do not ask the human.',
    '',
    'Original request:',
    goal,
    '',
    'Latest worker output before the question:',
    latestOutput || '(none)',
    '',
    'Worker question payload:',
    questionsJson,
  ].join('\n');
}
