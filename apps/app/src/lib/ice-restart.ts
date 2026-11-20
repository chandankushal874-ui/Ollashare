/**
 * WebRTC ICE Restart & Connection Recovery Controller
 *
 * Implements exponential backoff state machine for peer reconnection,
 * adhering to RFC 8829 / LiveKit reconnect specifications.
 */

export interface IceRestartOptions {
  onRestartOffer?: () => Promise<void> | void;
  onReconnect?: () => void;
  onFail?: (error?: Error) => void;
  maxRetries?: number;
  backoffSchedule?: number[];
}

export interface IceRestartController {
  getRetryCount: () => number;
  reset: () => void;
  dispose: () => void;
}

export function configureIceRestart(
  pc: RTCPeerConnection,
  options: IceRestartOptions = {},
): IceRestartController {
  const {
    onRestartOffer,
    onReconnect,
    onFail,
    maxRetries = 3,
    backoffSchedule = [1000, 2000, 4000],
  } = options;

  let retryCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wasDisconnected = false;
  let isDisposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleRestart = () => {
    if (isDisposed || pc.connectionState === "closed") return;

    if (retryCount >= maxRetries) {
      clearTimer();
      onFail?.(
        new Error(
          `WebRTC connection dropped: failed after ${maxRetries} ICE restart attempts`,
        ),
      );
      return;
    }

    const delay = backoffSchedule[retryCount] ?? 4000;
    retryCount++;

    clearTimer();
    timer = setTimeout(async () => {
      if (isDisposed || pc.connectionState === "closed") return;

      try {
        if (typeof pc.restartIce === "function") {
          pc.restartIce();
        }
        if (onRestartOffer) {
          await onRestartOffer();
        }
      } catch (err) {
        if (retryCount >= maxRetries) {
          onFail?.(
            err instanceof Error
              ? err
              : new Error("ICE restart offer generation failed"),
          );
        }
      }
    }, delay);
  };

  const handleStateChange = () => {
    if (isDisposed) return;
    const state = pc.connectionState;

    if (state === "connected") {
      clearTimer();
      retryCount = 0;
      if (wasDisconnected) {
        wasDisconnected = false;
        onReconnect?.();
      }
    } else if (state === "disconnected") {
      wasDisconnected = true;
      scheduleRestart();
    } else if (state === "failed") {
      wasDisconnected = true;
      if (retryCount < maxRetries && onRestartOffer) {
        scheduleRestart();
      } else {
        clearTimer();
        onFail?.(new Error("WebRTC peer connection failed"));
      }
    } else if (state === "closed") {
      clearTimer();
    }
  };

  pc.addEventListener("connectionstatechange", handleStateChange);

  return {
    getRetryCount: () => retryCount,
    reset: () => {
      clearTimer();
      retryCount = 0;
      wasDisconnected = false;
    },
    dispose: () => {
      isDisposed = true;
      clearTimer();
      try {
        pc.removeEventListener("connectionstatechange", handleStateChange);
      } catch {}
    },
  };
}
