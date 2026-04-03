import { quickStartSteps } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function QuickStartSection() {
  return (
    <SectionShell
      id="quick-start"
      eyebrow="Quick start"
      title="几分钟内，把你的项目接入 workspacecord"
      description="配置、挂载、启动。然后回到 Discord，开始调度你的代理工作流。"
    >
      <div className="quickstart-panel">
        {quickStartSteps.map((step, index) => (
          <div key={step.title} className="quickstart-row">
            <div className="quickstart-meta">
              <span className="quickstart-index">0{index + 1}</span>
              <h3>{step.title}</h3>
            </div>
            <code>{step.command}</code>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}
