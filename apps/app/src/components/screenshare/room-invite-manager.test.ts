import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
	new URL("./room-invite-manager.tsx", import.meta.url),
	"utf8",
);

describe("room invite manager contract", () => {
	test("exposes bounded invitation controls and host actions", () => {
		expect(source).toContain('max="168"');
		expect(source).toContain('min="1"');
		expect(source).toContain('max="100"');
		expect(source).toContain("One-time link");
		expect(source).toContain("Require host approval");
		expect(source).toContain("Optional password");
		expect(source).toContain("Revoke all");
		expect(source).toContain("Approve");
		expect(source).toContain("Deny");
	});

	test("renders only safe invitation metadata and keeps the bearer token fragment-only", () => {
		expect(source).toContain("passwordProtected");
		expect(source).toContain("requireApproval");
		expect(source).toContain("uses}/{invite.maxUses");
		expect(source).toContain("url.hash = `guestInvite=${result.token}`");
		expect(source).not.toContain("invite.tokenHash");
		expect(source).not.toContain("passwordVerifier");
		expect(source).not.toContain("passwordSalt");
		expect(source).not.toContain("requestSecretHash");
	});
});
