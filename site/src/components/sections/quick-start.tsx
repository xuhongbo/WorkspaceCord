import { quickStartContent } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function QuickStartSection() {
  return (
    <SectionShell
      id="quick-start"
      eyebrow={quickStartContent.eyebrow}
      title={quickStartContent.title}
      description={quickStartContent.description}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-stretch md:gap-6">
        {quickStartContent.steps.map((step) => (
          <div
            key={step.step}
            className="flex flex-1 flex-col gap-3 rounded-xl border border-white/10 bg-ink-800/70 p-5"
          >
            <div className="flex items-center gap-3">
              <span className="font-mono text-xl font-bold text-mint/50">{step.step}</span>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
                {step.label}
              </span>
            </div>
            <code className="block rounded-md bg-ink-900 px-3 py-2 font-mono text-sm text-white/90">
              $ {step.command}
            </code>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
