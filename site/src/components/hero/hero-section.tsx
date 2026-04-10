import { motion } from 'framer-motion';
import { useState } from 'react';
import { heroContent } from '../../lib/content';
import { WorkflowDemo } from './workflow-demo';

export function HeroSection() {
  const [copied, setCopied] = useState(false);

  const handleCopyInstall = async () => {
    try {
      await navigator.clipboard.writeText(heroContent.install);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="hero-section relative pt-6 pb-24">
      {/* Topbar */}
      <header className="mx-auto flex w-[min(1240px,calc(100%-40px))] items-center justify-between pt-6">
        <a className="flex items-center gap-2.5 text-sm text-white/90" href="#top">
          <span className="h-2.5 w-2.5 rounded-full bg-gradient-to-br from-violet to-cyan shadow-glow-violet" />
          workspacecord
        </a>
        <nav className="flex items-center gap-5 font-mono text-[11px] uppercase tracking-[0.16em] text-white/50">
          <a href="#the-problem" className="transition hover:text-mint">
            痛点
          </a>
          <a href="#how-it-works" className="transition hover:text-mint">
            工作流
          </a>
          <a href="#quick-start" className="transition hover:text-mint">
            快速开始
          </a>
          <a
            href={heroContent.secondaryCta.href}
            target="_blank"
            rel="noreferrer"
            className="transition hover:text-mint"
          >
            GitHub
          </a>
        </nav>
      </header>

      {/* Hero Layout */}
      <div className="mx-auto mt-10 grid w-[min(1280px,calc(100%-40px))] grid-cols-1 gap-10 lg:mt-16 lg:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)] lg:items-center lg:gap-12">
        {/* Copy */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
          className="max-w-2xl"
        >
          <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.2em] text-mint/80">
            {heroContent.eyebrow}
          </p>
          <h1 className="text-[clamp(2.2rem,4vw,3.75rem)] font-bold leading-[1.05] tracking-[-0.035em] text-white">
            <span className="block">{heroContent.titleLine1}</span>
            <span className="block bg-gradient-to-r from-mint via-mint-400 to-cyan bg-clip-text text-transparent">
              {heroContent.titleLine2}
            </span>
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-white/70">
            {heroContent.description}
          </p>

          {/* Install command chip */}
          <button
            type="button"
            onClick={handleCopyInstall}
            className="group mt-8 flex items-center gap-3 rounded-xl border border-white/10 bg-ink-800/80 px-4 py-3 font-mono text-sm text-white/90 transition hover:border-mint/50 hover:bg-ink-800"
          >
            <span className="text-mint/80">$</span>
            <span>{heroContent.install}</span>
            <span className="ml-2 flex items-center gap-1 text-[11px] uppercase tracking-wider text-white/40 group-hover:text-mint">
              {copied ? '已复制' : '复制'}
            </span>
          </button>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <a
              href={heroContent.primaryCta.href}
              className="inline-flex h-12 items-center justify-center rounded-full bg-mint px-6 font-semibold text-ink-900 shadow-glow-mint transition hover:-translate-y-0.5 hover:bg-mint-400"
            >
              {heroContent.primaryCta.label}
            </a>
            <a
              href={heroContent.secondaryCta.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-12 items-center justify-center rounded-full border border-white/15 px-6 font-medium text-white/90 transition hover:border-mint/40 hover:text-white"
            >
              {heroContent.secondaryCta.label}
            </a>
          </div>

          <ul className="mt-8 flex flex-wrap gap-2 text-[12px] font-mono uppercase tracking-[0.12em] text-white/50">
            {heroContent.badges.map((badge) => (
              <li
                key={badge}
                className="rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5"
              >
                {badge}
              </li>
            ))}
          </ul>
        </motion.div>

        {/* Demo */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: 'easeOut', delay: 0.15 }}
        >
          <WorkflowDemo />
        </motion.div>
      </div>
    </section>
  );
}
