/**
 * Synthetic DOM input dispatcher — receiver side of the remote-control pipeline.
 *
 * Architecture
 * ------------
 * The controlling host sends normalized `SharerInputMessage`s (coordinates in the
 * shared stream's native pixel space, "mira-screen-share/sharer" protocol). This
 * module maps them onto the local viewport and replays them as synthetic DOM
 * events on the guest's page:
 *
 *   mouse_move    -> pointermove + mousemove
 *   mouse_down    -> pointerdown + mousedown (+ focus nearest focusable ancestor)
 *   mouse_up      -> pointerup + mouseup + one click for an unmoved matching press
 *   mouse_cancel  -> pointercancel + held mouse release, never click
 *   mouse_wheel   -> wheel + scrollable-ancestor scroll fallback
 *   key_down/up   -> keydown/keyup (+ input/textarea/contenteditable value edits)
 *
 * Safety guard
 * ------------
 * Elements (and their subtrees) marked with `data-mira-remote-guard="true"` are
 * immune to remote gestures. This protects safety-critical control surfaces such
 * as the guest's "Revoke Control" pill and the incoming-request dialog. The guard
 * is deliberately narrow — the old broad `[data-mira-dashboard-ui]` page-level
 * guard swallowed *every* click (the root element wraps the whole app), which made
 * remote clicks appear dead. Only explicitly marked subtrees are guarded now.
 *
 * Exactly-once, page-local activation
 * ----------------------------------
 * One coordinate-accurate click preserves native checkbox/details activation and
 * React handlers. Dangerous browser defaults and native form navigation are
 * canceled; in-page submit handlers can still run. This is not a sandbox for page
 * JavaScript: only dispatch into the controlled application. Untrusted DOM events
 * cannot guarantee native dragging, text selection, pickers or privileged input.
 */

import type { SharerInputMessage, KeyModifiers } from "./remote-control";

/** Attribute marking a subtree as immune to remote-control gestures. */
export const MIRA_REMOTE_GUARD_ATTR = "data-mira-remote-guard";

const GUARD_SELECTOR = `[${MIRA_REMOTE_GUARD_ATTR}='true']`;
const FOCUSABLE_SELECTOR =
  "button, a[href], input:not([type='hidden']), select, textarea, [contenteditable='true'], [tabindex]";
const ACTIVATION_SELECTOR =
  "a[href], button, input, select, textarea, summary, label, [role='button'], [role='menuitem'], [role='tab'], [role='option'], [role='switch'], [role='checkbox'], [role='radio']";

// Local compatibility shape until the protocol owner's metadata/cancel change lands.
// Existing protocol messages remain assignable; do not change the wire protocol here.
type PointerMetadata = { pointerId?: number; pointerType?: "mouse" | "touch" | "pen" };
type MouseInput = (Extract<
  SharerInputMessage,
  { type: "mouse_move" | "mouse_down" | "mouse_up" }
> | {
  type: "mouse_cancel";
  x: number;
  y: number;
  sw?: number;
  sh?: number;
  button?: "left" | "right" | "middle";
}) & PointerMetadata & { u?: number; v?: number };
type WheelInput = Extract<SharerInputMessage, { type: "mouse_wheel" }> & {
  u?: number; v?: number; deltaMode?: 0 | 1 | 2;
};
type SyntheticInput = SharerInputMessage | MouseInput | WheelInput;
type KeyInput = Extract<SharerInputMessage, { type: "key_down" | "key_up" }> & { modifiers?: KeyModifiers };

function isGuarded(el: Element | null): boolean {
  try {
    return Boolean(el && el.closest && el.closest(GUARD_SELECTOR));
  } catch {
    return false;
  }
}

/**
 * Map stream-pixel coordinates onto the current viewport (clamped).
 *
 * v2 (2026-10-19): when the message carries normalized `u`/`v` (0..1 relative to the
 * ACTIVE VIDEO IMAGE — immune to host/guest resolution differences and letterboxing),
 * those are authoritative and the stream-pixel fields are ignored. Legacy messages
 * without `u`/`v` keep the old stream-pixel ratio math (Rust sharer back-compat).
 */
