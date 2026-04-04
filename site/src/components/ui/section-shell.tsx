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
  boxed,
}: SectionShellProps) {
  return (
    <section id={id} className={`section-shell${boxed ? ' has-box' : ''}`}>
      <div className="section-copy">
        {eyebrow ? <p className="section-eyebrow">{eyebrow}</p> : null}
        <h2 className="section-title">{title}</h2>
        {description ? <p className="section-description">{description}</p> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}
