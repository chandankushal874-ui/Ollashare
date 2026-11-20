import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import * as guestInvites from "./screenshare/guestInvites";

export const createGuestInviteV2 = internalMutation({
	args: {
		...guestInvites.createGuestInviteArgs,
		passwordSalt: v.optional(v.string()),
		passwordVerifier: v.optional(v.string()),
		passwordKdf: v.optional(v.string()),
	},
	handler: async (ctx, args) => guestInvites.createGuestInviteV2(ctx, args),
});

export const prepareGuestAdmissionPasswordAttempt = internalMutation({
	args: guestInvites.createGuestAdmissionRequestArgs,
	handler: guestInvites.prepareGuestAdmissionPasswordAttempt,
});

export const createGuestAdmissionRequestVerified = internalMutation({
	args: {
		...guestInvites.createGuestAdmissionRequestArgs,
		passwordVerified: v.boolean(),
	},
	handler: async (ctx, args) =>
		guestInvites.createGuestAdmissionRequestVerified(
			ctx,
			args,
			args.passwordVerified,
		),
});