function mapToViewport(
  x: number,
  y: number,
  sw?: number,
  sh?: number,
  u?: number,
  v?: number,
) {
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 720;
  if (typeof u === "number" && typeof v === "number" && Number.isFinite(u) && Number.isFinite(v)) {
    return mapNormalizedToViewport(u, v, vw, vh);
  }
  const streamW = sw || (typeof window !== "undefined" && window.screen?.width) || 1920;
  const streamH = sh || (typeof window !== "undefined" && window.screen?.height) || 1080;
  const clientX = Math.min(
    vw - 1,
    Math.max(0, Math.round((x / streamW) * vw)),
  );
  const clientY = Math.min(
    vh - 1,
    Math.max(0, Math.round((y / streamH) * vh)),
  );
  return { clientX, clientY };
}

/**
 * Map a normalized (0..1) remote position onto the guest's viewport.
 * Pure function — testable without a live DOM; `vw`/`vh` default to the live window
 * size but can be injected so resize/recompute paths can be unit-verified.
 * Out-of-range input is clamped (never negative, never off-window).
 */
export function mapNormalizedToViewport(
  u: number,
  v: number,
  vw: number = typeof window !== "undefined" ? window.innerWidth : 1280,
  vh: number = typeof window !== "undefined" ? window.innerHeight : 720,
): { clientX: number; clientY: number } {
  // DOM pointer coordinates are CSS pixels, not monitor/device pixels. Preserve
  // subpixel precision; multiplying by devicePixelRatio would misalign HiDPI input.
  const clientX = Math.min(vw - 1, Math.max(0, u * vw));
  const clientY = Math.min(vh - 1, Math.max(0, v * vh));
  return { clientX, clientY };
}

/**
 * Public coordinate mapping for remote-control messages (used by BOTH the synthetic
 * input dispatcher and the guest's visual cursor overlay so they can never disagree).
 * Prefers normalized u/v (v2 protocol) — falls back to stream-pixel ratio math for
 * legacy sharer messages.
 */
export function mapRemotePointToViewport(input: {
  x: number;
  y: number;
  sw?: number;
  sh?: number;
  u?: number;
  v?: number;
}): { clientX: number; clientY: number } {
  return mapToViewport(input.x, input.y, input.sw, input.sh, input.u, input.v);
}

/**
 * The element the host visually pointed at: the topmost hit-test candidate.
 * (What the host sees on the stream at that position is what must receive the
 * gesture — never content hidden underneath an overlay.)
 */
function topElementAt(clientX: number, clientY: number): Element | null {
  try {
    if (typeof document.elementsFromPoint === "function") {
      const stack = document.elementsFromPoint(clientX, clientY) as Element[];
      for (const el of stack) {
        if (el.tagName === "HTML" || el.tagName === "BODY") continue;
        return el;
      }
      return stack[0] ?? null;
    }
  } catch { }
  try {
    if (typeof document.elementFromPoint === "function") {
      return document.elementFromPoint(clientX, clientY);
    }
  } catch { }
  return document.body ?? null;
}

function focusNearestFocusable(el: Element | null): void {
  try {
    const focusable = el?.closest?.(FOCUSABLE_SELECTOR);
    if (focusable instanceof HTMLElement && !isGuarded(focusable) && !focusable.matches(":disabled")) {
      focusable.focus({ preventScroll: true });
    }
  } catch { }
}

function buttonCodeOf(input: MouseInput): number {
  const button = input.type === "mouse_move" ? "left" : input.button || "left";
  return button === "right" ? 2 : button === "middle" ? 1 : 0;
}

// UI Events `buttons` bitmask: 1=left, 4=middle, 2=right.
function buttonsMaskOf(buttonCode: number): number {
  return buttonCode === 2 ? 2 : buttonCode === 1 ? 4 : 1;
}

// screenX/Y must reflect where the injected point is on the MONITOR, not just
// clientX/Y. window.screenLeft/screenTop are deprecated/absent on Firefox and
// wrong on some multi-monitor layouts; prefer the modern screenX/screenY and
// fall back, then finally to 0 (clientX/Y are still correct for the page).
function screenXOf(clientX: number): number {
  const sx = typeof window !== "undefined" ? (window.screenX ?? window.screenLeft ?? 0) : 0;
  return clientX + sx;
}
function screenYOf(clientY: number): number {
  const sy = typeof window !== "undefined" ? (window.screenY ?? window.screenTop ?? 0) : 0;
  return clientY + sy;
}

function dispatchPointer(target: EventTarget, type: string, init: PointerEventInit): boolean {
  try {
    let event: MouseEvent;
    const { view: _view, ...eventInit } = init;
    if (typeof PointerEvent !== "undefined") event = new PointerEvent(type, eventInit);
    else {
      event = new MouseEvent(type, eventInit);
      // Preserve identity even in engines/shims without a PointerEvent constructor.
      for (const key of ["pointerId", "pointerType", "isPrimary"] as const) {
        Object.defineProperty(event, key, { value: init[key] });
      }
    }
    return target.dispatchEvent(event);
  } catch { return false; }
}

