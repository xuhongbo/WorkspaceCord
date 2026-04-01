import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import {
  makeGuild,
  makeInteraction,
  makeTextChannel,
  makeThreadChannel,
} from './discord-test-utils.ts';

const config = {
  allowedUsers: [],
  allowAllUsers: true,
  defaultProvider: 'claude',
  defaultMode: 'auto',
  claudePermissionMode: 'normal',
  shellEnabled: true,
  shellAllowedUsers: [],
};

const getProject = vi.fn();
const bindMountedProjectToCategory = vi.fn();
const setHistoryChannelId = vi.fn();
const setControlChannelId = vi.fn();
const setPersonality = vi.fn();
const clearPersonality = vi.fn();
const addSkill = vi.fn();
const removeSkill = vi.fn();
const getSkills = vi.fn();
const executeSkill = vi.fn();
const addMcpServer = vi.fn();
const removeMcpServer = vi.fn();
const getMcpServers = vi.fn();

const createSession = vi.fn();
const getSessionByChannel = vi.fn();
const getSessionsByCategory = vi.fn();
const abortSession = vi.fn();
const endSession = vi.fn();
const setMode = vi.fn();
const setMonitorGoal = vi.fn();
const setAgentPersona = vi.fn();
const setVerbose = vi.fn();
const setModel = vi.fn();
const setCurrentInteractionMessage = vi.fn();
const setStatusCardBinding = vi.fn();

const spawnSubagent = vi.fn();
const getSubagents = vi.fn();
const archiveSession = vi.fn();
const buildProjectCleanupPreview = vi.fn();
const createCleanupRequest = vi.fn();
const executeSessionPrompt = vi.fn();
const executeSessionContinue = vi.fn();
const makeModeButtons = vi.fn(() => []);
const resolveEffectiveClaudePermissionMode = vi.fn(() => 'normal');
const executeShellCommand = vi.fn();
const listProcesses = vi.fn();
const killProcess = vi.fn();
const isUserAllowed = vi.fn(() => true);
const registerExistingStatusCard = vi.fn();

vi.mock('../src/config.ts', () => ({ config }));
vi.mock('../src/project-manager.ts', () => ({
  getProject,
  bindMountedProjectToCategory,
  setHistoryChannelId,
  setControlChannelId,
  setPersonality,
  clearPersonality,
  addSkill,
  removeSkill,
  getSkills,
  executeSkill,
  addMcpServer,
  removeMcpServer,
  getMcpServers,
}));
vi.mock('../src/thread-manager.ts', () => ({
  createSession,
  getSessionByChannel,
  getSessionsByCategory,
  abortSession,
  endSession,
  setMode,
  setMonitorGoal,
  setAgentPersona,
  setVerbose,
  setModel,
  setCurrentInteractionMessage,
  setStatusCardBinding,
}));
vi.mock('../src/subagent-manager.ts', () => ({ spawnSubagent, getSubagents }));
vi.mock('../src/archive-manager.ts', () => ({ archiveSession }));
vi.mock('../src/session-housekeeping.ts', () => ({
  buildProjectCleanupPreview,
}));
vi.mock('../src/agent-cleanup-request-store.ts', () => ({
  createCleanupRequest,
}));
vi.mock('../src/session-executor.ts', () => ({ executeSessionPrompt, executeSessionContinue }));
vi.mock('../src/output-handler.ts', () => ({ makeModeButtons, resolveEffectiveClaudePermissionMode }));
vi.mock('../src/shell-handler.ts', () => ({ executeShellCommand, listProcesses, killProcess }));
vi.mock('../src/panel-adapter.ts', () => ({
  registerExistingStatusCard,
}));
vi.mock('../src/utils.ts', () => ({
  isUserAllowed,
  resolvePath: (value: string) => value,
  formatUptime: () => '1m',
  formatRelative: () => 'just now',
}));

