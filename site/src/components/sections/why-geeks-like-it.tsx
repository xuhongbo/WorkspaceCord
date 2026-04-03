import { reasons } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function WhyGeeksLikeItSection() {
  return (
    <SectionShell
      eyebrow="Why geeks like it"
      title="为讲究工作流的人而做"
      description="它不是另一层抽象，而是把你熟悉的终端、线程、状态和归档组织成更明确的控制面。"
    >
      <div className="reasons-grid">
        {reasons.map((reason, index) => (
          <article
            key={reason.title}
            className="reason-item"
            data-offset={index % 2 === 0 ? 'start' : 'end'}
          >
            <span>{reason.title}</span>
            <p>{reason.body}</p>
          </article>
        ))}
      </div>
    </SectionShell>
  );
}
