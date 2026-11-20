import {
	getAuthSessionId,
	getAuthUserId as getRawAuthUserId,
	retrieveAccount,
} from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
	type MutationCtx,
	type QueryCtx,
	action,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { getActiveUserId as getAuthUserId } from "./activeSession";
import { enqueueLiveKitParticipantEvictionsForUser } from "./screenshare/livekit_participant";
import { deleteBillingCustomer, polar } from "./subscriptions";
import {
	attachUpload,
	issueUpload,
	reclaimAvatarUpload,
	requireRegisteredUser,
	validateAttachedAvatar,
} from "./uploads";
import { projectPublicUser } from "./userProjection";
import { username } from "./utils/validators";

const deletionProfileRef = makeFunctionReference<
	"query",
	Record<string, never>,
	{ userId: Id<"users">; email: string } | null
>("users:deletionProfile");
const deletionReadyRef = makeFunctionReference<
	"query",
	{ userId: Id<"users"> },
	boolean
>("users:deletionReady");
const deleteUserAccountRef = makeFunctionReference<
	"mutation",
	{ userId: Id<"users"> },
	{ done: boolean }
>("users:deleteUserAccount");
const deletionBatchSize = 50;
let accountDeletionSchedulingDisabledForTests = false;
export function disableAccountDeletionSchedulingForTests() {
	accountDeletionSchedulingDisabledForTests = true;
}
const deletionPhases = [
	"files",
	"uploadObjects",
	"uploadTickets",
	"jobs",
	"apiKeys",
	"notifications",
	"usage",
	"auditLogs",
	"invites",
	"members",
	"workspaceRevocations",
	"rateLimits",
	"screenshareMessages",
	"screenshareGuestInvitesCreator",
	"screenshareGuestAdmissionsDecider",
	"screenshareGuestAdmissionsBoundUser",
	"screenshareViewers",
	"screenshareViewersApprover",
	"screenshareBans",
	"screenshareAnnotationPermissionsUser",
	"screenshareAnnotationPermissionsGrantor",
	"screenshareAnnotationEvents",
	"sharedBrowserControllersUser",
	"sharedBrowserControllersGrantor",
	"sharedBrowserGrants",
	"sharedBrowserSessionsCreator",
	"sharedBrowserSessionsTerminatedBy",
	"sharedBrowserSessionsController",
	"screenshareRooms",
	"screenshareSignalsSender",
	"screenshareSignalsTarget",
	"ownedWorkspaces",
	"authAccounts",
	"authSessions",
	"finalVerification",
	"user",
] as const;
type DeletionPhase = (typeof deletionPhases)[number];

async function deletionEligibility(ctx: QueryCtx, userId: Id<"users">) {
	const owned = await ctx.db
		.query("workspaces")
		.withIndex("by_owner", (q) => q.eq("ownerId", userId))
		.take(21);
	if (owned.length > 20)
		throw new Error("Account requires administrator-assisted deletion");
	const ownedIds = new Set(owned.map((workspace) => String(workspace._id)));
	const hostedRooms = await ctx.db
		.query("screenshareRooms")
		.withIndex("by_host", (q) => q.eq("hostId", userId))
		.take(21);
	if (
		hostedRooms.length > 20 ||
		hostedRooms.some((room) => !ownedIds.has(String(room.workspaceId)))
	)
		throw new Error("Transfer hosted rooms before deleting the account");
	for (const workspace of owned) {
		const members = await ctx.db
			.query("members")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
			.take(2);
		const file = await ctx.db
			.query("files")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
			.first();
		const job = await ctx.db
			.query("jobs")
			.withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
			.first();
		const room = await ctx.db
			.query("screenshareRooms")
			.withIndex("by_workspace_status", (q) =>
				q.eq("workspaceId", workspace._id).eq("status", "live"),
			)
			.first();
		if (
			members.some((member) => member.userId !== userId) ||
			file ||
			job ||
			room
		)
			throw new Error(
				"Transfer or clear owned workspaces before deleting the account",
			);
	}
	return owned;
}

