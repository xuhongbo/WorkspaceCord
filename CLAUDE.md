# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product Vision

workspacecord is a **globally-installed CLI tool** (`npm install -g workspacecord`) that runs as a background daemon, managing AI coding agent sessions (Claude Code, OpenAI Codex) on the local machine through Discord. Each project gets a Discord Category, each session gets a Channel.

**Current state:** Working prototype with .env-based config tied to cwd. Active redesign underway to migrate to global config (Configstore), explicit project mounting (`workspacecord project init`), and automatic sync of local CLI sessions to Discord. See `docs/superpowers/specs/` for design docs and `docs/superpowers/plans/` for implementation plans.

## Commands

```bash
pnpm build          # Build with tsup (ESM, Node 22 target)
pnpm start          # Run bot (requires .env in cwd — being migrated to global config)
pnpm dev            # Build + watch + auto-restart
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run (all tests)
pnpm test -- test/specific.test.ts   # Run single test file
```

## Architecture

### Entry Flow

```
cli.ts → setup | start | daemon | config | project | help
           ↓
         bot.ts → Discord Client → ready → loadProjects + loadSessions
                                         → register slash commands
                                         → listen: messageCreate, interactionCreate, channelDelete
```

### Provider Abstraction

All AI providers implement a unified interface (`src/providers/types.ts`):

```
Provider.sendPrompt(prompt, options) → AsyncGenerator<ProviderEvent>
Provider.continueSession(options)    → AsyncGenerator<ProviderEvent>
```

ProviderEvent is the unified stream protocol: `text_delta`, `tool_start`, `tool_result`, `ask_user`, `task`, `command_execution`, `file_change`, `reasoning`, `todo_list`, `session_init`, `result`, `error`.

- `claude-provider.ts` — Uses `@anthropic-ai/claude-agent-sdk` `query()`. System prompt via SDK's `systemPrompt.append`.
- `codex-provider.ts` — Uses `@openai/codex-sdk` `Codex` class + `Thread.runStreamed()`. System prompt injected via temporary AGENTS.md sentinel blocks.

### Message Flow (Discord → Agent → Discord)

```
messageCreate → message-handler.ts (parse text + images + file attachments)
             → session-executor.ts (orchestrate provider call, handle monitor mode)
             → provider.sendPrompt() → AsyncGenerator<ProviderEvent>
             → output-handler.ts (stream events → Discord messages, embeds, buttons)
```

### Session Modes

- `auto` — Agent decides autonomously
- `plan` — Forces EnterPlanMode before any changes
- `normal` — Asks user before destructive operations
- `monitor` — Worker-monitor dual-agent loop (max 6 iterations) with proof contracts

### Key Modules

- `session-manager.ts` — Session lifecycle (create/end/resume), persistence, abort control
- `project-manager.ts` — Per-project config (personality, skills, MCP servers)
- `persistence.ts` — JSON file store (currently cwd/.discord-friends/, migrating to ~/.workspacecord/)
- `output-handler.ts` — Converts ProviderEvent stream to Discord messages with batched edits
- `button-handler.ts` — Interactive buttons (ask_user questions, mode switching, expandable content)

### Data Storage

Currently: `cwd/.discord-friends/{sessions.json, projects.json}`
Target: `~/.workspacecord/` (global) + Configstore for bot config

## Conventions

- Node.js 22.6+ required (native TypeScript execution via `--experimental-strip-types`)
- ESM only (`"type": "module"` in package.json)
- `@openai/codex-sdk` is an optional dependency — lazy-loaded, may not be installed
- Tests use vitest with `vi.mock()` for module mocking
- All responses in Chinese when interacting with the user (project owner preference)
