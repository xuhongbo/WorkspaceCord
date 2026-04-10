import { describe, it, expect } from 'vitest';
import {
  getNextSceneIndex,
  remoteControlScenes,
} from '../src/lib/workflow-steps';

describe('remoteControlScenes', () => {
  it('定义 4 幕并按 send → parallel → approve → archive 推进', () => {
    expect(remoteControlScenes).toHaveLength(4);
    expect(remoteControlScenes.map((scene) => scene.id)).toEqual([
      'send',
      'parallel',
      'approve',
      'archive',
    ]);
    expect(remoteControlScenes.map((scene) => scene.label)).toEqual([
      'SEND',
      'PARALLEL',
      'APPROVE',
      'ARCHIVE',
    ]);
  });

  it('每一幕都有 sidebar、active 频道内容与终端 mock', () => {
    for (const scene of remoteControlScenes) {
      expect(scene.sidebar.length).toBeGreaterThanOrEqual(4);
      expect(scene.activeChannelId).toBeTruthy();
      expect(scene.activeView.title).toBeTruthy();
      expect(scene.terminal.title).toContain('coding');
      expect(scene.terminal.lines.length).toBeGreaterThan(0);
    }
  });

  it('每一幕 sidebar 都包含被 active 的那个 session 频道', () => {
    for (const scene of remoteControlScenes) {
      expect(
        scene.sidebar.some((channel) => channel.id === scene.activeChannelId),
      ).toBe(true);
    }
  });

  it('4 幕之间会切换 active channel（多 session 的体感）', () => {
    const activeIds = remoteControlScenes.map((s) => s.activeChannelId);
    const unique = new Set(activeIds);
    expect(unique.size).toBeGreaterThanOrEqual(3);
  });

  it('approve 幕携带 Discord 审批按钮 payload', () => {
    const approveScene = remoteControlScenes.find((s) => s.id === 'approve');
    expect(approveScene?.activeView.approval).toBeTruthy();
    expect(approveScene?.activeView.approval?.title).toContain('src/middleware.ts');
  });

  it('archive 幕切到 #history 并显示归档列表', () => {
    const archiveScene = remoteControlScenes.find((s) => s.id === 'archive');
    expect(archiveScene?.activeChannelId).toBe('history');
    expect(archiveScene?.activeView.archive?.items.length).toBeGreaterThan(0);
  });

  it('send 幕的用户消息出现且没有待审批 payload', () => {
    const sendScene = remoteControlScenes[0];
    expect(sendScene?.activeView.userMessage).toContain('auth');
    expect(sendScene?.activeView.approval).toBeUndefined();
  });

  it('终端 mock 描述 coding category 下的并发 session 状态', () => {
    for (const scene of remoteControlScenes) {
      expect(scene.terminal.title).toMatch(/coding · \d+ sessions/);
    }
  });

  it('getNextSceneIndex 在最后一幕后回到第一幕', () => {
    expect(getNextSceneIndex(0, remoteControlScenes.length)).toBe(1);
    expect(
      getNextSceneIndex(remoteControlScenes.length - 1, remoteControlScenes.length),
    ).toBe(0);
  });
});
