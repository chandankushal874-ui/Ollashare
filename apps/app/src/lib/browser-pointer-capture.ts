import type { SharerInputMessage } from "./remote-control";

export interface BrowserVideoPoint {
    x: number;
    y: number;
    sw: number;
    sh: number;
    u: number;
    v: number;
}

type PointerType = "mouse" | "touch" | "pen";
type Button = "left" | "middle" | "right";
type Contact = { point: BrowserVideoPoint; pointerId: number; pointerType: PointerType; button: Button };

const LOCAL_CONTROL = "[data-mira-remote-guard='true'],button,a,input,textarea,select,[contenteditable='true']";
const pointerType = (value: string): PointerType | null =>
    value === "mouse" || value === "touch" || value === "pen" ? value : null;
const buttonName = (value: number): Button | null =>
    value === 0 ? "left" : value === 1 ? "middle" : value === 2 ? "right" : null;

/** Native Pointer Events only: no compatibility mouse listeners or duplicate gestures.
 * Every deferred move is flushed/dropped BEFORE a discrete event, never after it.
 * Cancellation uses mouse_cancel (not mouse_up), so it cannot activate a target.
 */
export function attachBrowserInputCapture(
    container: HTMLElement,
    options: {
        coordinates: (event: { clientX: number; clientY: number }) => BrowserVideoPoint | null;
        send: (input: SharerInputMessage) => void;
        release: () => void;
    },
): () => void {
    const contacts = new Map<number, Contact>();
    const moves = new Map<number, Contact>();
    const keys = new Map<string, string>();
    let frame: number | null = null;
    const isLocal = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(LOCAL_CONTROL));
    const localAtPoint = (event: { clientX: number; clientY: number }) => {
        // Pointer capture retargets event.target to the tile even over its badge.
        // Hit-test as well so releasing over a local safety control never clicks
        // the guest content hidden underneath that control.
        const target = document.elementFromPoint?.(event.clientX, event.clientY);
        return Boolean(target && container.contains(target) && isLocal(target));
    };
    const emitPointer = (type: "mouse_move" | "mouse_down" | "mouse_up" | "mouse_cancel", contact: Contact) => {
        options.send({
            type, ...contact.point, button: contact.button,
            pointerId: contact.pointerId, pointerType: contact.pointerType
        });
    };
    const clearFrame = () => {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
    };
    const flushMoves = () => {
        clearFrame();
        const pending = [...moves.values()];
        moves.clear();
        pending.forEach((contact) => emitPointer("mouse_move", contact));
    };
    const releaseKeys = () => {
        const held = [...keys];
        keys.clear();
        held.forEach(([key, keyValue]) => options.send({
            type: "key_up", key, keyValue,
            modifiers: { shift: false, ctrl: false, alt: false, meta: false }
        }));
    };
    const cancelContact = (contact: Contact) => {
        moves.delete(contact.pointerId);
        contacts.delete(contact.pointerId);
        emitPointer("mouse_cancel", contact);
        try { container.releasePointerCapture(contact.pointerId); } catch { /* Capture may already be lost. */ }
    };
    const cancelAll = () => {
        clearFrame();
        moves.clear();
        [...contacts.values()].forEach(cancelContact);
        releaseKeys();
    };
    const onDown = (event: PointerEvent) => {
        if (isLocal(event.target) || localAtPoint(event)) return;
        const kind = pointerType(event.pointerType);
        const button = buttonName(event.button);
        const point = options.coordinates(event);
        if (!kind || !button || !point) return;
        event.preventDefault();
        flushMoves();
        const previous = contacts.get(event.pointerId);
        if (previous) cancelContact(previous); // No ambiguous multi-button activation.
        const contact = { point, pointerId: event.pointerId, pointerType: kind, button };
        try { container.setPointerCapture(event.pointerId); } catch { return; }
        container.focus({ preventScroll: true });
        contacts.set(event.pointerId, contact);
        emitPointer("mouse_down", contact);
    };
    const onMove = (event: PointerEvent) => {
        const active = contacts.get(event.pointerId);
        if (isLocal(event.target) || localAtPoint(event)) {
            moves.delete(event.pointerId);
            if (active) { cancelContact(active); releaseKeys(); }
            return;
        }
        const kind = pointerType(event.pointerType);
        if (!kind || (!active && kind !== "mouse" && kind !== "pen")) return;
        const point = options.coordinates(event);
        if (!point) {
            if (active) { cancelContact(active); releaseKeys(); }
            return;
        }
        if (active) active.point = point;
        moves.set(event.pointerId, { point, pointerId: event.pointerId, pointerType: kind, button: active?.button ?? "left" });
        if (frame === null) frame = requestAnimationFrame(flushMoves);
    };
    const onUp = (event: PointerEvent) => {
        const active = contacts.get(event.pointerId);
        if (!active) return;
        event.preventDefault();
        const point = options.coordinates(event);
        if (!point || buttonName(event.button) !== active.button || isLocal(event.target) || localAtPoint(event)) {
            cancelContact(active);
            releaseKeys();
            return;
        }
        flushMoves();
        contacts.delete(event.pointerId); // Normal lostcapture must not cancel a completed press.
        emitPointer("mouse_up", { ...active, point });
        try { container.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
    };
    const onCancel = (event: PointerEvent) => {
        const active = contacts.get(event.pointerId);
        if (active) { cancelContact(active); releaseKeys(); }
        moves.delete(event.pointerId);
    };
    const onWheel = (event: WheelEvent) => {
        if (isLocal(event.target) || localAtPoint(event)) return;
        const point = options.coordinates(event);
        if (!point) return;
        event.preventDefault();
        flushMoves();
        options.send({
            type: "mouse_wheel", ...point,
            dx: event.deltaX, dy: event.deltaY,
            deltaMode: event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? 2 : 0,
        });
    };
    const isLocalShortcut = (event: KeyboardEvent) =>
        event.key === "Escape" || event.key === "F5" ||
        ((event.ctrlKey || event.metaKey) && ["r", "l", "w", "t", "n"].includes(event.key.toLowerCase())) ||
        (event.altKey && ["ArrowLeft", "ArrowRight", "F4"].includes(event.key));
    const modifiers = (event: KeyboardEvent) => ({ shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey });
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && event.isTrusted) {
            cancelAll();
            options.release();
            return;
        }
        // Do not steal session navigation, local typing or safety-control activation.
        if (event.target !== container || isLocalShortcut(event) || event.isComposing || event.key === "Dead" || event.key === "Process") return;
        const code = event.code || event.key;
        if (!code || !event.key) return;
        event.preventDefault();
        event.stopPropagation();
        if (keys.has(code) && !event.repeat) return;
        flushMoves();
        keys.set(code, event.key);
        options.send({ type: "key_down", key: code, keyValue: event.key, repeat: event.repeat, modifiers: modifiers(event) });
    };
    const onKeyUp = (event: KeyboardEvent) => {
        const code = event.code || event.key;
        const keyValue = keys.get(code);
        if (!keys.delete(code)) return;
        if (event.target === container) { event.preventDefault(); event.stopPropagation(); }
        flushMoves();
        options.send({ type: "key_up", key: code, keyValue, modifiers: modifiers(event) });
    };
    const onBlur = (event: FocusEvent) => {
        if (!(event.relatedTarget instanceof Node) || !container.contains(event.relatedTarget) || isLocal(event.relatedTarget)) cancelAll();
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") cancelAll(); };
    const onContextMenu = (event: Event) => { if (!isLocal(event.target)) event.preventDefault(); };

    container.addEventListener("pointerdown", onDown);
    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerup", onUp);
    container.addEventListener("pointercancel", onCancel);
    container.addEventListener("lostpointercapture", onCancel);
    container.addEventListener("wheel", onWheel, { passive: false });
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("focusout", onBlur);
    container.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", cancelAll);
    window.addEventListener("pagehide", cancelAll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
        cancelAll();
        container.removeEventListener("pointerdown", onDown);
        container.removeEventListener("pointermove", onMove);
        container.removeEventListener("pointerup", onUp);
        container.removeEventListener("pointercancel", onCancel);
        container.removeEventListener("lostpointercapture", onCancel);
        container.removeEventListener("wheel", onWheel);
        container.removeEventListener("keydown", onKeyDown);
        container.removeEventListener("focusout", onBlur);
        container.removeEventListener("contextmenu", onContextMenu);
        window.removeEventListener("keyup", onKeyUp, true);
        window.removeEventListener("blur", cancelAll);
        window.removeEventListener("pagehide", cancelAll);
        document.removeEventListener("visibilitychange", onVisibility);
    };
}