const {
  handleProject,
  handleAgent,
  handleSubagent,
  handleShell,
  handleSpawnShortcut,
  handleStopShortcut,
  handleEndShortcut,
  handleRunShortcut,
} = await import('../src/command-handlers.ts');

const project = {
  categoryId: 'cat-1',
  name: 'demo',
  directory: '/repo',
  historyChannelId: 'forum-1',
  controlChannelId: 'control-1',
  personality: undefined,
  skills: [],
  mcpServers: [],
  createdAt: 1,
};
const session = {
  id: 'session-1',
  channelId: 'session-channel',
  categoryId: 'cat-1',
  projectName: 'demo',
  agentLabel: 'main',
  provider: 'claude',
  directory: '/repo',
  type: 'persistent',
  isGenerating: false,
  verbose: false,
  subagentDepth: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  config.shellEnabled = true;
  config.shellAllowedUsers = [];
  config.allowAllUsers = true;
  getProject.mockReturnValue(project);
  bindMountedProjectToCategory.mockResolvedValue(project);
  getSkills.mockReturnValue([]);
  executeSkill.mockReturnValue('run prompt');
  getMcpServers.mockReturnValue([]);
  getSessionByChannel.mockReturnValue(session);
  getSessionsByCategory.mockReturnValue([]);
  buildProjectCleanupPreview.mockReturnValue({
    categoryId: 'cat-1',
    projectName: 'demo',
    protectedChannels: {
      currentChannelId: 'current-1',
      controlChannelId: 'control-1',
      historyChannelId: 'forum-1',
    },
    archiveCandidates: [],
    skippedGenerating: [],
    skippedUnknown: [],
  });
  createCleanupRequest.mockReturnValue({
    id: 'cleanup-1',
    userId: 'user-1',
    guildId: 'guild-1',
    categoryId: 'cat-1',
    currentChannelId: 'current-1',
    candidateSessionIds: [],
    createdAt: 1,
  });
  createSession.mockResolvedValue({ ...session, claudePermissionMode: 'normal' });
  abortSession.mockReturnValue(true);
  listProcesses.mockReturnValue([]);
  killProcess.mockReturnValue(false);
  getSubagents.mockReturnValue([]);
  spawnSubagent.mockResolvedValue({ channelId: 'thread-1', subagentDepth: 1 });
});

