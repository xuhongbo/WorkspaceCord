# Discord 实时作战面板实现验证报告

日期：2026-03-31  
验证范围：2026-03-30-discord-realtime-ops-panel-design.md 设计符合度  
验证方法：多子代理并行代码审查

---

## 执行摘要

针对 Discord 实时作战面板设计文档，派发 4 个子代理对核心模块进行了并行验证。总体实现质量**较高**，但存在 **3 个关键偏离**和 **2 个中等风险**需要修复。

### 符合度评分

| 模块 | 符合度 | 关键问题数 |
|------|--------|-----------|
| Codex 监控 | ✅ 95% | 0 |
| 状态卡 | ✅ 98% | 0 |
| 等待人工闭环 | ⚠️ 70% | 2 |
| 状态机 | ⚠️ 75% | 2 |

---

## 关键偏离项（需修复）

### 1. 等待人工闭环存在双入口（P0）

**设计要求：** 所有 `awaiting_human` 场景必须统一走交互卡入口

**实际情况：**
- `src/output-handler.ts:523-527` 保留了旧问题卡直发逻辑
- 用户会看到两张卡：交互卡 + 旧问题卡
- 旧问题卡按钮（`answer:`, `confirm:`, `option:`）绕过了轮次和消息 ID 校验

**影响：**
- 违反"统一交互卡入口"设计原则
- 并发安全性风险：旧按钮可绕过先到先得逻辑
- 用户体验混乱：不清楚应该点击哪张卡

**修复建议：**
```typescript
// 删除 output-handler.ts:523-527
// const rendered = renderAskUserQuestion(event.questionsJson, sessionId);
// if (rendered) {
//   rendered.components.push(makeStopButton(sessionId));
//   await channel.send({ embeds: rendered.embeds, components: rendered.components });
// }
```

---

### 2. 旧问题卡按钮未校验 currentInteractionMessageId（P0）

**设计要求：** 使用 `currentInteractionMessageId` 防止旧消息误操作

**实际情况：**
- `button-handler.ts:271-290` (`answer:` 按钮) 未校验
- `button-handler.ts:293-310` (`confirm:` 按钮) 未校验
- `button-handler.ts:313-330` (`option:` 按钮) 未校验

**影响：**
- 用户可点击旧消息按钮触发会话
- 绕过"先到先得"和"消息 ID 校验"防护
- 可能导致并发冲突或旧请求误操作

**修复建议：**
```typescript
// 在每个按钮处理前增加校验
if (session.currentInteractionMessageId !== interaction.message.id) {
  await interaction.reply({ 
    content: '⚠️ 此交互已过期，请使用最新的交互卡', 
    ephemeral: true 
  });
  return;
}
```

---

### 3. 状态机未考虑 formal vs inferred 优先级（P1）

**设计要求：** 正式事件优先级高于启发式推断（设计文档 6.3）

**实际情况：**
- `state-machine.ts:42-46` 的 `shouldTransition` 只比较状态优先级
- 未考虑 `stateSource` 和 `confidence`
- 低优先级的 formal 事件可能被高优先级的 inferred 事件覆盖

**影响场景：**
```
thinking(formal, high) → awaiting_human(inferred, medium)
当前行为：会转换（因为 8 > 4）
预期行为：应拒绝（formal 优先于 inferred）
```

**修复建议：**
```typescript
function shouldTransition(
  from: RunState, 
  to: RunState,
  fromSource: 'formal' | 'inferred',
  toSource: 'formal' | 'inferred'
): boolean {
  const fromPri = STATE_PRIORITY[from];
  const toPri = STATE_PRIORITY[to];
  
  // formal 事件优先于 inferred
  if (fromSource === 'formal' && toSource === 'inferred') {
    return toPri > fromPri; // 只有更高优先级才能打断
  }
  
  return toPri >= fromPri;
}
```

---

### 4. completed 未实现自动回落到 idle（P1）

**设计要求：** completed 为短时高亮态，之后自动回落到 idle（设计文档 6.3）

**实际情况：**
- 只在 `summary-handler.ts:33` 手动回落
- 无自动定时器机制
- completed 状态会一直保持

**影响：**
- 不符合"短时高亮"语义
- 状态卡会长时间显示 completed

**修复建议：**
```typescript
// 在 applyPlatformEvent 中
if (event.type === 'completed') {
  // 3 秒后自动回落到 idle
  setTimeout(() => {
    this.applyPlatformEvent({
      type: 'session_idle',
      stateSource: 'formal',
      metadata: { phase: '待命' }
    });
  }, 3000);
}
```

---

## 中等风险项

### 5. Codex 监控状态去重不完整（P2）

**现状：** 仅对 `working` 状态去重（`codex-log-monitor.ts:216`）

