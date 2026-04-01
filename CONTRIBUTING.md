# Contributing to workspacecord

感谢你对 workspacecord 的关注！我们欢迎各种形式的贡献。

## 如何贡献

### 报告 Bug

如果你发现了 bug，请创建一个 issue 并包含：

- 清晰的标题和描述
- 复现步骤
- 预期行为和实际行为
- 环境信息（Node 版本、操作系统等）
- 相关日志或截图

### 提交功能建议

我们欢迎新功能建议！请先创建 issue 讨论：

- 描述功能的使用场景
- 说明为什么这个功能有价值
- 如果可能，提供实现思路

### 提交代码

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 开发流程

### 环境要求

- Node.js >= 22.6.0
- pnpm

### 设置开发环境

```bash
git clone https://github.com/xuhongbo/WorkspaceCord.git
cd WorkspaceCord
pnpm install
pnpm build
```

### 运行测试

```bash
pnpm typecheck
pnpm test
pnpm lint
```

### 代码规范

- 使用 ESLint 和 Prettier
- 提交前运行 `pnpm lint:fix` 和 `pnpm format`
- 遵循现有代码风格

### Commit 规范

使用语义化提交信息：

- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `style:` 代码格式调整
- `refactor:` 重构
- `test:` 测试相关
- `chore:` 构建或辅助工具变动

## Pull Request 指南

- 确保所有测试通过
- 更新相关文档
- 保持 PR 专注于单一功能或修复
- 清晰描述改动内容和原因
- 关联相关 issue

## 行为准则

请阅读并遵守我们的 [行为准则](CODE_OF_CONDUCT.md)。

## 许可证

提交代码即表示你同意将代码以 MIT 许可证授权。
