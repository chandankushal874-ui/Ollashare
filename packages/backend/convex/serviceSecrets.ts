import { ConvexError } from "convex/values";

const SERVICE_SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;
const MIN_SERVICE_SECRET_BYTES = 32;
const MIN_DISTINCT_CHARACTERS = 12;
const PLACEHOLDER_TERMS = [
	"changeme",
	"replace",
	"example",
	"placeholder",
	"secret",
	"password",
];

export function requireStrongServiceSecret(
	value: string | undefined,
	name: string,
): string {
	const secret = value ?? "";
	const normalized = secret.toLowerCase();
	const byteLength = new TextEncoder().encode(secret).byteLength;
	if (
		byteLength < MIN_SERVICE_SECRET_BYTES ||
		!SERVICE_SECRET_PATTERN.test(secret) ||
		new Set(secret).size < MIN_DISTINCT_CHARACTERS ||
		PLACEHOLDER_TERMS.some((term) => normalized.includes(term))
	) {
		throw new ConvexError(
			`${name} is not configured with a strong service secret`,
		);
	}
	return secret;
}

export function authorizeServiceSecret(
	provided: string,
	configuredValue: string | undefined,
	name: string,
): void {
	const configured = requireStrongServiceSecret(configuredValue, name);
	const providedBytes = new TextEncoder().encode(provided);
	const configuredBytes = new TextEncoder().encode(configured);
	if (providedBytes.byteLength !== configuredBytes.byteLength)
		throw new ConvexError("Unauthorized service");
	let difference = 0;
	for (let index = 0; index < configuredBytes.byteLength; index++)
		difference |= (providedBytes[index] ?? 0) ^ (configuredBytes[index] ?? 0);
	if (difference !== 0) throw new ConvexError("Unauthorized service");
}
