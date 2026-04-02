# workspacecord Discord 官方交互对齐设计

日期：2026-04-02  
状态：已批准，待规格审阅  
范围：第一阶段设计

## 1. 背景

`workspacecord` 当前已经具备完整的本地项目挂载、主代理会话、子代理线程、状态面板、人工审批、归档与多提供方执行能力。它的产品定位明显重于官方 `Claude Code Discord` 插件：官方实现更像一个带访问控制的 `Discord` 通道桥，而 `workspacecord` 是一个把 `Discord` 作为本地多代理工作台的系统。

但从用户可见的 `Discord` 交互来看，当前仓库仍与官方实现存在明显偏差，主要表现在：

1. 入站附件会被立即抓取并直接转成模型输入
2. 长文本分块逻辑分散在多个模块，行为不统一
3. 回复、引用、附件发送、日志发送、摘要发送缺少统一规则
4. 当前只有固定 `👀` 反应，没有官方式的可配置确认反应
5. 入站消息没有官方式 `typing` 反馈
6. 长任务收尾、附件处理与普通消息主链路的语义并不完全一致

本设计的目标不是把 `workspacecord` 改造成官方插件的架构，而是把 **所有用户可见的 `Discord` 交互** 尽量对齐到官方实现：

- 用户可见行为与官方保持一致
- 内部实现允许根据 `workspacecord` 的现有结构做适配
- 如与现有产品逻辑冲突，以官方交互为优先

## 2. 目标与非目标

### 2.1 目标

第一阶段目标是让 `workspacecord` 的所有 `Discord` 用户可见交互尽量与官方实现一致：

1. 普通消息收发链路使用统一的官方风格消息层
2. 入站消息先显示 `typing`，再按配置添加确认反应
3. 长文本采用官方式自然分块
4. 回复支持统一的引用回复语义，并默认只让首块挂引用
5. 入站附件默认只展示元信息，按需下载到本地 `inbox`
6. 出站附件遵守官方的数量、大小与“首块带附件”规则
7. 长任务完成时一定发出新的用户可见消息，不仅仅是编辑旧消息或更新状态卡
8. 聊天消息、系统通知、摘要、日志尽量统一走同一套消息投递规则

### 2.2 非目标

第一阶段明确不做：

- 把 `workspacecord` 重构成官方插件的 `MCP channel` 架构
- 移除现有的项目/会话/线程映射模型
- 移除状态卡、审批卡、控制面板等产品层能力
- 改写现有多提供方执行模型
- 强行复刻官方底层协议与工具名

## 3. 设计基线

本设计的唯一交互基线是官方 `Claude Code Discord` 插件在以下官方资料中的可见行为：

- 插件页
- `README.md`
- `ACCESS.md`
- `server.ts`

本设计采用以下一致性定义：

> 凡是 `Discord` 用户能直接感知到的交互，优先与官方保持一致；凡是官方底层结构无法直接复用的地方，采用等价行为而不是字面接口一致。

### 3.1 官方参考入口（2026-04-02 已核对）

为防止后续实施、审阅和回归时基线漂移，第一阶段统一以下官方入口为**固定参考集合**：

1. 插件页面：`https://claude.com/plugins/discord`
2. 官方仓库：`https://github.com/anthropics/claude-plugins-official`
3. `Discord` 插件目录：`https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord`
4. `README`：`https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/discord/README.md`
5. `ACCESS` 文档：`https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/discord/ACCESS.md`
6. 源码入口：`https://github.com/anthropics/claude-plugins-official/blob/main/external_plugins/discord/server.ts`

后续任何人阅读本规划时，都应默认按以下顺序校准理解：

1. 先看插件页面，确认对外产品定位
2. 再看 `README`，确认默认使用路径、工具面与附件语义
3. 再看 `ACCESS`，确认访问控制、`ackReaction`、`replyToMode`、`textChunkLimit`、`chunkMode` 等交互配置
4. 最后以 `server.ts` 为用户可见行为的最终实现依据

若 `README` / `ACCESS` / 本规划之间出现歧义，以 `server.ts` 的当前实现为准；若源码行为不易直接看出产品意图，再回看 `README` 与插件页面做解释。

### 3.2 本地参考副本

