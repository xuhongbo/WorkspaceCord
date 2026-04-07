# 统一状态机

实现设计文档第 5.4 节的三层状态模型。

## 架构

状态机采用分层设计，避免状态爆炸：

### 第一层：会话生命周期状态

```
initializing → active → waiting_human → paused → completed → error
```

- `initializing`: 会话初始化中
- `active`: 会话活跃
- `waiting_human`: 等待人工介入
- `paused`: 会话暂停
- `completed`: 会话完成
- `error`: 会话错误

### 第二层：执行状态（仅 active 时有效）

```
idle → thinking → tool_executing → streaming_output
```

- `idle`: 空闲
- `thinking`: 思考中
- `tool_executing`: 工具执行中
- `streaming_output`: 流式输出中

### 第三层：门控状态（独立管理）

```
pending → approved | rejected | expired | invalidated
```

- `pending`: 待处理
- `approved`: 已批准
- `rejected`: 已拒绝
- `expired`: 已过期
- `invalidated`: 已失效

## 使用示例

```typescript
import { stateMachine } from './state-machine.ts';

// 1. 会话初始化
const result1 = stateMachine.transition('session-1', 'session_start', {
  lifecycle: 'active',
  execution: 'idle',
});

// 2. 开始思考
const result2 = stateMachine.transition('session-1', 'thinking_start', {
  execution: 'thinking',
});

// 3. 执行工具
const result3 = stateMachine.transition('session-1', 'tool_start', {
  execution: 'tool_executing',
});

// 4. 等待人工介入
const result4 = stateMachine.transition('session-1', 'ask_user', {
  lifecycle: 'waiting_human',
  gate: 'pending',
});

// 5. 人工批准
const result5 = stateMachine.transition('session-1', 'user_approved', {
  lifecycle: 'active',
  gate: 'approved',
});

// 6. 完成会话
const result6 = stateMachine.transition('session-1', 'session_complete', {
  lifecycle: 'completed',
});

// 查询当前状态
const state = stateMachine.getState('session-1');
console.log(state);
// { lifecycle: 'completed', execution: null, gate: 'approved', ... }

const projection = stateMachine.getSnapshot('session-1');
console.log(projection);
// { state: 'completed', turn: 1, humanResolved: false, ... } // 通用投影

const panelProjection = stateMachine.getPanelProjection('session-1');
console.log(panelProjection);
// { state: 'completed', isCompleted: true, isWaitingHuman: false, ... } // 面板展示投影

// 查询转换历史
const history = stateMachine.getTransitionHistory('session-1');
console.log(history);
```

## 设计约束

### 单一入口

所有状态变更必须通过 `StateMachine.transition()` 方法。

### 幂等性

相同事件重复触发不改变最终状态：

```typescript
stateMachine.transition('session-1', 'noop', { lifecycle: 'active' });
stateMachine.transition('session-1', 'noop', { lifecycle: 'active' });
// 第二次调用直接返回成功，不记录转换历史
```

### 可观测

每次状态转换记录日志，包含 `from`、`to`、`event`、`timestamp`：

```
[state-machine] session-1 | session_start | lifecycle: initializing -> active | execution: null -> idle | gate: null -> null
```

### 可测试

状态机逻辑与 Discord API 解耦，便于单元测试。

## 状态转换规则

### 生命周期转换规则

- `initializing` → `active`, `error`
- `active` → `waiting_human`, `paused`, `completed`, `error`
- `waiting_human` → `active`, `paused`, `error`
- `paused` → `active`, `completed`, `error`
- `completed` → `active` (允许重新激活)
- `error` → `active`, `completed` (允许恢复或标记完成)

### 执行状态转换规则

- `idle` → `thinking`, `tool_executing`
- `thinking` → `tool_executing`, `streaming_output`, `idle`
- `tool_executing` → `thinking`, `streaming_output`, `idle`
- `streaming_output` → `idle`, `thinking`

### 约束

- 执行状态仅在 `lifecycle=active` 时有效
- 当 `lifecycle` 离开 `active` 时，执行状态自动清理为 `null`
- 门控状态独立管理，不影响生命周期和执行状态

## 错误处理

非法转换会被拒绝并返回错误信息：

```typescript
const result = stateMachine.transition('session-1', 'invalid', {
  lifecycle: 'waiting_human', // initializing 不能直接转到 waiting_human
});

console.log(result);
// {
//   success: false,
//   state: { lifecycle: 'initializing', execution: null, gate: null },
//   error: '非法生命周期转换: initializing -> waiting_human'
// }
```

## 测试

运行单元测试：

```bash
pnpm test -- test/state-machine.test.ts
```

测试覆盖：

- 合法转换
- 非法转换被拒绝
- 幂等性
- 执行状态约束
- 门控状态独立性
- 转换历史记录
- 会话清理
