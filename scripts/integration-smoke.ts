try { process.loadEnvFile(); } catch { /* .env not required */ }
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type TextChannel,
  type CategoryChannel,
  type ForumChannel,
  type AnyThreadChannel,
  type Guild,
} from 'discord.js';
import { config } from '../packages/core/src/config.ts';
import { handleProject, handleAgent, handleSubagent, handleShell } from '../packages/bot/src/command-handlers.ts';
import { executeSessionPrompt } from '../packages/engine/src/session-executor.ts';
import {
  loadRegistry,
  getProjectByName,
  getProjectByPath,
  registerProject,
  unbindProjectCategory,
  bindProjectCategory,
  setProjectHistoryChannel,
  setProjectControlChannel,
} from '../packages/engine/src/project-registry.ts';
import { loadProjects } from '../packages/engine/src/project-manager.ts';
import { loadSessions, getSession, getSessionsByCategory } from '../packages/engine/src/session-registry.ts';
import { loadArchived, getArchivedSessions } from '../packages/bot/src/archive-manager.ts';
import { CodexLogMonitor } from '../packages/bot/src/monitors/codex-log-monitor.ts';
import { handleCodexMonitorStateChange } from '../packages/bot/src/codex-monitor-bridge.ts';
import { cleanupSessionsById } from '../packages/bot/src/session-housekeeping.ts';

type OptionMap = Record<string, string | null | undefined>;

interface StepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
}

interface IntegrationReport {
  startedAt: string;
  finishedAt?: string;
  projectName: string;
  guildId: string;
  categoryId?: string;
  usedExistingBinding: boolean;
  temporaryCategoryCreated: boolean;
  historyChannelId?: string;
  mainSessionChannelId?: string;
  codexSessionChannelId?: string;
  subagentThreadId?: string;
  reportPath: string;
  steps: StepResult[];
  missingInputs: string[];
}

function makeOptions(subcommand: string, values: OptionMap) {
  return {
    getSubcommand: () => subcommand,
    getString: (name: string, required = false) => {
      const value = values[name];
      if ((value === undefined || value === null) && required) {
        throw new Error(`Missing required option: ${name}`);
      }
      return value ?? null;
    },
    getInteger: (name: string, required = false) => {
      const value = values[name];
      if ((value === undefined || value === null) && required) {
        throw new Error(`Missing required integer option: ${name}`);
      }
      return value ? parseInt(String(value), 10) : null;
    },
  };
}

function makeInteraction(
  userId: string,
  userTag: string,
  guild: { id: string; name?: string },
  channel: { id: string; guild?: { id: string } | null },
  subcommand: string,
  values: OptionMap,
) {
  let replied = false;
  let deferred = false;
  let lastReply: unknown;
  return {
    user: { id: userId, tag: userTag },
    guild,
    channel,
    channelId: channel.id,
    replied,
    deferred,
    options: makeOptions(subcommand, values),
    async reply(payload: unknown) {
      replied = true;
      lastReply = payload;
      return payload;
    },
    async deferReply() {
      deferred = true;
      return;
    },
    async editReply(payload: unknown) {
      lastReply = payload;
      return payload;
    },
    async fetchReply() {
      return lastReply;
    },
  };
}

function step(
  report: IntegrationReport,
  name: string,
  status: StepResult['status'],
  detail: string,
) {
  report.steps.push({ name, status, detail });
  const icon = status === 'passed' ? '✓' : status === 'skipped' ? '-' : '✗';
  process.stdout.write(`${icon} ${name}: ${detail}\n`);
}

async function waitFor(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  ms: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await waitFor(500);
  }
  throw new Error(`Timed out: ${label}`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    }),
  ]);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skipProviderSmoke(
  report: IntegrationReport,
  stepName: 'provider-claude-smoke' | 'provider-codex-smoke',
  providerLabel: 'Claude' | 'Codex',
  error: unknown,
): void {
  const message = messageOf(error);
  report.missingInputs.push(`${providerLabel} 真实生成冒烟未完成：${message}`);
  step(report, stepName, 'skipped', `${providerLabel} 真实生成未完成：${message}`);
}

const requestedProjectName = process.env.workspacecord_E2E_PROJECT || 'workspacecord';
const artifactsDir = join(process.cwd(), 'local-acceptance');
mkdirSync(artifactsDir, { recursive: true });
const reportPath = join(artifactsDir, 'workspacecord-integration-report.json');