为降低来回在线查阅成本，第一阶段允许在仓库内保留一份官方代码参考副本，但它**不是规范来源**，只用于便捷比对。

当前项目的本地参考副本路径固定为：

- `tmp/claude-plugins-official/`
- `tmp/claude-plugins-official/external_plugins/discord/`

使用约束：

- 规范来源始终以上述官方入口为准，本地副本仅作阅读与比对缓存
- 如需重新同步，直接更新该 `tmp` 目录，不在产品代码中形成对它的运行时依赖
- 评审实现是否“对齐官方”时，必须能回指到官方入口，而不是只引用本地副本

## 4. 产品定位

一句话定位：

> 在保留 `workspacecord` 现有会话控制台能力的前提下，把其所有用户可见的 `Discord` 消息体验统一收敛成官方 `Claude Code Discord` 插件风格。

两个硬约束：

1. 项目、主会话、子线程、审批卡、状态卡等产品层能力继续保留
2. 普通消息、附件、分块、回复、反馈等用户可见交互以官方行为为优先

## 5. 设计原则

1. 官方可见行为优先于现有交互习惯
2. 统一消息层优先于分散补丁
3. 普通消息优先文本化，控制卡片保留为少数例外
4. 入站附件懒下载优先于自动内联
5. 一切出站文本都遵守统一的分块、引用、附件策略
6. 失败不阻断主流程的交互反馈（如 `typing`、确认反应）应当尽量 fire-and-forget
7. 先统一主聊天链路，再统一摘要、日志与系统通知

## 6. 总体架构

### 6.1 新增统一消息层

新增一层 `Discord` 交互适配层，用于吸收官方行为并向现有上层能力提供统一接口。

建议新增模块：

- `src/discord/inbound-envelope.ts`
- `src/discord/attachment-inbox.ts`
- `src/discord/delivery-policy.ts`
- `src/discord/delivery.ts`
- `src/discord/session-message-context.ts`

这层负责：

- 入站消息统一封装
- 附件元信息登记与按需下载
- 长文本分块
- 引用回复规则
- 附件发送规则
- `typing` 与确认反应
- 每会话的可编辑进度消息状态
- 编辑消息与最终完成通知的统一语义

### 6.2 保留的现有产品层

以下模块继续保留，但其普通文本输出应尽量改走统一消息层：

- `src/discord/status-card.ts`
- `src/discord/interaction-card.ts`
- `src/discord/summary-handler.ts`
- `src/panel-adapter.ts`

### 6.3 统一数据流

#### 入站

`Discord Message`
→ `src/message-handler.ts`
→ 授权 / 限流 / 会话定位
→ `typing` + `ackReaction`
→ `inbound-envelope`
→ `attachment-inbox` 登记附件元信息
→ 生成统一消息包文本
→ `src/session-executor.ts`

#### 出站

`ProviderEvent`
→ `src/output-handler.ts`
→ `delivery-policy`
→ `delivery`
→ `Discord`

#### 系统通知

归档、摘要、日志、结束通知、子代理完成通知等
→ 统一转为普通文本或文本优先的消息载荷
→ `delivery`

## 7. 模块边界

### 7.1 `src/discord/inbound-envelope.ts`

职责：

- 接收原始 `Discord` 消息对象
- 生成统一的入站消息包文本
- 输出正文、引用关系、附件摘要、元数据

要求：

- 不负责下载附件内容
- 不负责把图片转 `base64`
- 不直接决定执行逻辑

### 7.2 `src/discord/attachment-inbox.ts`

职责：

- 记录消息的附件清单
- 提供按需下载能力
- 统一本地 `inbox` 路径与文件名净化规则
- 统一大小限制与基础安全校验

要求：

- 默认不下载
- 下载结果返回绝对路径与元数据
- 下载目录按会话隔离

### 7.3 `src/discord/delivery-policy.ts`

职责：

- 统一定义文本分块规则
- 统一定义引用回复规则
- 统一定义附件首块发送规则
- 统一定义编辑消息与完成通知规则

### 7.4 `src/discord/delivery.ts`

职责：

- 真正调用 `Discord` API 发消息、编辑消息、加反应、发 `typing`
- 对所有可见输出提供统一调用入口
- 维护每个 `sessionId` 最近一次可复用的进度消息 `id`

要求：

