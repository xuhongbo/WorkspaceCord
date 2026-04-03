import { finalCta } from '../../lib/content';

export function FinalCtaSection() {
  return (
    <section className="final-cta">
      <div>
        <p className="section-eyebrow">Ready to run</p>
        <h2>{finalCta.title}</h2>
        <p>{finalCta.description}</p>
      </div>
      <div className="cta-group">
        <a className="button button-primary" href={finalCta.primary.href}>
          {finalCta.primary.label}
        </a>
        <a
          className="button button-secondary"
          href={finalCta.secondary.href}
          target="_blank"
          rel="noreferrer"
        >
          {finalCta.secondary.label}
        </a>
      </div>
    </section>
  );
}
