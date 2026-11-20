/**
 * Shared Browser acceptance/security contract harness.
 *
 * Supply QA_SHARED_BROWSER_ADAPTER with a file URL or absolute path to a
 * test-only adapter. The adapter keeps this harness independent from product
 * transport details while making every contract executable against a deployed
 * control plane and real browser worker.
 *
 * Required adapter methods:
 *   createRoom(), createSession({ roomId }), joinSession({ roomId, sessionId }),
 *   grantControl({ roomId, sessionId, controllerId, expiresAt }),
 *   revokeGrant({ roomId, sessionId, grantId }),
 *   sendInput({ roomId, sessionId, grantId, controllerId, input }),
 *   endRoom({ roomId }), reconnect({ roomId, sessionId, participantId }),
 *   inspect({ roomId, sessionId }), probeNavigation({ roomId, sessionId, url }),
 *   probeRawPort({ roomId, sessionId, host, port }).
 *
 * Methods must reject unauthorized/invalid operations. inspect() returns at
 * least { sessionId, sessionCount, controllerIds, activeGrantIds,
 * cleanupComplete }.
 */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: This standalone harness is intentionally configured at execution time.
const adapterLocation = process.env.QA_SHARED_BROWSER_ADAPTER;

if (!adapterLocation) {
	throw new Error(
		"QA_SHARED_BROWSER_ADAPTER is required. Point it at a test-only adapter; see release-tools/docs/shared-browser-deployment-runbook.md.",
	);
}

const adapterUrl = adapterLocation.includes("://")
	? adapterLocation
	: pathToFileURL(adapterLocation).href;
const { default: sharedBrowser } = await import(adapterUrl);

const requiredMethods = [
	"createRoom",
	"createSession",
	"joinSession",
	"grantControl",
	"revokeGrant",
	"sendInput",
	"endRoom",
	"reconnect",
	"inspect",
	"probeNavigation",
	"probeRawPort",
];

for (const method of requiredMethods) {
	assert.equal(
		typeof sharedBrowser?.[method],
		"function",
		`Adapter must export ${method}()`,
	);
}

async function rejects(operation, description) {
	await assert.rejects(operation, undefined, description);
}

function unique(label) {
	return `${label}-${Date.now()}-${crypto.randomUUID()}`;
}

async function createRoomWithSession(label) {
	const room = await sharedBrowser.createRoom({ name: unique(label) });
	const session = await sharedBrowser.createSession({ roomId: room.roomId });
	assert.ok(room.roomId, "createRoom() must return roomId");
	assert.ok(session.sessionId, "createSession() must return sessionId");
	return { roomId: room.roomId, sessionId: session.sessionId };
}

async function run(name, operation) {
	try {
		await operation();
		console.log(`PASS ${name}`);
		return { name, passed: true };
	} catch (error) {
		console.error(`FAIL ${name}: ${error.message}`);
		return { name, passed: false, error: error.message };
	}
}

const results = [];

results.push(
	await run("one session per room", async () => {
		const { roomId, sessionId } = await createRoomWithSession("one-session");
		await rejects(
			() => sharedBrowser.createSession({ roomId }),
			"A room must not receive a second Shared Browser session",
		);
		assert.equal(
			(await sharedBrowser.inspect({ roomId, sessionId })).sessionId,
			sessionId,
		);
	}),
);

results.push(
	await run("cross-room access is rejected", async () => {
		const source = await createRoomWithSession("source-room");
		const target = await createRoomWithSession("target-room");
		await rejects(
			() =>
				sharedBrowser.joinSession({
					roomId: target.roomId,
					sessionId: source.sessionId,
				}),
			"A session identifier must not be accepted in another room",
		);
	}),
);

results.push(
	await run("expired and revoked grants reject input", async () => {
		const { roomId, sessionId } =
			await createRoomWithSession("grant-lifecycle");
		const controllerId = unique("controller");
		const expired = await sharedBrowser.grantControl({
			roomId,
			sessionId,
			controllerId,
			expiresAt: Date.now() - 1,
		});
		await rejects(
			() =>
				sharedBrowser.sendInput({
					roomId,
					sessionId,
					grantId: expired.grantId,
					controllerId,
					input: { type: "pointer", x: 1, y: 1 },
				}),
			"Expired control grants must reject input",
		);

		const active = await sharedBrowser.grantControl({
			roomId,
			sessionId,
			controllerId,
			expiresAt: Date.now() + 60_000,
		});
		await sharedBrowser.revokeGrant({
			roomId,
			sessionId,
			grantId: active.grantId,
		});
		await rejects(
			() =>
				sharedBrowser.sendInput({
					roomId,
					sessionId,
					grantId: active.grantId,
					controllerId,
					input: { type: "pointer", x: 1, y: 1 },
				}),
			"Revoked control grants must reject input",
		);
	}),
);