- 普通消息、摘要、日志、系统通知尽量都复用这里
- 不允许各业务模块继续散落实现自己的分块与发送行为
- `progress_update` 是否编辑旧消息，必须由这里根据显式目标或会话内缓存统一判定

### 7.5 `src/discord/session-message-context.ts`

职责：

- 为 `Claude` / `Codex` 注入统一的 `Discord` 交互语义说明
- 明确附件默认未下载、如需附件需要走本地下载入口
- 明确长任务完成后需要发新的可见消息
- 只负责“提供方可见语义”，不负责任何真实发送行为

要求：

- 只生成稳定、可测试的提示词片段，不直接访问 `Discord` API
- 只描述消息语义、附件获取方式、收尾通知原则
- 不承载“首块带附件”“首块带引用”“是否编辑旧消息”等发送策略；这些全部属于 `delivery-policy`

### 7.6 最小接口草案

为避免模块边界在实施时再次发散，第一阶段按以下最小接口推进。接口名称可调整，但输入/输出职责不能偏离。

```ts
type InboundAttachmentSummary = {
  attachmentId: string;
  name: string;
  contentType: string | null;
  sizeBytes: number;
};

type InboundEnvelope = {
  sessionId: string;
  chatId: string;
  messageId: string;
  replyToMessageId?: string;
  userId: string;
  username: string;
  timestampIso: string;
  text: string;
  attachments: InboundAttachmentSummary[];
  renderedPrompt: string;
};

type DeliveryPolicy = {
  textChunkLimit: number;
  chunkMode: 'length' | 'newline';
  replyToMode: 'off' | 'first' | 'all';
  ackReaction: string;
};

type DeliveryPlan = {
  sessionId: string;
  chatId: string;
  replyToMessageId?: string;
  editTargetMessageId?: string;
  chunks: string[];
  filesOnFirstChunk: string[];
  mode: 'user_reply' | 'system_notice' | 'summary' | 'log' | 'progress_update';
};
```

模块最小职责如下：

- `inbound-envelope`：输入原始 `Discord` 消息与 `sessionId`，输出 `InboundEnvelope`
- `attachment-inbox`：输入 `sessionId + messageId`，并可选指定 `attachmentId`，输出对应附件的本地绝对路径与元数据
- `delivery-policy`：输入消息模式、原始文本、附件列表、可选引用目标与配置，输出 `DeliveryPlan`
- `delivery`：输入 `DeliveryPlan`，执行实际发送并返回发送的消息 `id` 列表

补充约束：

- `replyToMessageId` 只表示对用户消息的引用目标，不承担编辑旧机器人消息的职责
- `editTargetMessageId` 只用于编辑已有机器人消息，缺失时仅 `progress_update` 可尝试回退到 `delivery` 内部维护的会话级最近进度消息
- `user_reply`、`summary`、`system_notice`、`log` 不得复用会话级进度消息作为最终结果，必须落为新消息

## 8. 入站消息设计

### 8.1 统一消息包

所有进入会话执行层的 `Discord` 消息都先被包装成统一文本消息包。建议语义类似：

```text
<discord chat_id="..." message_id="..." user="..." user_id="..." ts="..." reply_to="...">
正文
</discord>
```

如果消息携带附件，则在消息包中附加附件摘要：

- 文件名
- 内容类型
- 大小

但不附加附件内容本身。

### 8.2 附件语义

与官方一致：

- 附件默认不自动下载
- 代理初次只看到附件摘要
- 当且仅当代理明确需要文件内容时，才调用本地附件抓取入口

### 8.3 对当前实现的直接改变

`src/message-handler.ts` 需要取消：

- 图片自动抓取并转 `base64`
- 小文本附件自动读出内容并拼入提示词

改为：

- 只登记附件元信息
- 只生成统一消息包文本

## 9. 附件下载设计

### 9.1 行为目标

对齐官方 `download_attachment` 的用户可见行为，但内部实现使用 `workspacecord` 自己的本地入口。

### 9.2 本地下载入口

建议新增附件抓取入口，例如：

```text
workspacecord attachment fetch --session <session-id> --message <message-id> --attachment <attachment-id>
```

其行为应当是：

