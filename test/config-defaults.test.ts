import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/global-config.ts', () => ({
  getConfigValue: (key: string) => {
    if (key === 'DISCORD_TOKEN') return 'token';
    if (key === 'DISCORD_CLIENT_ID') return 'client';
    return undefined;
  },
}));

const { config } = await import('../src/config.ts');
const { getCommandDefinitions } = await import('../src/commands.ts');

describe('config defaults', () => {
  it('默认 provider 为 codex', () => {
    expect(config.defaultProvider).toBe('codex');
  });

  it('命令里的 provider 默认提示为 Codex', () => {
    const defs = getCommandDefinitions();
    const names = new Set<string>();
    type CommandOption = {
      name?: string;
      choices?: Array<{ name?: string }>;
      options?: CommandOption[];
    };
    for (const def of defs) {
      const options = (def.options ?? []) as CommandOption[];
      for (const option of options) {
        if (option.name === 'provider' && Array.isArray(option.choices)) {
          names.add(option.choices[0]?.name);
        }
        for (const sub of option.options ?? []) {
          if (sub.name === 'provider' && Array.isArray(sub.choices)) {
            names.add(sub.choices[0]?.name);
          }
        }
      }
    }
    expect(Array.from(names)).toContain('Codex（默认）');
  });
});
