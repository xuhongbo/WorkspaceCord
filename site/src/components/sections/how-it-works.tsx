import { howItWorksContent } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function HowItWorksSection() {
  return (
    <SectionShell
      id="how-it-works"
      eyebrow={howItWorksContent.eyebrow}
      title={howItWorksContent.title}
      description={howItWorksContent.description}
    >
      <div className="flex flex-col gap-16">
        {howItWorksContent.phases.map((phase) => (
          <article
            key={phase.id}
            className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-12"
          >
            {/* Left: copy + terminal */}
            <div>
              <div className="flex items-center gap-3">
                <span className="font-mono text-3xl font-bold text-mint/40">{phase.step}</span>
                <div>
                  <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-mint">
                    {phase.badge}
                  </p>
                  <p className="text-xs text-white/40">{phase.location}</p>
                </div>
              </div>
              <h3 className="mt-5 text-2xl font-bold leading-tight text-white md:text-3xl">
                {phase.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-white/60">{phase.detail}</p>

              <div className="mt-6 overflow-hidden rounded-xl border border-white/10 bg-ink-900">
                <div className="border-b border-white/5 bg-ink-800 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
                  terminal
                </div>
                <div className="flex flex-col gap-2 px-4 py-4 font-mono text-[12.5px]">
                  {phase.commands.map((line, i) => (
                    <div key={i} className="flex flex-col gap-0.5">
                      <div className="flex items-start gap-2 text-white/90">
                        <span className="text-mint/70">$</span>
                        <span className="break-all">{line.cmd}</span>
                      </div>
                      <p className="pl-4 text-[11px] text-white/35">{line.note}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: discord mock */}
            <div className="overflow-hidden rounded-xl border border-white/10 bg-discord-bg shadow-pane">
              <div className="flex items-center gap-2 border-b border-white/5 bg-discord-sidebar px-4 py-3">
                <span className="font-mono text-sm text-discord-muted">#</span>
                <strong className="text-discord-text">
                  {phase.discord.title.replace(/^#/, '')}
                </strong>
                <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-mint/70">
                  live
                </span>
              </div>
              <div className="min-h-[200px] px-5 py-5">
                <div className="flex flex-col gap-1.5 font-mono text-[12.5px] text-discord-text">
                  {phase.discord.lines.map((line, i) => (
                    <p key={i} className="break-words">
                      {line}
                    </p>
                  ))}
                </div>
                <p className="mt-5 border-t border-white/5 pt-3 text-xs text-white/40">
                  {phase.discord.note}
                </p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </SectionShell>
  );
}
