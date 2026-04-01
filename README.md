# workspacecord

[![CI](https://github.com/xuhongbo/WorkspaceCord/actions/workflows/ci.yml/badge.svg)](https://github.com/xuhongbo/WorkspaceCord/actions/workflows/ci.yml)
[![npm version](https://badge.fury.io/js/workspacecord.svg)](https://www.npmjs.com/package/workspacecord)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.6.0-brightgreen)](https://nodejs.org)

> Run and manage multi-agent coding sessions from Discord, backed by local projects on your machine.

[简体中文说明](./README.zh-CN.md)

> Repository name: `workspacecord`  
> CLI/package name: `workspacecord`

## Overview

`workspacecord` maps Discord structures to local development workflows:

```text
Discord Server
└─ Category = Project
   ├─ #history (Forum) = Archived Sessions
   └─ #claude-fix-login = Main Agent Session
      └─ [sub:codex] benchmark = Subagent Thread
```

- A `Category` represents one mounted local project.
- A `TextChannel` represents a main agent session.
- A `Thread` represents a subagent.
- The `#history` forum stores archived sessions.

## Features

- Explicit local project mounting with `workspacecord project init`
- Discord-side project binding with `/project setup`
- Main session channels and subagent threads
- Session archiving into `#history`
- Support for both Claude and Codex providers
- Global config storage without requiring a project-local `.env`
- Optional daemon install and background management

## Requirements

- `Node >= 22.6.0`
- `pnpm`
- A Discord application, bot token, client ID, and guild ID

## File Locations

- **Config**: `~/.config/workspacecord/config.json` - Global configuration
- **Data**: `~/.workspacecord/` - Projects, sessions, and logs

## Installation

```bash
pnpm install
pnpm build
pnpm link --global
```

After linking, you can use either the full command or the short alias:

```bash
workspacecord  # Full command
wsc            # Short alias
```

## Quick Start

### 1. Configure global credentials

```bash
workspacecord config setup
```

Or set values directly:

```bash
workspacecord config set DISCORD_TOKEN <token>
workspacecord config set DISCORD_CLIENT_ID <client-id>
workspacecord config set DISCORD_GUILD_ID <guild-id>
workspacecord config set ALLOW_ALL_USERS true
```

### 2. Mount a local project

Run inside your project directory:

```bash
workspacecord project init --name my-project
```

### 3. Start the bot

```bash
workspacecord
```

### 4. Bind the Discord category to the mounted project

Run this in the text channel you want to use as the dedicated control channel for new sessions:

```text
/project setup project:my-project
```

If successful, `workspacecord` creates or reuses the `#history` forum automatically and records the current channel as the control channel for `/agent spawn`.

## Commands

### Local CLI

**Config Management:**
```bash
workspacecord config setup              # Interactive configuration wizard
workspacecord config get <key>          # Read a configuration value
workspacecord config set <key> <value>  # Write a configuration value
workspacecord config list               # List all configuration values
workspacecord config path               # Show the config file path
```

**Project Management:**
```bash
workspacecord project init [--name <name>]  # Mount current directory as a project
workspacecord project list                  # List all mounted projects
workspacecord project info                  # Show current project info
workspacecord project rename <new-name>     # Rename current project
workspacecord project remove                # Unmount current project
```

**Daemon Management:**
```bash
workspacecord daemon install    # Install as system daemon (auto-start on boot)
workspacecord daemon uninstall  # Uninstall daemon (alias: remove)
workspacecord daemon status     # Check daemon status
```

**Advanced:**
```bash
workspacecord codex [options]   # Launch managed Codex session with remote approval
```

**Note:** All commands support the short alias `wsc`. For example: `wsc config list`

### Discord Slash Commands

- `/project setup` — bind the current category to a mounted project and mark the current channel as the control channel
- `/project info` — inspect project binding details
- `/agent spawn` — create a main agent session channel from the project control channel
- `/agent archive` — archive the current session into `#history`
- `/agent mode` / `/agent goal` / `/agent persona` / `/agent model`
- `/subagent run` — create a subagent thread under the current session
- `/subagent list` — list subagents for the current session
- `/shell run` / `/shell processes` / `/shell kill`

## Development

Run the standard verification flow:

```bash
pnpm typecheck
pnpm build
pnpm test
```

Additional scripts:

```bash
pnpm test:integration:smoke
pnpm test:multi-session:smoke
pnpm test:session-sync:smoke
pnpm test:monitor:e2e
pnpm test:acceptance:local
```

See also: [`docs/ACCEPTANCE.md`](./docs/ACCEPTANCE.md)

## Contributing

We welcome contributions! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

## Acknowledgments

This project was inspired by:
- [agentcord](https://github.com/radu2lupu/agentcord) - Discord integration for AI agents
- [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) - Claude desktop integration
