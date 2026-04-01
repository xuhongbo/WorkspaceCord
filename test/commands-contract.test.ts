import { describe, expect, it } from 'vitest';
import { getCommandDefinitions } from '../src/commands.ts';

describe('commands contract', () => {
  it('暴露完整命令定义列表', () => {
    const defs = getCommandDefinitions();
    const names = defs.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining(['project', 'agent', 'subagent', 'shell', 'spawn', 'stop', 'end', 'run']),
    );
  });

  it('agent 命令包含 cleanup 子命令', () => {
    const defs = getCommandDefinitions();
    const agent = defs.find((definition) => definition.name === 'agent');

    expect(agent?.options?.map((option) => option.name)).toEqual(
      expect.arrayContaining(['cleanup']),
    );
  });
});
