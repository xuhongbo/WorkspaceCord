# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

如果你发现了安全漏洞，请**不要**公开创建 issue。

请通过以下方式报告：

1. 发送邮件到项目维护者（请在 GitHub profile 中查找联系方式）
2. 或使用 GitHub Security Advisories 功能

报告应包含：

- 漏洞描述
- 复现步骤
- 潜在影响
- 可能的修复建议（如果有）

我们会在 48 小时内回复，并在修复后公开致谢。

## Security Best Practices

使用 WorkspaceCord 时的安全建议：

- 妥善保管 Discord bot token
- 使用 `ALLOWED_USERS` 限制访问
- 使用 `ALLOWED_PATHS` 限制文件系统访问
- 定期更新依赖
- 在生产环境中启用 Codex sandbox 模式
