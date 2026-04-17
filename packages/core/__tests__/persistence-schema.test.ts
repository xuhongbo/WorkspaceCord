import { describe, expect, it } from 'vitest';
import {
  parseSessionPersistData,
  parseRegisteredProject,
  parseProject,
  type SchemaIssue,
} from '../src/index.ts';

describe('parseSessionPersistData', () => {
  function minimalValidRaw() {
    return {
      id: 's1',
      channelId: 'ch1',
      categoryId: 'cat1',
      projectName: 'demo',
      agentLabel: 'fix-login',
      provider: 'claude',
      type: 'persistent',
      mode: 'auto',
      directory: '/repo',
      subagentDepth: 0,
      verbose: false,
      workflowState: { status: 'idle', iteration: 0, updatedAt: 1 },
      createdAt: 1,
      lastActivity: 1,
      messageCount: 0,
      totalCost: 0,
      currentTurn: 0,
      humanResolved: false,
    };
  }

  it('接受最小合法记录', () => {
    const issues: SchemaIssue[] = [];
    const parsed = parseSessionPersistData(minimalValidRaw(), 0, issues);
    expect(parsed).toBeDefined();
    expect(parsed!.id).toBe('s1');
    expect(issues).toEqual([]);
  });

  it('缺少必填字段时返回 undefined', () => {
    const issues: SchemaIssue[] = [];
    const raw = minimalValidRaw() as Record<string, unknown>;
    delete raw.channelId;
    const parsed = parseSessionPersistData(raw, 0, issues);
    expect(parsed).toBeUndefined();
    expect(issues.some((i) => i.path.includes('channelId'))).toBe(true);
  });

  it('非法枚举回落到默认值（不丢弃整条记录）', () => {
    const issues: SchemaIssue[] = [];
    const raw = { ...minimalValidRaw(), provider: 'bogus', mode: 'weird' };
    const parsed = parseSessionPersistData(raw, 0, issues);
    expect(parsed).toBeDefined();
    expect(parsed!.provider).toBe('claude');
    expect(parsed!.mode).toBe('auto');
  });

  it('忽略类型错误的可选字段', () => {
    const issues: SchemaIssue[] = [];
    const raw = {
      ...minimalValidRaw(),
      currentInteractionMessageId: 123, // 应为 string
      remoteHumanControl: 'yes', // 应为 boolean
    };
    const parsed = parseSessionPersistData(raw, 0, issues);
    expect(parsed).toBeDefined();
    expect(parsed!.currentInteractionMessageId).toBeUndefined();
    expect(parsed!.remoteHumanControl).toBeUndefined();
  });

  it('非对象输入返回 undefined 并记录 issue', () => {
    const issues: SchemaIssue[] = [];
    const parsed = parseSessionPersistData('not-an-object', 0, issues);
    expect(parsed).toBeUndefined();
    expect(issues).toHaveLength(1);
  });
});

describe('parseRegisteredProject', () => {
  it('接受合法记录', () => {
    const issues: SchemaIssue[] = [];
    const raw = {
      id: 'p1',
      name: 'demo',
      path: '/repo',
      skills: { test: 'run pnpm test' },
      mcpServers: [{ name: 'fs', command: 'fs-mcp' }],
      createdAt: 1,
      updatedAt: 1,
    };
    const parsed = parseRegisteredProject(raw, 0, issues);
    expect(parsed).toBeDefined();
    expect(parsed!.skills.test).toBe('run pnpm test');
    expect(parsed!.mcpServers).toHaveLength(1);
  });

  it('skills 非字符串值被丢弃而不污染结果', () => {
    const issues: SchemaIssue[] = [];
    const raw = {
      id: 'p1',
      name: 'demo',
      path: '/repo',
      skills: { good: 'ok', bad: 123 },
      mcpServers: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const parsed = parseRegisteredProject(raw, 0, issues);
    expect(parsed).toBeDefined();
    expect(parsed!.skills).toEqual({ good: 'ok' });
  });

  it('mcpServer 缺 name 时被丢弃', () => {
    const issues: SchemaIssue[] = [];
    const raw = {
      id: 'p1',
      name: 'demo',
      path: '/repo',
      skills: {},
      mcpServers: [{ command: 'fs-mcp' }, { name: 'ok', command: 'c' }],
      createdAt: 1,
      updatedAt: 1,
    };
    const parsed = parseRegisteredProject(raw, 0, issues);
    expect(parsed!.mcpServers).toHaveLength(1);
    expect(parsed!.mcpServers[0].name).toBe('ok');
  });
});

describe('parseProject (public Project type)', () => {
  it('要求 categoryId/name/directory 全部存在', () => {
    const issues: SchemaIssue[] = [];
    const missing = parseProject({ name: 'x' }, 0, issues);
    expect(missing).toBeUndefined();

    const full = parseProject(
      { categoryId: 'c1', name: 'x', directory: '/r', skills: [], mcpServers: [], createdAt: 1 },
      0,
      issues,
    );
    expect(full).toBeDefined();
  });
});
