import { problemCards } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function TheProblemSection() {
  return (
    <SectionShell
      id="the-problem"
      eyebrow="The Problem"
      title="远程协作，不该这么难"
      description="现有的 AI 编码工具要么本地受限，要么远程要付费，要么没有统一工作台。"
      boxed
    >
      <div className="problem-grid">
        {problemCards.map((card) => (
          <article key={card.terminal} className="problem-card">
            <code>{card.terminal}</code>
            <p>{card.body}</p>
          </article>
        ))}
      </div>
    </SectionShell>
  );
}