1. 查找该消息在附件索引中的记录
2. 默认只下载指定的单个附件
3. 将文件写入 `~/.workspacecord/inbox/<session-id>/`
4. 返回绝对路径、原始文件名、内容类型、大小

如确有必要，允许显式提供：

```text
workspacecord attachment fetch --session <session-id> --message <message-id> --all
```

用于一次性下载该消息的全部附件，但这不是默认路径。

第一阶段明确规定其触发方式与权限边界：

- 提供方侧通过现有命令执行能力触发，即会话代理正常执行本地命令来下载附件
- 不新增独立提供方事件类型，不新增旁路审批通道
- 如果当前会话处于需要人工确认的命令执行模式，则附件下载命令与其他本地命令一样，继续走现有审批链
- 命令实现必须校验 `session-id` 与 `message-id` 的绑定关系，只允许当前会话下载已登记到该会话的附件
- 当指定 `attachment-id` 时，还必须校验该附件确实属于该消息且属于当前会话
- 每次下载都写入现有会话日志/摘要流，保证事后可审计
- 非当前会话、跨项目、跨频道的附件不得通过该入口下载

### 9.3 安全规则

第一阶段至少遵守以下规则：

- 文件名净化，避免分隔符与控制字符污染
- 单文件大小默认对齐官方 25MB 限制
- 下载目录在 `inbox` 隔离，不混入其他运行时状态目录
- 下载记录可覆盖但不能逃逸出 `inbox`

## 10. 出站消息设计

### 10.1 文本分块

统一采用官方式分块器：

- 最大长度上限为 2000
- 默认 `chunkMode = newline`
- 分块优先级：双换行 → 单换行 → 空格 → 硬切
- 与官方源码保持一致，不对代码块、引用块、列表块做额外特殊处理

为保证可测试性，第一阶段将分块算法固定为以下确定性规则：

1. 若文本长度 `<= limit`，直接返回单块
2. 循环处理剩余文本 `rest`
3. 当 `chunkMode = newline` 时：
   - 先找 `rest.lastIndexOf('\\n\\n', limit)`
   - 再找 `rest.lastIndexOf('\\n', limit)`
   - 再找 `rest.lastIndexOf(' ', limit)`
   - 若“双换行位置 > limit / 2”，取双换行位置
   - 否则若“单换行位置 > limit / 2”，取单换行位置
   - 否则若“空格位置 > 0”，取空格位置
   - 否则硬切到 `limit`
4. 当 `chunkMode = length` 时，始终硬切到 `limit`
5. 每次切分后：
   - 当前块使用 `rest.slice(0, cut)`
   - 剩余文本使用 `rest.slice(cut).replace(/^\\n+/, '')`
6. 单个超长单词、超长行、无空白连续文本一律按硬切处理
7. 不保留被裁切点前后的多余前导换行，行为必须与上述规则一致

测试与实现均以这套固定算法为准，不允许在第一阶段加入额外“智能分块”启发式

当前分散在以下位置的分块逻辑需要被统一替换：

- `src/utils.ts`
- `src/bot.ts`
- `src/discord/summary-handler.ts`
- `src/output-handler.ts`

### 10.2 引用回复

统一支持 `reply_to` 语义，并提供：

- `off`
- `first`
- `all`

默认对齐官方使用 `first`：

- 多块消息只让第一块挂引用
- 系统通知默认不引用
- 回复历史消息时允许显式指定引用目标

第一阶段把“系统通知”明确限定为：

- 归档完成通知
- 会话同步提示
- 子代理完成通知
- 健康检查/日志摘要
- 状态面板的旁路说明消息

引用回复的边界规则固定如下：

1. 只允许引用同一 `chatId` 内的消息
2. 不允许跨频道、跨线程、跨项目引用
3. 如果目标消息不存在、已删除、无权限访问，或 `Discord` 拒绝该引用，则自动降级为普通独立消息
4. 降级不得中断主流程，只记录调试日志
5. 系统通知与摘要模式下，`delivery-policy` 必须强制清空 `replyToMessageId`

### 10.3 附件发送

统一采用官方规则：

- 最多 10 个附件
- 单文件最大 25MB
- 文本分块时附件只挂第一块

`src/output-handler.ts` 里当前 `image_file` 事件直接发送附件的逻辑需要被改造成“先加入待发送附件上下文，再交给统一投递层”。