const report: IntegrationReport = {
  startedAt: new Date().toISOString(),
  projectName: requestedProjectName,
  guildId: config.guildId,
  usedExistingBinding: false,
  temporaryCategoryCreated: false,
  reportPath,
  steps: [],
  missingInputs: [],
};

let client: Client | null = null;
let bootstrapChannel: TextChannel | null = null;
let tempCategory: CategoryChannel | null = null;
let cleanupBinding = false;
let existingControl: TextChannel | null = null;
let rebindForSmoke = false;
let guild: Guild | null = null;
let effectiveProjectName = requestedProjectName;
const createdSessionIds = new Set<string>();
const createdHistoryThreadIds = new Set<string>();
let originalBinding:
  | {
      categoryId?: string;
      categoryName?: string;
      historyChannelId?: string;
      controlChannelId?: string;
    }
  | null = null;

try {
  await loadRegistry();
  await loadProjects();
  await loadSessions();
  await loadArchived();

  let mountedProject = getProjectByName(effectiveProjectName);
  if (!mountedProject) {
    const mountedByPath = getProjectByPath(process.cwd());
    if (mountedByPath) {
      mountedProject = mountedByPath;
      effectiveProjectName = mountedByPath.name;
      report.projectName = mountedByPath.name;
      step(
        report,
        'mount-project',
        'passed',
        `复用当前路径已挂载项目 ${mountedByPath.name}`,
      );
    } else {
      mountedProject = await registerProject(effectiveProjectName, process.cwd());
      step(report, 'mount-project', 'passed', `自动挂载本地项目 ${effectiveProjectName}`);
    }
  } else {
    step(report, 'mount-project', 'passed', `已存在挂载项目 ${effectiveProjectName}`);
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  await client.login(config.token);
  await waitFor(1000);

  guild = await client.guilds.fetch(config.guildId);
  await guild.channels.fetch();
  step(report, 'discord-login', 'passed', `已连接到 guild ${guild.name}`);

  let category: CategoryChannel | null = null;
  if (mountedProject.discordCategoryId) {
    const existing = guild.channels.cache.get(mountedProject.discordCategoryId);
    if (existing?.type === ChannelType.GuildCategory) {
      category = existing as CategoryChannel;
      report.usedExistingBinding = true;
      originalBinding = {
        categoryId: mountedProject.discordCategoryId,
        categoryName: mountedProject.discordCategoryName,
        historyChannelId: mountedProject.historyChannelId,
        controlChannelId: mountedProject.controlChannelId,
      };
      step(report, 'resolve-category', 'passed', `复用已绑定分类 ${category.name}`);
    }
  }

  if (category && category.children.cache.size >= 50) {
    step(
      report,
      'resolve-category',
      'skipped',
      `已绑定分类 ${category.name} 已满 ${category.children.cache.size} 个频道，改用临时分类`,
    );
    category = null;
    report.usedExistingBinding = false;
    existingControl = null;
    cleanupBinding = true;
    rebindForSmoke = true;
  }

  if (!category) {
    category = await guild.channels.create({
      name: `workspacecord-e2e-${Date.now().toString().slice(-6)}`,
      type: ChannelType.GuildCategory,
      reason: 'workspacecord integration smoke test',
    });
    tempCategory = category;
    report.temporaryCategoryCreated = true;
    cleanupBinding = true;
    step(report, 'create-category', 'passed', `创建临时分类 ${category.name}`);
  }

  report.categoryId = category.id;

  existingControl =
    report.usedExistingBinding && mountedProject.controlChannelId
      ? (((await guild.channels.fetch(mountedProject.controlChannelId).catch(() => null)) as
          | TextChannel
          | null))
      : null;

  if (existingControl?.type === ChannelType.GuildText) {
    bootstrapChannel = existingControl;
    step(report, 'create-bootstrap-channel', 'passed', `复用控制频道 ${bootstrapChannel.name}`);
  } else {
    bootstrapChannel = await guild.channels.create({
      name: `e2e-control-${Date.now().toString().slice(-4)}`,
      type: ChannelType.GuildText,
      parent: category.id,
      reason: 'workspacecord integration smoke test bootstrap channel',
    });
    step(report, 'create-bootstrap-channel', 'passed', `创建控制频道 ${bootstrapChannel.name}`);
  }

  const actorId = config.allowedUsers[0] || 'integration-e2e-user';
  const actorTag = 'workspacecord-e2e#0001';

  if (rebindForSmoke) {
    await unbindProjectCategory(effectiveProjectName);
    step(report, 'project-rebind', 'passed', '已临时解绑原分类，准备在临时分类执行冒烟');
  }

  if (!report.usedExistingBinding || !existingControl) {
    const interaction = makeInteraction(actorId, actorTag, guild, bootstrapChannel, 'setup', {
      project: effectiveProjectName,
    });
    await handleProject(interaction);
    const setupReply = await interaction.fetchReply().catch(() => null);
    const setupText =
      typeof setupReply === 'string'
        ? setupReply
        : setupReply && typeof setupReply === 'object' && 'content' in setupReply
          ? String((setupReply as { content?: unknown }).content ?? '')
          : '';
    if (/Failed|not under a Category|Run `\/project setup` first/i.test(setupText)) {
      throw new Error(`project setup failed: ${setupText}`);
    }
    step(
      report,
      'project-setup',
      'passed',
      `已刷新项目绑定与控制频道 ${effectiveProjectName}`,
    );
  } else {
    step(report, 'project-setup', 'skipped', '项目已存在 Discord 绑定，跳过重复绑定');
  }

  await guild.channels.fetch();
  const boundProject = getProjectByName(effectiveProjectName);
  report.historyChannelId = boundProject?.historyChannelId;

  const mainLabel = `e2e-main-${Date.now().toString().slice(-4)}`;
  const spawnInteraction = makeInteraction(actorId, actorTag, guild, bootstrapChannel, 'spawn', {
    label: mainLabel,
    provider: 'claude',
    mode: 'auto',
  });
  await handleAgent(spawnInteraction);
  const spawnReply = await spawnInteraction.fetchReply().catch(() => null);

  const mainSession = getSessionsByCategory(category.id).find(
    (session) => session.type === 'persistent' && session.agentLabel === mainLabel,
  );
  if (!mainSession) {
    throw new Error(
      `主会话未创建成功${spawnReply ? `；spawn reply=${JSON.stringify(spawnReply)}` : ''}`,
    );
  }
  report.mainSessionChannelId = mainSession.channelId;
  createdSessionIds.add(mainSession.id);
  step(report, 'agent-spawn', 'passed', `创建主代理会话 ${mainLabel}`);

  const mainChannel = (await guild.channels.fetch(mainSession.channelId)) as TextChannel;
  const pinned = await mainChannel.messages.fetchPins().catch(() => null);
  if (!pinned || pinned.size === 0) {
    throw new Error('主会话未创建 pinned 状态消息');
  }
  step(report, 'status-pin', 'passed', '主会话已创建并置顶状态消息');

  const subLabel = `e2e-sub-${Date.now().toString().slice(-4)}`;
  const subInteraction = makeInteraction(actorId, actorTag, guild, mainChannel, 'run', {
    label: subLabel,
    provider: 'claude',
  });
  await handleSubagent(subInteraction);

  const subagent = getSessionsByCategory(category.id).find(
    (session) => session.type === 'subagent' && session.agentLabel === subLabel,
  );
  if (!subagent) {
    throw new Error('子代理未创建成功');
  }
  report.subagentThreadId = subagent.channelId;
  createdSessionIds.add(subagent.id);
  step(report, 'subagent-run', 'passed', `创建子代理线程 ${subLabel}`);

  if (!config.shellEnabled) {
    report.missingInputs.push(
      '若要自动验证 /shell run 真实命令入口，请先启用 SHELL_ENABLED=true',
    );
    step(report, 'shell-smoke', 'skipped', '未启用 SHELL_ENABLED，跳过 /shell run 冒烟');
  } else {
    const shellInteraction = makeInteraction(actorId, actorTag, guild, mainChannel, 'run', {
      command: 'pwd',
    });
    await withTimeout(handleShell(shellInteraction as never), 15000, 'shell-smoke');
    step(report, 'shell-smoke', 'passed', '主会话频道成功通过 /shell run 执行 pwd');
  }

  const claudeCapable = Boolean(config.anthropicApiKey);
  const codexCapable = Boolean(config.codexApiKey);
  if (!claudeCapable) {
    report.missingInputs.push(
      '若要自动验证 Claude 真正出流，请提供 ANTHROPIC_API_KEY 或全局配置中的同名键',
    );
    step(
      report,
      'provider-claude-smoke',
      'skipped',
      '未配置 ANTHROPIC_API_KEY，跳过真实 Claude 生成测试',
    );
  } else {
    try {
      await withTimeout(
        executeSessionPrompt(
          getSession(mainSession.id)!,
          mainChannel,
          'Reply with exactly: workspacecord_E2E_OK',
        ),
        60000,
        'provider-claude-smoke',
      );
      step(report, 'provider-claude-smoke', 'passed', '已执行 Claude 真实生成冒烟');
    } catch (err: unknown) {
      skipProviderSmoke(report, 'provider-claude-smoke', 'Claude', err);
    }
  }

  if (!codexCapable) {
    report.missingInputs.push(
      '若要自动验证 Codex 真正出流，请提供 CODEX_API_KEY 或全局配置中的同名键',
    );
    step(
      report,
      'provider-codex-smoke',
      'skipped',
      '未配置 CODEX_API_KEY，跳过真实 Codex 生成测试',
    );
  } else {
    try {
      const codexLabel = `e2e-codex-${Date.now().toString().slice(-4)}`;
      const codexInteraction = makeInteraction(actorId, actorTag, guild, bootstrapChannel, 'spawn', {
        label: codexLabel,
        provider: 'codex',
        mode: 'auto',
      });
      await withTimeout(handleAgent(codexInteraction), 30000, 'provider-codex-spawn');

      const codexSession = getSessionsByCategory(category.id).find(
        (session) => session.type === 'persistent' && session.agentLabel === codexLabel,
      );
      if (!codexSession) {
        throw new Error('Codex 冒烟会话未创建成功');
      }
      report.codexSessionChannelId = codexSession.channelId;
      createdSessionIds.add(codexSession.id);

      const codexChannel = (await guild.channels.fetch(codexSession.channelId)) as TextChannel;
      await withTimeout(
        executeSessionPrompt(
          getSession(codexSession.id)!,
          codexChannel,
          'Reply with exactly: workspacecord_CODEX_E2E_OK',
        ),
        60000,
        'provider-codex-smoke',
      );
      step(report, 'provider-codex-smoke', 'passed', '已执行 Codex 真实生成冒烟');

      const liveCodexSession = getSession(codexSession.id);
      if (!liveCodexSession?.statusCardMessageId) {
        throw new Error('Codex 会话缺少状态卡消息 ID，无法验证监控驱动状态更新');
      }

      const providerSessionId =
        liveCodexSession.providerSessionId || '019d4200-1111-2222-3333-444444444444';
      const monitorBaseDir = mkdtempSync(join(tmpdir(), 'workspacecord-codex-monitor-'));
      const now = new Date();
      const yyyy = String(now.getFullYear());
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const mi = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const dayDir = join(monitorBaseDir, yyyy, mm, dd);
      mkdirSync(dayDir, { recursive: true });
      const rolloutPath = join(
        dayDir,
        `rollout-${yyyy}-${mm}-${dd}T${hh}-${mi}-${ss}-${providerSessionId}.jsonl`,
      );

      const monitor = new CodexLogMonitor(monitorBaseDir, (sessionId, state, event, extra) => {
        void handleCodexMonitorStateChange(
          (channelId) => guild.channels.cache.get(channelId),
          sessionId,
          state,
          event,
          extra,
        );
      });

      try {
        monitor.start();
        writeFileSync(
          rolloutPath,
          `${JSON.stringify({ type: 'session_meta', payload: { cwd: liveCodexSession.directory } })}\n`,
          'utf-8',
        );

        appendFileSync(
          rolloutPath,
          `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`,
          'utf-8',
        );
        await waitForCondition(async () => {
          const statusMessage = await codexChannel.messages.fetch(liveCodexSession.statusCardMessageId!);
          return statusMessage.embeds[0]?.title?.includes('正在思考') ?? false;
        }, 10000, 'codex-monitor-thinking');
        step(report, 'codex-monitor-thinking', 'passed', 'Codex 日志监控已驱动状态卡进入“正在思考”');

        appendFileSync(
          rolloutPath,
          `${JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'pwd' }) },
          })}\n`,
          'utf-8',
        );
        await waitForCondition(async () => {
          const statusMessage = await codexChannel.messages.fetch(liveCodexSession.statusCardMessageId!);
          return statusMessage.embeds[0]?.title?.includes('正在执行') ?? false;
        }, 10000, 'codex-monitor-working');
        step(report, 'codex-monitor-working', 'passed', 'Codex 日志监控已驱动状态卡进入“正在执行”');
      } finally {
        monitor.stop();
      }
    } catch (err: unknown) {
      skipProviderSmoke(report, 'provider-codex-smoke', 'Codex', err);
    }
  }

  const archivedBefore = getArchivedSessions(category.id).length;
  const archiveInteraction = makeInteraction(actorId, actorTag, guild, mainChannel, 'archive', {});
  await withTimeout(handleAgent(archiveInteraction), 15000, 'agent-archive');
  const archivedAfter = getArchivedSessions(category.id).length;
  if (archivedAfter <= archivedBefore) {
    throw new Error('归档记录未增加');
  }
  for (const archivedRecord of getArchivedSessions(category.id).slice(archivedBefore)) {
    if (archivedRecord.forumPostId) {
      createdHistoryThreadIds.add(archivedRecord.forumPostId);
    }
  }
  step(report, 'agent-archive', 'passed', '主会话已归档到 #history');

  const historyForum = boundProject?.historyChannelId
    ? await guild.channels.fetch(boundProject.historyChannelId).catch(() => null)
    : null;
  if (historyForum?.type === ChannelType.GuildForum) {
    report.historyChannelId = historyForum.id;
    step(report, 'history-forum', 'passed', `归档论坛可用 ${historyForum.name}`);
  } else {
    step(report, 'history-forum', 'failed', '未找到 #history forum');
  }
} catch (err: unknown) {
  const message = (err as Error).message || 'unknown error';
  if (message.includes('Missing Permissions')) {
    report.missingInputs.push(
      '机器人在目标 guild 中缺少频道管理相关权限；至少需要创建 Category、TextChannel、Forum、Thread、删除频道与发送消息的权限',
    );
  }
  step(report, 'integration', 'failed', message);
} finally {
  try {
    if (guild) {
      await cleanupSessionsById(
        guild,
        createdSessionIds,
        'workspacecord integration smoke cleanup',
      ).catch(() => {});

      for (const threadId of createdHistoryThreadIds) {
        const thread = await guild.channels.fetch(threadId).catch(() => null);
        await thread?.delete('workspacecord integration smoke cleanup').catch(() => {});
      }
    }
    if (bootstrapChannel && !existingControl) {
      await bootstrapChannel.delete('workspacecord integration smoke cleanup').catch(() => {});
    }
    if (tempCategory) {
      for (const child of tempCategory.children.cache.values()) {
        await child.delete('workspacecord integration smoke cleanup').catch(() => {});
      }
      await tempCategory.delete('workspacecord integration smoke cleanup').catch(() => {});
    }
    if (cleanupBinding) {
      if (originalBinding?.categoryId) {
        await bindProjectCategory(
          effectiveProjectName,
          originalBinding.categoryId,
          originalBinding.categoryName,
        ).catch(() => {});
        if (originalBinding.historyChannelId) {
          await setProjectHistoryChannel(
            effectiveProjectName,
            originalBinding.historyChannelId,
          ).catch(
            () => {},
          );
        }
        if (originalBinding.controlChannelId) {
          await setProjectControlChannel(
            effectiveProjectName,
            originalBinding.controlChannelId,
          ).catch(
            () => {},
          );
        }
      } else {
        await unbindProjectCategory(effectiveProjectName).catch(() => {});
      }
    }
  } finally {
    if (client) {
      client.destroy();
    }
    report.finishedAt = new Date().toISOString();
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    process.stdout.write(`\n报告已写入: ${reportPath}\n`);
    if (report.missingInputs.length > 0) {
      process.stdout.write('\n还缺这些信息才能做更深的真实 provider 集成测试：\n');
      for (const item of report.missingInputs) {
        process.stdout.write(`- ${item}\n`);
      }
    }
    process.exit(report.steps.some((item) => item.status === 'failed') ? 1 : 0);
  }
}