function dispatchMouse(target: EventTarget, type: string, init: MouseEventInit): boolean {
  try { const { view: _view, ...eventInit } = init; return target.dispatchEvent(new MouseEvent(type, eventInit)); }
  catch { return false; }
}

function dispatchWheel(target: EventTarget, init: WheelEventInit): WheelEvent | null {
  try {
    const evt = new WheelEvent("wheel", init);
    target.dispatchEvent(evt);
    return evt;
  } catch {
    try {
      const { view: _view, ...rest } = init;
      const evt = new WheelEvent("wheel", rest);
      target.dispatchEvent(evt);
      return evt;
    } catch { }
  }
  return null;
}

function dispatchKeyboard(target: EventTarget, type: string, init: KeyboardEventInit): boolean {
  try { const { view: _view, ...eventInit } = init; return target.dispatchEvent(new KeyboardEvent(type, eventInit)); }
  catch { return false; }
}

type Press = {
  target: Element;
  activation: Element;
  clientX: number;
  clientY: number;
  moved: boolean;
  allowed: boolean;
  mouse: boolean;
};
type PointerState = {
  pointerId: number;
  pointerType: "mouse" | "touch" | "pen";
  isPrimary: boolean;
  position: { clientX: number; clientY: number };
  presses: Map<number, Press>;
};
const pointers = new Map<string, PointerState>();
const pressedKeys = new Map<string, { target: EventTarget; init: KeyboardEventInit }>();
const CLICK_DRAG_THRESHOLD = 5; // viewport CSS pixels; crossing it remains a drag
let lastPointerPos = { clientX: 0, clientY: 0 };
let inputGeneration = 0;
let lastClick: { target: Element; time: number; x: number; y: number } | null = null;

function activationTarget(top: Element): Element {
  return top.closest(ACTIVATION_SELECTOR) ?? top;
}
function releaseTarget(target: EventTarget): EventTarget {
  return target instanceof Element && isGuarded(target) ? window : target;
}
function pointerInit(state: PointerState, button: number): PointerEventInit {
  return {
    ...state.position,
    screenX: screenXOf(state.position.clientX),
    screenY: screenYOf(state.position.clientY),
    pointerId: state.pointerId,
    pointerType: state.pointerType,
    isPrimary: state.isPrimary,
    button,
    buttons: [...state.presses.keys()].reduce((mask, b) => mask | buttonsMaskOf(b), 0),
    bubbles: true,
    cancelable: true,
    view: window,
  };
}
function cancelPointer(state: PointerState): void {
  const presses = [...state.presses];
  state.presses.clear(); // drain before listeners can revoke/reenter
  const first = presses[0];
  if (first) dispatchPointer(releaseTarget(first[1].target), "pointercancel", pointerInit(state, first[0]));
  for (const [button, press] of presses) {
    if (press.mouse) dispatchMouse(releaseTarget(press.target), "mouseup", pointerInit(state, button));
  }
}

/** Reset releases held events too; forgetting state leaves page listeners stuck. */
export function resetRemoteInputState(): void {
  releaseAllRemoteInputs();
  lastPointerPos = { clientX: 0, clientY: 0 };
  wheelRemainders = new WeakMap();
}

/** Cleanup uses original press targets/identity, never a guard under the last point. */
export function releaseAllRemoteInputs(): void {
  inputGeneration++;
  const heldPointers = [...pointers.values()];
  const heldKeys = [...pressedKeys.values()];
  pointers.clear();
  pressedKeys.clear();
  lastClick = null;
  wheelRemainders = new WeakMap();
  if (typeof window === "undefined" || typeof document === "undefined") return;
  for (const state of heldPointers) cancelPointer(state);
  for (const { target, init } of heldKeys) {
    dispatchKeyboard(releaseTarget(target), "keyup", {
      ...init, repeat: false,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false
    });
  }
}