### 10.4 编辑消息与完成通知

与官方一致：

- 编辑旧消息可以用于中间进度更新
- 但长任务完成时必须再发一条新的用户可见消息
- 状态卡更新不能替代最终完成通知

第一阶段进一步固定：

- `progress_update` 模式允许编辑已有机器人消息
- `user_reply`、`summary`、`system_notice`、`log` 的最终落盘结果均必须以新消息结束
- 若编辑失败（消息不存在、无权限、已过期），自动退化为发送新消息

为保证这条规则可真正实施，第一阶段再增加两条硬约束：

1. `delivery` 必须维护按 `sessionId` 索引的会话级投递状态，至少记录“最近进度消息 `id`”与“最近最终可见消息 `id`”
2. `delivery-policy` 只负责产出发送/编辑意图，不直接保存任何消息 `id`；所有消息 `id` 生命周期都收口到 `delivery`

## 11. 入站反馈设计

### 11.1 `typing`

消息在通过授权、限流、会话存在性等门槛后，正式进入处理前应立即发送 `typing`。失败不阻断主流程。

第一阶段失败处理规则：

- 权限不足、频道不可用、网络抖动、被限流时直接吞掉异常
- 只记录调试日志，不向用户额外发送失败提示
- `typing` 只尝试一次，不做重试与保活循环

### 11.2 `ackReaction`

当前硬编码 `👀` 的实现需要改成官方式可配置字段：

- `ackReaction` 可为任意字符串
- 空字符串表示关闭
- 反应发送失败不阻断主流程

第一阶段失败处理规则：

- 无法加反应、消息过旧、权限不足、自定义表情不可用时直接忽略
- 只记录调试日志，不影响后续执行与回复

## 12. 配置设计

新增或统一以下消息层配置：

- `ackReaction`
- `replyToMode`
- `textChunkLimit`
- `chunkMode`

这些配置属于用户可见交互策略，应当集中收口，而不是散落在各个模块的常量中。

第一阶段配置来源、默认值与约束固定如下：

- 配置来源：现有全局配置系统
- 优先级：运行时显式发送参数 > 全局配置默认值
- 第一阶段不引入新的持久化会话级配置

默认值：

- `ackReaction = "👀"`
- `replyToMode = "first"`
- `textChunkLimit = 2000`
- `chunkMode = "length"`

取值约束：

- `textChunkLimit` 允许范围为 `1..2000`，超出时强制夹紧到该区间
- `chunkMode` 仅允许 `length | newline`
- `replyToMode` 仅允许 `off | first | all`
- `ackReaction` 允许 `Unicode emoji`、空字符串，或官方兼容的自定义表情格式 `<:name:id>`

## 13. 提示词与提供方适配

### 13.1 统一语义注入

在 `src/thread-manager.ts` 生成 `systemPromptParts` 时，追加统一的 `Discord` 交互规则：

1. 消息来自 `Discord`
2. 附件默认不自动下载
3. 如需查看附件，使用本地附件抓取入口
4. 正常回复不必反复引用最新消息
5. 长任务完成时需要发送新的可见消息，不要只依赖编辑旧消息

第一阶段落地时建议新增 `src/discord/session-message-context.ts`，专门生成这段稳定提示词，并由 `src/thread-manager.ts` 统一接入，避免附件语义与收尾语义再次散落。

### 13.2 第一阶段约束

第一阶段不修改 `ProviderEvent` 协议结构，不新增新的提供方附件块类型。统一采用“文本消息包 + 本地附件下载入口”的适配方案。

为避免接口漂移，第一阶段还固定如下：

- `attachment fetch` 只作为本地命令入口实现，不新增独立按钮或快捷命令
- 提供方是否能执行该命令，完全服从现有命令执行与人工审批体系
- 下载结果通过普通文本输出与后续文件读取能力继续衔接，不增加新的消息协议

## 14. 一致性边界与例外

### 14.1 可直接复刻的官方行为

- 长文本分块
- 引用回复策略
- 附件数量与大小限制
- 附件只挂首块
- 入站 `typing`
- `ackReaction`
- 附件懒下载

### 14.2 只能等价复刻的地方

- 官方 `MCP` 工具接口本身
- 官方 `<channel ...>` 通知协议
- 官方权限请求底层事件协议

