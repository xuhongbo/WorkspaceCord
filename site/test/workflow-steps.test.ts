import { describe, it, expect } from 'vitest';
import {
  getNextWorkflowIndex,
  workflowSteps,
} from '../src/lib/workflow-steps';

describe('workflow steps', () => {
  it('定义 6 个电影式分镜并按桌面焦点推进', () => {
    expect(workflowSteps).toHaveLength(6);
    expect(workflowSteps.map((step) => step.id)).toEqual([
      'terminal-boot',
      'dock-handoff',
      'discord-launch',
      'project-map',
      'session-expand',
      'history-archive',
    ]);

    expect(workflowSteps.map((step) => step.scene.desktopFocus)).toEqual([
      'terminal',
      'dock',
      'discord',
      'discord',
      'discord',
      'discord',
    ]);
  });

  it('包含桌面窗口状态与多项目到多线程的层级信息', () => {
    const [terminalStep, dockStep, discordStep, projectStep, sessionStep, historyStep] =
      workflowSteps;

    expect(terminalStep?.scene.terminal.windowState).toBe('foreground');
    expect(dockStep?.scene.terminal.windowState).toBe('docked');
    expect(discordStep?.scene.discord.windowState).toBe('foreground');

    expect(projectStep?.scene.discord.categories.length).toBeGreaterThan(1);
    expect(projectStep?.scene.discord.selectedCategoryId).toBeNull();

    expect(sessionStep?.scene.discord.selectedCategoryId).toBeTruthy();
    expect(sessionStep?.scene.discord.mainSession).toBeTruthy();
    expect(sessionStep?.scene.discord.threads.length).toBeGreaterThan(1);

    expect(historyStep?.scene.discord.history.channel).toBe('#history');
    expect(historyStep?.scene.discord.history.summary).toContain('summary posted');
  });

  it('包含更真实的协作消息流与 Dock 交接状态', () => {
    const [terminalStep, dockStep, discordStep, , sessionStep, historyStep] = workflowSteps;

    expect(dockStep?.scene.dock.apps.map((app) => app.label)).toEqual(['CLI', 'Discord']);
    expect(dockStep?.scene.dock.activeApp).toBe('discord');
    expect(terminalStep?.scene.dock.presentation).toBe('ambient');
    expect(dockStep?.scene.dock.presentation).toBe('handoff');
    expect(discordStep?.scene.dock.presentation).toBe('ambient');

    expect(sessionStep?.scene.discord.messages.length).toBeGreaterThan(2);
    expect(sessionStep?.scene.discord.messages[0]?.author).toBe('main session');
    expect(
      sessionStep?.scene.discord.messages.some((message) =>
        message.author.includes('thread / 验证灰度日志'),
      ),
    ).toBe(true);

    expect(
      historyStep?.scene.discord.messages[
        (historyStep?.scene.discord.messages.length ?? 1) - 1
      ]?.author,
    ).toBe('history summary');
  });

  it('在最后一步后回到第一步', () => {
    expect(getNextWorkflowIndex(0, workflowSteps.length)).toBe(1);
    expect(getNextWorkflowIndex(workflowSteps.length - 1, workflowSteps.length)).toBe(
      0,
    );
  });
});
