// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import App from '../src/App';

afterEach(() => {
  vi.useRealTimers();
});

describe('App', () => {
  it('渲染结构优先的 Hero（两行大字 + 多 session 演示 + CTA）', () => {
    const { container } = render(<App />);

    const heading = screen.getByRole('heading', {
      name: /一个 Discord 服务器/,
    });
    expect(heading).toBeInTheDocument();
    expect(heading.textContent).toContain('装下你所有 AI 编码任务');

    expect(screen.getByLabelText(/远程遥控演示舞台/)).toBeInTheDocument();

    expect(container.querySelector('.phone-frame')).toBeInTheDocument();
    expect(container.querySelector('.terminal-frame')).toBeInTheDocument();
    expect(container.querySelector('.flow-channel')).toBeInTheDocument();

    expect(
      screen.getByRole('button', { name: /01 SEND/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /02 PARALLEL/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /03 APPROVE/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /04 ARCHIVE/ }),
    ).toBeInTheDocument();

    const primaryCtas = screen.getAllByRole('link', { name: /一分钟跑起来/ });
    expect(primaryCtas[0]).toHaveAttribute('href', '#quick-start');
  });

  it('自动轮播 4 幕的 caption 文本', () => {
    vi.useFakeTimers();
    render(<App />);

    // 初始 scene = send
    expect(
      screen.getByText(/在任一频道发消息/),
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3700);
    });
    expect(
      screen.getByText(/滑到另一个频道/),
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3700);
    });
    expect(
      screen.getByText(/哪个 session 要批准/),
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3700);
    });
    expect(
      screen.getByText(/\/agent archive 后/),
    ).toBeInTheDocument();
  });

  it('渲染所有下半部 section 的 eyebrow', () => {
    render(<App />);

    expect(screen.getByText(/ONE SERVER, EVERYTHING/)).toBeInTheDocument();
    expect(screen.getByText(/THE GAP/)).toBeInTheDocument();
    expect(screen.getByText(/THE FLOW/)).toBeInTheDocument();
    expect(screen.getByText(/WHY DEVS LOVE IT/)).toBeInTheDocument();
    expect(screen.getByText(/QUICK START/)).toBeInTheDocument();
    expect(screen.getByText(/READY/)).toBeInTheDocument();
  });

  it('OneServerSection 展示 3 个项目 category', () => {
    render(<App />);
    expect(screen.getByText(/主项目：多 agent 编排引擎/)).toBeInTheDocument();
    expect(screen.getByText(/老项目：Discord thread 管理工具/)).toBeInTheDocument();
    expect(screen.getByText(/临时项目：官网改版/)).toBeInTheDocument();
  });
});
