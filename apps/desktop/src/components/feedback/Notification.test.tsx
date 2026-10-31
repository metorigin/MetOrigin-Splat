import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Notification, NotificationStack } from "./Notification";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("shared notification surface", () => {
  it("keeps the full Chinese and unbroken Latin error readable in a narrow host with a reachable dismiss control", () => {
    const dismiss = vi.fn();
    const message = "训练无法继续，请检查素材和引擎配置。".repeat(12) + "A".repeat(256);
    render(<div style={{ width: 240 }}><Notification variant="error" title="操作未完成" message={message} onDismiss={dismiss} dismissLabel="关闭错误提示" /></div>);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveAttribute("aria-atomic", "true");
    expect(alert.querySelectorAll("svg")).toHaveLength(2);
    expect(alert.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it.each(["info", "success", "warning"] as const)("announces %s politely without adding an unavailable close action", (variant) => {
    render(<Notification variant={variant} message="结果仍然保留" />);
    expect(screen.getByRole("status")).toHaveAttribute("data-feedback-variant", variant);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps inline recovery actions and details with the error instead of moving them into a toast", () => {
    const retry = vi.fn();
    render(<Notification variant="error" role="status" title="读取暂不可用" actions={<Button onClick={retry}>重试</Button>}><p>正在显示上次成功结果。</p></Notification>);
    expect(screen.getByRole("status")).not.toHaveClass("feedback-notification--toast");
    expect(screen.getByText("正在显示上次成功结果。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("groups global success and error feedback without merging their announcements", () => {
    render(<NotificationStack><Notification placement="toast" variant="success" message="文件已保存" /><Notification placement="toast" variant="error" message="另一个操作失败" /></NotificationStack>);
    expect(screen.getByRole("status")).toHaveTextContent("文件已保存");
    expect(screen.getByRole("alert")).toHaveTextContent("另一个操作失败");
    expect(screen.getByRole("status").parentElement).toBe(screen.getByRole("alert").parentElement);
  });

  it("stacks toasts from independent owners and releases the host only after the last one leaves", () => {
    const local = render(<Notification placement="toast" variant="success" message="恢复点已删除" />);
    const global = render(<Notification placement="toast" variant="error" message="输出目录打开失败" />);
    const stack = screen.getByRole("status").parentElement;
    expect(stack).toHaveClass("feedback-notification-stack");
    expect(screen.getByRole("alert").parentElement).toBe(stack);
    expect(document.querySelectorAll(".feedback-notification-stack")).toHaveLength(1);
    local.unmount();
    expect(stack?.isConnected).toBe(true);
    expect(screen.getByRole("alert").parentElement).toBe(stack);
    global.unmount();
    expect(document.querySelector(".feedback-notification-stack")).toBeNull();
  });

  it.each(["info", "success", "warning", "error"] as const)("dismisses a %s toast after exactly five seconds", (variant) => {
    const dismiss = vi.fn();
    render(<Notification placement="toast" variant={variant} message="本次通知" onDismiss={dismiss} />);
    act(() => vi.advanceTimersByTime(4999));
    expect(screen.getByText("本次通知")).toBeVisible();
    expect(dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("本次通知")).not.toBeInTheDocument();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(document.querySelector(".feedback-notification-stack")).toBeNull();
  });

  it("expires a toast without a state callback and leaves inline feedback untouched", () => {
    const dismiss = vi.fn();
    render(<><Notification placement="toast" message="临时提醒" /><Notification variant="error" message="必须保留的校验" onDismiss={dismiss} /></>);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByText("临时提醒")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("必须保留的校验");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("uses the newest dismiss callback without extending the original deadline for fresh JSX", () => {
    const first = vi.fn(), latest = vi.fn();
    const view = render(<Notification placement="toast" message={<span>同一条提示</span>} onDismiss={first} />);
    act(() => vi.advanceTimersByTime(4000));
    view.rerender(<Notification placement="toast" message={<span>同一条提示</span>} onDismiss={latest} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText("同一条提示")).not.toBeInTheDocument();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });

  it("gives changed content a full new deadline and shows fresh content after a prior dismissal", () => {
    const dismiss = vi.fn();
    const view = render(<Notification placement="toast" message="旧提示" onDismiss={dismiss} />);
    act(() => vi.advanceTimersByTime(4000));
    view.rerender(<Notification placement="toast" message="新提示" onDismiss={dismiss} />);
    act(() => vi.advanceTimersByTime(4999));
    expect(screen.getByText("新提示")).toBeVisible();
    expect(dismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(dismiss).toHaveBeenCalledOnce();
    view.rerender(<Notification placement="toast" message="旧提示" onDismiss={dismiss} />);
    expect(screen.getByText("旧提示")).toBeVisible();
    act(() => vi.advanceTimersByTime(5000));
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  it("times separate owners independently", () => {
    const first = vi.fn(), second = vi.fn();
    render(<Notification placement="toast" message="先到通知" onDismiss={first} />);
    act(() => vi.advanceTimersByTime(3000));
    render(<Notification placement="toast" message="后到通知" onDismiss={second} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(screen.getByText("后到通知")).toBeVisible();
    act(() => vi.advanceTimersByTime(3000));
    expect(second).toHaveBeenCalledOnce();
  });

  it("cleans up on unmount and never dismisses twice after a manual close", () => {
    const unmounted = vi.fn();
    const view = render(<Notification placement="toast" message="即将离开页面" onDismiss={unmounted} />);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(5000));
    expect(unmounted).not.toHaveBeenCalled();
    const manual = vi.fn();
    render(<Notification placement="toast" message="手动关闭通知" onDismiss={manual} />);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(manual).toHaveBeenCalledOnce();
    expect(screen.queryByText("手动关闭通知")).not.toBeInTheDocument();
  });

  it("shows the specific toast message once instead of repeating a generic title", () => {
    render(<Notification placement="toast" variant="error" title="操作未完成" message="项目位置不可用" />);
    expect(screen.getByRole("alert")).toHaveTextContent("项目位置不可用");
    expect(screen.queryByText("操作未完成")).not.toBeInTheDocument();
  });
});
