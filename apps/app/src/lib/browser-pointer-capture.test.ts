// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachBrowserInputCapture } from "./browser-pointer-capture";
import type { SharerInputMessage } from "./remote-control";

let container: HTMLDivElement;
let sent: SharerInputMessage[];
let cleanup: () => void;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let release: ReturnType<typeof vi.fn<() => void>>;

function pointer(type: string, init: Record<string, unknown> = {}, target: Element = container) {
    // jsdom need not implement PointerEvent or real pointer capture for this unit suite.
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.entries({ clientX: 100, clientY: 120, pointerId: 7, pointerType: "touch", button: 0, ...init })
        .forEach(([key, value]) => Object.defineProperty(event, key, { value }));
    target.dispatchEvent(event);
    return event;
}
function frame() {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
}
function types() { return sent.map((input) => input.type); }

beforeEach(() => {
    container = document.createElement("div");
    container.tabIndex = 0;
    document.body.appendChild(container);
    container.setPointerCapture = vi.fn();
    container.releasePointerCapture = vi.fn();
    sent = [];
    frames = new Map();
    nextFrame = 0;
    release = vi.fn<() => void>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    cleanup = attachBrowserInputCapture(container, {
        coordinates: ({ clientX, clientY }) => clientX < 0 ? null : {
            x: clientX, y: clientY, sw: 1000, sh: 800, u: clientX / 1000, v: clientY / 800,
        },
        send: (input) => sent.push(input),
        release,
    });
});
afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
});

describe("browser pointer capture", () => {
    it.each(["mouse", "touch", "pen"])("preserves %s identity without compatibility mouse duplicates", (pointerType) => {
        pointer("pointerdown", { pointerType });
        container.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        pointer("pointerup", { pointerType });
        container.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        expect(types()).toEqual(["mouse_down", "mouse_up"]);
        expect(sent[0]).toMatchObject({ pointerId: 7, pointerType, button: "left", x: 100, u: 0.1 });
        expect(container.setPointerCapture).toHaveBeenCalledWith(7);
    });

    it("flushes coalesced moves before up; no stale move can arrive after the button boundary", () => {
        pointer("pointerdown");
        pointer("pointermove", { clientX: 140 });
        pointer("pointermove", { clientX: 180 });
        pointer("pointerup", { clientX: 200 });
        frame();
        expect(types()).toEqual(["mouse_down", "mouse_move", "mouse_up"]);
        expect(sent[1]).toMatchObject({ x: 180, pointerId: 7, pointerType: "touch" });
        expect(sent[2]).toMatchObject({ x: 200 });
    });

    it.each(["pointercancel", "lostpointercapture"])("%s cancels once without activation or a later move/up", (type) => {
        pointer("pointerdown");
        pointer("pointermove");
        pointer(type);
        pointer("pointerup");
        frame();
        expect(types()).toEqual(["mouse_down", "mouse_cancel"]);
        expect(sent[1]).toMatchObject({ pointerId: 7, pointerType: "touch", button: "left", x: 100, y: 120 });
    });

    it("normal capture loss after up does not cancel the completed gesture", () => {
        pointer("pointerdown");
        pointer("pointerup");
        pointer("lostpointercapture");
        expect(types()).toEqual(["mouse_down", "mouse_up"]);
    });

    it("does not release a different touch contact", () => {
        pointer("pointerdown", { pointerId: 7 });
        pointer("pointerdown", { pointerId: 8 });
        pointer("pointercancel", { pointerId: 7 });
        pointer("pointerup", { pointerId: 8 });
        expect(sent[2]).toMatchObject({ type: "mouse_cancel", pointerId: 7 });
        expect(sent[3]).toMatchObject({ type: "mouse_up", pointerId: 8 });
    });

    it("release outside the active video cancels rather than clicking the last known point", () => {
        pointer("pointerdown");
        pointer("pointerup", { clientX: -1 });
        expect(types()).toEqual(["mouse_down", "mouse_cancel"]);
    });

    it("blur cancels held pointers and releases held keys exactly once", () => {
        pointer("pointerdown");
        container.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", key: "a", bubbles: true }));
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("blur"));
        expect(types()).toEqual(["mouse_down", "key_down", "mouse_cancel", "key_up"]);
        expect(sent[3]).toMatchObject({ key: "KeyA", modifiers: { ctrl: false, shift: false, alt: false, meta: false } });
    });

    it("pointer cancel also cleans held keys", () => {
        pointer("pointerdown");
        container.dispatchEvent(new KeyboardEvent("keydown", { code: "ShiftLeft", key: "Shift", bubbles: true }));
        pointer("pointercancel");
        expect(types()).toEqual(["mouse_down", "key_down", "mouse_cancel", "key_up"]);
    });

    it("cleanup drops scheduled moves and cancels held inputs without mouse_up", () => {
        pointer("pointerdown");
        pointer("pointermove");
        cleanup();
        cleanup = () => { };
        frame();
        expect(types()).toEqual(["mouse_down", "mouse_cancel"]);
    });

    it.each([0, 1, 2])("preserves fractional wheel deltas and deltaMode %s", (deltaMode) => {
        container.dispatchEvent(new WheelEvent("wheel", {
            clientX: 100, clientY: 120, deltaX: 0.125, deltaY: -0.375, deltaMode, bubbles: true, cancelable: true,
        }));
        expect(sent).toEqual([expect.objectContaining({ type: "mouse_wheel", dx: 0.125, dy: -0.375, deltaMode })]);
    });

    it("does not capture pointer/wheel/keyboard actions on guarded safety controls", () => {
        const guard = document.createElement("div");
        guard.setAttribute("data-mira-remote-guard", "true");
        const button = document.createElement("button");
        guard.appendChild(button);
        container.appendChild(guard);
        pointer("pointerdown", {}, button);
        pointer("pointerup", {}, button);
        button.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
        button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        expect(sent).toEqual([]);
    });

    it("capture-retargeted release over a safety badge cancels rather than clicking underneath", () => {
        const badge = document.createElement("div");
        badge.setAttribute("data-mira-remote-guard", "true");
        container.appendChild(badge);
        pointer("pointerdown");
        Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => badge });
        pointer("pointerup"); // target is container because pointer capture retargets it.
        expect(types()).toEqual(["mouse_down", "mouse_cancel"]);
        Reflect.deleteProperty(document, "elementFromPoint");
    });

    it("normal lostcapture after up does not release a still-held keyboard modifier", () => {
        pointer("pointerdown");
        container.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", bubbles: true }));
        pointer("pointerup");
        pointer("lostpointercapture");
        expect(types()).toEqual(["mouse_down", "key_down", "mouse_up"]);
        container.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", bubbles: true }));
        expect(types()).toEqual(["mouse_down", "key_down", "mouse_up", "key_up"]);
    });

    it("does not steal local shortcuts, Escape, or keys from outside the tile", () => {
        container.dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", ctrlKey: true, bubbles: true }));
        container.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true }));
        expect(sent).toEqual([]);
        expect(release).not.toHaveBeenCalled(); // Synthetic Escape is not a local user safety action.
    });

    it("releases a captured key after focus moves into a local input", () => {
        container.focus();
        container.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true }));
        const input = document.createElement("input");
        document.body.appendChild(input);
        input.focus();
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", code: "KeyA", bubbles: true }));
        expect(types()).toEqual(["key_down", "key_up"]);
    });
});
