I'm using the writing-plans skill to create the implementation plan.

# Discord Delivery Reply Handling Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让统一投递层在引用失败时自动退化为普通消息，并让 `replyToMode='all'` 在发送端真正串联每块旧消息的引用逻辑。

**Architecture:** delivery-policy 依据 `docs/superpowers/specs/2026-04-02-discord-official-interaction-alignment-design.md` 里对 `replyToMode` 的定义生成包含当前引用策略的计划；delivery 负责按 plan 逐块发送消息、处理引用失败的降级，同时根据 plan.replyToMode 决定哪些 chunk 要带 reply（`first` 只在首块，`all` 串联所有块，`off` 不引用）。

**Tech Stack:** Node 22+ (ESM)、TypeScript、discord.js、vitest

---

### Task 1: 让 delivery-policy 产出 `replyToMode`

**Files:**
- Modify: /Users/ld/Documents/github/agentcord/src/discord/delivery-policy.ts
- Modify: /Users/ld/Documents/github/agentcord/test/delivery-policy.test.ts

- [ ] **Step 1: 写一个失败的测试，验证 `buildDeliveryPlan` 会把 policy.replyToMode 反映到返回值，默认在 `user_reply` 中仍然可以引用用户消息**

```ts
it('在普通投递场景中保留 replyToMode', () => {
  const plan = buildDeliveryPlan({
    sessionId: 's1',
    chatId: 'c1',
    text: 'text',
    files: [],
    mode: 'user_reply',
    replyToMessageId: 'user-msg',
    policy: {
      textChunkLimit: 2000,
      chunkMode: 'length',
      replyToMode: 'first',
      ackReaction: '👀',
    },
  });

  expect(plan.replyToMode).toBe('first');
  expect(plan.replyToMessageId).toBe('user-msg');
});
```

- [ ] **Step 2: 运行 `pnpm vitest test/delivery-policy.test.ts -t 'replyToMode'` 确认新增断言失败，等待实现**
- [ ] **Step 3: 在 delivery-policy.ts 里把 policy.replyToMode 带进返回的 plan（并在必要时用默认值），保持原有 `replyToMessageId` 规则**

```ts
const replyToMode = input.policy.replyToMode ?? 'first';
const replyToMessageId = /* 保持原逻辑 */;
return {
  ...,
  replyToMessageId,
  replyToMode,
};
```

- [ ] **Step 4: 再次运行 `pnpm vitest test/delivery-policy.test.ts -t 'replyToMode'` 期望通过**
- [ ] **Step 5: 提交以上更改（`git add src/discord/delivery-policy.ts test/delivery-policy.test.ts` + `git commit -m "fix: capture replyToMode in delivery plan"`）**

### Task 2: 让 delivery 处理 reply 失败降级并支持 replyToMode='all'

**Files:**
- Modify: /Users/ld/Documents/github/agentcord/src/discord/delivery.ts
- Modify: /Users/ld/Documents/github/agentcord/test/delivery.test.ts

- [ ] **Step 1: 为 delivery 增加针对引用失败降级和 replyToMode='all' 的测试**

```ts
it('引用失败会降级到不带 reply 的重发', async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error('missing reference'))
    .mockResolvedValueOnce({ id: 'fallback' });
  const channel = { send };

  const ids = await deliver(channel as any, {
    sessionId: 's1',
    chatId: 'c1',
    replyToMessageId: 'user',
    replyToMode: 'first',
    editTargetMessageId: undefined,
    chunks: ['one'],
    filesOnFirstChunk: [],
    mode: 'user_reply',
  });

  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenNthCalledWith(2, { content: 'one' });
  expect(ids).toEqual(['fallback']);
});

it("replyToMode='all' 会让每块都带引用", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ id: 'm1' })
    .mockResolvedValueOnce({ id: 'm2' });
  const channel = { send };

  await deliver(channel as any, {
    sessionId: 's1',
    chatId: 'c1',
    replyToMessageId: 'user',
    replyToMode: 'all',
    editTargetMessageId: undefined,
    chunks: ['one', 'two'],
    filesOnFirstChunk: [],
    mode: 'user_reply',
  });

  expect(send).toHaveBeenNthCalledWith(1, expect.objectContaining({ reply: expect.anything() }));
  expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ reply: expect.anything() }));
});
```

- [ ] **Step 2: 运行 `pnpm vitest test/delivery.test.ts -t '引用'`，确认新测试未通过**
- [ ] **Step 3: 修改 delivery.ts：让 sendChunk 在带 `reply` 失败时捕捉异常并重新发送不带 reply 的 payload，并让循环在 `plan.replyToMode === 'all'` 时每块都传递 `replyToMessageId`**

```ts
const shouldReply =
  !!plan.replyToMessageId &&
  plan.replyToMode !== 'off' &&
  (plan.replyToMode === 'all' || index === 0);
await sendChunk(channel, chunk, {
  replyToMessageId: shouldReply ? plan.replyToMessageId : undefined,
  files: index === 0 ? plan.filesOnFirstChunk : undefined,
});
```

在 sendChunk 内部加上一层 try/catch，当 payload 包含 reply 且 send 失败时删掉 reply 并重试。
- [ ] **Step 4: 重新运行 `pnpm vitest test/delivery.test.ts -t '引用'` 直到通过**
- [ ] **Step 5: 提交以上更改（`git add src/discord/delivery.ts test/delivery.test.ts` + `git commit -m "fix: delivery reply fallback and all mode"`）**

### Task 3: 综合验证

**Files:**
- Verify: none (runs existing tests)

- [ ] **Step 1: 运行 `pnpm vitest test/delivery-policy.test.ts test/delivery.test.ts` 确认两个模块联动的测试都通过**
- [ ] **Step 2: 如果有额外依赖（如 summary-handler 调用 delivery），确认新增 plan.replyToMode 未破坏编译（TypeScript 一次 `pnpm vitest` 会覆盖它）**
- [ ] **Step 3: 不需要再额外更改源码，准备合并**
- [ ] **Step 4: 发布计划文件说明（如有需要）并记录变更点**
