import { ConvexError } from "convex/values";

export const WORKSPACE_NAME_MIN_LENGTH = 2;
export const WORKSPACE_NAME_MAX_LENGTH = 80;
const WORKSPACE_NAME_MAX_INPUT_CODE_UNITS = 320;

const UNSAFE_UNICODE = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const HTML_LIKE_DELIMITERS = /[<>]/u;

/**
 * Normalizes a workspace display name without restricting it to ASCII.
 *
 * NFKC removes compatibility-only distinctions, Unicode whitespace is collapsed,
 * and code-point length is checked after normalization. Format/control/surrogate
 * characters and HTML-like angle brackets are rejected rather than silently
 * removed so spoofed or invisible input is never stored under a surprising name.
 */
export function normalizeWorkspaceName(input: string): string {
	// Bound work before Unicode normalization or code-point materialization. The
	// stored-name limit remains authoritative after normalization.
	if (input.length > WORKSPACE_NAME_MAX_INPUT_CODE_UNITS) {
		throw new ConvexError(
			`Workspace name must be ${WORKSPACE_NAME_MIN_LENGTH} to ${WORKSPACE_NAME_MAX_LENGTH} characters`,
		);
	}
	if (UNSAFE_UNICODE.test(input)) {
		throw new ConvexError("Workspace name contains unsafe characters");
	}

	const name = input.normalize("NFKC").replace(/\s+/gu, " ").trim();
	if (UNSAFE_UNICODE.test(name)) {
		throw new ConvexError("Workspace name contains unsafe characters");
	}
	if (HTML_LIKE_DELIMITERS.test(name)) {
		throw new ConvexError("Workspace name contains HTML-like text");
	}

	const length = Array.from(name).length;
	if (
		length < WORKSPACE_NAME_MIN_LENGTH ||
		length > WORKSPACE_NAME_MAX_LENGTH
	) {
		throw new ConvexError(
			`Workspace name must be ${WORKSPACE_NAME_MIN_LENGTH} to ${WORKSPACE_NAME_MAX_LENGTH} characters`,
		);
	}

	return name;
}
