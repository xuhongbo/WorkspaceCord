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
export { HumanGateRegistry, type HumanGateRecord } from './human-gate.ts';

// 门控统一 facade(P1 重构后)
export {
  GateService,
  gateService,
  type CreateGateParams,
  type ReceiptHandle,
  type InvalidatedGate,
} from './gate-service.ts';

// 向后兼容别名:旧代码继续用 gateCoordinator / GateCoordinator / GateManager 也可以工作
// TODO(P3a): 最终仅保留 gateService,删掉这些 alias
export { gateService as gateCoordinator } from './gate-service.ts';
export { GateService as GateCoordinator } from './gate-service.ts';
export { GateService as GateManager } from './gate-service.ts';