describe('project commands', () => {
  it('setup 绑定项目并记录 control 频道', async () => {
    bindMountedProjectToCategory.mockResolvedValue({
      ...project,
      historyChannelId: undefined,
      controlChannelId: undefined,
    });
    const control = makeTextChannel({ id: 'control-1', parentId: 'cat-1', name: 'control' });
    const history = { id: 'forum-1' };
    const guild = makeGuild({ channels: [{ id: 'cat-1', name: 'Demo Category' }], createImpl: async (payload) => {
      if (payload.type === ChannelType.GuildForum) return history;
      throw new Error('unexpected');
    }});
    const interaction = makeInteraction({ subcommand: 'setup', values: { project: 'demo' }, channel: control, guild });

    await handleProject(interaction as never);

    expect(bindMountedProjectToCategory).toHaveBeenCalledWith('demo', 'cat-1', 'Demo Category');
    expect(setHistoryChannelId).toHaveBeenCalledWith('cat-1', 'forum-1');
    expect(setControlChannelId).toHaveBeenCalledWith('cat-1', 'control-1');
  });

  it('info 返回项目信息', async () => {
    getSessionsByCategory.mockReturnValue([{ ...session, type: 'persistent' }]);
    const interaction = makeInteraction({ subcommand: 'info', channel: makeTextChannel({ parentId: 'cat-1' }) });

    await handleProject(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array), ephemeral: true }),
    );
  });

  it('personality 设置项目人格', async () => {
    const interaction = makeInteraction({ subcommand: 'personality', values: { prompt: 'be careful' }, channel: makeTextChannel({ parentId: 'cat-1' }) });
    await handleProject(interaction as never);
    expect(setPersonality).toHaveBeenCalledWith('cat-1', 'be careful');
  });

  it('personality-clear 清理项目人格', async () => {
    const interaction = makeInteraction({ subcommand: 'personality-clear', channel: makeTextChannel({ parentId: 'cat-1' }) });
    await handleProject(interaction as never);
    expect(clearPersonality).toHaveBeenCalledWith('cat-1');
  });

  it('skill-add 添加技能', async () => {
    const interaction = makeInteraction({ subcommand: 'skill-add', values: { name: 'fix', prompt: 'do {input}' }, channel: makeTextChannel({ parentId: 'cat-1' }) });
    await handleProject(interaction as never);
    expect(addSkill).toHaveBeenCalledWith('cat-1', 'fix', 'do {input}');
  });

  it('skill-remove 在技能不存在时提示 not found', async () => {
    removeSkill.mockReturnValue(false);
    const interaction = makeInteraction({ subcommand: 'skill-remove', values: { name: 'missing' }, channel: makeTextChannel({ parentId: 'cat-1' }) });
    await handleProject(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Skill **missing** not found.' }));
  });

  it('skill-list 在为空时给出提示', async () => {
    getSkills.mockReturnValue([]);
    const interaction = makeInteraction({ subcommand: 'skill-list', channel: makeTextChannel({ parentId: 'cat-1' }) });
    await handleProject(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'No skills defined. Use `/project skill-add`.' }));
  });

  it('skill-run 在会话频道中执行技能', async () => {
    const interaction = makeInteraction({ subcommand: 'skill-run', values: { name: 'fix', input: 'bug' }, channel: makeTextChannel({ id: 'session-channel', parentId: 'cat-1' }) });
    await handleProject(interaction as never);
    expect(executeSessionPrompt).toHaveBeenCalledWith(session, expect.anything(), 'run prompt');
  });

  it('mcp-add 添加 mcp 服务', async () => {
    const interaction = makeInteraction({ subcommand: 'mcp-add', values: { name: 'fs', command: 'node', args: '--inspect,server.js' }, channel: makeTextChannel({ parentId: 'cat-1' }) });
    await handleProject(interaction as never);
    expect(addMcpServer).toHaveBeenCalledWith('cat-1', 'fs', 'node', ['--inspect', 'server.js']);
  });

  it('mcp-remove 在不存在时提示 not found', async () => {
    removeMcpServer.mockResolvedValue(false);
    const interaction = makeInteraction({ subcommand: 'mcp-remove', values: { name: 'missing' }, channel: makeTextChannel({ parentId: 'cat-1' }) });
    await handleProject(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'MCP server **missing** not found.' }));
  });

  it('mcp-list 返回服务列表', async () => {
    getMcpServers.mockReturnValue([{ name: 'fs', command: 'node', args: ['server.js'] }]);
    const interaction = makeInteraction({ subcommand: 'mcp-list', channel: makeTextChannel({ parentId: 'cat-1' }) });
    await handleProject(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('**fs**') }));
  });
});

