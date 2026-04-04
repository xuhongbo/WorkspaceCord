# Test Coverage Improvement Design

## Goal

系统性地提升项目测试覆盖率，采用分层渐进式策略，避免一次性大规模改动带来的风险。

## Current State

- 59 test files, 377 test cases, all passing
- No coverage tooling installed (`@vitest/coverage-v8` missing)
- ~55 source files without corresponding tests
- 5 E2E/smoke scripts (manual execution only)

## Three-Phase Strategy

### Phase 1: Core Infrastructure Layer

**Scope:** Core abstractions, utilities, session management, state machine

- Install `@vitest/coverage-v8` and configure coverage reporting
- `src/core/` — event-bus, service-bus, logger, di-container, tokens, events
- `src/utils.ts`, `src/config.ts`
- `src/session/session-store.ts`, `src/session/session-manager.ts`
- `src/session-registry.ts`
- `src/state/` — state-machine, event-normalizer, human-gate, gate-coordinator

**Target:** Line coverage >= 80% for covered modules

**Testing approach:** Pure unit tests with minimal mocking. Most core modules have clean dependency boundaries suitable for isolated testing.

### Phase 2: Core Business Pipeline Layer

**Scope:** Message processing, Provider abstractions, session execution, Discord delivery

- `src/providers/claude-provider.ts` (mock Anthropic SDK)
- `src/providers/codex-provider.ts` (mock Codex SDK)
- `src/thread-manager.ts`
- `src/discord/` — delivery, attachment-inbox, delivery-policy, digest-delivery, inbound-envelope, status-card, summary-handler, delivery-notices, interaction-card, session-message-context
- `src/bot-event-router.ts`
- `src/bot-locks.ts`, `src/bot-log-buffer.ts`, `src/bot-presence.ts`
- `src/bot-services-orchestrator.ts`

**Target:** Line coverage >= 75% for covered modules

**Testing approach:** Unit tests with SDK mocking. Provider tests mock the underlying SDK calls. Discord tests use mock Channel/Message objects. Bot tests mock discord.js Client.

### Phase 3: Integration + E2E Framework

**Scope:** End-to-end test framework, integration tests for key pipelines

- Set up separate E2E vitest config (isolated from unit tests)
- Integration tests: message -> provider -> output pipeline (mock Discord + mock Provider)
- CLI command integration tests
- Migrate existing smoke scripts into auto-runnable E2E test cases

**Target:** 5-10 E2E scenarios covering major user journeys

**Testing approach:** Integration tests wire real module interactions with mocked external services (Discord API, AI providers). E2E tests simulate full user flows.

## Coverage Reporting

- Add `pnpm test:coverage` script running `vitest run --coverage`
- Configure coverage thresholds in vitest.config.ts
- Generate HTML + LCOV reports
- Track coverage trends over time (optional: integrate with CI)

## Test Quality Standards

- Follow existing patterns from well-written tests (message-handler.test.ts, session-executor.test.ts)
- Use `vi.mock()` for module mocking consistently
- Each test should have clear arrange-act-assert structure
- Mock external dependencies (Discord, Anthropic SDK, Codex SDK), never call real APIs
- Tests should be deterministic and fast

## Exclusions

- `site/` directory excluded (separate frontend project with its own testing strategy)
- `types.ts` files excluded (type-only files, no runtime behavior)
- `index.ts` barrel files excluded (re-exports only)
- `src/agents.ts` excluded (simple data lookup)
- `src/config.ts` excluded (runtime config singleton, tested indirectly)
- `src/setup.ts` excluded (CLI setup wizard, interactive prompts)
- `src/daemon.ts` excluded (process daemon, tested via integration)
- `src/health-monitor.ts` excluded (operational monitoring, tested via integration)
- `src/service-container.ts` excluded (DI wiring, tested via integration)
- Hook-related files excluded (being migrated/deprecated)