results.push(
	await run(
		"one active controller and immediate input revocation",
		async () => {
			const { roomId, sessionId } = await createRoomWithSession(
				"controller-exclusive",
			);
			const first = unique("controller-a");
			const second = unique("controller-b");
			const grant = await sharedBrowser.grantControl({
				roomId,
				sessionId,
				controllerId: first,
				expiresAt: Date.now() + 60_000,
			});
			await rejects(
				() =>
					sharedBrowser.grantControl({
						roomId,
						sessionId,
						controllerId: second,
						expiresAt: Date.now() + 60_000,
					}),
				"A second controller must not be granted concurrently",
			);
			await sharedBrowser.revokeGrant({
				roomId,
				sessionId,
				grantId: grant.grantId,
			});
			await rejects(
				() =>
					sharedBrowser.sendInput({
						roomId,
						sessionId,
						grantId: grant.grantId,
						controllerId: first,
						input: { type: "key", key: "KeyA" },
					}),
				"Revoke must block subsequent input without a grace window",
			);
			assert.deepEqual(
				(await sharedBrowser.inspect({ roomId, sessionId })).controllerIds,
				[],
			);
		},
	),
);

results.push(
	await run("room end cleans session and grants", async () => {
		const { roomId, sessionId } =
			await createRoomWithSession("room-end-cleanup");
		const controllerId = unique("controller");
		const grant = await sharedBrowser.grantControl({
			roomId,
			sessionId,
			controllerId,
			expiresAt: Date.now() + 60_000,
		});
		await sharedBrowser.endRoom({ roomId });
		await rejects(
			() =>
				sharedBrowser.sendInput({
					roomId,
					sessionId,
					grantId: grant.grantId,
					controllerId,
					input: { type: "pointer", x: 1, y: 1 },
				}),
			"Room end must invalidate grants and prevent further input",
		);
		assert.equal(
			(await sharedBrowser.inspect({ roomId, sessionId })).cleanupComplete,
			true,
		);
	}),
);

results.push(
	await run("reconnect does not create a duplicate session", async () => {
		const { roomId, sessionId } = await createRoomWithSession("reconnect");
		const participantId = unique("participant");
		await sharedBrowser.reconnect({ roomId, sessionId, participantId });
		const state = await sharedBrowser.inspect({ roomId, sessionId });
		assert.equal(state.sessionId, sessionId);
		assert.equal(
			state.sessionCount,
			1,
			"Reconnect must reuse the room session",
		);
	}),
);

results.push(
	await run("SSRF and private-address navigation is denied", async () => {
		const { roomId, sessionId } = await createRoomWithSession("network-denial");
		for (const url of [
			"http://127.0.0.1/",
			"http://localhost/",
			"http://10.0.0.1/",
			"http://169.254.169.254/latest/meta-data/",
			"http://[::1]/",
		]) {
			await rejects(
				() => sharedBrowser.probeNavigation({ roomId, sessionId, url }),
				`Private target must be denied: ${url}`,
			);
		}
	}),
);

results.push(
	await run("raw ports are unavailable", async () => {
		const { roomId, sessionId } =
			await createRoomWithSession("raw-port-denial");
		for (const port of [22, 2375, 3306, 5432, 6379, 9222]) {
			await rejects(
				() =>
					sharedBrowser.probeRawPort({
						roomId,
						sessionId,
						host: "127.0.0.1",
						port,
					}),
				`Raw port ${port} must not be exposed through Shared Browser`,
			);
		}
	}),
);

const failures = results.filter((result) => !result.passed);
console.log(
	JSON.stringify(
		{ suite: "shared-browser-contracts", results, failures: failures.length },
		null,
		2,
	),
);
if (failures.length > 0) process.exitCode = 1;
