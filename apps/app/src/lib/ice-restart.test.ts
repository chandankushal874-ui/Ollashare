import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureIceRestart } from "./ice-restart";

// Minimal mock for RTCPeerConnection EventTarget + connectionState
class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  listeners: Record<string, (() => void)[]> = {};
  restartIceCalled = 0;

  addEventListener(event: string, callback: () => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  removeEventListener(event: string, callback: () => void) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
  }

  restartIce() {
    this.restartIceCalled++;
  }

  setState(newState: RTCPeerConnectionState) {
    this.connectionState = newState;
    if (this.listeners["connectionstatechange"]) {
      for (const cb of this.listeners["connectionstatechange"]) {
        cb();
      }
    }
  }
}

describe("configureIceRestart state machine (LiveKit / RFC 8829 pattern)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules ICE restart on disconnect with backoff 1s", () => {
    const pc = new MockRTCPeerConnection();
    const onRestartOffer = vi.fn();
    const onReconnect = vi.fn();
    const onFail = vi.fn();

    const controller = configureIceRestart(pc as unknown as RTCPeerConnection, {
      onRestartOffer,
      onReconnect,
      onFail,
      backoffSchedule: [1000, 2000, 4000],
    });

    pc.setState("disconnected");
    expect(controller.getRetryCount()).toBe(1);
    expect(onRestartOffer).not.toHaveBeenCalled();

    // Fast-forward 999ms -> not called yet
    vi.advanceTimersByTime(999);
    expect(onRestartOffer).not.toHaveBeenCalled();

    // Advance 1ms (total 1000ms) -> restart triggered
    vi.advanceTimersByTime(1);
    expect(pc.restartIceCalled).toBe(1);
    expect(onRestartOffer).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("resets backoff and triggers onReconnect when peer re-establishes connection", () => {
    const pc = new MockRTCPeerConnection();
    const onRestartOffer = vi.fn();
    const onReconnect = vi.fn();
    const onFail = vi.fn();

    const controller = configureIceRestart(pc as unknown as RTCPeerConnection, {
      onRestartOffer,
      onReconnect,
      onFail,
    });

    // 1. Initial connection
    pc.setState("connected");
    expect(onReconnect).not.toHaveBeenCalled(); // was not previously disconnected

    // 2. Disconnect
    pc.setState("disconnected");
    expect(controller.getRetryCount()).toBe(1);

    // 3. Reconnects before timeout
    pc.setState("connected");
    expect(controller.getRetryCount()).toBe(0);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("applies exponential backoff on multiple consecutive disconnects", () => {
    const pc = new MockRTCPeerConnection();
    const onRestartOffer = vi.fn();
    const onFail = vi.fn();

    const controller = configureIceRestart(pc as unknown as RTCPeerConnection, {
      onRestartOffer,
      onFail,
      backoffSchedule: [1000, 2000, 4000],
    });

    // Strike 1: 1000ms
    pc.setState("disconnected");
    expect(controller.getRetryCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(onRestartOffer).toHaveBeenCalledTimes(1);

    // Strike 2: 2000ms
    pc.setState("disconnected");
    expect(controller.getRetryCount()).toBe(2);
    vi.advanceTimersByTime(2000);
    expect(onRestartOffer).toHaveBeenCalledTimes(2);

    // Strike 3: 4000ms
    pc.setState("disconnected");
    expect(controller.getRetryCount()).toBe(3);
    vi.advanceTimersByTime(4000);
    expect(onRestartOffer).toHaveBeenCalledTimes(3);

    // Exceeded maxRetries (3 strikes) -> onFail triggered
    pc.setState("disconnected");
    expect(onFail).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("triggers onFail immediately if connection state becomes failed with no retries left", () => {
    const pc = new MockRTCPeerConnection();
    const onFail = vi.fn();

    const controller = configureIceRestart(pc as unknown as RTCPeerConnection, {
      maxRetries: 1,
      onFail,
    });

    pc.setState("disconnected");
    vi.advanceTimersByTime(1000);

    pc.setState("failed");
    expect(onFail).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("stops any scheduled restart when disposed", () => {
    const pc = new MockRTCPeerConnection();
    const onRestartOffer = vi.fn();

    const controller = configureIceRestart(pc as unknown as RTCPeerConnection, {
      onRestartOffer,
    });

    pc.setState("disconnected");
    controller.dispose();

    vi.advanceTimersByTime(5000);
    expect(onRestartOffer).not.toHaveBeenCalled();
  });
});
