import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import {
  getNextWorkflowIndex,
  workflowSteps,
} from '../../lib/workflow-steps';

function getWindowVariant(windowState: string) {
  if (windowState === 'foreground') {
    return { opacity: 1, scale: 1, x: 0, y: 0 };
  }

  if (windowState === 'background') {
    return { opacity: 0.56, scale: 0.9, x: -48, y: 26 };
  }

  if (windowState === 'docked') {
    return { opacity: 0.32, scale: 0.54, x: -126, y: 170 };
  }

  return { opacity: 0, scale: 0.82, x: 0, y: 18 };
}

export function WorkflowDemo() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useEffect(() => {
    if (hoveredIndex !== null) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setActiveIndex((current) =>
        getNextWorkflowIndex(current, workflowSteps.length),
      );
    }, 2400);

    return () => window.clearInterval(timer);
  }, [hoveredIndex]);

  const currentStep = useMemo(
    () => workflowSteps[hoveredIndex ?? activeIndex],
    [activeIndex, hoveredIndex],
  );

  const { scene } = currentStep;
  const discordVisible = scene.discord.windowState !== 'hidden';
  const sessionVisible = Boolean(scene.discord.mainSession);

  return (
    <div className="workflow-shell">
      <motion.div
        className="workflow-panel workflow-cinematic"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
      >
        <div className="workflow-panel-header">
          <span>cinematic workflow</span>
          <div className="status-pill">
            <i />
            {currentStep.status}
          </div>
        </div>

        <div
          className={`desktop-stage is-${scene.desktopFocus}`}
          aria-label="桌面演示舞台"
        >
          <div className="desktop-glow desktop-glow-left" aria-hidden="true" />
          <div className="desktop-glow desktop-glow-right" aria-hidden="true" />

          <motion.section
            className={`window-frame terminal-window is-${scene.terminal.windowState}`}
            animate={getWindowVariant(scene.terminal.windowState)}
            transition={{ duration: 0.42, ease: 'easeOut' }}
          >
            <div className="window-chrome">
              <div className="window-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <strong>{scene.terminal.title}</strong>
            </div>
            <div className="terminal-log cinematic-terminal-log">
              {scene.terminal.lines.map((line) => (
                <p key={line} className={line.startsWith('•') || line.startsWith('✓') ? 'is-success' : ''}>
                  {line}
                </p>
              ))}
            </div>
          </motion.section>

          <AnimatePresence initial={false}>
            {discordVisible ? (
              <motion.section
                key="discord-window"
                className="window-frame discord-window"
                initial={{ opacity: 0, scale: 0.92, x: 34, y: 24 }}
                animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, x: 22, y: 12 }}
                transition={{ duration: 0.42, ease: 'easeOut' }}
              >
                <div className="window-chrome discord-chrome">
                  <div className="window-dots" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <strong>Discord</strong>
                  <small>server live</small>
                </div>

                <div className="discord-layout">
                  <aside className="discord-rail">
                    <span className="discord-rail-mark">W</span>
                    <span className="discord-rail-dot" />
                    <span className="discord-rail-dot" />
                  </aside>

                  <aside className="discord-sidebar">
                    <div className="discord-sidebar-group">
                      <p className="discord-sidebar-label">服务器</p>
                      <strong>{scene.discord.serverName}</strong>
                    </div>

                    <div className="discord-sidebar-group">
                      <p className="discord-sidebar-label">分类 = 项目</p>
                      <ul className="project-tree cinematic-project-tree">
                        {scene.discord.categories.map((project) => (
                          <li
                            key={project.id}
                            className={`project-row is-${project.state}`}
                          >
                            <div>
                              <strong>{project.categoryLabel ?? project.name}</strong>
                              <small>{project.name}</small>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="discord-sidebar-group history-channel-group">
                      <p className="discord-sidebar-label">频道</p>
                      <div
                        className={`history-channel ${
                          scene.discord.history.highlighted ? 'is-highlighted' : ''
                        }`}
                      >
                        {scene.discord.history.channel}
                      </div>
                    </div>
                  </aside>

                  <section className="discord-main">
                    <header className="discord-main-header">
                      <div>
                        <strong>{sessionVisible ? '项目会话' : '映射总览'}</strong>
                        <p>
                          {sessionVisible
                            ? '单项目继续展开主会话与线程'
                            : '一个服务器承载多个本地项目'}
                        </p>
                      </div>
                      <span className="discord-main-badge">已连接</span>
                    </header>

                    {sessionVisible && scene.discord.mainSession ? (
                      <div className="session-stage">
                        <div className={`session-root is-${scene.discord.mainSession.state}`}>
                          <strong>{scene.discord.mainSession.title}</strong>
                          <em>{scene.discord.mainSession.state}</em>
                        </div>
                        <ul className="thread-list cinematic-thread-list">
                          {scene.discord.threads.map((thread) => (
                            <li key={thread.id} className={`is-${thread.state}`}>
                              <span>{thread.title}</span>
                              <em>{thread.state}</em>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <div className="project-stage-placeholder">
                        <div className="placeholder-flow-line" aria-hidden="true" />
                        <p>项目从本地挂载完成后，统一进入 Discord 服务器总览。</p>
                      </div>
                    )}

                    <div className="discord-chat">
                      {scene.discord.messages.map((message) => (
                        <div key={message.id} className={`discord-message is-${message.tone}`}>
                          <span className="discord-message-author">{message.author}</span>
                          <p>{message.body}</p>
                        </div>
                      ))}
                    </div>

                    <AnimatePresence initial={false}>
                      {scene.discord.history.summary ? (
                        <motion.div
                          className="history-summary"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 6 }}
                          transition={{ duration: 0.25, ease: 'easeOut' }}
                        >
                          <span>history sync</span>
                          <p>{scene.discord.history.summary}</p>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </section>
                </div>
              </motion.section>
            ) : null}
          </AnimatePresence>

          <motion.div
            className={`dock-stage is-${scene.dock.presentation}`}
            animate={
              scene.dock.presentation === 'handoff'
                ? { y: -18, scale: 1.04, opacity: 1 }
                : { y: 0, scale: 0.94, opacity: 0.7 }
            }
            transition={{ duration: 0.32, ease: 'easeOut' }}
          >
            <p>Dock</p>
            <div className="dock-bar">
              {scene.dock.apps.map((app) => (
                <div key={app.id} className={`dock-app is-${app.state}`}>
                  <span aria-hidden="true">{app.id === 'terminal' ? '⌘' : '◎'}</span>
                  <small className="dock-app-label">{app.label}</small>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </motion.div>

      <div className="workflow-timeline" aria-label="分镜时间轴">
        <div className="workflow-timeline-line" aria-hidden="true" />
        {workflowSteps.map((step, index) => {
          const isActive = currentStep.id === step.id;
          const handlePreview = () => {
            setActiveIndex(index);
            setHoveredIndex(index);
          };

          return (
            <button
              key={step.id}
              aria-label={`${step.shortLabel} ${step.title}`}
              className={`timeline-stop ${isActive ? 'is-active' : ''}`}
              onMouseEnter={handlePreview}
              onMouseLeave={() => setHoveredIndex(null)}
              onFocus={handlePreview}
              onBlur={() => setHoveredIndex(null)}
              type="button"
            >
              <span className="timeline-stop-index">{step.shortLabel}</span>
              <span className="timeline-stop-dot" aria-hidden="true" />
              <span className="timeline-stop-title">{step.title}</span>
            </button>
          );
        })}
      </div>

      <div className="workflow-caption workflow-caption-cinematic">
        <p className="section-eyebrow">当前分镜</p>
        <h3>{currentStep.title}</h3>
        <p>{currentStep.body}</p>
      </div>
    </div>
  );
}