export const deletionProfile = internalQuery({
	args: {},
	handler: async (ctx) => {
		const userId = await getRawAuthUserId(ctx);
		const sessionId = await getAuthSessionId(ctx);
		if (!userId || !sessionId) return null;
		const session = await ctx.db.get(sessionId);
		if (
			!session ||
			session.userId !== userId ||
			session.expirationTime <= Date.now() ||
			!(await ctx.db.get(userId))
		)
			return null;
		const account = await ctx.db
			.query("authAccounts")
			.withIndex("userIdAndProvider", (q) =>
				q.eq("userId", userId).eq("provider", "password"),
			)
			.first();
		return account ? { userId, email: account.providerAccountId } : null;
	},
});
export const deletionReady = internalQuery({
	args: { userId: v.id("users") },
	handler: async (ctx, { userId }) => {
		await deletionEligibility(ctx, userId);
		return true;
	},
});

export const getUser = query({
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) return;
		const user = await ctx.db.get(userId);
		if (!user) return;
		let subscription = null;
		try {
			subscription = await polar.getCurrentSubscription(ctx, {
				userId: user._id,
			});
		} catch {
			/* optional */
		}
		return {
			...projectPublicUser(user),
			name: user.username || user.name,
			subscription,
			avatarUrl: user.imageId
				? await ctx.storage.getUrl(user.imageId)
				: undefined,
		};
	},
});
export const updateUsername = mutation({
	args: { username: v.string() },
	handler: async (ctx, args) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) return;
		const parsed = username.safeParse(args.username);
		if (!parsed.success) throw new Error(parsed.error.message);
		await ctx.db.patch(userId, { username: parsed.data });
	},
});
export const generateUploadUrl = mutation({
	args: {},
	handler: async (ctx) => {
		if (!(await getAuthUserId(ctx))) throw new Error("User not found");
		return issueUpload(ctx);
	},
});
export const updateUserImage = mutation({
	args: { imageId: v.id("_storage") },
	handler: async (ctx, args) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new Error("User not found");
		const user = await requireRegisteredUser(ctx, userId);
		const previous = user.imageId;
		if (previous === args.imageId)
			return validateAttachedAvatar(ctx, args.imageId, userId);
		await attachUpload(ctx, args.imageId, userId);
		await ctx.db.patch(userId, { imageId: args.imageId, image: undefined });
		if (previous) await reclaimAvatarUpload(ctx, previous, userId);
	},
});
export const removeUserImage = mutation({
	args: {},
	handler: async (ctx) => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new Error("User not found");
		const user = await requireRegisteredUser(ctx, userId);
		await ctx.db.patch(userId, { imageId: undefined, image: undefined });
		if (user.imageId) await reclaimAvatarUpload(ctx, user.imageId, userId);
	},
});

