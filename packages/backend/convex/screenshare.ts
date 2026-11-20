// Public screenshare API. This file registers every `query`/`mutation` in the
// `api.screenshare.*` namespace. Because Convex derives a function's runtime
// name from the file where `query()`/`mutation()` is called (not from re-exports),
// the registrations must live here so the client pages keep working unchanged.
//
// The implementation of each concern is isolated in `screenshare/` and wired in
// below:
//
//   rooms.ts      -> screenshareRooms lifecycle
//   presence.ts   -> screenshareViewers join/heartbeat
//   signaling.ts  -> screenshareSignals WebRTC relay (offer/answer/candidate)
//   livekit.ts    -> LiveKit SFU access token issuance & permission verification

import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import {
	action,
	internalAction,
	internalMutation,
	mutation,
	query,
} from "./_generated/server";
import {
	downgradePublishPermission,
	evictParticipant,
	grantPublishPermission,
	teardownLiveKitRoom,
} from "./screenshare/livekit_admin";

import * as annotations from "./screenshare/annotations";
import * as chat from "./screenshare/chat";
import * as guestInvites from "./screenshare/guestInvites";
import * as livekit from "./screenshare/livekit";
import * as presence from "./screenshare/presence";
import * as recordings from "./screenshare/recordings";
import * as rooms from "./screenshare/rooms";
import * as signaling from "./screenshare/signaling";
export const sendChatMessage = mutation({
	args: chat.sendArgs,
	handler: chat.send,
});
export const listChatMessages = query({
	args: chat.listArgs,
	handler: chat.list,
});

type CreateGuestInviteResult = Awaited<
	ReturnType<typeof guestInvites.createGuestInviteV2>
>;
type CreateGuestAdmissionRequestResult = Awaited<
	ReturnType<typeof guestInvites.createGuestAdmissionRequestVerified>
>;
const createGuestInviteV2Ref = makeFunctionReference<"mutation">(
	"guestInviteInternal:createGuestInviteV2",
);
const prepareGuestAdmissionRef = makeFunctionReference<"mutation">(
	"guestInviteInternal:prepareGuestAdmissionPasswordAttempt",
);
const createGuestAdmissionVerifiedRef = makeFunctionReference<"mutation">(
	"guestInviteInternal:createGuestAdmissionRequestVerified",
);

/**
 * Return shape of `upgradeViewerToSharer`, derived from the raw mutation
 * implementation. This explicit alias breaks circular type inference
 * (TS7022): without it, the action's inferred return type depends on `api`,
 * which depends on `typeof screenshare` — the module that exports the action.
 */
type UpgradeViewerToSharerResult = Awaited<
	ReturnType<typeof livekit.issueLiveKitToken>
> & {
	permissionGranted: boolean;
};

export const createRoom = mutation({
	args: rooms.createRoomArgs,
	handler: rooms.createRoom,
});

export const getRoom = query({
	args: rooms.getRoomArgs,
	handler: rooms.getRoom,
});

export const listActiveRooms = query({
	args: rooms.listActiveRoomsArgs,
	handler: rooms.listActiveRooms,
});

export const updateRoomSettings = mutation({
	args: rooms.updateRoomSettingsArgs,
	handler: rooms.updateRoomSettings,
});

export const endRoom = mutation({
	args: rooms.endRoomArgs,
	handler: rooms.endRoom,
});

export const joinRoom = mutation({
	args: presence.joinRoomArgs,
	handler: presence.joinRoom,
});

export const getViewers = query({
	args: presence.getViewersArgs,
	handler: presence.getViewers,
});

export const pingViewer = mutation({
	args: presence.pingViewerArgs,
	handler: presence.pingViewer,
});

export const sendSignal = mutation({
	args: signaling.sendSignalArgs,
	handler: signaling.sendSignal,
});

export const getSignals = query({
	args: signaling.getSignalsArgs,
	handler: signaling.getSignals,
});

export const setRoomLock = mutation({
	args: rooms.setRoomLockArgs,
	handler: rooms.setRoomLock,
});

export const setRoomLimits = mutation({
	args: rooms.setRoomLimitsArgs,
	handler: rooms.setRoomLimits,
});

export const forceEndRoom = mutation({
	args: rooms.forceEndRoomArgs,
	handler: rooms.forceEndRoom,
});

export const listAllActiveRoomsWithDetails = query({
	args: rooms.listAllActiveRoomsWithDetailsArgs,
	handler: rooms.listAllActiveRoomsWithDetails,
});

export const kickParticipant = mutation({
	args: presence.kickParticipantArgs,
	handler: presence.kickParticipant,
});

export const setSharingStatus = mutation({
	args: presence.setSharingStatusArgs,
	handler: presence.setSharingStatus,
});

export const autoEndStaleRooms = internalMutation({
	args: {},
	handler: rooms.autoEndStaleRoomsHandler,
});

