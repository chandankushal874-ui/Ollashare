import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Multi-tenant: resources carry workspaceId. It is `optional` on pre-existing tables only so
// deploys don't fail validation against pre-migration rows; the function layer always sets it.
export default defineSchema({
	...authTables,
	uploadTickets: defineTable({
		tokenHash: v.string(),
		userId: v.id("users"),
		workspaceId: v.optional(v.id("workspaces")),
		expiresAt: v.number(),
	})
		.index("by_hash", ["tokenHash"])
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_expiry", ["expiresAt"]),
	uploadObjects: defineTable({
		storageId: v.id("_storage"),
		userId: v.id("users"),
		workspaceId: v.optional(v.id("workspaces")),
		size: v.number(),
		contentType: v.string(),
		attached: v.boolean(),
		createdAt: v.number(),
	})
		.index("by_storage", ["storageId"])
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_created", ["createdAt"])
		.index("by_attached_created", ["attached", "createdAt"]),
	accountDeletionStates: defineTable({
		userId: v.id("users"),
		phase: v.string(),
		cursor: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_updated", ["updatedAt"]),
	screenshareMessages: defineTable({
		roomCode: v.string(),
		senderId: v.id("users"),
		senderName: v.string(),
		senderRole: v.string(),
		text: v.string(),
		timestamp: v.number(),
	})
		.index("by_room_time", ["roomCode", "timestamp"])
		.index("by_sender", ["senderId"])
		.index("by_time", ["timestamp"]),
	workspaceRevocations: defineTable({
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		revokedAt: v.number(),
	})
		.index("by_workspace_user", ["workspaceId", "userId"])
		.index("by_user", ["userId"]),
	webhookReceipts: defineTable({ messageId: v.string(), expiresAt: v.number() })
		.index("by_message", ["messageId"])
		.index("by_expiry", ["expiresAt"]),
	users: defineTable({
		name: v.optional(v.string()),
		image: v.optional(v.string()),
		email: v.optional(v.string()),
		emailVerificationTime: v.optional(v.number()),
		phone: v.optional(v.string()),
		phoneVerificationTime: v.optional(v.number()),
		isAnonymous: v.optional(v.boolean()),
		// Security-only anonymous admission binding. These fields must never be
		// included in public user projections.
		anonymousInviteRoomCode: v.optional(v.string()),
		anonymousInviteTokenHash: v.optional(v.string()), // legacy v1 compatibility drain
		anonymousInviteExpiresAt: v.optional(v.number()),
		anonymousInviteId: v.optional(v.id("screenshareGuestInvites")),
		anonymousAdmissionRequestId: v.optional(
			v.id("screenshareGuestAdmissionRequests"),
		),
		anonymousInviteVersion: v.optional(v.number()),
		username: v.optional(v.string()),
		imageId: v.optional(v.id("_storage")),
	})
		.index("email", ["email"])
		.index("by_image_id", ["imageId"]),
	authVerifiers: defineTable({
		sessionId: v.optional(v.id("authSessions")),
		signature: v.optional(v.string()),
	})
		.index("by_session", ["sessionId"])
		.index("signature", ["signature"]),

	events: defineTable({
		workspaceId: v.optional(v.id("workspaces")),
		source: v.string(),
		type: v.string(),
		payload: v.any(),
		receivedAt: v.number(),
	})
		.index("by_received", ["receivedAt"])
		.index("by_workspace", ["workspaceId"]),

	jobs: defineTable({
		workspaceId: v.optional(v.id("workspaces")),
		userId: v.id("users"),
		kind: v.string(),
		status: v.string(),
		input: v.optional(v.any()),
		result: v.optional(v.any()),
		error: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_status", ["userId", "status"])
		.index("by_workspace", ["workspaceId"])
		.index("by_workspace_status", ["workspaceId", "status"]),

	auditLogs: defineTable({
		workspaceId: v.optional(v.id("workspaces")),
		userId: v.id("users"),
		action: v.string(),
		actorName: v.optional(v.string()),
		actorEmail: v.optional(v.string()),
		meta: v.optional(v.any()),
		at: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_time", ["at"]),

	usage: defineTable({
		workspaceId: v.optional(v.id("workspaces")),
		userId: v.optional(v.id("users")),
		metric: v.string(),
		count: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user_metric", ["userId", "metric"])
		.index("by_workspace_metric", ["workspaceId", "metric"]),

	apiKeys: defineTable({
		workspaceId: v.optional(v.id("workspaces")),
		userId: v.id("users"),
		name: v.string(),
		prefix: v.string(),
		hash: v.string(),
		revoked: v.boolean(),
		createdAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_user_workspace", ["userId", "workspaceId"])
		.index("by_hash", ["hash"]),

	// Files (workspace-scoped). Stored in Convex file storage; row holds metadata.
	files: defineTable({
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		name: v.string(),
		storageId: v.id("_storage"),
		size: v.number(),
		contentType: v.string(),
		createdAt: v.number(),
	})
		.index("by_workspace", ["workspaceId"])
		.index("by_user", ["userId"]),

	workspaces: defineTable({
		name: v.string(),
		ownerId: v.id("users"),
		createdAt: v.number(),
	}).index("by_owner", ["ownerId"]),
	members: defineTable({
		workspaceId: v.id("workspaces"),
		userId: v.id("users"),
		role: v.string(),
		createdAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_workspace", ["workspaceId"])
		.index("by_user_workspace", ["userId", "workspaceId"]),
	invites: defineTable({
		workspaceId: v.id("workspaces"),
		email: v.string(),
		role: v.string(),
		invitedBy: v.id("users"),
		accepted: v.boolean(),
		expiresAt: v.optional(v.number()),
		revokedAt: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index("by_inviter", ["invitedBy"])
		.index("by_workspace", ["workspaceId"])
		.index("by_workspace_email", ["workspaceId", "email"])
		.index("by_email", ["email"]),

	notifications: defineTable({
		userId: v.id("users"),
		type: v.string(),
		title: v.string(),
		body: v.optional(v.string()),
		read: v.boolean(),
		createdAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_read", ["userId", "read"]),

	counters: defineTable({
		workspaceId: v.id("workspaces"),
		metric: v.string(),
		value: v.number(),
	}).index("by_workspace_metric", ["workspaceId", "metric"]),

	screenshareRooms: defineTable({
		code: v.string(),
		workspaceId: v.id("workspaces"),
		title: v.string(),
		hostId: v.id("users"),
		hostName: v.string(),
		status: v.string(),
		isLocked: v.optional(v.boolean()),
		maxViewers: v.optional(v.number()),
		maxSharers: v.optional(v.number()),
		allowGuestSharing: v.optional(v.boolean()),
		resolution: v.string(),
		fps: v.number(),
		bitrateKbps: v.number(),
		codec: v.string(),
		audioEnabled: v.boolean(),
		startedAt: v.number(),
		endedAt: v.optional(v.number()),
		analyticsCreatedRecordedAt: v.optional(v.number()),
		analyticsDurationRecordedAt: v.optional(v.number()),
	})
		.index("by_code", ["code"])
		.index("by_host", ["hostId"])
		.index("by_workspace_status", ["workspaceId", "status"])
		.index("by_workspace_status_ended", ["workspaceId", "status", "endedAt"])
		.index("by_status_analytics_duration", [
			"status",
			"analyticsDurationRecordedAt",
			"endedAt",
		])
		.index("by_status", ["status"]),

	screenshareLocalRecordings: defineTable({
		roomCode: v.string(),
		workspaceId: v.id("workspaces"),
		hostId: v.id("users"),
		target: v.string(),
		profile: v.object({
			resolution: v.string(),
			fps: v.number(),
			width: v.number(),
			height: v.number(),
			videoBitrateKbps: v.number(),
			audioIncluded: v.boolean(),
		}),
		state: v.string(),
		createdAt: v.number(),
		startedAt: v.optional(v.number()),
		pausedAt: v.optional(v.number()),
		resumedAt: v.optional(v.number()),
		stoppedAt: v.optional(v.number()),
		heartbeatAt: v.optional(v.number()),
		leaseExpiresAt: v.optional(v.number()),
		failureCategory: v.optional(v.string()),
	})
		.index("by_room_created", ["roomCode", "createdAt"])
		.index("by_workspace_created", ["workspaceId", "createdAt"])
		.index("by_host_created", ["hostId", "createdAt"])
		.index("by_state_lease", ["state", "leaseExpiresAt"]),

	screenshareGuestInvites: defineTable({
		roomCode: v.string(),
		tokenHash: v.string(),
		version: v.optional(v.number()),
		label: v.optional(v.string()),
		requireApproval: v.optional(v.boolean()),
		passwordKdf: v.optional(v.string()),
		passwordSalt: v.optional(v.string()),
		passwordVerifier: v.optional(v.string()),
		createdBy: v.optional(v.id("users")),
		createdAt: v.number(),
		expiresAt: v.number(),
		maxUses: v.number(),
		uses: v.number(),
		lastUsedAt: v.optional(v.number()),
		revokedAt: v.optional(v.number()),
	})
		.index("by_token_hash", ["tokenHash"])
		.index("by_creator", ["createdBy"])
		.index("by_room", ["roomCode"])
		.index("by_room_active", ["roomCode", "revokedAt"])
		.index("by_expiry", ["expiresAt"]),
	screenshareGuestAdmissionRequests: defineTable({
		roomCode: v.string(),
		inviteId: v.id("screenshareGuestInvites"),
		requestSecretHash: v.string(),
		displayName: v.string(),
		status: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
		decidedAt: v.optional(v.number()),
		decidedBy: v.optional(v.id("users")),
		consumedAt: v.optional(v.number()),
		boundUserId: v.optional(v.id("users")),
		analyticsAdmissionRecordedAt: v.optional(v.number()),
	})
		.index("by_secret_hash", ["requestSecretHash"])
		.index("by_room_status", ["roomCode", "status"])
		.index("by_invite_status", ["inviteId", "status"])
		.index("by_decider", ["decidedBy"])
		.index("by_bound_user", ["boundUserId"])
		.index("by_expiry", ["expiresAt"]),
	screenshareLiveKitTeardowns: defineTable({
		roomCode: v.string(),
		status: v.string(),
		attempts: v.number(),
		requestedAt: v.number(),
		updatedAt: v.number(),
		nextAttemptAt: v.number(),
		lastAttemptAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		leaseUntil: v.optional(v.number()),
		failureKind: v.optional(v.string()),
		lastError: v.optional(v.string()),
	})
		.index("by_room", ["roomCode"])
		.index("by_status_due", ["status", "nextAttemptAt"]),
	screenshareLiveKitParticipantOperations: defineTable({
		operationKey: v.string(),
		operationKind: v.string(),
		roomCode: v.string(),
		identity: v.string(),
		reason: v.string(),
		status: v.string(),
		attempts: v.number(),
		requestedAt: v.number(),
		updatedAt: v.number(),
		nextAttemptAt: v.number(),
		lastAttemptAt: v.optional(v.number()),
		completedAt: v.optional(v.number()),
		leaseUntil: v.optional(v.number()),
		failureKind: v.optional(v.string()),
		lastError: v.optional(v.string()),
	})
		.index("by_key", ["operationKey"])
		.index("by_status_due", ["status", "nextAttemptAt"])
		.index("by_room_identity", ["roomCode", "identity"]),

	screenshareViewers: defineTable({
		roomCode: v.string(),
		viewerId: v.id("users"),
		name: v.string(),
		role: v.string(),
		isSharing: v.optional(v.boolean()),
		status: v.optional(v.string()),
		sharerApproved: v.optional(v.boolean()),
		sharerApprovedBy: v.optional(v.id("users")),
		sharerApprovedAt: v.optional(v.number()),
		lastPingAt: v.number(),
		analyticsJoinRecordedAt: v.optional(v.number()),
	})
		.index("by_viewer", ["viewerId"])
		.index("by_approver", ["sharerApprovedBy"])
		.index("by_last_ping", ["lastPingAt"])
		.index("by_room_viewer", ["roomCode", "viewerId"])
		.index("by_room_ping", ["roomCode", "lastPingAt"])
		.index("by_room_sharing", ["roomCode", "isSharing"]),
	screenshareSignals: defineTable({
		roomCode: v.string(),
		senderId: v.id("users"),
		type: v.string(),
		to: v.optional(v.id("users")),
		payload: v.string(),
		timestamp: v.number(),
	})
		.index("by_sender", ["senderId"])
		.index("by_target", ["to"])
		.index("by_room", ["roomCode"])
		.index("by_room_time", ["roomCode", "timestamp"])
		.index("by_time", ["timestamp"]),
	screenshareBans: defineTable({
		roomCode: v.string(),
		viewerId: v.id("users"),
		bannedAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_viewer", ["viewerId"])
		.index("by_room_viewer", ["roomCode", "viewerId"])
		.index("by_expires", ["expiresAt"]),
	screenshareAnnotationPermissions: defineTable({
		roomCode: v.string(),
		userId: v.id("users"),
		targetKind: v.string(),
		targetId: v.optional(v.string()),
		grantedBy: v.id("users"),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_grantor", ["grantedBy"])
		.index("by_room_user", ["roomCode", "userId"])
		.index("by_room_target", ["roomCode", "targetKind", "targetId"]),
	screenshareAnnotationStreams: defineTable({
		roomCode: v.string(),
		nextSequence: v.number(),
		updatedAt: v.number(),
	}).index("by_room", ["roomCode"]),
	screenshareAnnotationEvents: defineTable({
		roomCode: v.string(),
		targetKind: v.string(),
		targetId: v.string(),
		sequence: v.number(),
		kind: v.string(),
		actorId: v.string(),
		actorName: v.string(),
		strokeId: v.optional(v.string()),
		color: v.optional(v.string()),
		width: v.optional(v.number()),
		tool: v.optional(v.string()),
		opacity: v.optional(v.number()),
		points: v.optional(v.array(v.object({ u: v.number(), v: v.number() }))),
		clearScope: v.optional(v.string()),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_actor", ["actorId"])
		.index("by_room_sequence", ["roomCode", "sequence"])
		.index("by_room_target_sequence", [
			"roomCode",
			"targetKind",
			"targetId",
			"sequence",
		])
		.index("by_expiry", ["expiresAt"]),

	sharedBrowserSessions: defineTable({
		roomCode: v.string(),
		workspaceId: v.id("workspaces"),
		createdBy: v.optional(v.id("users")),
		status: v.string(),
		createdAt: v.number(),
		terminatedAt: v.optional(v.number()),
		terminatedBy: v.optional(v.id("users")),
		controllerUserId: v.optional(v.id("users")),
		controllerLeaseId: v.optional(v.string()),
		controllerLeaseExpiresAt: v.optional(v.number()),
		controllerRequestId: v.optional(v.string()),
	})
		.index("by_creator", ["createdBy"])
		.index("by_terminated_by", ["terminatedBy"])
		.index("by_controller", ["controllerUserId"])
		.index("by_room", ["roomCode"])
		.index("by_room_status", ["roomCode", "status"])
		.index("by_workspace_status", ["workspaceId", "status"])
		.index("by_status", ["status"]),
	sharedBrowserControllers: defineTable({
		sessionId: v.id("sharedBrowserSessions"),
		roomCode: v.string(),
		userId: v.id("users"),
		leaseId: v.string(),
		grantedBy: v.id("users"),
		createdAt: v.number(),
		updatedAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_grantor", ["grantedBy"])
		.index("by_session", ["sessionId"])
		.index("by_session_user", ["sessionId", "userId"])
		.index("by_expiry", ["expiresAt"]),
	sharedBrowserGrants: defineTable({
		sessionId: v.id("sharedBrowserSessions"),
		roomCode: v.string(),
		userId: v.id("users"),
		kind: v.string(),
		mode: v.optional(v.string()),
		tokenHash: v.optional(v.string()),
		controllerLeaseId: v.optional(v.string()),
		status: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
		redeemedAt: v.optional(v.number()),
		revokedAt: v.optional(v.number()),
	})
		.index("by_user", ["userId"])
		.index("by_session_user", ["sessionId", "userId"])
		.index("by_session_status", ["sessionId", "status"])
		.index("by_token_hash", ["tokenHash"])
		.index("by_expiry", ["expiresAt"]),
	sharedBrowserRevocations: defineTable({
		grantId: v.id("sharedBrowserGrants"),
		sessionId: v.id("sharedBrowserSessions"),
		roomCode: v.string(),
		reason: v.string(),
		createdAt: v.number(),
		deliveredAt: v.optional(v.number()),
		deliveryClaimId: v.optional(v.string()),
		deliveryClaimedAt: v.optional(v.number()),
		deliveryAttempts: v.optional(v.number()),
	})
		.index("by_grant", ["grantId"])
		.index("by_delivery", ["deliveredAt", "createdAt"])
		.index("by_session", ["sessionId", "createdAt"]),

	workspaceAnalyticsDaily: defineTable({
		workspaceId: v.id("workspaces"),
		dayStart: v.number(),
		rooms: v.number(),
		roomDurationMs: v.number(),
		participantJoins: v.number(),
		guestAdmissions: v.number(),
		screenShareStarts: v.number(),
		activeUsers: v.number(),
		invitationFailures: v.number(),
		roomFailures: v.number(),
		clientFailures: v.number(),
		securityEvents: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_workspace_day", ["workspaceId", "dayStart"])
		.index("by_day", ["dayStart"]),
	workspaceAnalyticsActors: defineTable({
		workspaceId: v.id("workspaces"),
		dayStart: v.number(),
		actorKey: v.string(),
		createdAt: v.number(),
	})
		.index("by_workspace_day_actor", ["workspaceId", "dayStart", "actorKey"])
		.index("by_day", ["dayStart"]),
	workspaceAnalyticsSecurityEvents: defineTable({
		workspaceId: v.id("workspaces"),
		event: v.string(),
		reason: v.string(),
		outcome: v.string(),
		actorKind: v.string(),
		at: v.number(),
	})
		.index("by_workspace_time", ["workspaceId", "at"])
		.index("by_time", ["at"]),
	rateLimits: defineTable({
		key: v.string(),
		kind: v.optional(v.string()),
		count: v.number(),
		resetAt: v.number(),
	})
		.index("by_key", ["key"])
		.index("by_reset", ["resetAt"]),
});
