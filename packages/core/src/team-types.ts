import type { ProviderName } from './types.ts';

export type TeamPhaseStatus = 'pending' | 'in_progress' | 'completed';
export type TeamTaskPhase = 'planning' | 'executing' | 'reviewing' | 'completed' | 'failed';

export interface PhaseAssignment {
  role: string;
  description: string;
  agentName?: string; // filled after team assembly
  status: TeamPhaseStatus;
  result?: string; // collected response text
}

export interface TaskPhase {
  name: string;
  assignments: PhaseAssignment[];
  status: TeamPhaseStatus;
}

export interface TaskPlan {
  summary: string;
  phases: TaskPhase[];
}

export interface TeamAgent {
  agentId: string;
  role: string;
  reused: boolean;
}

export interface TeamTask {
  id: string;
  description: string;
  projectName: string;
  directory: string;
  channelId: string;
  managerSessionId: string;
  phase: TeamTaskPhase;
  plan: TaskPlan | null;
  agents: TeamAgent[];
  createdAt: number;
  createdBy: string;
  completedAt?: number;
}

export interface TeamTaskPersistData {
  id: string;
  description: string;
  projectName: string;
  directory: string;
  channelId: string;
  managerSessionId: string;
  phase: TeamTaskPhase;
  plan: TaskPlan | null;
  agents: TeamAgent[];
  createdAt: number;
  createdBy: string;
  completedAt?: number;
}
