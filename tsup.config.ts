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
  // In watch mode, ignore src/ and only rebuild when .restart is touched
  ...(options.watch
    ? {
        ignoreWatch: ['src'],
        watch: ['.restart'],
      }
    : {}),
}));