function handleMouse(input: MouseInput): void {
  const position = mapRemotePointToViewport(input);
  lastPointerPos = position;
  const top = topElementAt(position.clientX, position.clientY);
  const pointerId = input.pointerId ?? 1;
  const pointerType = input.pointerType ?? "mouse";
  const identity = `${pointerType}:${pointerId}`;
  const button = buttonCodeOf(input);
  let state = pointers.get(identity);
  if (state) {
    state.position = position;
    for (const press of state.presses.values()) {
      if (Math.hypot(position.clientX - press.clientX, position.clientY - press.clientY) > CLICK_DRAG_THRESHOLD || isGuarded(top)) {
        press.moved = true;
      }
    }
  }
  if (input.type === "mouse_cancel") {
    if (state) { pointers.delete(identity); cancelPointer(state); }
    return;
  }
  const guarded = isGuarded(top);
  if (input.type === "mouse_down") {
    if (!top || guarded) return;
    if (!state) {
      state = {
        pointerId, pointerType, position, presses: new Map(),
        isPrimary: ![...pointers.values()].some((p) => p.pointerType === pointerType)
      };
      pointers.set(identity, state);
    }
    if (state.presses.has(button)) return;
    const press: Press = {
      target: top, activation: activationTarget(top), ...position,
      moved: false, allowed: true, mouse: false
    };
    state.presses.set(button, press);
    const generation = inputGeneration;
    press.allowed = dispatchPointer(top, "pointerdown", pointerInit(state, button));
    if (generation !== inputGeneration || !state.presses.has(button)) return;
    if (isGuarded(top)) press.allowed = false;
    if (press.allowed && (pointerType === "mouse" || state.isPrimary)) {
      press.mouse = true;
      press.allowed = dispatchMouse(top, "mousedown", { ...pointerInit(state, button), detail: 1 });
    }
    if (press.allowed && generation === inputGeneration && !isGuarded(top)) focusNearestFocusable(top);
    return;
  }
  if (input.type === "mouse_up") {
    const press = state?.presses.get(button);
    if (!state || !press) return;
    state.presses.delete(button);
    if (!state.presses.size) pointers.delete(identity);
    const generation = inputGeneration;
    // Always unstick listeners on the element that received the down, including
    // when release lands on another child of the same activation ancestor.
    const target = releaseTarget(press.target);
    const init = pointerInit(state, button);
    const pointerAllowed = dispatchPointer(target, "pointerup", init);
    const mouseAllowed = !press.mouse || dispatchMouse(releaseTarget(target), "mouseup", { ...init, detail: 1 });
    if (button === 0 && (pointerType === "mouse" || state.isPrimary) && !guarded && top && !press.moved && press.allowed && pointerAllowed && mouseAllowed &&
      generation === inputGeneration && press.target.isConnected && activationTarget(top) === press.activation) {
      fireExactlyOneClick(top, init);
    }
    if (button !== 0 && !guarded && top && !press.moved && press.allowed && pointerAllowed && mouseAllowed &&
      generation === inputGeneration && press.target.isConnected && activationTarget(top) === press.activation) {
      const event = new MouseEvent(button === 2 ? "contextmenu" : "auxclick", { ...init, button, buttons: 0 });
      // Application listeners may implement a menu; never invoke browser chrome,
      // middle-button navigation, downloads or a new tab.
      event.preventDefault();
      top.dispatchEvent(event);
    }
    return;
  }
  if (guarded || !top) return;
  const moveState = state ?? { pointerId, pointerType, isPrimary: true, position, presses: new Map<number, Press>() };
  const generation = inputGeneration;
  const moveTarget = state?.presses.values().next().value?.target ?? top;
  dispatchPointer(releaseTarget(moveTarget), "pointermove", pointerInit(moveState, -1));
  if (generation === inputGeneration && !isGuarded(top) &&
    (state ? [...state.presses.values()].some((press) => press.mouse) : pointerType === "mouse")) {
    dispatchMouse(releaseTarget(moveTarget), "mousemove", { ...pointerInit(moveState, 0), detail: 0 });
  }
}

/** Block native form navigation while still delivering in-page submit handlers. */
function withoutNativeSubmission(action: () => void): void {
  const preventNavigation = (event: Event) => event.preventDefault();
  window.addEventListener("submit", preventNavigation, true);
  try { action(); }
  finally { window.removeEventListener("submit", preventNavigation, true); }
}

