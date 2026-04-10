import type { ReactNode } from 'react';

type SectionShellProps = {
  id?: string;
  eyebrow?: string;
  title: string;
  description?: string;
  children: ReactNode;
  boxed?: boolean;
};

export function SectionShell({
  id,
  eyebrow,
  title,
  description,
  children,
  boxed = false,
}: SectionShellProps) {
  return (
    <section
      id={id}
      className={`mx-auto w-[min(1240px,calc(100%-40px))] ${
        boxed
          ? 'my-20 rounded-3xl border border-white/10 bg-white/[0.015] px-6 py-16 md:px-12 md:py-20'
          : 'my-24 py-6'
      }`}
    >
      <header className="mx-auto max-w-3xl text-center">
        {eyebrow ? (
          <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.2em] text-mint/80">
            {eyebrow}
          </p>
        ) : null}
        <h2 className="text-[clamp(1.9rem,3.5vw,3rem)] font-bold leading-[1.1] tracking-[-0.025em] text-white">
          {title}
        </h2>
        {description ? (
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-white/60">
            {description}
          </p>
        ) : null}
      </header>

      <div className="mt-14">{children}</div>
    </section>
  );
}
