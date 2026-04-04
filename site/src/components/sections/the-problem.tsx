import { problemCards } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function TheProblemSection() {
  return (
    <SectionShell
      id="the-problem"
      eyebrow="The Problem"
      title="你的一天是这样的"
      description="终端塞满窗口，Discord 消息乱飞，上下文在切换中丢失。"
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
