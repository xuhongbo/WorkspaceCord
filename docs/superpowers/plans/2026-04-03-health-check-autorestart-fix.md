# Health Check Autorestart Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复健康检查与自动恢复链路中的旧命令名、旧仓库路径与错误打包文件匹配，让重启后服务能够被正确重装与拉起。

**Architecture:** 保留现有壳脚本入口，但把路径与命令选择改成从脚本位置和当前环境动态推导。先用集成测试驱动脚本行为，再更新本机 LaunchAgent 并做端到端验证。

**Tech Stack:** Bash、launchd、Vitest、Node.js

---

## Chunk 1: 测试覆盖脚本行为

### Task 1: 为健康检查安装脚本补测试

**Files:**
- Create: `test/health-check-scripts.test.ts`
- Test: `scripts/setup-health-check-cron.sh`

- [ ] **Step 1: 写失败测试**
- [ ] **Step 2: 运行单测，确认因旧硬编码路径失败**
- [ ] **Step 3: 记录期望：plist 指向当前仓库下的脚本路径**

### Task 2: 为健康检查主脚本补测试

**Files:**
- Create: `test/health-check-scripts.test.ts`
- Test: `scripts/health-check.sh`

- [ ] **Step 1: 写失败测试**
- [ ] **Step 2: 运行单测，确认因旧命令名/旧项目路径/旧 tgz 匹配失败**
- [ ] **Step 3: 记录期望：兼容当前命令名并能完成全量重装流程**

## Chunk 2: 修实现

### Task 3: 修复健康检查安装脚本

**Files:**
- Modify: `scripts/setup-health-check-cron.sh`
- Test: `test/health-check-scripts.test.ts`

- [ ] **Step 1: 改为通过脚本自身位置推导 `SCRIPT_PATH`**
- [ ] **Step 2: 补充稳定 PATH 环境**
- [ ] **Step 3: 运行相关单测确认通过**

### Task 4: 修复健康检查主脚本

**Files:**
- Modify: `scripts/health-check.sh`
- Test: `test/health-check-scripts.test.ts`

- [ ] **Step 1: 动态解析仓库根目录**
- [ ] **Step 2: 自动选择可用 CLI 命令**
- [ ] **Step 3: 修复打包文件匹配逻辑，兼容当前包名**
- [ ] **Step 4: 运行相关单测确认通过**

## Chunk 3: 本机修复与验证

### Task 5: 重建本机健康检查任务并验证

**Files:**
- Modify: `~/Library/LaunchAgents/*.plist`（运行时变更）

- [ ] **Step 1: 卸载旧健康检查任务（含旧 label）**
- [ ] **Step 2: 安装新的健康检查任务**
- [ ] **Step 3: 手动执行健康检查脚本验证可运行**
- [ ] **Step 4: 检查 `launchctl` 状态与日志**
