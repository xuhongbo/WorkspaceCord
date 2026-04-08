import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/cli.ts'],
  format: 'esm',
  target: 'node22',
  clean: true,
  outDir: 'dist',
  splitting: true,
  external: ['@openai/codex-sdk'],
  banner: {
    js: '#!/usr/bin/env node',
  },
  noExternal: [
    '@workspacecord/core',
    '@workspacecord/providers',
    '@workspacecord/state',
    '@workspacecord/engine',
    '@workspacecord/bot',
  ],
  ...(options.watch
    ? {
        ignoreWatch: ['src'],
        watch: ['.restart'],
      }
    : {}),
}));
