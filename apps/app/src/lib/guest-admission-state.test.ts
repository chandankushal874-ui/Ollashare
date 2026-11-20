import { describe, expect, test } from "vitest";
import {
	initialGuestAdmissionState,
	isTerminalGuestAdmissionStatus,
	reduceGuestAdmission,
} from "./guest-admission-state";

describe("guest admission state machine", () => {
	test("covers password collection, pending, approved, denied, and expired states", () => {
		let state = reduceGuestAdmission(initialGuestAdmissionState, {
			type: "edit",
			displayName: "Alice",
			password: "invitation password",
		});
		state = reduceGuestAdmission(state, { type: "submit" });
		expect(state.status).toBe("submitting");
		state = reduceGuestAdmission(state, {
			type: "created",
			status: "pending",
			requestSecret: "a".repeat(64),
			expiresAt: 1234,
		});
		expect(state).toMatchObject({
			status: "pending",
			password: "",
			expiresAt: 1234,
		});
		state = reduceGuestAdmission(state, { type: "polled", status: "approved" });
		expect(state.status).toBe("approved");
		state = reduceGuestAdmission(state, { type: "polled", status: "denied" });
		expect(state.status).toBe("denied");
		expect(isTerminalGuestAdmissionStatus(state.status)).toBe(true);
		state = reduceGuestAdmission(state, { type: "retry" });
		state = reduceGuestAdmission(state, { type: "polled", status: "expired" });
		expect(state.status).toBe("expired");
	});

	test("uses a generic failure and clears passwords", () => {
		const state = reduceGuestAdmission(
			{
				...initialGuestAdmissionState,
				displayName: "Alice",
				password: "secret",
			},
			{ type: "failure" },
		);
		expect(state).toMatchObject({
			status: "failed",
			password: "",
			message: "Invitation could not be verified.",
		});
	});

	test("does not submit without a bounded display name", () => {
		const state = reduceGuestAdmission(initialGuestAdmissionState, {
			type: "submit",
		});
		expect(state.status).toBe("failed");
		expect(state.message).toMatch(/display name/i);
	});
});
