const OTP_LENGTH = 8;
const ACCEPTED_BYTE_RANGE = 250;

export function generateNumericOtp(
	randomValues: (bytes: Uint8Array) => Uint8Array = (bytes) =>
		crypto.getRandomValues(bytes),
): string {
	const digits: number[] = [];
	while (digits.length < OTP_LENGTH) {
		const bytes = randomValues(new Uint8Array(OTP_LENGTH - digits.length));
		for (const byte of bytes) {
			if (byte >= ACCEPTED_BYTE_RANGE) continue;
			digits.push(byte % 10);
			if (digits.length === OTP_LENGTH) break;
		}
	}
	return digits.join("");
}
