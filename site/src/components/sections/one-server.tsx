import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import {
  oneServerContent,
  type OneServerMessage,
  type OneServerScene,
} from '../../lib/content';

const CHANNEL_COLOR: Record<string, string> = {
  control: 'text-discord-muted',
  claude: 'text-mint/85',
  codex: 'text-violet-400',
  forum: 'text-amber-300/80',
};

const STATUS_DOT: Record<string, string> = {
  running: 'bg-mint animate-pulse-soft',
  streaming: 'bg-cyan animate-pulse-soft',
  awaiting: 'bg-amber-400',
};

const MESSAGE_TONE: Record<string, string> = {
  user: 'text-[13px] text-discord-text',
  'agent-thinking': 'font-mono text-[12px] text-white/55',
  'agent-tool': 'font-mono text-[12px] text-discord-text',
  'agent-ok': 'font-mono text-[12px] text-mint',
  'agent-warn': 'font-mono text-[12px] text-amber-300',
};

const SCENE_DURATION_MS = 5400;

export function OneServerSection() {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
    if (isPaused) return undefined;
    const timer = window.setInterval(() => {
      setSceneIndex((current) => (current + 1) % oneServerContent.scenes.length);
    }, SCENE_DURATION_MS);
    return () => window.clearInterval(timer);
  }, [isPaused]);

  const scene = useMemo<OneServerScene>(
    () => oneServerContent.scenes[sceneIndex],
    [sceneIndex],
  );

  const activeCategoryId = scene.activeCategoryId;
  const activeChannelId = scene.activeChannelId;

  return (
    <section
      id="one-server"
      className="mx-auto my-28 w-[min(1280px,calc(100%-40px))]"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <header className="mx-auto max-w-3xl text-center">
        <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.2em] text-mint/80">
          {oneServerContent.eyebrow}
        </p>
        <h2 className="text-[clamp(1.9rem,3.5vw,3rem)] font-bold leading-[1.1] tracking-[-0.025em] text-white">
          {oneServerContent.title}
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-white/60">
          {oneServerContent.description}
        </p>
      </header>

      <div className="mt-14 overflow-hidden rounded-2xl border border-white/10 bg-ink-900 shadow-pane">
        {/* Discord-style title bar */}
        <div className="flex items-center gap-3 border-b border-white/5 bg-ink-800 px-5 py-3">
          <div className="flex gap-1.5">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          </div>
          <span className="font-mono text-[12px] text-white/60">
            Discord · server: {oneServerContent.serverName}
          </span>
          <span className="ml-auto flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-mint/70">
            <span className="h-1.5 w-1.5 rounded-full bg-mint animate-pulse-soft" />
            live
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr]">
          {/* Sidebar */}
          <aside className="border-b border-white/5 bg-discord-sidebar px-3 py-4 lg:border-b-0 lg:border-r">
            <div className="mb-3 flex items-center gap-2 border-b border-white/[0.06] px-2 pb-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet to-mint text-sm font-bold text-ink-900">
                {oneServerContent.serverName[0].toUpperCase()}
              </div>
              <div className="flex-1">
                <strong className="block text-[13px] text-white">
                  {oneServerContent.serverName}
                </strong>
                <span className="text-[10px] text-white/40">
                  {oneServerContent.categories.length} projects ·{' '}
                  {oneServerContent.categories.reduce(
                    (acc, cat) =>
                      acc +
                      cat.channels.filter((ch) => 'status' in ch && ch.status).length,
                    0,
                  )}{' '}
                  sessions live
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              {oneServerContent.categories.map((category) => {
                const isActiveCategory = category.id === activeCategoryId;
                return (
                  <div
                    key={category.id}
                    className={`transition-opacity ${
                      isActiveCategory ? 'opacity-100' : 'opacity-60'
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-1 px-1">
                      <span className="text-[10px] text-white/30">▾</span>
                      <p
                        className={`text-[10px] font-mono uppercase tracking-wider ${
                          isActiveCategory ? 'text-white/70' : 'text-white/40'
                        }`}
                      >
                        {category.name}
                      </p>
                    </div>
                    <p className="mb-1.5 px-3 text-[9px] text-white/25">
                      {category.description}
                    </p>
                    <ul className="flex flex-col gap-0.5">
                      {category.channels.map((channel) => {
                        const isActive = channel.id === activeChannelId;
                        const status =
                          'status' in channel ? channel.status : undefined;
                        return (
                          <li
                            key={channel.id}
                            className={`relative flex items-center justify-between rounded-md px-2 py-1.5 text-[11px] transition ${
                              isActive
                                ? 'bg-white/[0.08] text-white'
                                : 'text-white/55'
                            }`}
                          >
                            {isActive ? (
                              <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-mint" />
                            ) : null}
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span
                                className={`shrink-0 ${CHANNEL_COLOR[channel.tone] ?? ''}`}
                              >
                                {channel.tone === 'forum' ? '💬' : '#'}
                              </span>
                              <span className="truncate font-mono">
                                {channel.name}
                              </span>
                            </span>
                            {status ? (
                              <span
                                className={`ml-2 h-1.5 w-1.5 shrink-0 rounded-full ${
                                  STATUS_DOT[status] ?? 'bg-white/40'
                                }`}
                                title={status}
                              />
                            ) : 'count' in channel && channel.count ? (
                              <span className="ml-2 rounded-full bg-white/[0.08] px-1.5 text-[9px] text-white/40">
                                {channel.count}
                              </span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </aside>

          {/* Active channel content */}
          <div className="flex min-h-[520px] flex-col bg-discord-bg">
            {/* Channel header */}
            <div className="flex items-center gap-2 border-b border-white/5 px-5 py-3">
              <span className="text-discord-muted text-lg">#</span>
              <strong className="text-discord-text">{scene.channelTitle}</strong>
              <span className="ml-3 max-w-md truncate font-mono text-[11px] text-white/35">
                {scene.subtitle}
              </span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-mint/70">
                {scene.isControl ? 'control room' : 'session'}
              </span>
            </div>

            <div className="relative flex-1 overflow-hidden">
              <AnimatePresence mode="wait">
                <motion.div
                  key={scene.id}
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.42, ease: 'easeOut' }}
                  className="flex h-full flex-col gap-4 px-5 py-5"
                >
                  {/* Welcome banner */}
                  {scene.welcomeBanner ? (
                    <motion.div
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.35 }}
                      className="rounded-lg border border-white/5 bg-white/[0.02] px-4 py-3"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="text-2xl text-discord-muted">#</span>
                        <p className="text-[13px] text-discord-text">
                          欢迎来到{' '}
                          <strong className="text-white">
                            #{scene.welcomeBanner.channelName}
                          </strong>
                          ！
                        </p>
                      </div>
                      <p className="mt-1 pl-7 text-[11px] text-white/40">
                        这是 <span className="text-mint/80">{scene.welcomeBanner.provider}</span>{' '}
                        session 的起点 · {scene.welcomeBanner.description}
                      </p>
                    </motion.div>
                  ) : null}

                  {/* Messages */}
                  <div className="flex flex-col gap-3">
                    {scene.messages.map((msg, i) => (
                      <MessageBubble key={`${scene.id}-${i}`} message={msg} index={i} />
                    ))}
                  </div>

                  {/* Footer hint */}
                  {scene.footer ? (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3, delay: 0.1 + scene.messages.length * 0.22 }}
                      className="mt-auto rounded-lg border border-mint/15 bg-mint/[0.04] px-4 py-3 font-mono text-[11px] text-mint/75"
                    >
                      → {scene.footer}
                    </motion.div>
                  ) : null}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Scene timeline */}
        <div className="flex items-center justify-center gap-2 border-t border-white/5 bg-ink-800 px-4 py-3">
          {oneServerContent.scenes.map((s, i) => {
            const isActive = i === sceneIndex;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSceneIndex(i)}
                className={`group flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-mono uppercase tracking-wider transition ${
                  isActive
                    ? 'border-mint/60 bg-mint/10 text-mint'
                    : 'border-white/10 bg-transparent text-white/40 hover:border-white/20 hover:text-white/70'
                }`}
              >
                <span className="opacity-50">0{i + 1}</span>
                <span>{s.isControl ? 'spawn' : 'use'}</span>
                <span className="opacity-60">·</span>
                <span>{s.activeCategoryId}</span>
              </button>
            );
          })}
        </div>
      </div>

      <p className="mt-6 text-center text-sm text-white/40">{oneServerContent.footnote}</p>
    </section>
  );
}

function MessageBubble({
  message,
  index,
}: {
  message: OneServerMessage;
  index: number;
}) {
  const delay = 0.15 + index * 0.22;

  if (message.kind === 'agent-card' && message.card) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay }}
        className="flex gap-3"
      >
        <div className="mt-0.5 h-8 w-8 flex-none rounded-full bg-gradient-to-br from-cyan to-mint" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-discord-muted">{message.author}</p>
          <div
            className={`mt-1 rounded-lg border px-4 py-3 ${
              message.card.provider === 'Claude'
                ? 'border-mint/30 bg-mint/[0.05]'
                : 'border-violet/30 bg-violet/[0.05]'
            }`}
          >
            <p className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-white">
              <span
                className={
                  message.card.provider === 'Claude' ? 'text-mint' : 'text-violet-400'
                }
              >
                ✦
              </span>
              {message.card.title}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
              {message.card.fields.map((f) => (
                <div key={f.key} className="contents">
                  <dt className="text-white/35">{f.key}</dt>
                  <dd
                    className={
                      f.accent === 'claude'
                        ? 'text-mint'
                        : f.accent === 'codex'
                        ? 'text-violet-300'
                        : 'text-white/80'
                    }
                  >
                    {f.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </motion.div>
    );
  }

  if (message.kind === 'user') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, delay }}
        className="flex gap-3"
      >
        <div className="mt-0.5 h-8 w-8 flex-none rounded-full bg-gradient-to-br from-violet to-mint" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-discord-muted">{message.author}</p>
          <p className={`mt-0.5 ${MESSAGE_TONE[message.kind]}`}>{message.text}</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.28, delay }}
      className="flex gap-3"
    >
      <div className="mt-0.5 h-8 w-8 flex-none rounded-full bg-gradient-to-br from-cyan to-mint" />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-discord-muted">{message.author}</p>
        <p className={`mt-0.5 ${MESSAGE_TONE[message.kind]}`}>{message.text}</p>
      </div>
    </motion.div>
  );
}