function fireExactlyOneClick(top: Element, init: MouseEventInit): void {
  const target = activationTarget(top);
  if (isGuarded(top) || isGuarded(target) || target.matches(":disabled")) return;
  const label = target.closest("label");
  const control = label instanceof HTMLLabelElement ? label.control : null;
  if (control && (isGuarded(control) || control.matches(":disabled"))) return;
  const formControl = control ?? target;
  if ((formControl instanceof HTMLButtonElement || formControl instanceof HTMLInputElement) && isGuarded(formControl.form)) return;
  const unsafeControl = (el: Element | null) => Boolean(el?.matches("button[type='reset'], [popovertarget], [commandfor]")) ||
    (el instanceof HTMLInputElement &&
      !["button", "submit", "checkbox", "radio", "text", "search", "email", "tel", "url", "password", "number", "range"].includes(el.type));
  const { view: _view, ...eventInit } = init;
  const now = Date.now();
  const x = init.clientX ?? 0, y = init.clientY ?? 0;
  const double = lastClick?.target === target && now - lastClick.time < 500 &&
    Math.hypot(x - lastClick.x, y - lastClick.y) <= CLICK_DRAG_THRESHOLD;
  const event = new MouseEvent("click", { ...eventInit, button: 0, buttons: 0, detail: double ? 2 : 1 });
  // Even same-origin navigation can destroy the sharing session. Preserve page
  // handlers, never native href/download/target navigation, pickers or resets.
  if (target.closest("a[href], area[href], [download], [popovertarget], [commandfor], button[type='reset'], input[type='reset']") ||
    unsafeControl(target) || unsafeControl(control)) event.preventDefault();
  const generation = inputGeneration;
  withoutNativeSubmission(() => { target.dispatchEvent(event); });
  if (generation !== inputGeneration || !target.isConnected || isGuarded(target)) return;
  lastClick = double ? null : { target, time: now, x, y };
  if (double) {
    const doubleClick = new MouseEvent("dblclick", { ...eventInit, button: 0, buttons: 0, detail: 2 });
    doubleClick.preventDefault();
    target.dispatchEvent(doubleClick);
  }
}

// Integer scroll APIs in some engines discard tiny trackpad deltas. Carry their
// remainder per scroll destination/axis instead of rounding each packet to zero.
let wheelRemainders = new WeakMap<object, { x: number; y: number }>();
function wholeWheelDelta(target: object, axis: "x" | "y", delta: number): number {
  const remainder = wheelRemainders.get(target) ?? { x: 0, y: 0 };
  const total = remainder[axis] + delta;
  const whole = Math.trunc(total);
  remainder[axis] = total - whole;
  wheelRemainders.set(target, remainder);
  return whole;
}

function scrollWheelAxis(top: Element | null, axis: "x" | "y", delta: number): void {
  const horizontal = axis === "x";
  for (let el = top; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (isGuarded(el)) return;
    const style = window.getComputedStyle(el);
    const overflow = horizontal ? style.overflowX : style.overflowY;
    const max = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    if (!(overflow === "auto" || overflow === "scroll") || max <= 0) continue;
    const offset = horizontal ? el.scrollLeft : el.scrollTop;
    const available = delta > 0 ? max - offset : offset;
    if (available > 0) {
      const consumed = Math.sign(delta) * Math.min(Math.abs(delta), available);
      const whole = wholeWheelDelta(el, axis, consumed);
      if (horizontal) el.scrollLeft += whole;
      else el.scrollTop += whole;
      delta -= consumed;
      if (!delta) return;
    } else {
      // Don't replay a stale fraction if this axis later scrolls back from an edge.
      const remainder = wheelRemainders.get(el);
      if (remainder) remainder[axis] = 0;
    }
    const overscroll = horizontal ? style.overscrollBehaviorX : style.overscrollBehaviorY;
    if (overscroll === "contain" || overscroll === "none") return;
  }
  const whole = wholeWheelDelta(window, axis, delta);
  if (whole) window.scrollBy({ left: horizontal ? whole : 0, top: horizontal ? 0 : whole, behavior: "instant" });
}

function handleWheel(input: WheelInput): void {
  const { clientX, clientY } = mapRemotePointToViewport(input);
  const top = topElementAt(clientX, clientY);
  if (isGuarded(top) || !Number.isFinite(input.dx) || !Number.isFinite(input.dy)) return;
  const deltaMode = input.deltaMode === 1 || input.deltaMode === 2 ? input.deltaMode : 0;
  const generation = inputGeneration;
  const evt = dispatchWheel(top ?? window, {
    deltaX: input.dx, deltaY: input.dy, deltaMode, clientX, clientY,
    bubbles: true, cancelable: true, view: window,
  });
  if (!evt || evt.defaultPrevented || generation !== inputGeneration || isGuarded(top)) return;
  const style = top ? window.getComputedStyle(top) : null;
  const lineHeight = Number.parseFloat(style?.lineHeight ?? "") ||
    (Number.parseFloat(style?.fontSize ?? "") || 16) * 1.2;
  const scaleX = deltaMode === 1 ? lineHeight : deltaMode === 2 ? window.innerWidth : 1;
  const scaleY = deltaMode === 1 ? lineHeight : deltaMode === 2 ? window.innerHeight : 1;
  if (input.dx) scrollWheelAxis(top, "x", input.dx * scaleX);
  if (input.dy) scrollWheelAxis(top, "y", input.dy * scaleY);
}

