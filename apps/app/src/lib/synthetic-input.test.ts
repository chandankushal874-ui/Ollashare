// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  MIRA_REMOTE_GUARD_ATTR,
  dispatchRemoteInputToPage,
  resetRemoteInputState,
  releaseAllRemoteInputs,
} from "./synthetic-input";

/**
 * Regression suite for the remote-control synthetic input dispatcher.
 *
 * Covers the exact failure modes reported in production:
 *  - every click swallowed by the old page-wide guard (root div wrapped the app)
 *  - user handlers firing twice (dispatch + .click() double activation)
 *  - clicks that never activate checkboxes (missing safe default action)
 *  - focus never landing on the focused control (typing after click impossible)
 *  - phantom clicks from stray mouse_up without a press
 *  - coordinate mapping / clamping drift
 */

let hitStack: Element[] = [];

beforeEach(() => {
  resetRemoteInputState();
  hitStack = [];
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    writable: true,
    value: () => hitStack,
  });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
  document.body.innerHTML = "";
});

afterEach(() => {
  releaseAllRemoteInputs();
  vi.restoreAllMocks();
});

function pressRelease(target: Element, x = 960, y = 540) {
  hitStack = [target, document.body, document.documentElement];
  dispatchRemoteInputToPage({ type: "mouse_down", x, y, sw: 1920, sh: 1080, button: "left" });
  dispatchRemoteInputToPage({ type: "mouse_up", x, y, sw: 1920, sh: 1080, button: "left" });
}

