import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { _setDataDirForTest } from '@workspacecord/core';
import {
  loadRegistry,
  registerProject,
  getProjectByName,
  getProjectByPath,
  getProjectByCategoryId,
  getAllRegisteredProjects,
  renameProject,
  removeProject,
  bindProjectCategory,
  setProjectHistoryChannel,
  setProjectControlChannel,
} from '../src/project-registry.ts';

describe('project-registry', () => {
  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspacecord-project-reg-'));
    _setDataDirForTest(dir);
    await loadRegistry();
  });

  it('registers and queries projects', async () => {
    const project = await registerProject('demo', '/tmp/demo');
    expect(getProjectByName('demo')?.id).toBe(project.id);
    expect(getProjectByPath('/tmp/demo')?.name).toBe('demo');
    expect(getAllRegisteredProjects().length).toBe(1);
  });

  it('rejects duplicate path and duplicate name', async () => {
    await registerProject('demo', '/tmp/demo');
    await expect(registerProject('demo2', '/tmp/demo')).rejects.toThrow(/Path already registered/);
    await expect(registerProject('demo', '/tmp/another')).rejects.toThrow(
      /Project name already exists/,
    );
  });

  it('renames and removes project', async () => {
    await registerProject('demo', '/tmp/demo');
    await renameProject('demo', 'demo-renamed');
    expect(getProjectByName('demo')).toBeUndefined();
    expect(getProjectByName('demo-renamed')).toBeDefined();

    await removeProject('demo-renamed');
    expect(getAllRegisteredProjects()).toHaveLength(0);
  });

  it('binds a mounted project to a discord category and stores history/control channels', async () => {
    await registerProject('demo', '/tmp/demo');
    await bindProjectCategory('demo', 'cat-1', 'Demo Category');
    await setProjectHistoryChannel('demo', 'forum-1');
    await setProjectControlChannel('demo', 'control-1');

    expect(getProjectByCategoryId('cat-1')?.name).toBe('demo');
    expect(getProjectByName('demo')?.discordCategoryName).toBe('Demo Category');
    expect(getProjectByName('demo')?.historyChannelId).toBe('forum-1');
    expect(getProjectByName('demo')?.controlChannelId).toBe('control-1');
  });
});