describe('agent commands', () => {
  it('spawn 创建后注册常驻状态消息', async () => {
    const control = makeTextChannel({ id: 'control-1', parentId: 'cat-1', name: 'control' });
    const statusMessage = { id: 'msg-1', pin: vi.fn(async () => undefined) };
    const created = makeTextChannel({ id: 'created-1', parentId: 'cat-1', name: 'codex-test', send: vi.fn(async () => statusMessage) });
    const guild = makeGuild({ channels: [control], createImpl: async () => created });
    createSession.mockResolvedValue({ ...session, channelId: 'created-1', provider: 'codex' });
    const interaction = makeInteraction({ subcommand: 'spawn', values: { label: 'test' }, channel: control, guild });
    await handleAgent(interaction as never);
    expect(registerExistingStatusCard).toHaveBeenCalledWith('session-1', created, 'msg-1');
    expect(setStatusCardBinding).toHaveBeenCalledWith('session-1', { messageId: 'msg-1' });
  });

  it('spawn 在非 control 频道时重定向', async () => {
    const guild = makeGuild({ channels: [makeTextChannel({ id: 'control-1', parentId: 'cat-1', name: 'control' })] });
    const interaction = makeInteraction({ subcommand: 'spawn', values: { label: 'test' }, channel: makeTextChannel({ id: 'other', parentId: 'cat-1' }), guild });
    await handleAgent(interaction as never);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('<#control-1>'));
    expect(createSession).not.toHaveBeenCalled();
  });

  it('list 在为空时提示', async () => {
    const interaction = makeInteraction({ subcommand: 'list', channel: makeTextChannel({ parentId: 'cat-1' }) });
    await handleAgent(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'No active agent sessions in this project.' }));
  });

  it('stop 在会话存在时调用 abort', async () => {
    const interaction = makeInteraction({ subcommand: 'stop', channel: makeTextChannel({ id: 'session-channel', parentId: 'cat-1' }) });
    await handleAgent(interaction as never);
    expect(abortSession).toHaveBeenCalledWith('session-1');
  });

  it('end 结束持久会话并删除频道', async () => {
    const channel = makeTextChannel({ id: 'session-channel', parentId: 'cat-1' });
    const guild = makeGuild({ channels: [channel] });
    getSessionByChannel.mockReturnValue({ ...session, channelId: 'session-channel', type: 'persistent' });
    const interaction = makeInteraction({ subcommand: 'end', channel, guild });
    await handleAgent(interaction as never);
    expect(endSession).toHaveBeenCalledWith('session-1');
    expect(channel.delete).toHaveBeenCalled();
  });

  it('archive 对子代理会话拒绝执行', async () => {
    getSessionByChannel.mockReturnValue({ ...session, type: 'subagent' });
    const interaction = makeInteraction({ subcommand: 'archive', channel: makeTextChannel({ id: 'session-channel', parentId: 'cat-1' }) });
    await handleAgent(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Only persistent sessions can be archived') }));
  });

  it('cleanup 在有候选时返回预览消息与确认按钮', async () => {
    buildProjectCleanupPreview.mockReturnValue({
      categoryId: 'cat-1',
      projectName: 'demo',
      protectedChannels: {
        currentChannelId: 'current-1',
        controlChannelId: 'control-1',
        historyChannelId: 'forum-1',
      },
      archiveCandidates: [{ id: 'idle-1', channelId: 'idle-1', agentLabel: 'idle-one' }],
      skippedGenerating: [{ id: 'run-1', channelId: 'run-1', agentLabel: 'running-one' }],
      skippedUnknown: [],
    });
    createCleanupRequest.mockReturnValue({
      id: 'cleanup-1',
      userId: 'user-1',
      guildId: 'guild-1',
      categoryId: 'cat-1',
      currentChannelId: 'current-1',
      candidateSessionIds: ['idle-1'],
      createdAt: 1,
    });

    const interaction = makeInteraction({
      subcommand: 'cleanup',
      channel: makeTextChannel({ id: 'current-1', parentId: 'cat-1' }),
      guild: makeGuild({ channels: [makeTextChannel({ id: 'current-1', parentId: 'cat-1' })] }),
    });

    await handleAgent(interaction as never);

    expect(buildProjectCleanupPreview).toHaveBeenCalledWith({
      categoryId: 'cat-1',
      currentChannelId: 'current-1',
      controlChannelId: 'control-1',
      historyChannelId: 'forum-1',
      projectName: 'demo',
    });
    expect(createCleanupRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        guildId: 'guild-1',
        categoryId: 'cat-1',
        currentChannelId: 'current-1',
        candidateSessionIds: ['idle-1'],
      }),
    );
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringContaining('批量清理预览'),
        components: expect.any(Array),
      }),
    );
  });

  it('cleanup 在子代理线程中执行时会保护父会话频道', async () => {
    buildProjectCleanupPreview.mockReturnValue({
      categoryId: 'cat-1',
      projectName: 'demo',
      protectedChannels: {
        currentChannelId: 'session-channel',
        controlChannelId: 'control-1',
        historyChannelId: 'forum-1',
      },
      archiveCandidates: [{ id: 'idle-1', channelId: 'idle-1', agentLabel: 'idle-one' }],
      skippedGenerating: [],
      skippedUnknown: [],
    });
    createCleanupRequest.mockReturnValue({
      id: 'cleanup-1',
      userId: 'user-1',
      guildId: 'guild-1',
      categoryId: 'cat-1',
      currentChannelId: 'session-channel',
      candidateSessionIds: ['idle-1'],
      createdAt: 1,
    });

    const parentChannel = makeTextChannel({ id: 'session-channel', parentId: 'cat-1' });
    const interaction = makeInteraction({
      subcommand: 'cleanup',
      channel: makeThreadChannel({ id: 'thread-1', parent: parentChannel }),
      guild: makeGuild({ channels: [parentChannel] }),
    });

    await handleAgent(interaction as never);

    expect(buildProjectCleanupPreview).toHaveBeenCalledWith({
      categoryId: 'cat-1',
      currentChannelId: 'session-channel',
      controlChannelId: 'control-1',
      historyChannelId: 'forum-1',
      projectName: 'demo',
    });
    expect(createCleanupRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        currentChannelId: 'session-channel',
      }),
    );
  });

  it('cleanup 在无候选时直接提示没有可清理的空闲会话', async () => {
    const interaction = makeInteraction({
      subcommand: 'cleanup',
      channel: makeTextChannel({ id: 'current-1', parentId: 'cat-1' }),
      guild: makeGuild({ channels: [makeTextChannel({ id: 'current-1', parentId: 'cat-1' })] }),
    });

    await handleAgent(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: '没有可清理的空闲会话',
      ephemeral: true,
    });
    expect(createCleanupRequest).not.toHaveBeenCalled();
  });

  it('mode 设置模式', async () => {
    const interaction = makeInteraction({ subcommand: 'mode', values: { mode: 'plan' }, channel: makeTextChannel({ id: 'session-channel' }) });
    await handleAgent(interaction as never);
    expect(setMode).toHaveBeenCalledWith('session-1', 'plan');
  });

  it('goal 设置监督目标', async () => {
    const interaction = makeInteraction({ subcommand: 'goal', values: { goal: 'finish it' }, channel: makeTextChannel({ id: 'session-channel' }) });
    await handleAgent(interaction as never);
    expect(setMonitorGoal).toHaveBeenCalledWith('session-1', 'finish it');
  });

  it('persona 把 general 转为 undefined', async () => {
    const interaction = makeInteraction({ subcommand: 'persona', values: { name: 'general' }, channel: makeTextChannel({ id: 'session-channel' }) });
    await handleAgent(interaction as never);
    expect(setAgentPersona).toHaveBeenCalledWith('session-1', undefined);
  });

  it('verbose 切换详细模式', async () => {
    getSessionByChannel.mockReturnValue({ ...session, verbose: false });
    const interaction = makeInteraction({ subcommand: 'verbose', channel: makeTextChannel({ id: 'session-channel' }) });
    await handleAgent(interaction as never);
    expect(setVerbose).toHaveBeenCalledWith('session-1', true);
  });

  it('model 设置模型', async () => {
    const interaction = makeInteraction({ subcommand: 'model', values: { model: 'gpt-5' }, channel: makeTextChannel({ id: 'session-channel' }) });
    await handleAgent(interaction as never);
    expect(setModel).toHaveBeenCalledWith('session-1', 'gpt-5');
  });

  it('continue 在空闲会话上继续执行', async () => {
    const channel = makeTextChannel({ id: 'session-channel' });
    const interaction = makeInteraction({ subcommand: 'continue', channel });
    await handleAgent(interaction as never);
    expect(executeSessionContinue).toHaveBeenCalledWith(session, channel);
  });
});

