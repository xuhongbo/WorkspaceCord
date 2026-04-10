import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import {
  getNextSceneIndex,
  remoteControlScenes,
  type ChannelTone,
  type FlowDirection,
  type PhoneMessageTone,
  type RemoteControlScene,
  type SidebarChannel,
  type TerminalLineTone,
} from '../../lib/workflow-steps';

const PHONE_TONE_CLASS: Record<PhoneMessageTone, string> = {
  thinking: 'text-discord-muted',
  tool: 'text-discord-text',
  ok: 'text-mint',
  warn: 'text-amber-300',
};

const TERMINAL_TONE_CLASS: Record<TerminalLineTone, string> = {
  cmd: 'text-white',
  info: 'text-cyan/90',
  ok: 'text-mint',
  warn: 'text-amber-300',
  muted: 'text-white/40',
};

const CHANNEL_ICON: Record<ChannelTone, string> = {
  claude: '#',
  codex: '#',
  control: '#',
  forum: '💬',
  text: '#',
};

const CHANNEL_COLOR: Record<ChannelTone, string> = {
  claude: 'text-mint/80',
  codex: 'text-violet-400',
  control: 'text-discord-muted',
  forum: 'text-amber-300/80',
  text: 'text-discord-muted',
};

export function WorkflowDemo() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (isPaused) return undefined;
    const timer = window.setInterval(() => {
      setActiveIndex((current) =>
        getNextSceneIndex(current, remoteControlScenes.length),
      );
    }, 3600);
    return () => window.clearInterval(timer);
  }, [isPaused]);

  const currentScene = useMemo(
    () => remoteControlScenes[activeIndex],
    [activeIndex],
  );

  return (
    <div
      className="remote-stage relative w-full"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      aria-label="远程遥控演示舞台"
    >
      <div className="grid grid-cols-1 lg:grid-cols-[240px_72px_minmax(0,1fr)] items-center gap-6 lg:gap-3">
        <PhonePanel scene={currentScene} />
        <FlowChannel direction={currentScene.flowDirection} />
        <TerminalPanel scene={currentScene} />
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        {remoteControlScenes.map((scene, index) => {
          const isActive = index === activeIndex;
          return (
            <button
              key={scene.id}
              type="button"
              onClick={() => {
                setActiveIndex(index);
                setIsPaused(true);
              }}
              className={`group flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-mono uppercase tracking-[0.14em] transition ${
                isActive
                  ? 'border-mint/60 bg-mint/10 text-mint shadow-glow-mint'
                  : 'border-white/10 bg-white/[0.02] text-white/50 hover:border-white/20 hover:text-white/80'
              }`}
              aria-label={`${scene.step} ${scene.label}`}
            >
              <span className="text-[0.65rem] opacity-60">{scene.step}</span>
              <span>{scene.label}</span>
            </button>
          );
        })}
      </div>

      <motion.p
        key={currentScene.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: 'easeOut' }}
        className="mt-4 text-center text-sm text-white/60"
      >
        {currentScene.caption}
      </motion.p>
    </div>
  );
}