/** Key code -> printable key mapping (KeyA -> "a", Digit1 -> "1", Space -> " "). */
function keyCharOf(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.charAt(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Space") return " ";
  return code;
}

/** Human-readable `key` for a KeyboardEvent from a code + modifier state. */
function keyLabelOf(code: string, modifiers?: KeyModifiers): string {
  const shift = modifiers?.shift === true;
  const base = keyCharOf(code);
  if (shift && code.startsWith("Key") && code.length === 4) return base.toUpperCase();
  if (shift && code === "Digit1") return "!";
  if (shift && code === "Digit2") return "@";
  if (shift && code === "Digit3") return "#";
  if (shift && code === "Digit4") return "$";
  if (shift && code === "Digit5") return "%";
  if (shift && code === "Digit6") return "^";
  if (shift && code === "Digit7") return "&";
  if (shift && code === "Digit8") return "*";
  if (shift && code === "Digit9") return "(";
  if (shift && code === "Digit0") return ")";
  // Non-printable keys keep their canonical names (Enter, Backspace, Tab, ArrowLeft...).
  return base;
}

/**
 * Apply a text-editing key to an input-like target. Mutates value/selection through
 * the same steps a real keystroke performs so React/validators observe them.
 * Returns true when the key was consumed as a text edit.
 */
const _inputValueSetter =
  typeof HTMLInputElement !== "undefined"
    ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
    : undefined;
const _textareaValueSetter =
  typeof HTMLTextAreaElement !== "undefined"
    ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    : undefined;

// Sets `value` via the NATIVE prototype setter, not the instance property. React's
// controlled inputs track `value` by wrapping the prototype setter; assigning
// `el.value = x` directly bypasses that tracker, so React's next onChange sees the
// OLD value and snaps the input back. Using the native setter makes the change
// visible to React, exactly like a real keystroke.
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = el instanceof HTMLTextAreaElement ? _textareaValueSetter : _inputValueSetter;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

function applyTextEdit(target: HTMLElement, code: string, modifiers?: KeyModifiers, keyValue?: string): boolean {
  try {
    if (isGuarded(target) || target.matches(":disabled")) return false;
    if (target instanceof HTMLInputElement && !["text", "search", "email", "tel", "url", "password"].includes(target.type)) return false;
    if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.readOnly) return false;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) return false;
    // Printable AltGraph characters are text, not Ctrl+Alt shortcuts.
    const data = keyValue ?? keyLabelOf(code, modifiers);
    const printable = Array.from(data).length === 1;
    if ((modifiers?.ctrl || modifiers?.meta || modifiers?.alt) && !(modifiers.ctrl && modifiers.alt && !modifiers.meta && printable)) return false;
    const inputType = code === "Backspace" ? "deleteContentBackward" : code === "Delete" ? "deleteContentForward" :
      code === "Enter" && !(target instanceof HTMLInputElement) ? (target.isContentEditable ? "insertParagraph" : "insertLineBreak") :
        printable ? "insertText" : null;
    const textControl = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    // Email inputs expose no selection API even though their values are editable.
    const setCaret = (position: number) => {
      if (textControl) {
        try { target.setSelectionRange(position, position); } catch { /* unsupported input type */ }
      }
    };
    if (inputType) {
      const generation = inputGeneration;
      const allowed = target.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, composed: true, inputType,
        data: inputType === "insertText" ? data : null,
      }));
      if (!allowed || generation !== inputGeneration || isGuarded(target) || document.activeElement !== target ||
        target.matches(":disabled") || ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.readOnly)) return true;
    }
    if (target instanceof HTMLInputElement) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;

      if (code === "Backspace") {
        if (start === end && start > 0) {
          setInputValue(target, target.value.slice(0, start - 1) + target.value.slice(end));
          setCaret(start - 1);
        } else {
          setInputValue(target, target.value.slice(0, start) + target.value.slice(end));
          setCaret(start);
        }
      } else if (code === "Delete") {
        if (start === end && start < target.value.length) {
          setInputValue(target, target.value.slice(0, start) + target.value.slice(start + 1));
        } else {
          setInputValue(target, target.value.slice(0, start) + target.value.slice(end));
        }
        setCaret(start);
      } else if (code === "ArrowLeft") {
        const next = Math.max(0, start - 1);
        setCaret(next);
      } else if (code === "ArrowRight") {
        const next = Math.min(target.value.length, start + 1);
        setCaret(next);
      } else if (code === "Home") {
        setCaret(0);
      } else if (code === "End") {
        const len = target.value.length;
        setCaret(len);
      } else if (printable) {
        setInputValue(target, target.value.slice(0, start) + data + target.value.slice(end));
        const caret = start + data.length;
        setCaret(caret);
      } else {
        return false;
      }
      if (inputType) target.dispatchEvent(new InputEvent("input", {
        bubbles: true, composed: true, inputType,
        data: inputType === "insertText" ? data : null
      }));
      return true;
    }

    if (target instanceof HTMLTextAreaElement) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;

      if (code === "Backspace") {
        if (start === end && start > 0) {
          setInputValue(target, target.value.slice(0, start - 1) + target.value.slice(end));
          target.setSelectionRange(start - 1, start - 1);
        } else {
          setInputValue(target, target.value.slice(0, start) + target.value.slice(end));
          target.setSelectionRange(start, start);
        }
      } else if (code === "Delete") {
        if (start === end && start < target.value.length) {
          setInputValue(target, target.value.slice(0, start) + target.value.slice(start + 1));
        } else {
          setInputValue(target, target.value.slice(0, start) + target.value.slice(end));
        }
        target.setSelectionRange(start, start);
      } else if (code === "ArrowLeft") {
        const next = Math.max(0, start - 1);
        target.setSelectionRange(next, next);
      } else if (code === "ArrowRight") {
        const next = Math.min(target.value.length, start + 1);
        target.setSelectionRange(next, next);
      } else if (code === "ArrowUp" || code === "ArrowDown") {
        // Approximate single-line movement; exact line math is engine-specific.
        return false;
      } else if (code === "Home") {
        target.setSelectionRange(0, 0);
      } else if (code === "End") {
        const len = target.value.length;
        target.setSelectionRange(len, len);
      } else if (code === "Enter") {
        setInputValue(target, target.value.slice(0, start) + "\n" + target.value.slice(end));
        target.setSelectionRange(start + 1, start + 1);
      } else if (printable) {
        setInputValue(target, target.value.slice(0, start) + data + target.value.slice(end));
        const caret = start + data.length;
        target.setSelectionRange(caret, caret);
      } else {
        return false;
      }
      if (inputType) target.dispatchEvent(new InputEvent("input", {
        bubbles: true, composed: true, inputType,
        data: inputType === "insertText" ? data : null
      }));
      return true;
    }

    if (target.isContentEditable) {
      const selection = window.getSelection();
      // execCommand acts on the document selection, not necessarily the target.
      if (!selection?.anchorNode || !selection.focusNode ||
        !target.contains(selection.anchorNode) || !target.contains(selection.focusNode) ||
        isGuarded(selection.anchorNode.parentElement) || isGuarded(selection.focusNode.parentElement)) return false;
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const guard of Array.from(target.querySelectorAll(GUARD_SELECTOR))) {
          if (range.intersectsNode(guard)) return false;
        }
      }
      if (code === "Backspace") document.execCommand("delete");
      else if (code === "Enter") document.execCommand("insertParagraph");
      else if (code === "Delete") document.execCommand("forwardDelete");
      else if (printable) {
        document.execCommand("insertText", false, data);
      } else return false;
      return true;
    }
  } catch { }
  return false;
}