这些采用行为等价而非接口字面一致。

### 14.3 保留的 `workspacecord` 产品差异

- 项目 / 分类 / 频道 / 线程映射模型
- 状态卡、审批卡、控制面板
- 多提供方执行能力
- monitor、归档、同步、子代理等产品能力

## 15. 实施顺序

本设计虽然标记为“第一阶段设计”，但第一阶段交付口径就是完成下述三批内容。三批是实施批次，不是三个独立阶段。

第一阶段完成的验收标准是：

1. 主聊天链路完成官方风格对齐
2. 附件语义从自动内联改为懒下载
3. 摘要、日志与系统通知并入统一消息层

只有三批全部完成，第一阶段才算交付完成。

### 15.1 第一批：主聊天链路对齐

优先修改：

- `src/message-handler.ts`
- `src/discord/inbound-envelope.ts`
- `src/discord/attachment-inbox.ts`
- `src/output-handler.ts`
- `src/panel-adapter.ts`
- `src/discord/summary-handler.ts`
- `src/thread-manager.ts`
- `src/utils.ts`
- 新增 `src/discord/delivery-policy.ts`
- 新增 `src/discord/delivery.ts`

目标：

- 聊天主链路与“回合结束主路径”一起先对齐到官方风格
- 入站消息先统一封装，停止自动内联图片与小文本附件
- `typing`、确认反应、分块、引用、附件首块发送全部落地
- `panel-adapter` / `summary-handler` 的最终用户可见消息改走统一消息层
- 长任务结束时无论中途是否编辑过进度消息，最终都必须新增一条可见消息

### 15.2 第二批：附件抓取入口与提供方语义打通

新增：

- 本地附件抓取入口
- `src/discord/session-message-context.ts`

目标：

- 提供方稳定知道“附件默认未下载”
- 建立默认单附件、可选全量的按需下载语义
- 让附件抓取命令、审批链、日志审计三者闭环

### 15.3 第三批：系统通知全面并轨

修改：

- `src/discord/summary-handler.ts`
- `src/bot.ts`
- `src/hook-health-check.ts`
- 其他直接 `channel.send()` 的模块

目标：

- 摘要、日志、归档通知、完成通知全部尽量统一为官方风格

## 16. 风险与缓解

### 16.1 风险：现有输出点很多，容易遗漏

缓解：

- 第一阶段先覆盖聊天主链路与回合结束主路径
- 第三阶段再全仓扫描 `channel.send()`、`messages.edit()`、`react()` 的调用点并收口

### 16.2 风险：附件自动内联改为懒下载后，短期内模型可见信息减少

缓解：

- 在系统提示中明确附件获取方式
- 消息包内提供清晰的附件摘要

### 16.3 风险：状态卡与普通文本通知可能重复

缓解：

- 明确分工：状态卡负责持续状态，普通消息负责用户可见事件通知

## 17. 测试策略

### 17.1 单元测试

至少覆盖：

- 官方式分块器的分段规则
- `replyToMode` 的不同分支
- 附件限制（数量、大小、首块发送）
- 附件索引与下载路径生成
- 文件名净化
- 空 `ackReaction` 与启用 `ackReaction` 的分支

### 17.2 集成测试

至少覆盖：

1. 用户发送普通文本消息
2. 用户发送长文本消息并收到多块回复
3. 用户发送带附件消息，代理先看到摘要而非内容
4. 代理触发附件下载后能拿到稳定本地路径
5. 长任务执行过程中存在编辑/状态更新，但完成时仍收到新的消息通知
6. 摘要、日志与系统消息走统一投递策略

### 17.3 回归重点

- monitor 模式
- 子代理线程完成通知
- 审批卡不受普通消息层改造影响
- 现有状态卡生命周期不被破坏

## 18. 结论

本设计不追求复刻官方插件的内部架构，而是把其 **用户可见交互行为** 作为唯一基线，通过新增统一消息层，把 `workspacecord` 当前分散的文本、附件、反馈、通知行为收口，最终形成：

- 产品能力仍是 `workspacecord`
- 用户体感尽量是官方 `Claude Code Discord`

后续实施应先从聊天主链路入手，再扩展到附件语义与系统通知全量并轨。
