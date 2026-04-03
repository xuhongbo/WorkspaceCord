import { howItWorksSteps } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function HowItWorksSection() {
  return (
    <SectionShell
      id="how-it-works"
      eyebrow="How it works"
      title="从频道到线程，把开发流程接进 Discord"
      description="不是把机器人塞进聊天窗口，而是把整个多智能体工作流映射成你熟悉的服务器结构。"
    >
      <div className="flow-grid">
        {howItWorksSteps.map((step, index) => (
          <article key={step.id} className="flow-step">
            <div className="flow-index">0{index + 1}</div>
            <div className="flow-line" aria-hidden="true" />
            <div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </article>
        ))}
      </div>
    </SectionShell>
  );
}