export const startLocalRecording = mutation({
	args: recordings.startLocalRecordingArgs,
	handler: recordings.startLocalRecording,
});
export const heartbeatLocalRecording = mutation({
	args: recordings.heartbeatLocalRecordingArgs,
	handler: recordings.heartbeatLocalRecording,
});
export const setLocalRecordingPaused = mutation({
	args: recordings.setLocalRecordingPausedArgs,
	handler: recordings.setLocalRecordingPaused,
});
export const finishLocalRecording = mutation({
	args: recordings.finishLocalRecordingArgs,
	handler: recordings.finishLocalRecording,
});
export const getActiveLocalRecording = query({
	args: recordings.getActiveLocalRecordingArgs,
	handler: recordings.getActiveLocalRecording,
});
export const cleanupLocalRecordings = internalMutation({
	args: {},
	handler: recordings.cleanupLocalRecordings,
});

export const issueLiveKitToken = mutation({
	args: livekit.issueLiveKitTokenArgs,
	handler: livekit.issueLiveKitToken,
});

// ---- LiveKit SFU Side-Effect Actions ----
// LiveKit RoomServiceClient uses HTTP network requests with timers (setTimeout).
// Convex deterministic isolate strictly forbids setTimeout in queries and mutations.
// These actions run in Convex Node.js action runtime without isolate restrictions.

export const liveKitParticipantOperationAction = internalAction({
	args: {
		operationKey: v.string(),
	},
	handler: async (ctx, { operationKey }) => {
		const claim = await ctx.runMutation(
			internal.screenshareLiveKitParticipant.claimLiveKitParticipantOperation,
			{ operationKey },
		);
		if (!claim) return;

		const result =
			claim.operationKind === "evict"
				? await evictParticipant(claim.roomCode, claim.identity)
				: await downgradePublishPermission(claim.roomCode, claim.identity);
		if (result.ok) {
			await ctx.runMutation(
				internal.screenshareLiveKitParticipant
					.recordLiveKitParticipantOperationSuccess,
				{ operationId: claim.operationId, attempts: claim.attempts },
			);
			return;
		}

		await ctx.runMutation(
			internal.screenshareLiveKitParticipant
				.recordLiveKitParticipantOperationRetry,
			{
				operationId: claim.operationId,
				attempts: claim.attempts,
				failureKind: result.failureKind,
				error: result.error,
			},
		);
	},
});

export const evictParticipantAction = internalAction({
	args: {
		roomCode: v.string(),
		identity: v.string(),
	},
	handler: async (ctx, { roomCode, identity }) => {
		const operationKey = await ctx.runMutation(
			internal.screenshareLiveKitParticipant
				.enqueueLiveKitParticipantOperationMutation,
			{
				operationKind: "evict",
				roomCode,
				identity,
				reason: "legacy-eviction-action",
			},
		);
		await ctx.runAction(
			internal.screenshare.liveKitParticipantOperationAction,
			{ operationKey },
		);
	},
});

export const teardownLiveKitRoomAction = internalAction({
	args: {
		roomCode: v.string(),
	},
	handler: async (ctx, { roomCode }) => {
		const claim = await ctx.runMutation(
			internal.screenshareLiveKitTeardown.claimLiveKitTeardown,
			{
				roomCode,
			},
		);
		if (!claim) return;

		const result = await teardownLiveKitRoom(roomCode);
		if (result.ok) {
			await ctx.runMutation(
				internal.screenshareLiveKitTeardown.recordLiveKitTeardownSuccess,
				{
					teardownId: claim.teardownId,
				},
			);
			return;
		}

		await ctx.runMutation(
			internal.screenshareLiveKitTeardown.recordLiveKitTeardownRetry,
			{
				teardownId: claim.teardownId,
				attempts: claim.attempts,
				failureKind: result.failureKind,
				error: result.error,
			},
		);
	},
});

/**
 * Public action to kick a participant from a screenshare session.
 * Executes the transactional database mutation and performs external LiveKit SFU eviction safely in action runtime.
 */
export const kickParticipantAction = action({
	args: presence.kickParticipantArgs,
	handler: async (ctx, args) => {
		await ctx.runMutation(api.screenshare.kickParticipant, args);
		return true;
	},
});

/**
 * Public action: upgrade the caller from viewer to sharer WITHOUT reconnecting.
 *
 * Architecture (fixes the same-identity reconnect race that could make other
 * participants miss the new screen-share track):
 *   1. `issueLiveKitToken` mutation validates the caller (auth, maxSharers cap,
 *      rate limit), registers sharer presence in the DB, and mints a fresh
 *      publish-capable JWT (used for future reconnects/token refreshes).
 *   2. `grantPublishPermission` applies the grant to the caller's LIVE SFU
 *      session via RoomService UpdateParticipant — the client keeps the same
 *      session, so viewers see zero churn (no ParticipantDisconnected /
 *      ParticipantConnected / tile blink) and reliably auto-subscribe.
 *
 * Returns the token payload plus `permissionGranted`. When the runtime grant
 * could not be applied (participant briefly absent from the SFU), callers fall
 * back to reconnecting with `token` — behavior identical to the legacy flow.
 */
export const upgradeViewerToSharer = action({
	args: { roomCode: v.string() },
	handler: async (ctx, { roomCode }): Promise<UpgradeViewerToSharerResult> => {
		const tokenData = await ctx.runMutation(api.screenshare.issueLiveKitToken, {
			roomCode,
			requestPublish: true,
		});
		const permissionGranted = await grantPublishPermission(
			roomCode,
			String(tokenData.identity),
		);
		return { ...tokenData, permissionGranted };
	},
});