describe('subagent commands', () => {
  it('run 在会话频道中创建子代理', async () => {
    const channel = makeTextChannel({ id: 'session-channel' });
    const guild = makeGuild({ channels: [channel] });
    const interaction = makeInteraction({ subcommand: 'run', values: { label: 'worker' }, channel, guild });
    await handleSubagent(interaction as never);
    expect(spawnSubagent).toHaveBeenCalledWith(session, 'worker', 'claude', channel);
  });

  it('list 在为空时提示', async () => {
    const interaction = makeInteraction({ subcommand: 'list', channel: makeTextChannel({ id: 'session-channel' }) });
    await handleSubagent(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'No active subagents for this session.' }));
  });
});

describe('shell commands', () => {
  it('run 从会话目录执行命令', async () => {
    const channel = makeTextChannel({ id: 'session-channel', parentId: 'cat-1' });
    const interaction = makeInteraction({ subcommand: 'run', values: { command: 'pwd' }, channel });
    await handleShell(interaction as never);
    expect(executeShellCommand).toHaveBeenCalledWith('pwd', '/repo', channel);
  });

  it('processes 返回进程列表', async () => {
    listProcesses.mockReturnValue([{ pid: 1, command: 'npm test', startedAt: Date.now() }]);
    const interaction = makeInteraction({ subcommand: 'processes', channel: makeTextChannel({ id: 'session-channel' }) });
    await handleShell(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('PID 1') }));
  });

  it('kill 在找到进程时返回 killed', async () => {
    killProcess.mockReturnValue(true);
    const interaction = makeInteraction({ subcommand: 'kill', values: { pid: 123 }, channel: makeTextChannel({ id: 'session-channel' }) });
    await handleShell(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Process 123 killed.', ephemeral: true }));
  });

  it('shell 关闭时拒绝执行', async () => {
    config.shellEnabled = false;
    const interaction = makeInteraction({ subcommand: 'run', values: { command: 'pwd' }, channel: makeTextChannel({ id: 'session-channel' }) });
    await handleShell(interaction as never);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('Shell execution is disabled') }));
  });
});