describe("dispatchRemoteInputToPage — click exactly-once semantics", () => {
  it("fires a button click listener EXACTLY once per press-release pair", () => {
    const btn = document.createElement("button");
    const onClick = vi.fn();
    btn.addEventListener("click", onClick);
    document.body.appendChild(btn);

    pressRelease(btn);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("dispatches pointerdown/pointerup and mousedown/mouseup once each", () => {
    const btn = document.createElement("button");
    const counts = { pointerdown: 0, pointerup: 0, mousedown: 0, mouseup: 0 };
    btn.addEventListener("pointerdown", () => counts.pointerdown++);
    btn.addEventListener("pointerup", () => counts.pointerup++);
    btn.addEventListener("mousedown", () => counts.mousedown++);
    btn.addEventListener("mouseup", () => counts.mouseup++);
    document.body.appendChild(btn);

    pressRelease(btn);

    expect(counts).toEqual({ pointerdown: 1, pointerup: 1, mousedown: 1, mouseup: 1 });
  });

  it("does NOT click when mouse_up arrives without a prior mouse_down (phantom protection)", () => {
    const btn = document.createElement("button");
    const onClick = vi.fn();
    btn.addEventListener("click", onClick);
    document.body.appendChild(btn);

    hitStack = [btn, document.body];
    dispatchRemoteInputToPage({ type: "mouse_up", x: 960, y: 540, sw: 1920, sh: 1080, button: "left" });

    expect(onClick).not.toHaveBeenCalled();
  });

  it("does not click on right-button release", () => {
    const div = document.createElement("div");
    const onClick = vi.fn();
    div.addEventListener("click", onClick);
    document.body.appendChild(div);

    hitStack = [div, document.body];
    dispatchRemoteInputToPage({ type: "mouse_down", x: 960, y: 540, sw: 1920, sh: 1080, button: "right" });
    dispatchRemoteInputToPage({ type: "mouse_up", x: 960, y: 540, sw: 1920, sh: 1080, button: "right" });

    expect(onClick).not.toHaveBeenCalled();
  });

  it("resetRemoteInputState clears a dangling press (revoke mid-drag)", () => {
    const btn = document.createElement("button");
    const onClick = vi.fn();
    btn.addEventListener("click", onClick);
    document.body.appendChild(btn);

    hitStack = [btn, document.body];
    dispatchRemoteInputToPage({ type: "mouse_down", x: 960, y: 540, sw: 1920, sh: 1080, button: "left" });
    resetRemoteInputState();
    dispatchRemoteInputToPage({ type: "mouse_up", x: 960, y: 540, sw: 1920, sh: 1080, button: "left" });

    expect(onClick).not.toHaveBeenCalled();
  });

  it("activates checkbox default behavior (toggles once) via one click event", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.appendChild(checkbox);

    pressRelease(checkbox);

    expect(checkbox.checked).toBe(true);
  });

  it("clicks a nested span inside a button via its activation ancestor, once", () => {
    const btn = document.createElement("button");
    const span = document.createElement("span");
    span.textContent = "label";
    btn.appendChild(span);
    const onClick = vi.fn();
    btn.addEventListener("click", onClick);
    document.body.appendChild(btn);

    pressRelease(span);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("dispatches a coordinate-accurate click event for plain (non-activation) elements", () => {
    const canvasLike = document.createElement("div");
    const events: MouseEvent[] = [];
    canvasLike.addEventListener("click", (e) => events.push(e as MouseEvent));
    document.body.appendChild(canvasLike);

    pressRelease(canvasLike);

    expect(events).toHaveLength(1);
    expect(events[0]?.clientX).toBe(640);
    expect(events[0]?.clientY).toBe(360);
  });
});

describe("dispatchRemoteInputToPage — remote guard", () => {
  it("blocks clicks aimed at guarded control surfaces (revoke pill, request dialog)", () => {
    const guard = document.createElement("div");
    guard.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    const revokeBtn = document.createElement("button");
    guard.appendChild(revokeBtn);
    document.body.appendChild(guard);

    const onClick = vi.fn();
    revokeBtn.addEventListener("click", onClick);

    pressRelease(revokeBtn);

    expect(onClick).not.toHaveBeenCalled();
  });

  it("still clicks regular page content OUTSIDE the guard (previously the whole app was guarded)", () => {
    const guard = document.createElement("div");
    guard.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    document.body.appendChild(guard);

    const contentBtn = document.createElement("button");
    document.body.appendChild(contentBtn);
    const onClick = vi.fn();
    contentBtn.addEventListener("click", onClick);

    pressRelease(contentBtn);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("suppresses wheel over guarded surfaces", () => {
    const guard = document.createElement("div");
    guard.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    document.body.appendChild(guard);
    const onWheel = vi.fn();
    guard.addEventListener("wheel", onWheel);

    hitStack = [guard, document.body];
    dispatchRemoteInputToPage({ type: "mouse_wheel", x: 960, y: 540, sw: 1920, sh: 1080, dx: 0, dy: 120 });

    expect(onWheel).not.toHaveBeenCalled();
  });
});

describe("dispatchRemoteInputToPage — coordinate mapping and focus", () => {
  it("maps stream pixels to viewport pixels with clamping (1920x1080 -> 1280x720)", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const moves: MouseEvent[] = [];
    el.addEventListener("mousemove", (e) => moves.push(e as MouseEvent));

    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_move", x: 960, y: 540, sw: 1920, sh: 1080 });

    expect(moves).toHaveLength(1);
    expect(moves[0]?.clientX).toBe(640);
    expect(moves[0]?.clientY).toBe(360);
  });

  it("clamps out-of-bounds stream coordinates into the viewport", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const moves: MouseEvent[] = [];
    el.addEventListener("mousemove", (e) => moves.push(e as MouseEvent));

    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_move", x: 99999, y: -50, sw: 1920, sh: 1080 });

    expect(moves[0]?.clientX).toBe(1279);
    expect(moves[0]?.clientY).toBe(0);
  });

  it("focuses the nearest focusable ancestor on mouse_down (typing after click works)", () => {
    const wrap = document.createElement("div");
    const field = document.createElement("input");
    field.type = "text";
    wrap.appendChild(field);
    document.body.appendChild(wrap);

    hitStack = [field, wrap, document.body];
    dispatchRemoteInputToPage({ type: "mouse_down", x: 100, y: 100, sw: 1920, sh: 1080, button: "left" });

    expect(document.activeElement).toBe(field);
  });

  it("focuses a button when the press lands on its inner span", () => {
    const btn = document.createElement("button");
    const span = document.createElement("span");
    span.textContent = "go";
    btn.appendChild(span);
    document.body.appendChild(btn);

    hitStack = [span, btn, document.body];
    dispatchRemoteInputToPage({ type: "mouse_down", x: 100, y: 100, sw: 1920, sh: 1080, button: "left" });

    expect(document.activeElement).toBe(btn);
  });
});

describe("dispatchRemoteInputToPage — keyboard", () => {
  it("replays keydown/keyup on the focused element with mapped key chars", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();

    const keys: string[] = [];
    input.addEventListener("keydown", (e) => keys.push((e as KeyboardEvent).key));

    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    dispatchRemoteInputToPage({ type: "key_up", key: "KeyA" });

    expect(keys).toEqual(["a"]);
    expect(input.value).toBe("a");
  });

  it("Backspace removes the last character from a focused input", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = "hello";
    document.body.appendChild(input);
    input.focus();

    dispatchRemoteInputToPage({ type: "key_down", key: "Backspace" });

    expect(input.value).toBe("hell");
  });

  it("Digit and Space keys append the correct characters", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();

    dispatchRemoteInputToPage({ type: "key_down", key: "Digit7" });
    dispatchRemoteInputToPage({ type: "key_down", key: "Space" });

    expect(input.value).toBe("7 ");
  });

  it("RC-2026-10-19: key events carry modifier state (shift/ctrl/alt/meta) via getModifierState", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();

    const states: Array<Record<string, unknown>> = [];
    input.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      states.push({ key: ke.key, shift: ke.getModifierState?.("Shift"), ctrl: ke.getModifierState?.("Control") });
    });

    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA", modifiers: { shift: true, ctrl: true } });

    expect(states).toHaveLength(1);
    expect(states[0]?.shift).toBe(true);
    expect(states[0]?.ctrl).toBe(true);
  });

  it("RC-2026-10-19: Shift+KeyA produces uppercase 'A' in a text input", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();

    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA", modifiers: { shift: true } });

    expect(input.value).toBe("A");
  });

  it("RC-2026-10-19: Delete removes the character AFTER the caret (start of input)", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = "hello";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(0, 0); // caret at start — Delete removes 'h'

    dispatchRemoteInputToPage({ type: "key_down", key: "Delete" });

    expect(input.value).toBe("ello");
  });

  it("RC-2026-10-19: ArrowLeft/ArrowRight move the caret and do not type characters", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.value = "abc";
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(3, 3); // caret at end

    dispatchRemoteInputToPage({ type: "key_down", key: "ArrowLeft" });

    expect(input.selectionStart).toBe(2);
    expect(input.value).toBe("abc");
  });

  it("RC-2026-10-19: Tab inserts nothing in a plain input but propagates a keydown with key 'Tab'", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();

    const keys: string[] = [];
    input.addEventListener("keydown", (e) => keys.push((e as KeyboardEvent).key));

    dispatchRemoteInputToPage({ type: "key_down", key: "Tab" });

    expect(keys).toEqual(["Tab"]);
    expect(input.value).toBe(""); // no character inserted
  });

  it("RC-2026-10-19: Enter inside a form submits it (requestSubmit)", () => {
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.type = "text";
    form.appendChild(input);
    document.body.appendChild(form);
    input.focus();

    let submitted = false;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitted = true;
    });

    dispatchRemoteInputToPage({ type: "key_down", key: "Enter" });

    expect(submitted).toBe(true);
  });
});

