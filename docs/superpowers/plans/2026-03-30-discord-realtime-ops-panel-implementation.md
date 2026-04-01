# Discord 实时作战面板实现计划

日期：2026-03-30
状态：待审批
关联设计：2026-03-30-discord-realtime-ops-panel-design.md

## 实现范围

第一阶段实现核心功能：
1. 统一状态机与事件归一层
2. 常驻状态卡（pinned Embed）
3. 本轮/结束总结分离
4. 等待人工闭环（轮次化）
5. Codex 增量日志监控

## 阶段划分

### Phase 1: 状态机基础设施（核心）
- 创建统一状态机
- 实现状态优先级裁决
- 实现事件归一层
- 扩展 ProviderEvent 类型

### Phase 2: Discord 面板组件
- 实现常驻状态卡
- 实现本轮/结束总结分离
- 实现长内容自动拆分

### Phase 3: 等待人工闭环
- 实现轮次化按钮
- 实现先到先得逻辑
- 实现审计反馈

### Phase 4: Codex 增量监控
- 移植 clawd 的增量读取逻辑
- 实现启发式权限检测
- 实现失活清理

## 文件结构

```
src/
├── state/
│   ├── state-machine.ts          # 状态机核心
│   ├── event-normalizer.ts       # 事件归一层
│   └── types.ts                   # 状态相关类型
├── discord/
│   ├── status-card.ts             # 常驻状态卡
│   ├── summary-handler.ts         # 总结处理器
│   └── interaction-card.ts        # 交互卡（等待人工）
├── monitors/
│   └── codex-log-monitor.ts       # Codex 日志监控
└── providers/
    └── types.ts                   # 扩展 ProviderEvent
```

## 详细任务

### Phase 1: 状态机基础设施

#### 任务 1.1: 创建状态类型定义
**文件**: `src/state/types.ts`
**内容**:
- 定义统一运行状态枚举
- 定义状态优先级常量
- 定义会话状态快照接口
- 定义平台事件类型

**参考**: clawd-on-desk/src/state.js (STATE_PRIORITY, STATE_SVGS)

#### 任务 1.2: 实现状态机核心
**文件**: `src/state/state-machine.ts`
**功能**:
- `resolveDisplayState()`: 多会话状态裁决
- `shouldTransition()`: 状态转换判定
- `getStateLabel()`: 状态到展示文案映射
- `getStateColor()`: 状态到 Discord 颜色映射

**参考**: clawd-on-desk/src/state.js (resolveDisplayState, STATE_PRIORITY)

#### 任务 1.3: 实现事件归一层
**文件**: `src/state/event-normalizer.ts`
**功能**:
- `normalizeClaudeEvent()`: Claude ProviderEvent → 平台事件
- `normalizeCodexEvent()`: Codex 日志事件 → 平台事件
- 标注来源、置信度、是否推断

**参考**: clawd-on-desk/agents/registry.js (eventMap)

#### 任务 1.4: 扩展 ProviderEvent
**文件**: `src/providers/types.ts`
**修改**:
- 添加 `session_started` 事件
- 添加 `session_ended` 事件
- 添加 `awaiting_human` 事件
- 为 `result` 事件添加 `sessionEnd` 元数据

---

### Phase 2: Discord 面板组件

#### 任务 2.1: 实现常驻状态卡
**文件**: `src/discord/status-card.ts`
**功能**:
- `initialize()`: 创建并 pin 状态卡
- `update()`: 编辑状态卡（不发新消息）
- `validate()`: 验证内容不包含禁止项
- 字段：状态、轮次、更新时间、阶段

**约束**:
- 禁止长内容（description < 200 字符）
- 禁止代码块、文件列表、diff

#### 任务 2.2: 实现总结处理器
**文件**: `src/discord/summary-handler.ts`
**功能**:
- `sendTurnSummary()`: 发送本轮总结，状态回落 idle
- `sendEndingSummary()`: 发送结束总结，状态进入 offline
- `splitIfNeeded()`: 自动拆分超长内容

**参考**: 设计文档 5.5 本轮总结与结束总结

#### 任务 2.3: 修改 output-handler.ts
**修改**:
- 集成 StatusCard
- 集成 SummaryHandler
- 区分 `result` 事件的 sessionEnd 标志
- 移除冗余的状态更新消息

---

### Phase 3: 等待人工闭环

#### 任务 3.1: 实现交互卡
**文件**: `src/discord/interaction-card.ts`
**功能**:
- `show()`: 显示等待人工按钮（绑定轮次）
- `hide()`: 隐藏按钮
- customId 格式: `awaiting_human:{sessionId}:{turn}:{action}`