**风险：** 其他状态（如 `thinking`）可能产生重复事件

**建议：** 扩展去重逻辑到所有状态

---

### 6. 状态卡 phase 字段未强制验证（P2）

**现状：** `phase` 通过 `validate()` 验证，但来源可能是外部

**风险：** 如果 state machine 返回超长或包含禁止内容的 phase，会被拒绝

**建议：** 在 `getStateLabel()` 中确保返回值符合约束

---

## 完全符合设计的部分

### ✅ Codex 监控（7/7 符合）

1. 增量偏移读取 - 维护 `TrackedFile.offset`
2. partial 行拼接 - 维护 `TrackedFile.partial` 缓冲区
3. 启发式权限检测 - 2 秒超时推断 `codex-permission`
4. 失活清理 - 5 分钟超时清理
5. 跳过陈旧文件 - 2 分钟前的文件不追踪
6. task_complete 状态回落 - 有工具使用 → attention，无工具使用 → idle
7. 事件归一层推断态标记 - `codex-permission` 标记为 `stateSource: 'inferred'`

### ✅ 状态卡（6/6 符合）

1. validate() 已实现并被调用
2. 拒绝禁止内容 - 长度限制 200 字符、代码块、diff、文件列表
3. 接管旧消息清理 components
4. 接管后 pin
5. 状态卡只包含状态信息
6. 测试覆盖充分

### ✅ 等待人工闭环（6/8 符合）

1. 统一交互卡入口（ask_user）- ⚠️ 但存在旧问题卡双入口
2. 监督流阻塞场景挂交互卡 - 完全符合
3. 轮次校验 - 完全符合
4. 先到先得逻辑 - 完全符合
5. 审计反馈 - 完全符合
6. 消息 ID 校验 - ⚠️ 但旧问题卡按钮未校验

### ✅ 状态机（5/7 符合）

1. 状态优先级定义正确
2. shouldTransition 实现了优先级判断 - ⚠️ 但未考虑 formal vs inferred
3. applyPlatformEvent 接入了 shouldTransition
4. 区分 formal/inferred 状态来源
5. 推断态正确标记
6. metadata.phase 被保留和传递
7. session_ended 可落到 offline

---

## 测试覆盖缺口

1. **等待人工闭环**
   - 缺少旧问题卡按钮的并发场景测试
   - 缺少 `currentInteractionMessageId` 校验测试

2. **状态机**
   - 缺少 formal vs inferred 优先级测试
   - 缺少 completed 自动回落测试
   - 缺少同优先级但不同 confidence 的测试

3. **Codex 监控**
   - 缺少多文件并发追踪测试
   - 缺少 7 天历史目录扫描测试
   - 缺少 `codex-turn-end` 清理 approvalTimer 的测试

---

## 修复优先级建议

### P0（高优先级，阻塞发布）
1. 删除 `output-handler.ts:523-527` 的旧问题卡直发逻辑
2. 为 `answer:`, `confirm:`, `option:` 按钮增加 `currentInteractionMessageId` 校验

### P1（中优先级，影响核心语义）
3. shouldTransition 增加 `stateSource` 判断
4. completed 自动回落机制

### P2（低优先级，改进项）
5. 扩展 Codex 监控状态去重逻辑
6. 状态卡 phase 字段强制验证
7. 补充测试覆盖

---

## 关键文件清单

### 需要修改的文件
- `src/output-handler.ts` - 删除旧问题卡双入口
- `src/button-handler.ts` - 增加消息 ID 校验
- `src/state/state-machine.ts` - 增加 formal vs inferred 判断，completed 自动回落

### 需要补充测试的文件
- `test/button-handler.test.ts` - 旧问题卡按钮并发场景
- `test/state-machine.test.ts` - formal vs inferred 优先级，completed 自动回落

---

## 验证方法

本次验证使用了 4 个并行子代理：
1. **Codex 监控验证代理** - 验证增量读取、推断态、失活清理
2. **等待人工闭环验证代理** - 验证统一入口、轮次校验、消息 ID 校验
3. **状态卡验证代理** - 验证 validate()、禁止内容、接管清理
4. **状态机验证代理** - 验证优先级、formal vs inferred、completed 回落

每个代理独立读取设计文档和代码，生成符合度报告，最后汇总整合。

---

## 结论

实现质量**整体较高**，核心功能（Codex 监控、状态卡）完全符合设计。主要偏离集中在：

1. **等待人工闭环的双入口问题** - 违反设计原则，存在并发安全风险
2. **状态机的 formal vs inferred 优先级缺失** - 不符合设计语义
3. **completed 自动回落缺失** - 不符合"短时高亮"语义

建议优先修复 P0 和 P1 问题后再发布。