describe("dispatchRemoteInputToPage — wheel", () => {
  it("dispatches a wheel event with the remote deltas", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const wheelEvents: WheelEvent[] = [];
    el.addEventListener("wheel", (e) => wheelEvents.push(e as WheelEvent));

    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_wheel", x: 960, y: 540, sw: 1920, sh: 1080, dx: 5, dy: 120 });

    expect(wheelEvents).toHaveLength(1);
    expect(wheelEvents[0]?.deltaY).toBe(120);
    expect(wheelEvents[0]?.deltaX).toBe(5);
  });
});

describe("RC-2026-10-19 B: normalized (u,v) coordinate mapping", () => {
  it("maps u,v to the same viewport point regardless of stream resolution (u,v preferred)", () => {
    // Same normalized position (0.25, 0.75) but completely different stream sizes:
    // a legacy 1920x1080 stream and a 2560x1440 stream must land identically.
    const events: { x: number; y: number }[] = [];
    const el = document.createElement("div");
    el.addEventListener("mousemove", (e) => events.push({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY }));
    document.body.appendChild(el);

    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_move", x: 480, y: 810, sw: 1920, sh: 1080, u: 0.25, v: 0.75 });
    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_move", x: 640, y: 1080, sw: 2560, sh: 1440, u: 0.25, v: 0.75 });

    // 1280x720 window: u=0.25 -> 320, v=0.75 -> 540 — both streams identical
    expect(events).toEqual([
      { x: 320, y: 540 },
      { x: 320, y: 540 },
    ]);
  });

  it("falls back to stream-pixel math when u,v are absent (legacy sharer compatibility)", () => {
    const events: { x: number; y: number }[] = [];
    const el = document.createElement("div");
    el.addEventListener("mousemove", (e) => events.push({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY }));
    document.body.appendChild(el);

    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_move", x: 960, y: 540, sw: 1920, sh: 1080 });

    expect(events).toEqual([{ x: 640, y: 360 }]); // 960/1920*1280, 540/1080*720
  });

  it("clamps normalized coordinates into the viewport (never negative, never off-window)", () => {
    const events: { x: number; y: number }[] = [];
    const el = document.createElement("div");
    el.addEventListener("mousemove", (e) => events.push({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY }));
    document.body.appendChild(el);

    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_move", x: 0, y: 0, sw: 1920, sh: 1080, u: -0.5, v: 1.7 });

    expect(events).toEqual([{ x: 0, y: 719 }]); // clamped to [0, innerWidth-1] / [0, innerHeight-1]
  });

  it("u,v survives mid-session window resize without recalculating stream pixels", () => {
    // Guest window shrinks from 1280x720 to 800x600 — same u,v maps to new point.
    const events: { x: number; y: number }[] = [];
    const el = document.createElement("div");
    el.addEventListener("mousemove", (e) => events.push({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY }));
    document.body.appendChild(el);

    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_move", x: 480, y: 270, sw: 1920, sh: 1080, u: 0.25, v: 0.25 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_move", x: 480, y: 270, sw: 1920, sh: 1080, u: 0.25, v: 0.25 });

    expect(events).toEqual([
      { x: 320, y: 180 }, // 0.25 * 1280, 0.25 * 720
      { x: 200, y: 150 }, // 0.25 * 800, 0.25 * 600
    ]);
  });
});

