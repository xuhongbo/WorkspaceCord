import { capabilitiesContent } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

const SIZE_CLASS: Record<string, string> = {
  large: 'md:col-span-2 md:row-span-2',
  medium: 'md:col-span-1 md:row-span-2',
  small: 'md:col-span-1 md:row-span-1',
};

export function WhyGeeksLikeItSection() {
  return (
    <SectionShell
      eyebrow={capabilitiesContent.eyebrow}
      title={capabilitiesContent.title}
      description={capabilitiesContent.description}
    >
      <div className="grid grid-cols-1 gap-4 md:auto-rows-[minmax(140px,auto)] md:grid-cols-3">
        {capabilitiesContent.items.map((item) => (
          <article
            key={item.id}
            className={`group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.015] p-6 transition hover:border-mint/30 hover:bg-white/[0.025] ${
              SIZE_CLASS[item.size] ?? ''
            }`}
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-mint/70">
              {item.tag}
            </p>
            <h3
              className={`mt-3 font-bold leading-tight text-white ${
                item.size === 'large' ? 'text-2xl md:text-3xl' : 'text-lg md:text-xl'
              }`}
            >
              {item.title}
            </h3>
            <p
              className={`mt-3 leading-relaxed text-white/55 ${
                item.size === 'large' ? 'text-base' : 'text-sm'
              }`}
            >
              {item.body}
            </p>
            <div className="pointer-events-none absolute -right-20 -top-20 h-40 w-40 rounded-full bg-mint/5 opacity-0 blur-3xl transition group-hover:opacity-100" />
          </article>
        ))}
      </div>
    </SectionShell>
  );
}
