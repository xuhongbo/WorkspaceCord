# workspacecord 验收清单

## 一、本地基础验收

### 1. 命令与构建

```bash
workspacecord help
pnpm typecheck
pnpm build
pnpm test
```

期望：

- 全部成功
- `workspacecord help` 能看到 `config / project / daemon`

### 2. 全局配置

```bash
workspacecord config list
workspacecord config path
```

期望：

- 能看到 `DISCORD_CLIENT_ID / DISCORD_GUILD_ID / DISCORD_TOKEN / ALLOW_ALL_USERS`
- 配置文件路径可读

### 3. 显式项目挂载

在仓库目录执行：

```bash
workspacecord project info
workspacecord project list
```

期望：

- 当前项目名为 `workspacecord`
- 路径为当前仓库根目录
- Discord 绑定若未执行 `/project setup` 则显示 pending

## 二、Discord 冒烟验收

### 1. 启动机器人

```bash
workspacecord
```

期望：

- 进程启动成功
- Discord 中命令已注册

### 2. 绑定项目

在目标服务器某个 Category 下任意文本频道执行：

```text
/project setup project:workspacecord
```

期望：

- 返回绑定成功
- 自动创建或复用 `#history` forum
- `/project info` 能看到本地路径与 history

### 3. 创建主代理会话

```text
/agent spawn label:smoke-main
```

期望：

- 在当前 Category 下创建新文本频道
- 频道里有欢迎信息和 mode 按钮

### 4. 创建子代理

进入主会话频道后执行：

```text
/subagent run label:smoke-sub
```

期望：

- 在主会话频道下创建 thread
- `/subagent list` 可看到子代理

### 5. Shell 冒烟

在主会话频道执行：

```text
/shell run command:pwd
```

期望：

- 返回当前项目路径

### 6. 归档

在主会话频道执行：

```text
/agent archive
```

期望：

- 主会话被归档
- `#history` forum 出现新帖子

## 三、更深集成测试脚本

### 运行脚本

```bash
pnpm test:integration:smoke
```

脚本会自动：

- 读取全局配置
- 确认已挂载项目
- 登录 Discord
- 创建临时 Category/频道（如无现有绑定）
- 执行 `/project setup` 等价逻辑
- 创建主会话
- 创建子代理
- 执行 shell 冒烟
- 执行归档
- 输出报告到：

```text
artifacts/workspacecord-integration-report.json
```

## 四、若要做真实 Provider 出流测试，还需要你提供

### Claude

需要其一：

- 全局配置中的 `ANTHROPIC_API_KEY`
- 或环境变量 `ANTHROPIC_API_KEY`

可选：

- `ANTHROPIC_BASE_URL`

### Codex

需要其一：

- 全局配置中的 `CODEX_API_KEY`
- 或环境变量 `CODEX_API_KEY`

可选：

- `CODEX_BASE_URL`
- `CODEX_PATH`

## 五、下午验收时我建议你重点看

- 项目挂载是否仍然显式存在
- Discord Category 绑定是否正确
- 主会话/子代理/thread 层级是否符合预期
- `#history` 是否工作
- 命令面是否已经完全 workspacecord 化