function handleKey(input: KeyInput): void {
  const mods = input.modifiers;
  const init: KeyboardEventInit = {
    code: input.key, key: input.keyValue ?? keyLabelOf(input.key, mods), bubbles: true, cancelable: true, view: window,
    shiftKey: mods?.shift === true, ctrlKey: mods?.ctrl === true,
    altKey: mods?.alt === true, metaKey: mods?.meta === true, repeat: pressedKeys.has(input.key),
  };
  if (input.type === "key_up") {
    const held = pressedKeys.get(input.key);
    pressedKeys.delete(input.key);
    // Focus may now be on Revoke Control: release the original target instead.
    if (held) dispatchKeyboard(releaseTarget(held.target), "keyup", { ...init, repeat: false });
    return;
  }
  let active = document.activeElement;
  if (isGuarded(active)) return;
  if (!active || active === document.body || active === document.documentElement) {
    const top = topElementAt(lastPointerPos.clientX, lastPointerPos.clientY);
    if (isGuarded(top)) return;
    focusNearestFocusable(top);
    active = document.activeElement;
  }
  if (isGuarded(active) || (active instanceof Element && active.matches(":disabled"))) return;
  const target = active ?? window;
  const previous = pressedKeys.get(input.key);
  if (previous && previous.target !== target) {
    pressedKeys.delete(input.key);
    const generation = inputGeneration;
    dispatchKeyboard(releaseTarget(previous.target), "keyup", { ...previous.init, repeat: false });
    if (generation !== inputGeneration || isGuarded(active) || document.activeElement !== active) return;
  }
  if (!pressedKeys.has(input.key)) pressedKeys.set(input.key, { target, init });
  const generation = inputGeneration;
  const allowed = dispatchKeyboard(target, "keydown", init);
  if (!allowed || generation !== inputGeneration || isGuarded(active) || document.activeElement !== active) return;
  const key = input.keyValue ?? keyLabelOf(input.key, mods);
  if ((mods?.ctrl || mods?.meta) && !mods?.alt && key.toLowerCase() === "a" &&
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && !active.readOnly) {
    try { active.select(); } catch { /* Unsupported selection type. */ }
    return;
  }
  const altGraphText = mods?.ctrl && mods?.alt && !mods?.meta && Array.from(key).length === 1;
  if ((mods?.ctrl || mods?.meta || mods?.alt) && !altGraphText) return;
  if (key === "Tab") {
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter(el => !isGuarded(el) && !el.matches(":disabled,[inert],[inert] *") && el.tabIndex >= 0 &&
        el.getClientRects().length > 0 && window.getComputedStyle(el).visibility !== "hidden")
      .map((el, order) => ({ el, order }))
      .sort((a, b) => (a.el.tabIndex > 0 ? a.el.tabIndex : Infinity) - (b.el.tabIndex > 0 ? b.el.tabIndex : Infinity) || a.order - b.order)
      .map(item => item.el);
    if (focusable.length) {
      const current = focusable.indexOf(active as HTMLElement);
      const next = mods?.shift ? (current <= 0 ? focusable.length - 1 : current - 1) : (current + 1) % focusable.length;
      focusable[next]?.focus({ preventScroll: true });
    }
    return;
  }
  if ((key === "Enter" || key === " ") && active instanceof HTMLElement &&
    (active.matches("button,[role='button'],input[type='button'],input[type='submit'],input[type='checkbox'],input[type='radio']") ||
      (key === "Enter" && active.matches("a[href]")))) {
    if (!init.repeat) fireExactlyOneClick(active, { ...init, clientX: lastPointerPos.clientX, clientY: lastPointerPos.clientY });
    return;
  }
  if (key === "Enter" && active instanceof HTMLInputElement && active.form &&
    !active.disabled && !active.readOnly && ["text", "search", "email", "tel", "url", "password", "number"].includes(active.type)) {
    const form = active.form;
    if (isGuarded(form)) return;
    // requestSubmit validates and emits submit; never fall back to form.submit(),
    // which bypasses cancellation and would navigate away from the sharing page.
    const submitter = form.querySelector("button:not([type]), button[type='submit'], input[type='submit'], input[type='image']");
    if (submitter && (isGuarded(submitter) || submitter.matches(":disabled"))) return;
    if (typeof form.requestSubmit === "function") withoutNativeSubmission(() => form.requestSubmit());
    return;
  }
  if (active instanceof HTMLElement) applyTextEdit(active, key.length === 1 ? input.key : key, mods, input.keyValue);
}

/**
 * Replay a remote input message on the local page.
 * Pure DOM side effects only — rendering (cursor overlay) is the caller's concern.
 */
export function dispatchRemoteInputToPage(input: SyntheticInput): void {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    switch (input.type) {
      case "mouse_move":
      case "mouse_down":
      case "mouse_up":
      case "mouse_cancel":
        handleMouse(input);
        break;
      case "mouse_wheel":
        handleWheel(input);
        break;
      case "key_down":
      case "key_up":
        handleKey(input);
        break;
    }
  } catch (err) {
    console.warn("[remote-control:synthetic] dispatch error:", err);
  }
}
