import { defineConfig } from 'tsup';
import { cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

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
  onSuccess: async () => {
    for (const file of ['README.md', 'README.zh-CN.md', 'LICENSE']) {
      cpSync(join(root, file), join(__dirname, file));
    }
  },
  ...(options.watch
    ? {
        ignoreWatch: ['src'],
        watch: ['.restart'],
      }
    : {}),
}));