#### 任务 3.2: 扩展 button-handler.ts
**修改**:
- 添加 `awaiting_human` 按钮处理
- 实现轮次校验
- 实现先到先得逻辑
- 生成审计反馈

#### 任务 3.3: 扩展 thread-manager.ts
**修改**:
- 在 ThreadSession 添加 `currentTurn` 字段
- 在 ThreadSession 添加 `humanResolved` 字段
- 在 ThreadSession 添加 `currentInteractionMessageId` 字段

---

### Phase 4: Codex 增量监控

#### 任务 4.1: 创建 Codex 日志监控器
**文件**: `src/monitors/codex-log-monitor.ts`
**功能**:
- 增量读取 JSONL（维护 offset）
- 处理不完整行（partial buffer）
- 启发式权限检测（2 秒超时）
- 自动清理失活会话（5 分钟）

**直接移植**: clawd-on-desk/agents/codex-log-monitor.js

#### 任务 4.2: 集成到 bot.ts
**修改**:
- 在 bot ready 事件启动 CodexLogMonitor
- 将监控事件传递给事件归一层
- 更新会话状态

---

## 实现顺序

建议按以下顺序实施，每个阶段独立可测：

1. **Phase 1** (状态机基础) - 2-3 天
   - 先实现类型定义和状态机核心
   - 再实现事件归一层
   - 最后扩展 ProviderEvent

2. **Phase 2** (Discord 面板) - 2-3 天
   - 先实现常驻状态卡
   - 再实现总结处理器
   - 最后集成到 output-handler

3. **Phase 3** (等待人工) - 1-2 天
   - 先扩展数据结构
   - 再实现交互卡
   - 最后集成到 button-handler

4. **Phase 4** (Codex 监控) - 1-2 天
   - 直接移植 clawd 代码
   - 集成到 bot

总计：6-10 天

---

## 关键设计决策

### 1. 状态优先级
直接复用 clawd 的优先级系统：
```typescript
const STATE_PRIORITY = {
  error: 9,
  awaiting_human: 8,
  stalled: 7,
  summarizing: 6,
  working: 5,
  thinking: 4,
  completed: 3,
  idle: 2,
  offline: 1
};
```

### 2. 常驻状态卡 vs 消息流
- 状态卡：固定消息 ID，只编辑不发新消息
- 摘要/结果：发送新消息
- 原则：状态更新编辑，内容产出发送

### 3. 本轮 vs 结束总结
判断依据：`result` 事件的 `metadata.sessionEnd` 标志
- `sessionEnd: false` → 本轮总结 + 状态回落 idle
- `sessionEnd: true` → 结束总结 + 状态进入 offline

### 4. 轮次化防重
customId 格式：`awaiting_human:{sessionId}:{turn}:{action}`
- 每次新请求 turn++
- 按钮点击时校验 turn 是否匹配
- 先到先得：检查 `session.humanResolved`

---

## 测试策略

### 单元测试
- `state-machine.ts`: 状态优先级裁决
- `event-normalizer.ts`: 事件映射正确性
- `summary-handler.ts`: 长内容拆分逻辑

### 集成测试
- Claude 会话状态流
- Codex 日志监控
- 等待人工闭环

### 手动验证
- 状态卡 pin 到频道顶部
- 本轮总结后状态回落 idle
- 结束总结后状态进入 offline
- 并发点击按钮先到先得

---

## 风险与缓解

### 风险 1: 状态卡频繁更新导致 API 限流
**缓解**:
- 实现防抖机制（500ms 内合并更新）
- 只在状态真正变化时更新

### 风险 2: Codex 日志文件过大
**缓解**:
- 增量读取（维护 offset）
- 跳过 2 分钟前的陈旧文件

### 风险 3: 长内容拆分后可读性下降
**缓解**:
- 在 footer 显示 "第 X/Y 部分"
- 保持段落完整性（按句子拆分）

---

## 成功标准

Phase 1 完成标准：
- [ ] 状态机可以裁决多会话状态
- [ ] 事件归一层可以统一 Claude/Codex 事件

Phase 2 完成标准：
- [ ] 状态卡固定在频道顶部
- [ ] 本轮总结后状态回落 idle
- [ ] 结束总结后状态进入 offline
- [ ] 超长内容自动拆分

Phase 3 完成标准：
- [ ] 等待人工按钮绑定轮次
- [ ] 并发点击先到先得
- [ ] 生成审计反馈

Phase 4 完成标准：
- [ ] Codex 日志增量读取
- [ ] 启发式权限检测
- [ ] 失活会话自动清理

