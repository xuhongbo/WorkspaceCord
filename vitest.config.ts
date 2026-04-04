import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '.worktrees/**', 'tmp/**', 'site/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/__tests__/**',
        '**/*.test.ts',
        'src/types.ts',
        'src/index.ts',
        'src/providers/types.ts',
        'src/providers/index.ts',
        'src/agents.ts',
        'src/setup.ts',
        'src/daemon.ts',
        'src/health-monitor.ts',
        'src/service-container.ts',
        'src/config.ts',
        'src/hooks/**',
        'site/**',
      ],
      thresholds: {
        lines: 65,
        functions: 60,
        branches: 50,
        statements: 65,
      },
    },
  },
});
