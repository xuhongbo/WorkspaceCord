# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product Vision

workspacecord is a **globally-installed CLI tool** (`npm install -g workspacecord`) that runs as a background daemon, managing AI coding agent sessions (Claude Code, OpenAI Codex) on the local machine through Discord. Each project gets a Discord Category, each session gets a Channel.

## Commands

```bash
pnpm build          # Build CLI package with tsup (ESM, Node 22 target)
pnpm start          # Run bot via CLI entry point
pnpm dev            # Build + watch + auto-restart
pnpm typecheck      # tsc -b (project references, all packages)
pnpm test           # vitest run (all packages)
pnpm test -- packages/engine/__tests__/specific.test.ts  # Run single test
pnpm lint           # eslint
```

## Architecture

### Monorepo Structure (pnpm workspace)

```
packages/
├── core/       @workspacecord/core       — types, config, utils, persistence, event-bus, logger
├── providers/  @workspacecord/providers   — AI provider abstraction (Claude, Codex)
├── state/      @workspacecord/state       — state machine, gate management
├── engine/     @workspacecord/engine      — session registry, executor, project registry (no discord.js)
├── bot/        @workspacecord/bot         — Discord integration, panel rendering, output handling
└── cli/        workspacecord (npm pkg)    — CLI entry point, daemon management
```

**Dependency direction (strict, no cycles):**
```
cli → bot → engine → { state, providers } → core
```

### Key Design: OutputPort Abstraction

Engine is decoupled from Discord via `SessionOutputPort` interface:
- `packages/engine/src/output-port.ts` — defines interface + `registerOutputPort()` / `getOutputPort()`
- `packages/bot/src/discord-output-port.ts` — `DiscordOutputPort` implements the interface
- `packages/bot/src/bot-services-orchestrator.ts` — calls `registerOutputPort()` during startup

Engine code calls `getOutputPort().handleResult(...)` etc. instead of importing Discord-specific modules directly.

### Build Strategy

- **Internal packages** don't build — `exports` in package.json point directly to `src/*.ts`
- **Only CLI** uses tsup — produces `dist/cli.js` with shebang for npm publishing
- `tsup.config.ts` uses `noExternal` to bundle all `@workspacecord/*` packages into the CLI dist
- **TypeScript Project References** — `tsc -b` for type checking across packages

### Entry Flow

```
cli.ts → setup | start | daemon | config | project | help
           ↓
         bot.ts → Discord Client → ready → registerOutputPort() → loadProjects + loadSessions
                                         → register slash commands
                                         → listen: messageCreate, interactionCreate, channelDelete
```

### Provider Abstraction

All AI providers implement a unified interface (`packages/providers/src/types.ts`):

```
Provider.sendPrompt(prompt, options) → AsyncGenerator<ProviderEvent>
Provider.continueSession(options)    → AsyncGenerator<ProviderEvent>
```

ProviderEvent is the unified stream protocol: `text_delta`, `tool_start`, `tool_result`, `ask_user`, `task`, `command_execution`, `file_change`, `reasoning`, `todo_list`, `session_init`, `result`, `error`.

- `claude-provider.ts` — Uses `@anthropic-ai/claude-agent-sdk` `query()`.
- `codex-provider.ts` — Uses `@openai/codex-sdk` `Codex` class + `Thread.runStreamed()`.

### Session Modes

- `auto` — Agent decides autonomously
- `plan` — Forces EnterPlanMode before any changes
- `normal` — Asks user before destructive operations
- `monitor` — Worker-monitor dual-agent loop (max 6 iterations) with proof contracts

### Key Modules

- `packages/engine/src/session-registry.ts` — Session lifecycle (create/end/resume), persistence, abort control
- `packages/engine/src/project-registry.ts` — Project registration and lookup
- `packages/engine/src/session-executor.ts` — Orchestrates provider calls, monitor mode
- `packages/bot/src/panel-adapter.ts` — Discord status card rendering and state projection
- `packages/bot/src/output-handler.ts` — Converts ProviderEvent stream to Discord messages
- `packages/bot/src/button-handler.ts` — Interactive buttons (ask_user questions, mode switching)
- `packages/core/src/persistence.ts` — JSON file store (`~/.workspacecord/`)

### Data Storage

`~/.workspacecord/` (global) — sessions.json, projects.json, config via Configstore

## Conventions

- Node.js 22.6+ required (native TypeScript execution via `--experimental-strip-types`)
- ESM only (`"type": "module"` in all package.json)
- `@openai/codex-sdk` is an optional dependency — lazy-loaded, may not be installed
- Tests use vitest with `vi.mock()` for module mocking
- All responses in Chinese when interacting with the user (project owner preference)
- When mocking cross-package imports in tests, use the `@workspacecord/*` package path (not relative paths to other packages)
