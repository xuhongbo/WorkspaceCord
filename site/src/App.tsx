import { FinalCtaSection } from './components/sections/final-cta';
import { HeroSection } from './components/hero/hero-section';
import { HowItWorksSection } from './components/sections/how-it-works';
import { OneServerSection } from './components/sections/one-server';
import { QuickStartSection } from './components/sections/quick-start';
import { TheProblemSection } from './components/sections/the-problem';
import { WhyGeeksLikeItSection } from './components/sections/why-geeks-like-it';

export default function App() {
  return (
    <div id="top" className="page-shell">
      <HeroSection />
      <main>
        <OneServerSection />
        <TheProblemSection />
        <HowItWorksSection />
        <WhyGeeksLikeItSection />
        <QuickStartSection />
        <FinalCtaSection />
      </main>
    </div>
  );
}
