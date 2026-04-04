import { developerScenes } from '../../lib/content';
import { SectionShell } from '../ui/section-shell';

export function WhyGeeksLikeItSection() {
  return (
    <SectionShell
      eyebrow="Why Developers Love It"
      title="场景证明"
      description="不是罗列功能，而是看看开发者的一天。"
    >
      <div className="scenes-grid">
        {developerScenes.map((scene) => (
          <article key={scene.tag} className="scene-card">
            <span className="scene-tag">{scene.tag}</span>
            <h3>{scene.title}</h3>
            <code>{scene.terminal}</code>
            <p>{scene.body}</p>
          </article>
        ))}
      </div>
    </SectionShell>
  );
}
