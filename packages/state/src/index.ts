// @workspacecord/state — state machine, gates, event normalization

export * from './types.ts';
export { stateMachine, StateMachine } from './state-machine.ts';
export {
  toProjection,
  toPanelProjection,
  resolveDisplayState,
  getStateLabel,
  getStateColor,
} from './state-projections.ts';
export { mapEventToTransition } from './state-event-mapper.ts';
export { StateLookup } from './state-lookup.ts';
export { toPlatformEvent, mapPlatformEventToState, normalizeCodexEvent } from './event-normalizer.ts';
export { GateManager, type CreateGateParams } from './gate-manager.ts';
export { HumanGateRegistry, type HumanGateRecord } from './human-gate.ts';
export { GateCoordinator, gateCoordinator } from './gate-coordinator.ts';
