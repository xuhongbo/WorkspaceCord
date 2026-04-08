import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const packages = ['core', 'providers', 'state', 'engine', 'bot', 'cli'];

function workspaceAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const pkg of packages) {
    const name = pkg === 'cli' ? 'workspacecord' : `@workspacecord/${pkg}`;
    aliases[name] = resolve(__dirname, `packages/${pkg}/src/index.ts`);
  }
  return aliases;
}

export default defineConfig({
  resolve: {
    alias: [
      // Deep imports: @workspacecord/engine/session-registry → packages/engine/src/session-registry.ts
      ...packages.map((pkg) => ({
        find: new RegExp(`^@workspacecord/${pkg}/(.+)$`),
        replacement: resolve(__dirname, `packages/${pkg}/src/$1.ts`),
      })),
      // Barrel imports: @workspacecord/core → packages/core/src/index.ts
      ...Object.entries(workspaceAliases()).map(([find, replacement]) => ({
        find,
        replacement,
      })),
    ],
  },
  test: {
    include: ['packages/*/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.git/**', '.worktrees/**', 'tmp/**', 'site/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/__tests__/**',
        '**/*.test.ts',
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