describe("RC-2026-10-19 C: stuck-input release (disconnect/revoke safety)", () => {
  it("releases a held left button: releaseAllRemoteInputs synthesizes mouseup for pressed buttons", () => {
    const btn = document.createElement("button");
    const events: string[] = [];
    btn.addEventListener("mouseup", () => events.push("mouseup"));
    btn.addEventListener("click", () => events.push("click"));
    document.body.appendChild(btn);

    // Host pressed but never released (disconnect scenario)
    hitStack = [btn, document.body];
    dispatchRemoteInputToPage({ type: "mouse_down", x: 100, y: 100, sw: 1920, sh: 1080, button: "left" });

    releaseAllRemoteInputs();

    // mouseup IS synthesized (so held-state listeners unstick), but NO click —
    // releasing stuck inputs must never fabricate a phantom click.
    expect(events).toEqual(["mouseup"]);
  });

  it("releases multiple held buttons (left + right) independently", () => {
    const el = document.createElement("div");
    const ups: number[] = [];
    el.addEventListener("mouseup", (e) => ups.push((e as MouseEvent).button));
    document.body.appendChild(el);

    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_down", x: 100, y: 100, sw: 1920, sh: 1080, button: "left" });
    hitStack = [el, document.body];
    dispatchRemoteInputToPage({ type: "mouse_down", x: 100, y: 100, sw: 1920, sh: 1080, button: "right" });

    releaseAllRemoteInputs();

    expect(ups.sort()).toEqual([0, 2]);
  });

  it("releases held keys: keyup is synthesized for every key still down", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);
    input.focus();

    const ups: string[] = [];
    input.addEventListener("keyup", (e) => ups.push((e as KeyboardEvent).code));

    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    dispatchRemoteInputToPage({ type: "key_down", key: "ShiftLeft" });

    releaseAllRemoteInputs();

    expect(ups.sort()).toEqual(["KeyA", "ShiftLeft"]);
  });

  it("is idempotent — calling with nothing held dispatches nothing", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const ups: string[] = [];
    input.addEventListener("keyup", (e) => ups.push((e as KeyboardEvent).code));

    releaseAllRemoteInputs();
    releaseAllRemoteInputs();

    expect(ups).toEqual([]);
  });
});

// Intentionally use the dispatcher's parameter type while the separate protocol
// change is being integrated; these tests also work after that change lands.
type SyntheticMessage = Parameters<typeof dispatchRemoteInputToPage>[0];
function pointer(type: "mouse_down" | "mouse_up" | "mouse_move" | "mouse_cancel", extra: Partial<SyntheticMessage> = {}) {
  dispatchRemoteInputToPage({ type, x: 100, y: 100, sw: 1280, sh: 720, button: "left", ...extra } as SyntheticMessage);
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K) {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  hitStack = [el, document.body];
  return el;
}