describe('shortcut commands', () => {
  it('spawn shortcut 复用 spawn 主路径', async () => {
    const control = makeTextChannel({ id: 'control-1', parentId: 'cat-1', name: 'control' });
    const created = makeTextChannel({ id: 'created-1', parentId: 'cat-1', name: 'claude-test' });
    const guild = makeGuild({ channels: [control], createImpl: async () => created });
    createSession.mockResolvedValue({ ...session, channelId: 'created-1', claudePermissionMode: 'normal' });
    const interaction = makeInteraction({ subcommand: 'spawn', values: { label: 'test' }, channel: control, guild });
    await handleSpawnShortcut(interaction as never);
    expect(createSession).toHaveBeenCalled();
  });

  it('stop/end/run shortcut 走对应主路径', async () => {
    const channel = makeTextChannel({ id: 'session-channel' });
    const guild = makeGuild({ channels: [channel] });
    await handleStopShortcut(makeInteraction({ subcommand: 'stop', channel }) as never);
    await handleEndShortcut(makeInteraction({ subcommand: 'end', channel, guild }) as never);
    await handleRunShortcut(makeInteraction({ subcommand: 'run', values: { label: 'worker' }, channel, guild }) as never);
    expect(abortSession).toHaveBeenCalled();
    expect(endSession).toHaveBeenCalled();
    expect(spawnSubagent).toHaveBeenCalled();
  });
});
