# Clawd 实时感知机制深度分析

## 核心原理

Clawd 通过 **Claude Code Hooks 系统** 实现实时感知，而不是轮询。

### 1. Hook 注册机制

Clawd 在启动时自动向 `~/.claude/settings.json` 注册 hooks：

```javascript
// hooks/install.js
const hookScript = path.resolve(__dirname, "clawd-hook.js");
const hookCommand = `node ${hookScript} ${event}`;

settings.hooks[event] = [
  { command: hookCommand }
];
```

注册的事件包括：
- SessionStart
- UserPromptSubmit
- PreToolUse
- PostToolUse
- Stop
- SubagentStart
- 等等...

### 2. 实时触发流程

```
Claude Code 执行 → 触发事件 → 调用 hook 脚本 → HTTP POST → Clawd 更新状态
```

**关键点**：
- Claude Code **主动调用** hook 脚本（不是轮询）
- Hook 脚本通过 HTTP POST 发送状态到 `localhost:23333/state`
- Clawd 的 HTTP 服务器立即接收并更新 UI

### 3. Hook 脚本执行

```javascript
// hooks/clawd-hook.js
const event = process.argv[2]; // Claude Code 传入事件名
const state = EVENT_TO_STATE[event]; // 映射到状态

// 读取 stdin 获取 session_id
process.stdin.on('end', () => {
  const payload = JSON.parse(Buffer.concat(chunks));
  const sessionId = payload.session_id;

  // 立即 HTTP POST 到 Clawd
  postStateToRunningServer({
    state,
    session_id: sessionId,
    event
  });
});
```

**超快响应**：
- Hook 脚本零依赖，启动极快（<50ms）
- 100ms 超时，不阻塞 Claude Code
- 异步 HTTP POST，不等待响应

### 4. HTTP 服务器接收

```javascript
// src/server.js
httpServer = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/state") {
    const data = JSON.parse(body);
    const { state, session_id, event } = data;

    // 立即更新状态
    ctx.updateSession(session_id, state, event);
    res.writeHead(200);
    res.end("ok");
  }
});
```

**关键优势**：
- 事件驱动，零延迟
- 不需要轮询文件系统
- 支持多会话并发

## 对 workspacecord 的启示

### 当前问题
workspacecord 是 **Discord → 本地** 的单向流：
- Discord 发消息 → 本地 Claude/Codex 执行
- 但本地会话状态无法实时同步回 Discord

### 解决方案：反向 Hook

使用 Claude Code Hooks 将本地会话实时同步到 Discord：

```
本地 Claude Code → Hook 触发 → HTTP POST → workspacecord bot → Discord 更新
```

### 实现方案

#### 1. 创建 workspacecord hook 脚本

```javascript
// hooks/workspacecord-hook.js
const http = require('http');

const event = process.argv[2];
const chunks = [];

process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const payload = JSON.parse(Buffer.concat(chunks));

  const data = JSON.stringify({
    event,
    sessionId: payload.session_id,
    cwd: payload.cwd,
    timestamp: Date.now()
  });

  const req = http.request({
    hostname: 'localhost',
    port: 3000, // workspacecord bot 端口
    path: '/hook/claude',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, () => process.exit(0));

  req.write(data);
  req.end();
});

setTimeout(() => process.exit(0), 100);
```

#### 2. 在 bot.ts 添加 HTTP 端点

```typescript
// bot.ts
import express from 'express';

const app = express();
app.use(express.json());

app.post('/hook/claude', async (req, res) => {
  const { event, sessionId, cwd } = req.body;

  // 查找对应的 Discord 会话
  const session = sessions.getSession(sessionId);
  if (!session) {
    res.status(404).send('Session not found');
    return;
  }

  // 更新状态卡
  await updateSessionState(sessionId, event);

  res.send('ok');
});

app.listen(3000);
```

#### 3. 注册 hooks 到 Claude Code

```typescript
// setup-hooks.ts
import { writeFileSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const settingsPath = join(homedir(), '.claude', 'settings.json');
const hookScript = join(__dirname, 'hooks', 'workspacecord-hook.js');

const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
if (!settings.hooks) settings.hooks = {};

const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

for (const event of events) {
  settings.hooks[event] = [{ command: `node ${hookScript} ${event}` }];
}

writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
```

### 核心优势

1. **零延迟感知**
   - 事件驱动，不是轮询
   - Claude Code 执行动作 → 立即触发 hook → 立即更新 Discord

2. **双向同步**
   - Discord → 本地：现有流程
   - 本地 → Discord：通过 hooks 实现

3. **多会话支持**
   - 每个本地会话都会触发 hook
   - sessionId 自动关联到 Discord 频道

4. **低开销**
   - Hook 脚本零依赖，启动快
   - HTTP POST 异步，不阻塞

### 应用场景

1. **本地 CLI 会话同步**
   - 用户在终端运行 `claude chat`
   - workspacecord 自动在 Discord 创建频道
   - 实时同步状态和输出

2. **多设备协作**
   - 开发者在本地 IDE 使用 Claude
   - 团队成员在 Discord 实时观察进度

3. **远程监控**
   - 服务器上的 Claude 会话
   - 通过 Discord 远程监控状态

## 总结

Clawd 的实时感知机制核心是 **Claude Code Hooks 系统**：

1. **注册 hooks** 到 `~/.claude/settings.json`
2. **Claude Code 主动调用** hook 脚本（事件驱动）
3. **Hook 脚本 HTTP POST** 到本地服务器
4. **立即更新 UI**，零延迟

这个机制完美适用于 workspacecord 的本地会话同步需求，可以实现：
- 本地 CLI 会话自动同步到 Discord
- 实时状态更新
- 多会话并发支持

**下一步**：实现 workspacecord 的 hook 系统，实现双向同步。
