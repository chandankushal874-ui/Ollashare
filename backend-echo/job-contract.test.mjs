import assert from "node:assert/strict";
import test from "node:test";
import { validateJobRunRequest } from "./job-contract.mjs";

const validRequest = () => ({
	jobId: "job_123",
	workspaceId: "workspace_123",
	userId: "user_123",
	kind: "demo",
	input: { prompt: "hello" },
});

test("attached backend accepts the supported bounded job contract", () => {
	const body = validRequest();
	assert.equal(validateJobRunRequest(body, body.userId), body);
});

test("attached backend independently rejects unknown kinds and ownership mismatch", () => {
	assert.throws(
		() =>
			validateJobRunRequest(
				{ ...validRequest(), kind: "admin.reindex" },
				"user_123",
			),
		/Invalid job request/,
	);
	assert.throws(
		() => validateJobRunRequest(validRequest(), "different_user"),
		/Invalid job request/,
	);
});

test("attached backend independently rejects oversized, deep, cyclic, and unsupported input", () => {
	assert.throws(
		() =>
			validateJobRunRequest(
				{ ...validRequest(), input: { prompt: "x".repeat(4097) } },
				"user_123",
			),
		/Invalid job request/,
	);
	let deep = "leaf";
	for (let index = 0; index < 10; index++) deep = { child: deep };
	assert.throws(
		() => validateJobRunRequest({ ...validRequest(), input: deep }, "user_123"),
		/Invalid job request/,
	);
	const cyclic = {};
	cyclic.self = cyclic;
	assert.throws(
		() =>
			validateJobRunRequest({ ...validRequest(), input: cyclic }, "user_123"),
		/Invalid job request/,
	);
	assert.throws(
		() =>
			validateJobRunRequest(
				{ ...validRequest(), input: { prompt: "ok", extra: true } },
				"user_123",
			),
		/Invalid job request/,
	);
});
