import { motion } from 'framer-motion';
import { heroContent } from '../../lib/content';
import { WorkflowDemo } from './workflow-demo';

export function HeroSection() {
  return (
    <section className="hero-section">
      <header className="topbar">
        <a className="brand-mark" href="#top">
          <span />
          {heroContent.eyebrow}
        </a>
        <nav>
          <a href="#how-it-works">工作流</a>
          <a href="#quick-start">快速开始</a>
          <a href={heroContent.secondaryCta.href} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </header>

      <div className="hero-layout">
        <div className="hero-stage-row">
          <WorkflowDemo />
        </div>

        <div className="hero-copy-row">
          <motion.div
            className="hero-copy"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, ease: 'easeOut' }}
          >
            <p className="hero-eyebrow">
              远程受限 → Discord 工作台 → 分类=项目 → 频道=session
            </p>
            <h1>{heroContent.title}</h1>
            <p className="hero-description">{heroContent.description}</p>
            <div className="cta-group">
              <a className="button button-primary" href={heroContent.primaryCta.href}>
                {heroContent.primaryCta.label}
              </a>
              <a
                className="button button-secondary"
                href={heroContent.secondaryCta.href}
                target="_blank"
                rel="noreferrer"
              >
                {heroContent.secondaryCta.label}
              </a>
            </div>
            <ul className="hero-stats">
              {heroContent.stats.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
