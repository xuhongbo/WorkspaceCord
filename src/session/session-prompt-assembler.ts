import { getAgent } from '../agents.ts';
import { getPersonality } from '../project-manager.ts';
import { buildDiscordSessionMessageContext } from '../discord/session-message-context.ts';
import type { ThreadSession } from '../types.ts';

const MODE_PROMPTS: Record<ThreadSession['mode'], string> = {
  auto: '',
  plan: 'You MUST use EnterPlanMode at the start of every task. Present your plan for user approval before making any code changes. Do not write or edit files until the user approves the plan.',
  normal:
    'Before performing destructive or significant operations (deleting files, running dangerous commands, making large refactors, writing to many files), use AskUserQuestion to confirm with the user first. Ask for explicit approval before proceeding with changes.',
  monitor:
    'This session is running in monitored autonomy mode. Treat the active user request as the task objective and keep working until it is fully satisfied. Do not stop at a partial implementation or ask the user for follow-up direction unless you are truly blocked by missing permissions, credentials, or required external information that you cannot obtain yourself. When you believe the task is complete, explain concisely what was finished and why it satisfies the request.',
};

const MONITOR_SYSTEM_PROMPT = `You are a monitor agent supervising another coding agent.

Your job is to judge progress against the user's original request and decide whether the worker should continue.

Return JSON only in this schema:
{
  "status": "complete" | "continue" | "blocked",
  "confidence": "high" | "medium" | "low",
  "rationale": "Short explanation tied to the original request",
  "steering": "Concrete next instructions for the worker. Empty string only when status is complete.",
  "completionSummary": "Short summary of what is complete. Empty string unless status is complete."
}

Rules:
- Favor continuing unless the task clearly satisfies the original request.
- Judge against robustness, completeness, and the user's stated quality bar, not just whether some code changed.
- If the worker stopped early, ask for the next concrete step instead of accepting the output.
- Use "blocked" only for true blockers the worker cannot resolve autonomously.
- Never ask the human for optional next steps.
- Output valid JSON and nothing else.`;

export function buildSystemPromptParts(session: ThreadSession): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.categoryId);
  if (personality) parts.push(personality);

  if (session.agentPersona) {
    const agent = getAgent(session.agentPersona);
    if (agent?.systemPrompt) parts.push(agent.systemPrompt);
  }

  const modePrompt = MODE_PROMPTS[session.mode];
  if (modePrompt) parts.push(modePrompt);

  parts.push(buildDiscordSessionMessageContext());

  return parts;
}

export function buildMonitorSystemPromptParts(session: ThreadSession): string[] {
  const parts: string[] = [];

  const personality = getPersonality(session.categoryId);
  if (personality) parts.push(personality);

  parts.push(MONITOR_SYSTEM_PROMPT);
  parts.push(buildDiscordSessionMessageContext());
  return parts;
}
