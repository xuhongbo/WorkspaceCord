import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0a0b0e',
          900: '#0f1015',
          800: '#14151b',
          700: '#1c1b1a',
          600: '#242324',
          500: '#2e2d2e',
          400: '#3a3a3c',
        },
        mint: {
          DEFAULT: '#6ee7b7',
          400: '#84ffcb',
          300: '#a7f3d0',
          200: '#c6f6e0',
        },
        violet: {
          DEFAULT: '#8664ff',
          400: '#9a82ff',
        },
        cyan: {
          DEFAULT: '#65ffd6',
        },
        discord: {
          bg: '#313338',
          sidebar: '#2b2d31',
          rail: '#1e1f22',
          text: '#dbdee1',
          muted: '#949ba4',
          accent: '#5865f2',
        },
      },
      fontFamily: {
        display: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"SFMono-Regular"',
          '"Fira Code"',
          'Consolas',
          'monospace',
        ],
      },
      boxShadow: {
        'glow-mint': '0 16px 48px rgba(110, 231, 183, 0.22)',
        'glow-mint-lg': '0 24px 80px rgba(110, 231, 183, 0.3)',
        'glow-violet': '0 16px 48px rgba(134, 100, 255, 0.25)',
        'glow-cyan': '0 16px 48px rgba(101, 255, 214, 0.22)',
        'pane': '0 26px 64px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
      },
      backgroundImage: {
        'grid-fade':
          'linear-gradient(180deg, rgba(20, 21, 27, 0) 0%, rgba(20, 21, 27, 0.6) 50%, rgba(20, 21, 27, 0) 100%)',
        'aurora':
          'radial-gradient(60% 50% at 20% 30%, rgba(134, 100, 255, 0.25) 0%, rgba(134, 100, 255, 0) 70%), radial-gradient(50% 45% at 80% 70%, rgba(101, 255, 214, 0.18) 0%, rgba(101, 255, 214, 0) 70%)',
      },
      animation: {
        'cursor-blink': 'cursor-blink 1s step-end infinite',
        'flow-forward': 'flow-forward 2.6s cubic-bezier(0.65, 0, 0.35, 1) infinite',
        'flow-backward': 'flow-backward 2.6s cubic-bezier(0.65, 0, 0.35, 1) infinite',
        'pulse-soft': 'pulse-soft 3s ease-in-out infinite',
        'fade-in-up': 'fade-in-up 0.7s ease-out both',
      },
      keyframes: {
        'cursor-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        'flow-forward': {
          '0%': { offsetDistance: '0%', opacity: '0' },
          '10%': { opacity: '1' },
          '90%': { opacity: '1' },
          '100%': { offsetDistance: '100%', opacity: '0' },
        },
        'flow-backward': {
          '0%': { offsetDistance: '100%', opacity: '0' },
          '10%': { opacity: '1' },
          '90%': { opacity: '1' },
          '100%': { offsetDistance: '0%', opacity: '0' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