export const setAllowGuestSharing = mutation({
	args: rooms.setAllowGuestSharingArgs,
	handler: rooms.setAllowGuestSharing,
});
export const createGuestInvite = mutation({
	args: guestInvites.createGuestInviteArgs,
	handler: guestInvites.createGuestInvite,
});
export const createGuestInviteSecure = action({
	args: guestInvites.createGuestInviteArgs,
	handler: async (ctx, args): Promise<CreateGuestInviteResult> => {
		if (!args.password) return ctx.runMutation(createGuestInviteV2Ref, args);
		const passwordSalt = crypto.randomUUID().replaceAll("-", "").slice(0, 32);
		const passwordVerifier = await guestInvites.derivePasswordVerifier(
			args.password,
			passwordSalt,
		);
		return ctx.runMutation(createGuestInviteV2Ref, {
			...args,
			password: undefined,
			passwordSalt,
			passwordVerifier,
			passwordKdf: "pbkdf2-sha256-v1:100000",
		});
	},
});
export const listGuestInvites = query({
	args: guestInvites.listGuestInvitesArgs,
	handler: guestInvites.listGuestInvites,
});
export const revokeGuestInvite = mutation({
	args: guestInvites.revokeGuestInviteArgs,
	handler: guestInvites.revokeGuestInviteByHost,
});
export const revokeGuestInvites = mutation({
	args: guestInvites.revokeGuestInvitesArgs,
	handler: guestInvites.revokeGuestInvitesByHost,
});
export const createGuestAdmissionRequest = mutation({
	args: guestInvites.createGuestAdmissionRequestArgs,
	handler: guestInvites.createGuestAdmissionRequest,
});
export const createGuestAdmissionRequestSecure = action({
	args: guestInvites.createGuestAdmissionRequestArgs,
	handler: async (ctx, args): Promise<CreateGuestAdmissionRequestResult> => {
		let prepared: Awaited<
			ReturnType<typeof guestInvites.prepareGuestAdmissionPasswordAttempt>
		>;
		try {
			prepared = (await ctx.runMutation(
				prepareGuestAdmissionRef,
				args,
			)) as Awaited<
				ReturnType<typeof guestInvites.prepareGuestAdmissionPasswordAttempt>
			>;
		} catch (error) {
			const workspaceId = await ctx.runQuery(
				internal.analytics.lookupWorkspaceForRoom,
				{
					roomCode: args.roomCode,
				},
			);
			if (workspaceId) {
				await ctx.runMutation(
					internal.analytics.recordInvitationFailureByWorkspace,
					{
						workspaceId,
					},
				);
			}
			throw error;
		}
		let passwordVerified = false;
		if (prepared.passwordProtected) {
			const candidate = await guestInvites.derivePasswordVerifier(
				args.password ?? "",
				prepared.passwordSalt,
			);
			passwordVerified = guestInvites.constantTimeEqual(
				candidate,
				prepared.passwordVerifier,
			);
			if (!passwordVerified) {
				await ctx.runMutation(
					internal.analytics.recordInvitationFailureForRoom,
					{
						roomCode: args.roomCode,
					},
				);
				throw new Error("Invitation could not be verified");
			}
		}
		return ctx.runMutation(createGuestAdmissionVerifiedRef, {
			...args,
			password: undefined,
			passwordVerified,
		});
	},
});
export const pollGuestAdmission = mutation({
	args: guestInvites.pollGuestAdmissionArgs,
	handler: guestInvites.pollGuestAdmission,
});
export const listGuestAdmissionRequests = query({
	args: guestInvites.listGuestAdmissionRequestsArgs,
	handler: guestInvites.listGuestAdmissionRequests,
});
export const decideGuestAdmission = mutation({
	args: guestInvites.decideGuestAdmissionArgs,
	handler: guestInvites.decideGuestAdmission,
});
export const cleanupGuestInvitationData = internalMutation({
	args: {},
	handler: guestInvites.cleanupGuestInvitationData,
});

export const approveSharer = mutation({
	args: rooms.approveSharerArgs,
	handler: rooms.approveSharer,
});

export const grantAnnotation = mutation({
	args: annotations.grantAnnotationArgs,
	handler: annotations.grantAnnotation,
});
export const revokeAnnotation = mutation({
	args: annotations.revokeAnnotationArgs,
	handler: annotations.revokeAnnotation,
});
export const getAnnotationPermission = query({
	args: annotations.getAnnotationPermissionArgs,
	handler: annotations.getAnnotationPermission,
});
export const appendAnnotationEvents = mutation({
	args: annotations.appendAnnotationEventsArgs,
	handler: annotations.appendAnnotationEvents,
});
export const listAnnotationEvents = query({
	args: annotations.listAnnotationEventsArgs,
	handler: annotations.listAnnotationEvents,
});
export const cleanupAnnotationEvents = internalMutation({
	args: {},
	handler: annotations.cleanupAnnotationEvents,
});
