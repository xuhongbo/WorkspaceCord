import { finalCtaContent } from '../../lib/content';

export function FinalCtaSection() {
  return (
    <section className="mx-auto my-32 w-[min(1240px,calc(100%-40px))] overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-ink-800 via-ink-900 to-ink-950 px-8 py-24 text-center md:px-16 md:py-32">
      <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-mint/80">
        {finalCtaContent.eyebrow}
      </p>
      <h2 className="mx-auto mt-5 max-w-3xl text-[clamp(2.2rem,4.5vw,4rem)] font-bold leading-[1.05] tracking-[-0.035em] text-white">
        <span className="block">{finalCtaContent.title}</span>
        <span className="block bg-gradient-to-r from-mint via-mint-400 to-cyan bg-clip-text text-transparent">
          {finalCtaContent.titleAccent}
        </span>
      </h2>
      <p className="mx-auto mt-5 max-w-xl text-base text-white/60">
        {finalCtaContent.description}
      </p>
      <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
        <a
          href={finalCtaContent.primary.href}
          className="inline-flex h-12 items-center justify-center rounded-full bg-mint px-7 font-semibold text-ink-900 shadow-glow-mint-lg transition hover:-translate-y-0.5 hover:bg-mint-400"
        >
          {finalCtaContent.primary.label}
        </a>
        <a
          href={finalCtaContent.secondary.href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-12 items-center justify-center rounded-full border border-white/15 px-7 font-medium text-white/90 transition hover:border-mint/40"
        >
          {finalCtaContent.secondary.label}
        </a>
      </div>
    </section>
  );
}
