const CLIENT_JOB_KINDS = new Set(["demo"]);
export const MAX_JOB_INPUT_BYTES = 32 * 1024;
const MAX_JOB_INPUT_DEPTH = 8;
const MAX_JOB_INPUT_ARRAY_LENGTH = 100;
const MAX_JOB_INPUT_OBJECT_KEYS = 32;
const MAX_JOB_INPUT_STRING_LENGTH = 16 * 1024;
const MAX_JOB_INPUT_VALUES = 512;
const MAX_DEMO_PROMPT_LENGTH = 4096;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,160}$/;

function invalidJobRequest() {
	const error = new Error("Invalid job request");
	error.code = "INVALID_JOB_REQUEST";
	throw error;
}

function validateBoundedJsonValue(value, depth, state, ancestors = new Set()) {
	state.values += 1;
	if (state.values > MAX_JOB_INPUT_VALUES || depth > MAX_JOB_INPUT_DEPTH) {
		invalidJobRequest();
	}
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalidJobRequest();
		return;
	}
	if (typeof value === "string") {
		if (value.length > MAX_JOB_INPUT_STRING_LENGTH) invalidJobRequest();
		return;
	}
	if (typeof value !== "object") invalidJobRequest();
	if (ancestors.has(value)) invalidJobRequest();
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_JOB_INPUT_ARRAY_LENGTH) invalidJobRequest();
			for (const item of value) {
				validateBoundedJsonValue(item, depth + 1, state, ancestors);
			}
			return;
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			invalidJobRequest();
		const keys = Object.keys(value);
		if (keys.length > MAX_JOB_INPUT_OBJECT_KEYS) invalidJobRequest();
		for (const key of keys) {
			if (key.length > MAX_JOB_INPUT_STRING_LENGTH) invalidJobRequest();
			validateBoundedJsonValue(value[key], depth + 1, state, ancestors);
		}
	} finally {
		ancestors.delete(value);
	}
}

function validateOpaqueId(value) {
	if (typeof value !== "string" || !OPAQUE_ID.test(value)) invalidJobRequest();
}

/** Independent attached-backend copy of the public producer contract. */
export function validateJobRunRequest(body, forwardedUserId) {
	if (!body || typeof body !== "object" || Array.isArray(body))
		invalidJobRequest();
	const keys = Object.keys(body);
	if (
		keys.length !== 5 ||
		keys.some(
			(key) =>
				key !== "jobId" &&
				key !== "workspaceId" &&
				key !== "userId" &&
				key !== "kind" &&
				key !== "input",
		)
	) {
		invalidJobRequest();
	}
	validateOpaqueId(body.jobId);
	validateOpaqueId(body.workspaceId);
	validateOpaqueId(body.userId);
	if (body.userId !== forwardedUserId) invalidJobRequest();
	if (!CLIENT_JOB_KINDS.has(body.kind)) invalidJobRequest();
	validateBoundedJsonValue(body.input, 0, { values: 0 });
	if (
		!body.input ||
		typeof body.input !== "object" ||
		Array.isArray(body.input)
	) {
		invalidJobRequest();
	}
	const inputKeys = Object.keys(body.input);
	if (inputKeys.some((key) => key !== "prompt")) invalidJobRequest();
	if (
		body.input.prompt !== undefined &&
		(typeof body.input.prompt !== "string" ||
			body.input.prompt.length === 0 ||
			body.input.prompt.length > MAX_DEMO_PROMPT_LENGTH)
	) {
		invalidJobRequest();
	}
	let serialized;
	try {
		serialized = JSON.stringify(body.input);
	} catch {
		invalidJobRequest();
	}
	if (
		serialized === undefined ||
		Buffer.byteLength(serialized, "utf8") > MAX_JOB_INPUT_BYTES
	) {
		invalidJobRequest();
	}
	return body;
}
