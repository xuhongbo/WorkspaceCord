import { finalCta } from '../../lib/content';

export function FinalCtaSection() {
  return (
    <section className="final-cta">
      <div>
        <p className="section-eyebrow">Ready to run</p>
        <h2>{finalCta.title}</h2>
        <p>{finalCta.description}</p>
      </div>
      <a className="button button-primary" href={finalCta.primary.href}>
        {finalCta.primary.label}
      </a>
    </section>
  );
}
