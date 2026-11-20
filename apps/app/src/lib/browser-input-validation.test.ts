import { describe, expect, it } from "vitest";
import { isValidBrowserInput } from "./remote-control";

const point = { x: 123, y: 456, sw: 1920, sh: 1080, u: 0.25, v: 0.5 };
describe("untrusted browser input validation", () => {
    it.each(["mouse", "touch", "pen"])("accepts %s pointer down, move, up and cancellation", (pointerType) => {
        for (const type of ["mouse_move", "mouse_down", "mouse_up", "mouse_cancel"]) {
            expect(isValidBrowserInput({ type, ...point, button: "left", pointerId: 12, pointerType })).toBe(true);
        }
    });
    it("retains fractional wheel deltas and all standard wheel units", () => {
        for (const deltaMode of [0, 1, 2]) expect(isValidBrowserInput({ type: "mouse_wheel", ...point, dx: -0.125, dy: 0.25, deltaMode })).toBe(true);
    });
    it("accepts bounded browser key codes and boolean modifiers", () => {
        expect(isValidBrowserInput({ type: "key_down", key: "KeyA", modifiers: { shift: true, ctrl: false } })).toBe(true);
        expect(isValidBrowserInput({ type: "key_up", key: "KeyA" })).toBe(true);
    });
    it.each([null, [], {}, { type: "shell", command: "anything" },
        { type: "mouse_down", ...point, button: "invalid" },
        { type: "mouse_move", ...point, x: NaN },
        { type: "mouse_move", ...point, y: Infinity },
        { type: "mouse_move", ...point, u: -1 },
        { type: "mouse_move", ...point, v: undefined },
        { type: "mouse_move", ...point, pointerId: -1 },
        { type: "mouse_move", ...point, pointerId: 1.5 },
        { type: "mouse_move", ...point, pointerType: "hardware" },
        { type: "mouse_wheel", ...point, dx: 1, dy: Infinity },
        { type: "mouse_wheel", ...point, dx: 1, dy: 1, deltaMode: 3 },
        { type: "key_down", key: "" },
        { type: "key_up", key: "x".repeat(65) },
        { type: "key_down", key: "KeyA", modifiers: { ctrl: "yes" } },
    ])("rejects malformed input %#", (value) => {
        expect(isValidBrowserInput(value)).toBe(false);
    });
});
