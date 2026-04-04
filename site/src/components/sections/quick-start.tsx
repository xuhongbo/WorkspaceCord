import { quickStartSteps } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function QuickStartSection() {
  return (
    <SectionShell
      id="quick-start"
      eyebrow="Quick Start"
      title="三步开始"
      description="安装、挂载、启动。然后回到 Discord，开始工作。"
    >
      <div className="quickstart-steps">
        {quickStartSteps.map((step) => (
          <div key={step.step} className="quickstart-step">
            <span className="quickstart-step-number">{step.step}</span>
            <code>{step.command}</code>
            <span className="quickstart-step-label">{step.label}</span>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
