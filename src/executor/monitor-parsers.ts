export interface ParsedMonitorDecision {
  status: 'complete' | 'continue' | 'blocked';
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
  steering: string;
  completionSummary: string;
  acceptedEvidence: string[];
  missingEvidence: string[];
  requiredNextProof: string[];
  disallowedDrift: string[];
  blockingReason: string;
}

export interface ParsedAskUserDecision {
  shouldAskHuman: boolean;
  rationale: string;
  autoResponse: string;
}

export function parseMonitorDecision(text: string): ParsedMonitorDecision | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<ParsedMonitorDecision>;
    if (
      parsed.status !== 'complete' &&
      parsed.status !== 'continue' &&
      parsed.status !== 'blocked'
    ) {
      return null;
    }
    const confidence =
      parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
        ? parsed.confidence
        : 'low';
    return {
      status: parsed.status,
      confidence,
      rationale: (parsed.rationale || '').trim(),
      steering: (parsed.steering || '').trim(),
      completionSummary: (parsed.completionSummary || '').trim(),
      acceptedEvidence: Array.isArray(parsed.acceptedEvidence)
        ? parsed.acceptedEvidence
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      missingEvidence: Array.isArray(parsed.missingEvidence)
        ? parsed.missingEvidence
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      requiredNextProof: Array.isArray(parsed.requiredNextProof)
        ? parsed.requiredNextProof
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      disallowedDrift: Array.isArray(parsed.disallowedDrift)
        ? parsed.disallowedDrift
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [],
      blockingReason: (parsed.blockingReason || '').trim(),
    };
  } catch {
    return null;
  }
}

export function parseAskUserDecision(text: string): ParsedAskUserDecision | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Partial<ParsedAskUserDecision>;
    if (typeof parsed.shouldAskHuman !== 'boolean') return null;
    return {
      shouldAskHuman: parsed.shouldAskHuman,
      rationale: (parsed.rationale || '').trim(),
      autoResponse: (parsed.autoResponse || '').trim(),
    };
  } catch {
    return null;
  }
}