describe("browser-only pointer safety", () => {
  it("preserves touch pointer identity and does not release a different contact", () => {
    const btn = element("button");
    const events: Array<[string, number, string, number]> = [];
    for (const name of ["pointerdown", "pointermove", "pointerup"]) {
      btn.addEventListener(name, (e) => {
        const p = e as PointerEvent;
        events.push([name, p.pointerId, p.pointerType, p.buttons]);
      });
    }
    const click = vi.fn();
    btn.addEventListener("click", click);
    pointer("mouse_down", { pointerId: 42, pointerType: "touch" });
    pointer("mouse_up", { pointerId: 43, pointerType: "touch" });
    pointer("mouse_move", { pointerId: 42, pointerType: "touch" });
    pointer("mouse_up", { pointerId: 42, pointerType: "touch" });
    expect(events).toEqual([["pointerdown", 42, "touch", 1], ["pointermove", 42, "touch", 1], ["pointerup", 42, "touch", 0]]);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("cancels a pen contact without a click, even when cancellation hits a guard", () => {
    const btn = element("button");
    const cancel = vi.fn();
    const click = vi.fn();
    btn.addEventListener("pointercancel", cancel);
    btn.addEventListener("click", click);
    pointer("mouse_down", { pointerId: 7, pointerType: "pen" });
    const guard = element("button");
    guard.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    const guarded = vi.fn();
    guard.addEventListener("pointercancel", guarded);
    pointer("mouse_cancel", { pointerId: 7, pointerType: "pen", x: 400 });
    hitStack = [btn];
    pointer("mouse_up", { pointerId: 7, pointerType: "pen" });
    releaseAllRemoteInputs();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]?.[0]).toMatchObject({ pointerId: 7, pointerType: "pen", buttons: 0, clientX: 400 });
    expect(click).not.toHaveBeenCalled();
    expect(guarded).not.toHaveBeenCalled();
  });

  it("keeps simultaneous touch contacts separate and activates only the primary contact", () => {
    const btn = element("button");
    const down: Array<[number, boolean]> = [];
    const cancel = vi.fn();
    const click = vi.fn();
    btn.addEventListener("pointerdown", (e) => down.push([(e as PointerEvent).pointerId, (e as PointerEvent).isPrimary]));
    btn.addEventListener("pointercancel", cancel);
    btn.addEventListener("click", click);
    pointer("mouse_down", { pointerId: 10, pointerType: "touch" });
    pointer("mouse_down", { pointerId: 11, pointerType: "touch" });
    pointer("mouse_cancel", { pointerId: 10, pointerType: "touch" });
    pointer("mouse_up", { pointerId: 11, pointerType: "touch" });
    expect(down).toEqual([[10, true], [11, false]]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
  });

  it.each([false, true])("suppresses a drag click (returns to initial point: %s)", (returns) => {
    const btn = element("button");
    const click = vi.fn();
    btn.addEventListener("click", click);
    pointer("mouse_down");
    pointer("mouse_move", { x: 140 });
    pointer("mouse_up", { x: returns ? 100 : 140 });
    expect(click).not.toHaveBeenCalled();
  });

  it("allows small pointer jitter and a matching activation ancestor", () => {
    const btn = element("button");
    const span = document.createElement("span");
    btn.appendChild(span);
    const click = vi.fn();
    btn.addEventListener("click", click);
    hitStack = [span];
    pointer("mouse_down");
    hitStack = [btn];
    pointer("mouse_up", { x: 102, y: 101 });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("releases the press target without clicking a mismatched release target", () => {
    const first = element("button");
    const up = vi.fn();
    const click = vi.fn();
    first.addEventListener("mouseup", up);
    first.addEventListener("click", click);
    pointer("mouse_down");
    const second = element("button");
    second.addEventListener("click", click);
    pointer("mouse_up");
    releaseAllRemoteInputs();
    expect(up).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
  });

  it.each(["release", "revoke", "reset"])("cleans held inputs when the last hit is guarded: %s", (method) => {
    const btn = element("button");
    const events: string[] = [];
    btn.addEventListener("mouseup", () => events.push("up"));
    btn.addEventListener("click", () => events.push("click"));
    pointer("mouse_down");
    const guard = element("button");
    guard.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    const guarded = vi.fn();
    guard.addEventListener("mouseup", guarded);
    pointer("mouse_move");
    if (method === "release") pointer("mouse_up");
    else if (method === "revoke") releaseAllRemoteInputs();
    else resetRemoteInputState();
    hitStack = [btn];
    pointer("mouse_up");
    releaseAllRemoteInputs();
    expect(events).toEqual(["up"]);
    expect(guarded).not.toHaveBeenCalled();
  });

  it("reports all held buttons on down/move/up, not just the changed button", () => {
    const el = element("div");
    const masks: number[] = [];
    for (const name of ["mousedown", "mousemove", "mouseup"]) {
      el.addEventListener(name, (e) => masks.push((e as MouseEvent).buttons));
    }
    pointer("mouse_down");
    pointer("mouse_down", { button: "right" });
    pointer("mouse_move");
    pointer("mouse_up", { button: "right" });
    pointer("mouse_up");
    expect(masks).toEqual([1, 3, 3, 1, 0]);
  });

  it.each(["pointerdown", "mousedown"])("honors canceled %s without focusing or clicking", (name) => {
    const btn = element("button");
    btn.addEventListener(name, (e) => e.preventDefault());
    const click = vi.fn();
    btn.addEventListener("click", click);
    pressRelease(btn);
    expect(click).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(btn);
  });

  it("does not click if a pointerup handler revokes control", () => {
    const btn = element("button");
    btn.addEventListener("pointerup", releaseAllRemoteInputs);
    const click = vi.fn();
    btn.addEventListener("click", click);
    pressRelease(btn);
    expect(click).not.toHaveBeenCalled();
  });
});

describe("browser-only keyboard and default-action safety", () => {
  it("does not type or submit when focus is inside a guard", () => {
    const form = element("form");
    form.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    const field = document.createElement("input");
    form.appendChild(field);
    field.focus();
    const key = vi.fn();
    const submit = vi.fn();
    field.addEventListener("keydown", key);
    form.addEventListener("submit", submit);
    const request = vi.spyOn(form, "requestSubmit");
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    dispatchRemoteInputToPage({ type: "key_down", key: "Enter" });
    releaseAllRemoteInputs();
    expect(field.value).toBe("");
    expect(key).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("never focuses a guarded fallback keyboard target", () => {
    const field = element("input");
    field.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    pointer("mouse_move");
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    expect(document.activeElement).toBe(document.body);
    expect(field.value).toBe("");
  });

  it.each(["keyup", "revoke", "reset"])("releases a held key on its original target after guarded focus: %s", (method) => {
    const field = element("input");
    field.focus();
    const up = vi.fn();
    field.addEventListener("keyup", up);
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    const guard = element("input");
    guard.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    guard.focus();
    const guarded = vi.fn();
    guard.addEventListener("keyup", guarded);
    if (method === "keyup") dispatchRemoteInputToPage({ type: "key_up", key: "KeyA" });
    else if (method === "revoke") releaseAllRemoteInputs();
    else resetRemoteInputState();
    releaseAllRemoteInputs();
    expect(up).toHaveBeenCalledTimes(1);
    expect(guarded).not.toHaveBeenCalled();
  });

  it("honors canceled keydown for both edits and Enter submission", () => {
    const form = element("form");
    const field = document.createElement("input");
    form.appendChild(field);
    field.focus();
    field.addEventListener("keydown", (e) => e.preventDefault());
    const request = vi.spyOn(form, "requestSubmit");
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    dispatchRemoteInputToPage({ type: "key_down", key: "Enter" });
    expect(field.value).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["input", "textarea"] as const)("honors canceled beforeinput in %s", (tag) => {
    const field = element(tag);
    field.value = "abc";
    field.focus();
    field.setSelectionRange(3, 3);
    const input = vi.fn();
    const before: string[] = [];
    field.addEventListener("input", input);
    field.addEventListener("beforeinput", (e) => { before.push((e as InputEvent).inputType); e.preventDefault(); });
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    dispatchRemoteInputToPage({ type: "key_down", key: "Backspace" });
    expect(before).toEqual(["insertText", "deleteContentBackward"]);
    expect(field.value).toBe("abc");
    expect(input).not.toHaveBeenCalled();
  });

  it("emits beforeinput then input for edits, but no input for caret-only movement", () => {
    const field = element("input");
    field.focus();
    const events: string[] = [];
    field.addEventListener("beforeinput", () => events.push("beforeinput"));
    field.addEventListener("input", () => events.push("input"));
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    dispatchRemoteInputToPage({ type: "key_down", key: "ArrowLeft" });
    expect(field.value).toBe("a");
    expect(events).toEqual(["beforeinput", "input"]);
  });

  it("does not edit readonly inputs or replace checkbox values with text", () => {
    const field = element("input");
    field.readOnly = true;
    field.focus();
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    expect(field.value).toBe("");
    field.readOnly = false;
    field.type = "checkbox";
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    expect(field.value).toBe("on");
  });

  it.each(["keydown", "beforeinput"])("stops explicit edits when %s revokes control", (eventName) => {
    const field = element("input");
    field.focus();
    field.addEventListener(eventName, releaseAllRemoteInputs);
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    expect(field.value).toBe("");
  });

  it("edits email inputs and notifies listeners even without a selection API", () => {
    const field = element("input");
    field.type = "email";
    field.focus();
    const input = vi.fn();
    field.addEventListener("input", input);
    dispatchRemoteInputToPage({ type: "key_down", key: "KeyA" });
    expect(field.value).toBe("a");
    expect(input).toHaveBeenCalledTimes(1);
  });

  it("does not submit through a guarded default submit button", () => {
    const form = element("form");
    const field = document.createElement("input");
    const btn = document.createElement("button");
    btn.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    form.append(field, btn);
    field.focus();
    const request = vi.spyOn(form, "requestSubmit");
    dispatchRemoteInputToPage({ type: "key_down", key: "Enter" });
    expect(request).not.toHaveBeenCalled();
  });

  it("lets in-page submit handlers run once but cancels native form navigation", () => {
    const form = element("form");
    form.action = "https://example.com/logout";
    const field = document.createElement("input");
    form.appendChild(field);
    field.focus();
    const submit = vi.fn((e: Event) => expect(e.defaultPrevented).toBe(true));
    form.addEventListener("submit", submit);
    const nativeSubmit = vi.spyOn(form, "submit");
    dispatchRemoteInputToPage({ type: "key_down", key: "Enter" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(nativeSubmit).not.toHaveBeenCalled();
  });

  it.each(["https://example.com/logout", "/logout", "javascript:window.close()", "data:text/html,no", "#different"])("cancels native link navigation: %s", (href) => {
    const link = element("a");
    link.href = href;
    link.target = "_blank";
    link.download = "export";
    const click = vi.fn((e: Event) => expect(e.defaultPrevented).toBe(true));
    link.addEventListener("click", click);
    pressRelease(link);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("cancels file picker activation including an associated label", () => {
    const file = element("input");
    file.type = "file";
    file.id = "upload";
    const fileClick = vi.fn((e: Event) => expect(e.defaultPrevented).toBe(true));
    file.addEventListener("click", fileClick);
    pressRelease(file);
    expect(fileClick).toHaveBeenCalledTimes(1);
    const label = element("label");
    label.htmlFor = file.id;
    const click = vi.fn((e: Event) => expect(e.defaultPrevented).toBe(true));
    label.addEventListener("click", click);
    pressRelease(label);
    expect(click).toHaveBeenCalledTimes(1);
    expect(fileClick).toHaveBeenCalledTimes(1);
  });

  it("does not submit a guarded form through an external associated button", () => {
    const form = element("form");
    form.id = "protected-form";
    form.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    const btn = element("button");
    btn.setAttribute("form", form.id);
    const submit = vi.fn();
    form.addEventListener("submit", submit);
    pressRelease(btn);
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not activate a guarded control via an unguarded label", () => {
    const field = element("input");
    field.type = "checkbox";
    field.id = "guarded";
    field.setAttribute(MIRA_REMOTE_GUARD_ATTR, "true");
    const label = element("label");
    label.htmlFor = field.id;
    pressRelease(label);
    expect(field.checked).toBe(false);
  });

  it("activates a submit button once without native navigation", () => {
    const form = element("form");
    const btn = document.createElement("button");
    form.appendChild(btn);
    const click = vi.fn();
    const submit = vi.fn((e: Event) => expect(e.defaultPrevented).toBe(true));
    btn.addEventListener("click", click);
    form.addEventListener("submit", submit);
    pressRelease(btn);
    expect(click).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("honors click cancellation and disabled checkbox/button activation", () => {
    const checkbox = element("input");
    checkbox.type = "checkbox";
    checkbox.addEventListener("click", (e) => e.preventDefault());
    pressRelease(checkbox);
    expect(checkbox.checked).toBe(false);
    const btn = element("button");
    btn.disabled = true;
    const click = vi.fn();
    btn.addEventListener("click", click);
    pressRelease(btn);
    expect(click).not.toHaveBeenCalled();
  });

  it("React button/toggle handlers and checkbox state activate exactly once", () => {
    const container = element("div");
    const root = createRoot(container);
    const buttonClick = vi.fn();
    const checkboxChange = vi.fn();
    function Controls() {
      const [on, setOn] = useState(false);
      const [checked, setChecked] = useState(false);
      return createElement("div", null,
        createElement("button", { type: "button", onClick: () => { buttonClick(); setOn((old) => !old); } }, String(on)),
        createElement("input", {
          type: "checkbox", checked, onChange: (e: { target: { checked: boolean } }) => {
            checkboxChange(); setChecked(e.target.checked);
          }
        }));
    }
    try {
      flushSync(() => root.render(createElement(Controls)));
      const btn = container.querySelector("button")!;
      const checkbox = container.querySelector("input")!;
      flushSync(() => pressRelease(btn));
      flushSync(() => pressRelease(checkbox));
      expect(btn.textContent).toBe("true");
      expect(checkbox.checked).toBe(true);
      expect(buttonClick).toHaveBeenCalledTimes(1);
      expect(checkboxChange).toHaveBeenCalledTimes(1);
    } finally { flushSync(() => root.unmount()); }
  });
});

function scrollBox(parent?: Element) {
  const el = document.createElement("div");
  (parent ?? document.body).appendChild(el);
  el.style.overflowY = "auto";
  el.style.overflowX = "auto";
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, value: 500 }, clientHeight: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: 500 }, clientWidth: { configurable: true, value: 100 },
  });
  hitStack = [el];
  return el;
}
function wheel(dx: number, dy: number, deltaMode: 0 | 1 | 2 = 0) {
  dispatchRemoteInputToPage({ type: "mouse_wheel", x: 100, y: 100, sw: 1280, sh: 720, dx, dy, deltaMode });
}

describe("browser-only precision wheel fallback", () => {
  it("accumulates fractional trackpad deltas without dropping or doubling them", () => {
    const box = scrollBox();
    const deltas: number[] = [];
    box.addEventListener("wheel", (e) => deltas.push((e as WheelEvent).deltaY));
    for (let i = 0; i < 8; i++) wheel(0.25, 0.25);
    expect(deltas).toEqual(Array(8).fill(0.25));
    expect(box.scrollTop).toBe(2);
    expect(box.scrollLeft).toBe(2);
    for (let i = 0; i < 4; i++) wheel(-0.25, -0.25);
    expect(box.scrollTop).toBe(1);
    expect(box.scrollLeft).toBe(1);
  });

  it("preserves wheel deltaMode for listeners and normalizes line units for scrolling", () => {
    const box = scrollBox();
    box.style.lineHeight = "20px";
    const events: WheelEvent[] = [];
    box.addEventListener("wheel", (e) => events.push(e as WheelEvent));
    wheel(0.25, 0.5, 1);
    expect(events[0]).toMatchObject({ deltaMode: 1, deltaX: 0.25, deltaY: 0.5 });
    expect(box.scrollLeft).toBe(5);
    expect(box.scrollTop).toBe(10);
  });

  it("normalizes fractional page units using viewport dimensions", () => {
    const box = scrollBox();
    wheel(0.125, 0.25, 2);
    expect(box.scrollLeft).toBe(160);
    expect(box.scrollTop).toBe(180);
  });

  it("honors preventDefault without explicit scroll", () => {
    const box = scrollBox();
    const rootScroll = vi.spyOn(window, "scrollBy").mockImplementation(() => { });
    box.addEventListener("wheel", (e) => e.preventDefault());
    wheel(10, 100);
    expect(box.scrollTop).toBe(0);
    expect(rootScroll).not.toHaveBeenCalled();
  });

  it("chains each axis independently through exhausted ancestors", () => {
    const outer = scrollBox();
    const inner = scrollBox(outer);
    inner.scrollTop = 395;
    wheel(3, 20);
    expect(inner.scrollLeft).toBe(3);
    expect(inner.scrollTop).toBe(400);
    expect(outer.scrollTop).toBe(15);
  });

  it("scrolls an ancestor when the inner container is already at its edge", () => {
    const outer = scrollBox();
    const inner = scrollBox(outer);
    inner.scrollTop = 400;
    wheel(0, 5);
    expect(inner.scrollTop).toBe(400);
    expect(outer.scrollTop).toBe(5);
  });

  it("preserves fractional root scrolling and clears its remainder on revoke", () => {
    const rootScroll = vi.spyOn(window, "scrollBy").mockImplementation(() => { });
    hitStack = [];
    wheel(0, 0.5);
    wheel(0, 0.5);
    expect(rootScroll).toHaveBeenCalledTimes(1);
    expect(rootScroll).toHaveBeenLastCalledWith({ left: 0, top: 1, behavior: "instant" });
    wheel(0, 0.75);
    releaseAllRemoteInputs();
    wheel(0, 0.5);
    expect(rootScroll).toHaveBeenCalledTimes(1);
  });

  it("does not carry fractional remainders across reset", () => {
    const box = scrollBox();
    wheel(0, 0.75);
    resetRemoteInputState();
    wheel(0, 0.5);
    expect(box.scrollTop).toBe(0);
  });
});
