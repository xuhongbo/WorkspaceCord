import { Fragment } from 'react';
import { problemContent } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function TheProblemSection() {
  return (
    <SectionShell
      id="the-problem"
      eyebrow={problemContent.eyebrow}
      title={problemContent.title}
      description={problemContent.description}
      boxed
    >
      <div className="flex flex-col items-stretch gap-6 lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center lg:gap-8">
        {problemContent.compareCards.map((card, index) => (
          <Fragment key={card.brand}>
            <article
              className={`rounded-2xl border p-6 transition ${
                card.tone === 'warm'
                  ? 'border-amber-300/20 bg-amber-300/[0.03]'
                  : 'border-cyan/20 bg-cyan/[0.03]'
              }`}
            >
              <p
                className={`font-mono text-[11px] uppercase tracking-[0.18em] ${
                  card.tone === 'warm' ? 'text-amber-200/80' : 'text-cyan/80'
                }`}
              >
                {card.verdict}
              </p>
              <h3 className="mt-2 text-2xl font-bold text-white">{card.brand}</h3>
              <p className="mt-3 text-lg font-semibold text-white/85">{card.pain}</p>
              <p className="mt-2 text-sm leading-relaxed text-white/55">{card.detail}</p>
            </article>
            {index === 0 ? (
              <div className="flex items-center justify-center text-3xl text-mint/60 lg:text-4xl">
                <span className="hidden lg:inline">→</span>
                <span className="lg:hidden">↓</span>
              </div>
            ) : null}
          </Fragment>
        ))}
      </div>

      <div className="mt-12 rounded-2xl border border-mint/30 bg-gradient-to-br from-mint/[0.08] via-mint/[0.04] to-cyan/[0.05] p-8 shadow-glow-mint">
        <div className="flex flex-col gap-4 text-center md:flex-row md:items-center md:justify-between md:text-left md:gap-8">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-mint">
              → {problemContent.bridge.brand}
            </p>
            <h3 className="mt-2 text-2xl font-bold text-white md:text-3xl">
              {problemContent.bridge.headline}
            </h3>
          </div>
          <p className="max-w-lg text-sm leading-relaxed text-white/70">
            {problemContent.bridge.detail}
          </p>
        </div>
      </div>
    </SectionShell>
  );
}
