// 本地会话快速注册
// 实现设计文档第 7.4 节的统一注册流程

import type { Client } from 'discord.js';
import type { ProviderName } from './types.ts';
import { registerLocalSession } from './thread-manager.ts';

export interface SessionDiscoveryParams {
  provider: ProviderName;
  providerSessionId: string;
  cwd: string;
  discoverySource: 'claude-hook' | 'codex-log';
}

export async function discoverAndRegisterSession(
  client: Client,
  params: SessionDiscoveryParams,
): Promise<{ sessionId: string; channelId: string; isNew: boolean } | null> {
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.warn('[Session Discovery] No guild found, cannot register local session');
    return null;
  }

  const result = await registerLocalSession(
    {
      provider: params.provider,
      providerSessionId: params.providerSessionId,
      cwd: params.cwd,
      discoverySource: params.discoverySource,
      labelHint: `${params.provider}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`,
      remoteHumanControl: false,
    },
    guild,
  );
  if (!result) return null;

  return {
    sessionId: result.session.id,
    channelId: result.session.channelId,
    isNew: result.isNewlyCreated,
  };
}
