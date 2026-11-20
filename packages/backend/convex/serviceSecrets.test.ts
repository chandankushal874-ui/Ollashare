import { describe, expect, test } from "vitest";
import {
	authorizeServiceSecret,
	requireStrongServiceSecret,
} from "./serviceSecrets";

const strongSecret = "A7_jQ2mZ9-xLp4Vr8Nc6Tk3Ws1Hy5Df0";

describe("service secret validation", () => {
	test("accepts a strong URL-safe service secret", () => {
		expect(requireStrongServiceSecret(strongSecret, "TEST_SECRET")).toBe(
			strongSecret,
		);
		expect(() =>
			authorizeServiceSecret(strongSecret, strongSecret, "TEST_SECRET"),
		).not.toThrow();
	});

	test.each([
		"short",
		"service-secret-that-is-at-least-32-bytes",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"not url safe value with spaces and padding==",
	])("rejects weak or placeholder configuration", (secret) => {
		expect(() => requireStrongServiceSecret(secret, "TEST_SECRET")).toThrow(
			/strong service secret/,
		);
	});

	test("rejects incorrect credentials", () => {
		expect(() =>
			authorizeServiceSecret(
				"B7_jQ2mZ9-xLp4Vr8Nc6Tk3Ws1Hy5Df0",
				strongSecret,
				"TEST_SECRET",
			),
		).toThrow(/Unauthorized service/);
	});
});
