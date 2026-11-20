import { describe, expect, test } from "vitest";
import { generateNumericOtp } from "./otp";

describe("generateNumericOtp", () => {
	test("returns the eight digit SDK contract", () => {
		expect(generateNumericOtp((bytes) => bytes.fill(42))).toBe("22222222");
	});

	test("rejects the biased upper byte range", () => {
		const batches = [
			Uint8Array.from([250, 251, 252, 253, 254, 255, 9, 19]),
			Uint8Array.from([29, 39, 49, 59, 69, 79]),
		];
		let index = 0;
		expect(
			generateNumericOtp(() => batches[index++] ?? Uint8Array.from([89])),
		).toBe("99999999");
	});
});
