import type { SessionNextProofContract, SessionWorkerProgressReport } from '@workspacecord/core';

export interface ProofDecisionLike {
  status: 'complete' | 'continue' | 'blocked';
  completionSummary: string;
  rationale: string;
  acceptedEvidence: string[];
  missingEvidence: string[];
  requiredNextProof: string[];
  disallowedDrift: string[];
}

function deriveRequiredArtifacts(
  missingEvidence: string[],
  workerReport?: SessionWorkerProgressReport,
): string[] {
  const fromMissing = missingEvidence.filter((item) =>
    /\b(file|artifact|report|rubric|spec|scenario|benchmark)\b/i.test(item),
  );
  const artifactHints = workerReport?.artifacts ?? [];
  return [...new Set([...fromMissing, ...artifactHints])].slice(0, 6);
}

function deriveRequiredValidation(
  requiredNextProof: string[],
  workerReport?: SessionWorkerProgressReport,
): string[] {
  const fromProof = requiredNextProof.filter((item) =>
    /\b(test|validate|validation|benchmark|grader|check|prove|metric)\b/i.test(item),
  );
  const validations = workerReport?.validationCommands ?? [];
  return [...new Set([...fromProof, ...validations])].slice(0, 6);
}

export function buildNextProofContract(
  goal: string,
  decision: Pick<
    ProofDecisionLike,
    | 'acceptedEvidence'
    | 'missingEvidence'
    | 'requiredNextProof'
    | 'disallowedDrift'
    | 'status'
    | 'completionSummary'
    | 'rationale'
  >,
  workerReport?: SessionWorkerProgressReport,
): SessionNextProofContract | undefined {
  if (decision.status !== 'continue') return undefined;

  const requiredNextProof =
    decision.requiredNextProof.length > 0
      ? decision.requiredNextProof
      : ['Produce concrete evidence that the original request is complete.'];

  const missingEvidence =
    decision.missingEvidence.length > 0
      ? decision.missingEvidence
      : ['Concrete completion evidence tied to the original request.'];

  return {
    goal,
    acceptedEvidence: decision.acceptedEvidence,
    missingEvidence,
    requiredNextProof,
    requiredArtifacts: deriveRequiredArtifacts(missingEvidence, workerReport),
    requiredValidation: deriveRequiredValidation(requiredNextProof, workerReport),
    stopCondition:
      decision.completionSummary ||
      decision.rationale ||
      'Stop only once the missing proof is explicitly present.',
    avoidUntilProved: decision.disallowedDrift,
  };
}