async function deleteRows(rows: Array<{ _id: string }>, ctx: MutationCtx) {
	for (const row of rows) await ctx.db.delete(row._id as never);
}
async function deleteStorageIfPresent(
	ctx: MutationCtx,
	storageId: Id<"_storage">,
) {
	if (await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
}
async function hasRemainingUserLinks(ctx: MutationCtx, userId: Id<"users">) {
	const checks = [
		ctx.db
			.query("files")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("uploadObjects")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("uploadTickets")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("jobs")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("apiKeys")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("notifications")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("usage")
			.withIndex("by_user_metric", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("auditLogs")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("invites")
			.withIndex("by_inviter", (q) => q.eq("invitedBy", userId))
			.first(),
		ctx.db
			.query("members")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("workspaceRevocations")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("screenshareMessages")
			.withIndex("by_sender", (q) => q.eq("senderId", userId))
			.first(),
		ctx.db
			.query("screenshareGuestInvites")
			.withIndex("by_creator", (q) => q.eq("createdBy", userId))
			.first(),
		ctx.db
			.query("screenshareGuestAdmissionRequests")
			.withIndex("by_decider", (q) => q.eq("decidedBy", userId))
			.first(),
		ctx.db
			.query("screenshareGuestAdmissionRequests")
			.withIndex("by_bound_user", (q) => q.eq("boundUserId", userId))
			.first(),
		ctx.db
			.query("screenshareViewers")
			.withIndex("by_viewer", (q) => q.eq("viewerId", userId))
			.first(),
		ctx.db
			.query("screenshareViewers")
			.withIndex("by_approver", (q) => q.eq("sharerApprovedBy", userId))
			.first(),
		ctx.db
			.query("screenshareBans")
			.withIndex("by_viewer", (q) => q.eq("viewerId", userId))
			.first(),
		ctx.db
			.query("screenshareAnnotationPermissions")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("screenshareAnnotationPermissions")
			.withIndex("by_grantor", (q) => q.eq("grantedBy", userId))
			.first(),
		ctx.db
			.query("screenshareAnnotationEvents")
			.withIndex("by_actor", (q) => q.eq("actorId", String(userId)))
			.first(),
		ctx.db
			.query("sharedBrowserControllers")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("sharedBrowserControllers")
			.withIndex("by_grantor", (q) => q.eq("grantedBy", userId))
			.first(),
		ctx.db
			.query("sharedBrowserGrants")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("sharedBrowserSessions")
			.withIndex("by_creator", (q) => q.eq("createdBy", userId))
			.first(),
		ctx.db
			.query("sharedBrowserSessions")
			.withIndex("by_terminated_by", (q) => q.eq("terminatedBy", userId))
			.first(),
		ctx.db
			.query("sharedBrowserSessions")
			.withIndex("by_controller", (q) => q.eq("controllerUserId", userId))
			.first(),
		ctx.db
			.query("screenshareRooms")
			.withIndex("by_host", (q) => q.eq("hostId", userId))
			.first(),
		ctx.db
			.query("screenshareSignals")
			.withIndex("by_sender", (q) => q.eq("senderId", userId))
			.first(),
		ctx.db
			.query("screenshareSignals")
			.withIndex("by_target", (q) => q.eq("to", userId))
			.first(),
		ctx.db
			.query("workspaces")
			.withIndex("by_owner", (q) => q.eq("ownerId", userId))
			.first(),
		ctx.db
			.query("authAccounts")
			.withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
			.first(),
		ctx.db
			.query("authSessions")
			.withIndex("userId", (q) => q.eq("userId", userId))
			.first(),
	];
	return (await Promise.all(checks)).some(Boolean);
}

async function runDeletionPhase(
	ctx: MutationCtx,
	userId: Id<"users">,
	phase: DeletionPhase,
): Promise<number> {
	const takeDelete = async (query: {
		take(n: number): Promise<Array<{ _id: string }>>;
	}) => {
		const rows = await query.take(deletionBatchSize);
		await deleteRows(rows, ctx);
		return rows.length;
	};
	switch (phase) {
		case "files": {
			const rows = await ctx.db
				.query("files")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.take(deletionBatchSize);
			for (const row of rows) {
				await deleteStorageIfPresent(ctx, row.storageId);
				await ctx.db.delete(row._id);
			}
			return rows.length;
		}
		case "uploadObjects": {
			const rows = await ctx.db
				.query("uploadObjects")
				.withIndex("by_user", (q) => q.eq("userId", userId))
				.take(deletionBatchSize);
			for (const row of rows) {
				await deleteStorageIfPresent(ctx, row.storageId);
				await ctx.db.delete(row._id);
			}
			return rows.length;
		}
		case "uploadTickets":
			return takeDelete(
				ctx.db
					.query("uploadTickets")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "jobs":
			return takeDelete(
				ctx.db
					.query("jobs")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "apiKeys":
			return takeDelete(
				ctx.db
					.query("apiKeys")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "notifications":
			return takeDelete(
				ctx.db
					.query("notifications")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "usage":
			return takeDelete(
				ctx.db
					.query("usage")
					.withIndex("by_user_metric", (q) => q.eq("userId", userId)),
			);
		case "auditLogs":
			return takeDelete(
				ctx.db
					.query("auditLogs")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "invites":
			return takeDelete(
				ctx.db
					.query("invites")
					.withIndex("by_inviter", (q) => q.eq("invitedBy", userId)),
			);
		case "members":
			return takeDelete(
				ctx.db
					.query("members")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "workspaceRevocations":
			return takeDelete(
				ctx.db
					.query("workspaceRevocations")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "rateLimits":
			return 0;
		case "screenshareMessages":
			return takeDelete(
				ctx.db
					.query("screenshareMessages")
					.withIndex("by_sender", (q) => q.eq("senderId", userId)),
			);
		case "screenshareGuestInvitesCreator": {
			const rows = await ctx.db
				.query("screenshareGuestInvites")
				.withIndex("by_creator", (q) => q.eq("createdBy", userId))
				.take(deletionBatchSize);
			for (const row of rows)
				await ctx.db.patch(row._id, {
					createdBy: undefined,
					revokedAt: row.revokedAt ?? Date.now(),
				});
			return rows.length;
		}
		case "screenshareGuestAdmissionsDecider": {
			const rows = await ctx.db
				.query("screenshareGuestAdmissionRequests")
				.withIndex("by_decider", (q) => q.eq("decidedBy", userId))
				.take(deletionBatchSize);
			for (const row of rows)
				await ctx.db.patch(row._id, { decidedBy: undefined });
			return rows.length;
		}
		case "screenshareGuestAdmissionsBoundUser": {
			const rows = await ctx.db
				.query("screenshareGuestAdmissionRequests")
				.withIndex("by_bound_user", (q) => q.eq("boundUserId", userId))
				.take(deletionBatchSize);
			for (const row of rows)
				await ctx.db.patch(row._id, { boundUserId: undefined });
			return rows.length;
		}
		case "screenshareViewers":
			return takeDelete(
				ctx.db
					.query("screenshareViewers")
					.withIndex("by_viewer", (q) => q.eq("viewerId", userId)),
			);
		case "screenshareViewersApprover": {
			const rows = await ctx.db
				.query("screenshareViewers")
				.withIndex("by_approver", (q) => q.eq("sharerApprovedBy", userId))
				.take(deletionBatchSize);
			for (const row of rows)
				await ctx.db.patch(row._id, {
					sharerApprovedBy: undefined,
					sharerApprovedAt: undefined,
					sharerApproved: false,
				});
			return rows.length;
		}
		case "screenshareBans":
			return takeDelete(
				ctx.db
					.query("screenshareBans")
					.withIndex("by_viewer", (q) => q.eq("viewerId", userId)),
			);
		case "screenshareAnnotationPermissionsUser":
			return takeDelete(
				ctx.db
					.query("screenshareAnnotationPermissions")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "screenshareAnnotationPermissionsGrantor":
			return takeDelete(
				ctx.db
					.query("screenshareAnnotationPermissions")
					.withIndex("by_grantor", (q) => q.eq("grantedBy", userId)),
			);
		case "screenshareAnnotationEvents":
			return takeDelete(
				ctx.db
					.query("screenshareAnnotationEvents")
					.withIndex("by_actor", (q) => q.eq("actorId", String(userId))),
			);
		case "sharedBrowserControllersUser":
			return takeDelete(
				ctx.db
					.query("sharedBrowserControllers")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "sharedBrowserControllersGrantor":
			return takeDelete(
				ctx.db
					.query("sharedBrowserControllers")
					.withIndex("by_grantor", (q) => q.eq("grantedBy", userId)),
			);
		case "sharedBrowserGrants":
			return takeDelete(
				ctx.db
					.query("sharedBrowserGrants")
					.withIndex("by_user", (q) => q.eq("userId", userId)),
			);
		case "sharedBrowserSessionsCreator": {
			const rows = await ctx.db
				.query("sharedBrowserSessions")
				.withIndex("by_creator", (q) => q.eq("createdBy", userId))
				.take(deletionBatchSize);
			for (const row of rows)
				await ctx.db.patch(row._id, { createdBy: undefined });
			return rows.length;
		}
		case "sharedBrowserSessionsTerminatedBy": {
			const rows = await ctx.db
				.query("sharedBrowserSessions")
				.withIndex("by_terminated_by", (q) => q.eq("terminatedBy", userId))
				.take(deletionBatchSize);
			for (const row of rows)
				await ctx.db.patch(row._id, { terminatedBy: undefined });
			return rows.length;
		}
		case "sharedBrowserSessionsController": {
			const rows = await ctx.db
				.query("sharedBrowserSessions")
				.withIndex("by_controller", (q) => q.eq("controllerUserId", userId))
				.take(deletionBatchSize);
			for (const row of rows)
				await ctx.db.patch(row._id, {
					controllerUserId: undefined,
					controllerLeaseId: undefined,
					controllerLeaseExpiresAt: undefined,
					controllerRequestId: undefined,
				});
			return rows.length;
		}
		case "screenshareRooms":
			return 0;
		case "screenshareSignalsSender":
			return takeDelete(
				ctx.db
					.query("screenshareSignals")
					.withIndex("by_sender", (q) => q.eq("senderId", userId)),
			);
		case "screenshareSignalsTarget":
			return takeDelete(
				ctx.db
					.query("screenshareSignals")
					.withIndex("by_target", (q) => q.eq("to", userId)),
			);
		case "ownedWorkspaces": {
			const rows = await ctx.db
				.query("workspaces")
				.withIndex("by_owner", (q) => q.eq("ownerId", userId))
				.take(deletionBatchSize);
			for (const workspace of rows) {
				const groups = await Promise.all([
					ctx.db
						.query("invites")
						.withIndex("by_workspace", (q) =>
							q.eq("workspaceId", workspace._id),
						)
						.take(deletionBatchSize),
					ctx.db
						.query("counters")
						.withIndex("by_workspace_metric", (q) =>
							q.eq("workspaceId", workspace._id),
						)
						.take(deletionBatchSize),
					ctx.db
						.query("events")
						.withIndex("by_workspace", (q) =>
							q.eq("workspaceId", workspace._id),
						)
						.take(deletionBatchSize),
					ctx.db
						.query("uploadTickets")
						.withIndex("by_workspace", (q) =>
							q.eq("workspaceId", workspace._id),
						)
						.take(deletionBatchSize),
					ctx.db
						.query("uploadObjects")
						.withIndex("by_workspace", (q) =>
							q.eq("workspaceId", workspace._id),
						)
						.take(deletionBatchSize),
					ctx.db
						.query("screenshareRooms")
						.withIndex("by_workspace_status", (q) =>
							q.eq("workspaceId", workspace._id).eq("status", "ended"),
						)
						.take(deletionBatchSize),
					ctx.db
						.query("sharedBrowserSessions")
						.withIndex("by_workspace_status", (q) =>
							q.eq("workspaceId", workspace._id).eq("status", "terminated"),
						)
						.take(deletionBatchSize),
					ctx.db
						.query("workspaceAnalyticsDaily")
						.withIndex("by_workspace_day", (q) =>
							q.eq("workspaceId", workspace._id),
						)
						.take(deletionBatchSize),
					ctx.db
						.query("workspaceAnalyticsSecurityEvents")
						.withIndex("by_workspace_time", (q) =>
							q.eq("workspaceId", workspace._id),
						)
						.take(deletionBatchSize),
					ctx.db
						.query("workspaceAnalyticsActors")
						.filter((q) => q.eq(q.field("workspaceId"), workspace._id))
						.take(deletionBatchSize),
				]);
				const [
					invites,
					counters,
					events,
					tickets,
					uploads,
					rooms,
					browsers,
					daily,
					security,
					actors,
				] = groups;
				await deleteRows(
					[
						...invites,
						...counters,
						...events,
						...tickets,
						...rooms,
						...browsers,
						...daily,
						...security,
						...actors,
					],
					ctx,
				);
				for (const upload of uploads) {
					await deleteStorageIfPresent(ctx, upload.storageId);
					await ctx.db.delete(upload._id);
				}
				if (groups.every((group) => group.length === 0))
					await ctx.db.delete(workspace._id);
			}
			return rows.length;
		}
		case "authAccounts": {
			const rows = await ctx.db
				.query("authAccounts")
				.withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
				.take(deletionBatchSize);
			let deleted = 0;
			for (const account of rows) {
				const codes = await ctx.db
					.query("authVerificationCodes")
					.withIndex("accountId", (q) => q.eq("accountId", account._id))
					.take(deletionBatchSize);
				const limit = await ctx.db
					.query("authRateLimits")
					.withIndex("identifier", (q) =>
						q.eq("identifier", String(account._id)),
					)
					.unique();
				await deleteRows(codes, ctx);
				if (limit) await ctx.db.delete(limit._id);
				deleted += codes.length + (limit ? 1 : 0);
				if (codes.length === 0) {
					await ctx.db.delete(account._id);
					deleted++;
				}
			}
			return deleted;
		}
		case "authSessions": {
			const rows = await ctx.db
				.query("authSessions")
				.withIndex("userId", (q) => q.eq("userId", userId))
				.take(deletionBatchSize);
			let deleted = 0;
			for (const session of rows) {
				const verifiers = await ctx.db
					.query("authVerifiers")
					.withIndex("by_session", (q) => q.eq("sessionId", session._id))
					.take(deletionBatchSize);
				const tokens = await ctx.db
					.query("authRefreshTokens")
					.withIndex("sessionId", (q) => q.eq("sessionId", session._id))
					.take(deletionBatchSize);
				await deleteRows([...verifiers, ...tokens], ctx);
				deleted += verifiers.length + tokens.length;
				if (verifiers.length + tokens.length === 0) {
					await ctx.db.delete(session._id);
					deleted++;
				}
			}
			return deleted;
		}
		case "finalVerification":
			return (await hasRemainingUserLinks(ctx, userId)) ? -1 : 0;
		case "user": {
			const user = await ctx.db.get(userId);
			if (!user) return 0;
			if (await hasRemainingUserLinks(ctx, userId)) return -1;
			if (user.imageId) await deleteStorageIfPresent(ctx, user.imageId);
			await ctx.db.delete(userId);
			return 1;
		}
	}
}

export const deleteUserAccount = internalMutation({
	args: { userId: v.id("users") },
	handler: async (ctx, args) => {
		const user = await ctx.db.get(args.userId);
		const existing = await ctx.db
			.query("accountDeletionStates")
			.withIndex("by_user", (q) => q.eq("userId", args.userId))
			.unique();
		if (!user) {
			if (existing) await ctx.db.delete(existing._id);
			return { done: true };
		}
		if (!existing) await deletionEligibility(ctx, args.userId);
		const stateId =
			existing?._id ??
			(await ctx.db.insert("accountDeletionStates", {
				userId: args.userId,
				phase: deletionPhases[0],
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}));
		const state = existing ?? (await ctx.db.get(stateId));
		const phase = (state?.phase ?? deletionPhases[0]) as DeletionPhase;
		if (phase === deletionPhases[0])
			await enqueueLiveKitParticipantEvictionsForUser(ctx, {
				userId: args.userId,
				reason: "account-deletion",
			});
		if (phase === "rateLimits") {
			const page = await ctx.db.query("rateLimits").paginate({
				cursor: state?.cursor ?? null,
				numItems: deletionBatchSize,
			});
			await deleteRows(
				page.page.filter((row) => row.key.includes(String(args.userId))),
				ctx,
			);
			if (page.isDone)
				await ctx.db.patch(stateId, {
					phase: deletionPhases[deletionPhases.indexOf(phase) + 1],
					cursor: undefined,
					updatedAt: Date.now(),
				});
			else
				await ctx.db.patch(stateId, {
					cursor: page.continueCursor,
					updatedAt: Date.now(),
				});
			if (!accountDeletionSchedulingDisabledForTests)
				await ctx.scheduler.runAfter(0, deleteUserAccountRef, {
					userId: args.userId,
				});
			return { done: false };
		}
		const processed = await runDeletionPhase(ctx, args.userId, phase);
		if (phase === "user" && !(await ctx.db.get(args.userId))) {
			await ctx.db.delete(stateId);
			return { done: true };
		}
		if (processed < 0)
			await ctx.db.patch(stateId, {
				phase: deletionPhases[0],
				cursor: undefined,
				updatedAt: Date.now(),
			});
		else if (processed === 0)
			await ctx.db.patch(stateId, {
				phase: deletionPhases[deletionPhases.indexOf(phase) + 1] ?? "user",
				cursor: undefined,
				updatedAt: Date.now(),
			});
		else
			await ctx.db.patch(stateId, {
				cursor: String(Number(state?.cursor ?? 0) + processed),
				updatedAt: Date.now(),
			});
		if (
			!accountDeletionSchedulingDisabledForTests &&
			(await ctx.db.get(args.userId))
		)
			await ctx.scheduler.runAfter(0, deleteUserAccountRef, {
				userId: args.userId,
			});
		return { done: false };
	},
});
export const continueAccountDeletions = internalMutation({
	args: {},
	handler: async (ctx) => {
		const states = await ctx.db
			.query("accountDeletionStates")
			.withIndex("by_updated")
			.take(10);
		for (const state of states)
			await ctx.scheduler.runAfter(0, deleteUserAccountRef, {
				userId: state.userId,
			});
		return states.length;
	},
});
export const deleteCurrentUserAccount = action({
	args: { password: v.string() },
	handler: async (ctx, { password }) => {
		const profile = await ctx.runQuery(deletionProfileRef, {});
		if (!profile || !password || password.length > 256)
			throw new Error("Password reauthentication is required");
		const verified = await retrieveAccount(ctx, {
			provider: "password",
			account: { id: profile.email, secret: password },
		});
		if (verified.user?._id !== profile.userId)
			throw new Error("Unable to delete account");
		await ctx.runQuery(deletionReadyRef, { userId: profile.userId });
		let subscription: Awaited<ReturnType<typeof polar.getCurrentSubscription>>;
		try {
			subscription = await polar.getCurrentSubscription(ctx, {
				userId: profile.userId,
			});
		} catch {
			throw new Error(
				"Billing readiness could not be confirmed; deletion was not performed",
			);
		}
		if (subscription)
			await polar.cancelSubscription(ctx, { revokeImmediately: true });
		try {
			await deleteBillingCustomer(ctx, profile.userId);
		} catch {
			throw new Error(
				"Billing cleanup could not be completed; deletion was not started",
			);
		}
		await ctx.runMutation(deleteUserAccountRef, { userId: profile.userId });
	},
});
