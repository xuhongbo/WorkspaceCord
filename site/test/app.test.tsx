// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import App from '../src/App';

afterEach(() => {
  vi.useRealTimers();
});

describe('App', () => {
  it('渲染首屏主标题与桌面式演示舞台', () => {
    const { container } = render(<App />);

    expect(
      screen.getByRole('heading', {
        name: /把 discord 变成你的多智能体开发控制台/i,
      }),
    ).toBeInTheDocument();

    expect(screen.getByLabelText(/桌面演示舞台/i)).toBeInTheDocument();
    expect(screen.getByText(/WorkspaceCord CLI/i, { selector: '.window-chrome strong' })).toBeInTheDocument();
    expect(screen.getByText(/^Dock$/i)).toBeInTheDocument();
    expect(screen.getByText(/^CLI$/i, { selector: '.dock-app-label' })).toBeInTheDocument();
    expect(screen.getByText(/^Discord$/i, { selector: '.dock-app-label' })).toBeInTheDocument();
    expect(screen.getByLabelText(/分镜时间轴/i)).toBeInTheDocument();

    const heroSection = container.querySelector('.hero-section');
    const stageRow = heroSection?.querySelector('.hero-stage-row');
    const copyRow = heroSection?.querySelector('.hero-copy-row');
    expect(stageRow).toBeInTheDocument();
    expect(copyRow).toBeInTheDocument();
    expect(stageRow?.compareDocumentPosition(copyRow as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    const quickStartLinks = screen.getAllByRole('link', { name: /快速开始/i });
    expect(quickStartLinks[0]).toHaveAttribute('href', '#quick-start');
  });

  it('自动播放桌面分镜，悬停时停留当前场景并从该场景继续', () => {
    vi.useFakeTimers();
    render(<App />);

    expect(screen.getByText(/daemon ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Discord$/i, { selector: '.window-chrome strong' })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(screen.getByText(/Dock handoff ready/i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(screen.getByText(/^Discord$/i, { selector: '.window-chrome strong' })).toBeInTheDocument();
    expect(screen.getByText(/workspace-hub/i, { selector: '.discord-sidebar strong' })).toBeInTheDocument();

    const sessionStepChip = screen.getByRole('button', {
      name: /05 展开项目会话与线程/i,
    });

    fireEvent.mouseEnter(sessionStepChip);
    expect(screen.getByText(/^main session$/i, { selector: '.discord-message-author' })).toBeInTheDocument();
    expect(screen.getByText(/thread \/ 验证灰度日志/i, { selector: '.discord-message-author' })).toBeInTheDocument();
    expect(screen.getByText(/拆解 auth rollout，先确认鉴权链路与灰度验证。/i)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(screen.getByText(/^main session$/i, { selector: '.discord-message-author' })).toBeInTheDocument();

    fireEvent.mouseLeave(sessionStepChip);
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(screen.getByText(/^#history$/i, { selector: '.history-channel' })).toBeInTheDocument();
    expect(screen.getByText(/^history summary$/i, { selector: '.discord-message-author' })).toBeInTheDocument();
    expect(screen.getByText(/summary posted/i, { selector: '.history-summary p' })).toBeInTheDocument();
  });
});
