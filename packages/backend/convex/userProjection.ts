export function projectPublicUser<
	T extends {
		anonymousInviteRoomCode?: string;
		anonymousInviteTokenHash?: string;
		anonymousInviteExpiresAt?: number;
		anonymousInviteId?: unknown;
		anonymousAdmissionRequestId?: unknown;
		anonymousInviteVersion?: number;
	},
>(
	user: T,
): Omit<
	T,
	| "anonymousInviteRoomCode"
	| "anonymousInviteTokenHash"
	| "anonymousInviteExpiresAt"
	| "anonymousInviteId"
	| "anonymousAdmissionRequestId"
	| "anonymousInviteVersion"
> {
	const {
		anonymousInviteRoomCode: _anonymousInviteRoomCode,
		anonymousInviteTokenHash: _anonymousInviteTokenHash,
		anonymousInviteExpiresAt: _anonymousInviteExpiresAt,
		anonymousInviteId: _anonymousInviteId,
		anonymousAdmissionRequestId: _anonymousAdmissionRequestId,
		anonymousInviteVersion: _anonymousInviteVersion,
		...publicUser
	} = user;
	return publicUser;
}
