import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { createAccount } from "@convex-dev/auth/server";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("password signup isolation", () => {
	test("password pre-registration stays unverified", async () => {
		const t = convexTest(schema, modules);
		const email = "pre-registration@example.com";

		const registered = await t.run(async (ctx) =>
			createAccount(ctx as never, {
				provider: "password",
				account: { id: email, secret: "StrongPassword123!" },
				profile: { email, name: "Registrant", isAnonymous: false },
				shouldLinkViaEmail: false,
				shouldLinkViaPhone: false,
			}),
		);

		expect(registered.account.emailVerified).toBeUndefined();
		expect(
			(await t.run((ctx) => ctx.db.get(registered.user._id)))
				?.emailVerificationTime,
		).toBeUndefined();
	});

	test("does not link a new password credential to an existing verified user", async () => {
		const t = convexTest(schema, modules);
		const email = "victim@example.com";
		const victimId = await t.run((ctx) =>
			ctx.db.insert("users", {
				email,
				emailVerificationTime: Date.now(),
				name: "Victim",
			}),
		);

		const attacker = await t.run(async (ctx) =>
			createAccount(ctx as never, {
				provider: "password",
				account: { id: email, secret: "StrongPassword123!" },
				profile: { email, name: "Attacker", isAnonymous: false },
				shouldLinkViaEmail: false,
				shouldLinkViaPhone: false,
			}),
		);

		expect(attacker.user?._id).not.toBe(victimId);
		expect(attacker.account.userId).not.toBe(victimId);
	});
});
