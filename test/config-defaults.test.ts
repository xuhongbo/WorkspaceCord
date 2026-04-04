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

  it('discord 投递默认配置与官方源码一致', () => {
    expect(config.ackReaction).toBe('👀');
    expect(config.replyToMode).toBe('first');
    expect(config.textChunkLimit).toBe(2000);
    expect(config.chunkMode).toBe('length');
    expect(config.socketPath).toBe('/tmp/workspacecord.sock');
  });

  it('codex 默认开启联网与 live 搜索', () => {
    expect(config.codexNetworkAccessEnabled).toBe(true);
    expect(config.codexWebSearchMode).toBe('live');
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


describe('config runtime fallback', () => {
  it('非法运行时配置会回退到安全默认值', async () => {
    vi.resetModules();
    vi.doMock('../src/global-config.ts', () => ({
      getConfigValue: (key: string) => {
        if (key === 'DISCORD_TOKEN') return 'token';
        if (key === 'DISCORD_CLIENT_ID') return 'client';
        if (key === 'REPLY_TO_MODE') return 'broken';
        if (key === 'CHUNK_MODE') return 'smart';
        if (key === 'TEXT_CHUNK_LIMIT') return '99999';
        return undefined;
      },
    }));
    const mod = await import('../src/config.ts?fallback');
    expect(mod.config.replyToMode).toBe('first');
    expect(mod.config.chunkMode).toBe('length');
    expect(mod.config.textChunkLimit).toBe(2000);
  });
});
