export type FlowDirection = 'forward' | 'backward';

export type ChannelTone = 'claude' | 'codex' | 'control' | 'forum' | 'text';

export type SidebarChannel = {
  id: string;
  name: string;
  tone: ChannelTone;
  unread?: boolean;
  count?: number;
};

export type PhoneMessageTone = 'thinking' | 'tool' | 'ok' | 'warn';
export type TerminalLineTone = 'cmd' | 'info' | 'ok' | 'warn' | 'muted';

export type ActiveChannelView = {
  title: string;
  subtitle?: string;
  userMessage?: string;
  botName?: string;
  agentLines: Array<{ text: string; tone: PhoneMessageTone }>;
  approval?: {
    title: string;
  };
  archive?: {
    items: Array<{ name: string; status: string }>;
  };
};

export type TerminalMock = {
  title: string;
  lines: Array<{ text: string; tone: TerminalLineTone }>;
  cursorOn: boolean;
};

export type RemoteControlScene = {
  id: 'send' | 'parallel' | 'approve' | 'archive';
  step: string;
  label: string;
  caption: string;
  flowDirection: FlowDirection;
  categoryName: string;
  sidebar: SidebarChannel[];
  activeChannelId: string;
  activeView: ActiveChannelView;
  terminal: TerminalMock;
};

/**
 * Base sidebar layout reused across scenes. The `tone` maps to the color accent
 * (claude=mint, codex=violet, control=muted, forum=amber).
 */
const baseSidebar: SidebarChannel[] = [
  { id: 'control', name: 'control', tone: 'control' },
  { id: 'history', name: 'history', tone: 'forum', count: 40 },
  { id: 'fix-auth-bug', name: 'claude-fix-auth-bug', tone: 'claude' },
  { id: 'refactor-payment', name: 'claude-refactor-payment', tone: 'claude' },
  { id: 'codex-test', name: 'codex-test', tone: 'codex' },
  { id: 'codex-perf', name: 'codex-perf-benchmark', tone: 'codex' },
];

function withUnread(channelId: string, extra?: Partial<Record<string, boolean>>): SidebarChannel[] {
  return baseSidebar.map((ch) => ({
    ...ch,
    unread: ch.id === channelId || Boolean(extra?.[ch.id]),
  }));
}

export const remoteControlScenes: RemoteControlScene[] = [
  {
    id: 'send',
    step: '01',
    label: 'SEND',
    caption: '在任一频道发消息，就是一条新 prompt',
    flowDirection: 'forward',
    categoryName: 'coding',
    sidebar: withUnread('fix-auth-bug'),
    activeChannelId: 'fix-auth-bug',
    activeView: {
      title: 'claude-fix-auth-bug',
      subtitle: 'claude · session running',
      userMessage: '帮我修下 auth 中间件的 401 bug',
      botName: 'workspacecord · bot',
      agentLines: [
        { text: '🧠 thinking...', tone: 'thinking' },
        { text: '🔧 reading src/auth.ts', tone: 'tool' },
      ],
    },
    terminal: {
      title: 'coding · 2 sessions running',
      lines: [
        { text: '[fix-auth-bug]    claude · reading src/auth.ts', tone: 'ok' },
        { text: '[refactor-payment] claude · (idle)', tone: 'muted' },
        { text: '[codex-test]     codex · (idle)', tone: 'muted' },
      ],
      cursorOn: true,
    },
  },
  {
    id: 'parallel',
    step: '02',
    label: 'PARALLEL',
    caption: '滑到另一个频道，另一个 session 已经在跑',
    flowDirection: 'forward',
    categoryName: 'coding',
    sidebar: withUnread('refactor-payment', { 'fix-auth-bug': true }),
    activeChannelId: 'refactor-payment',
    activeView: {
      title: 'claude-refactor-payment',
      subtitle: 'claude · streaming',
      botName: 'workspacecord · bot',
      agentLines: [
        { text: '🔧 editing src/payment/charge.ts', tone: 'tool' },
        { text: '🔧 editing src/payment/refund.ts', tone: 'tool' },
        { text: '🧠 extracting shared types', tone: 'thinking' },
      ],
    },
    terminal: {
      title: 'coding · 3 sessions running',
      lines: [
        { text: '[fix-auth-bug]    claude · running npm test', tone: 'ok' },
        { text: '[refactor-payment] claude · editing charge.ts', tone: 'ok' },
        { text: '[codex-test]     codex · reviewing diff', tone: 'info' },
      ],
      cursorOn: true,
    },
  },
  {
    id: 'approve',
    step: '03',
    label: 'APPROVE',
    caption: '哪个 session 要批准，哪个频道弹审批卡',
    flowDirection: 'backward',
    categoryName: 'coding',
    sidebar: withUnread('fix-auth-bug', { 'refactor-payment': true, 'codex-test': true }),
    activeChannelId: 'fix-auth-bug',
    activeView: {
      title: 'claude-fix-auth-bug',
      subtitle: '⚠ awaiting approval',
      botName: 'workspacecord · bot',
      agentLines: [{ text: '⚠ write src/middleware.ts?', tone: 'warn' }],
      approval: {
        title: '写入 src/middleware.ts',
      },
    },
    terminal: {
      title: 'coding · 3 sessions running',
      lines: [
        { text: '[fix-auth-bug]    🔐 awaiting approval...', tone: 'warn' },
        { text: '[refactor-payment] claude · streaming edits', tone: 'ok' },
        { text: '[codex-test]     codex · 2 tests passed', tone: 'ok' },
      ],
      cursorOn: false,
    },
  },
  {
    id: 'archive',
    step: '04',
    label: 'ARCHIVE',
    caption: '/agent archive 后，自动进 #history forum',
    flowDirection: 'forward',
    categoryName: 'coding',
    sidebar: withUnread('history'),
    activeChannelId: 'history',
    activeView: {
      title: '# history (forum)',
      subtitle: '40 archived sessions',
      botName: '',
      agentLines: [],
      archive: {
        items: [
          { name: 'claude-fix-auth-bug', status: '✓ 3 tests passed' },
          { name: 'claude-refactor-payment', status: '✓ 2 files, 1 commit' },
          { name: 'codex-perf-benchmark', status: '✓ p95 -34%' },
        ],
      },
    },
    terminal: {
      title: 'coding · 2 sessions running',
      lines: [
        { text: '✓ archived: claude-fix-auth-bug', tone: 'ok' },
        { text: '[refactor-payment] claude · streaming', tone: 'info' },
        { text: '[codex-test]     codex · reviewing', tone: 'info' },
      ],
      cursorOn: true,
    },
  },
];

export function getNextSceneIndex(current: number, total: number): number {
  return (current + 1) % total;
}