function PhonePanel({ scene }: { scene: RemoteControlScene }) {
  return (
    <motion.section
      className="phone-frame relative mx-auto w-full max-w-[240px] rounded-[30px] border border-white/10 bg-ink-950 p-1.5 shadow-pane"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: 'easeOut' }}
    >
      {/* Phone notch */}
      <div className="pointer-events-none absolute left-1/2 top-1.5 z-10 h-4 w-20 -translate-x-1/2 rounded-b-2xl bg-black" />
      {/* Screen */}
      <div className="phone-screen relative flex h-[500px] flex-col overflow-hidden rounded-[24px] bg-ink-900">
        {/* Server header */}
        <div className="flex items-center justify-between border-b border-white/[0.04] bg-ink-800 px-3 pt-7 pb-2.5">
          <div className="flex items-center gap-1.5">
            <strong className="text-[13px] text-white">{scene.categoryName}</strong>
            <span className="text-[10px] text-white/30">›</span>
          </div>
          <span className="text-[9px] font-mono uppercase tracking-wider text-mint/70">
            live
          </span>
        </div>

        {/* Sidebar */}
        <div className="phone-sidebar border-b border-white/[0.04] px-2 py-2">
          <p className="px-2 pb-1 text-[9px] font-mono uppercase tracking-wider text-white/30">
            sessions
          </p>
          <ul className="flex flex-col gap-0.5">
            {scene.sidebar.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                active={channel.id === scene.activeChannelId}
              />
            ))}
          </ul>
        </div>

        {/* Active channel content */}
        <div className="flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={scene.id}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -12 }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
              className="flex h-full flex-col gap-2 px-3 py-3"
            >
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="text-discord-muted">#</span>
                <strong className="truncate text-discord-text">
                  {scene.activeView.title.replace(/^#\s*/, '')}
                </strong>
              </div>
              {scene.activeView.subtitle ? (
                <p className="text-[9px] font-mono uppercase tracking-wider text-white/35">
                  {scene.activeView.subtitle}
                </p>
              ) : null}

              {scene.activeView.userMessage ? (
                <div className="flex gap-1.5">
                  <div className="mt-0.5 h-5 w-5 flex-none rounded-full bg-gradient-to-br from-violet to-mint" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[9px] text-discord-muted">你</p>
                    <p className="text-[11px] leading-snug text-discord-text">
                      {scene.activeView.userMessage}
                    </p>
                  </div>
                </div>
              ) : null}

              {scene.activeView.agentLines.length > 0 ? (
                <div className="flex gap-1.5">
                  <div className="mt-0.5 h-5 w-5 flex-none rounded-full bg-gradient-to-br from-cyan to-mint" />
                  <div className="min-w-0 flex-1">
                    {scene.activeView.botName ? (
                      <p className="text-[9px] text-discord-muted">
                        {scene.activeView.botName}
                      </p>
                    ) : null}
                    <div className="mt-0.5 flex flex-col gap-0.5 font-mono text-[10px]">
                      {scene.activeView.agentLines.map((line, i) => (
                        <motion.p
                          key={`${scene.id}-${i}`}
                          initial={{ opacity: 0, x: -4 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.24, delay: 0.1 + i * 0.12 }}
                          className={PHONE_TONE_CLASS[line.tone]}
                        >
                          {line.text}
                        </motion.p>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {scene.activeView.approval ? (
                <motion.div
                  initial={{ opacity: 0, y: 4, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.32, delay: 0.35 }}
                  className="mt-1 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2"
                >
                  <p className="text-[9px] uppercase tracking-wider text-amber-300/80">
                    approve action
                  </p>
                  <p className="mt-0.5 text-[10px] text-discord-text">
                    {scene.activeView.approval.title}
                  </p>
                  <div className="mt-1.5 flex gap-1.5">
                    <button className="flex-1 rounded-md bg-mint px-2 py-1 text-[10px] font-semibold text-ink-900">
                      ✓ 批准
                    </button>
                    <button className="rounded-md border border-white/10 bg-transparent px-2 py-1 text-[10px] text-white/50">
                      拒绝
                    </button>
                  </div>
                </motion.div>
              ) : null}

              {scene.activeView.archive ? (
                <div className="mt-1 flex flex-col gap-1">
                  {scene.activeView.archive.items.map((item, i) => (
                    <motion.div
                      key={`${scene.id}-arch-${i}`}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.28, delay: 0.1 + i * 0.14 }}
                      className="rounded-md border border-amber-400/15 bg-amber-400/[0.03] px-2 py-1.5"
                    >
                      <p className="truncate text-[10px] text-discord-text">
                        # {item.name}
                      </p>
                      <p className="text-[9px] text-mint/80">{item.status}</p>
                    </motion.div>
                  ))}
                </div>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </motion.section>
  );
}

function ChannelRow({
  channel,
  active,
}: {
  channel: SidebarChannel;
  active: boolean;
}) {
  return (
    <li
      className={`flex items-center justify-between rounded-md px-2 py-1 text-[10px] transition ${
        active
          ? 'bg-white/[0.07] text-white'
          : channel.unread
          ? 'text-white/85'
          : 'text-white/40'
      }`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className={`shrink-0 text-[11px] ${CHANNEL_COLOR[channel.tone]}`}>
          {CHANNEL_ICON[channel.tone]}
        </span>
        <span className="truncate font-mono">{channel.name}</span>
      </span>
      {channel.count ? (
        <span className="ml-1 rounded-full bg-white/[0.08] px-1.5 text-[8px] text-white/50">
          {channel.count}
        </span>
      ) : channel.unread && !active ? (
        <span className="ml-1 h-1.5 w-1.5 rounded-full bg-mint" />
      ) : null}
    </li>
  );
}

function TerminalPanel({ scene }: { scene: RemoteControlScene }) {
  return (
    <motion.section
      className="terminal-frame relative w-full overflow-hidden rounded-2xl border border-white/10 bg-ink-900 shadow-pane"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: 'easeOut', delay: 0.1 }}
    >
      {/* Title bar */}
      <div className="flex items-center gap-3 border-b border-white/5 bg-ink-800 px-4 py-2.5">
        <div className="flex gap-1.5">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="font-mono text-[11px] text-white/60">{scene.terminal.title}</span>
      </div>
      {/* Body */}
      <div className="min-h-[460px] px-5 py-4 font-mono text-[12px] leading-relaxed">
        <p className="text-white/35">~/projects · workspacecord daemon</p>
        <AnimatePresence mode="wait">
          <motion.div
            key={scene.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="mt-2 flex flex-col gap-1"
          >
            {scene.terminal.lines.map((line, i) => (
              <motion.p
                key={`${scene.id}-${i}`}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.28, delay: i * 0.16 }}
                className={TERMINAL_TONE_CLASS[line.tone]}
              >
                {line.text}
              </motion.p>
            ))}
            {scene.terminal.cursorOn ? (
              <p className="text-mint">
                <span className="typing-cursor" />
              </p>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

function FlowChannel({ direction }: { direction: FlowDirection }) {
  const animClass = direction === 'forward' ? 'animate-flow-forward' : 'animate-flow-backward';
  return (
    <div className="flow-channel relative flex h-16 items-center justify-center lg:h-[300px] lg:w-18">
      {/* Background line */}
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-gradient-to-r from-violet/20 via-mint/30 to-cyan/20 lg:inset-y-0 lg:left-1/2 lg:top-0 lg:h-full lg:w-px lg:bg-gradient-to-b" />
      {/* Labels */}
      <div className="pointer-events-none absolute inset-x-0 flex justify-between px-1 text-[10px] font-mono uppercase tracking-[0.18em] text-white/30 lg:hidden">
        <span>你</span>
        <span>→</span>
        <span>家里</span>
      </div>
      <div className="pointer-events-none absolute inset-y-0 hidden flex-col items-center justify-between py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-white/30 lg:flex">
        <span>你</span>
        <span className="rotate-90">→</span>
        <span>家里</span>
      </div>
      {/* Particles */}
      {[0, 0.5, 1.0].map((delay, i) => (
        <span
          key={i}
          className={`flow-particle ${animClass}`}
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  );
}
