import { howItWorksSteps } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function HowItWorksSection() {
  return (
    <SectionShell
      id="workflow"
      eyebrow="The Workflow"
      title="解决方案"
      description="从终端到 Discord，一条工作流串联所有步骤。"
    >
      <div className="workflow-timeline-v2">
        {howItWorksSteps.map((step, index) => (
          <div key={step.id} className="timeline-item">
            <div className="timeline-marker">
              <span className="timeline-marker-index">0{index + 1}</span>
            </div>
            <div className="timeline-content">
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
