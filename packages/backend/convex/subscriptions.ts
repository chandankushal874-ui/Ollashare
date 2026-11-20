import { Polar } from "@convex-dev/polar";
import { components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { getActiveUserId as getAuthUserId } from "./activeSession";

export const polar = new Polar(components.polar, {
	// biome-ignore lint/suspicious/noExplicitAny: third-party alpha component context type is not exported
	getUserInfo: async (ctx: any): Promise<{ userId: string; email: string }> => {
		const userId = await getAuthUserId(ctx);
		if (!userId) throw new Error("User not authenticated");
		const user = await ctx.db.get(userId);
		if (!user) throw new Error("User not found");
		if (!user.email) throw new Error("User email is required");
		return { userId: user._id, email: user.email };
	},
});

export async function deleteBillingCustomer(
	ctx: ActionCtx,
	userId: Id<"users">,
) {
	const customer = await polar.getCustomerByUserId(ctx, String(userId));
	if (!customer) return false;
	try {
		await polar.sdk.customers.delete({ id: customer.id });
	} catch (error) {
		if (!(error instanceof Error) || error.name !== "ResourceNotFound")
			throw error;
	}
	await ctx.runMutation(components.polar.lib.deleteCustomerByUserId, {
		userId: String(userId),
	});
	return true;
}

export const {
	changeCurrentSubscription,
	cancelCurrentSubscription,
	listAllProducts,
} = polar.api();
export const { generateCheckoutLink, generateCustomerPortalUrl } =
	polar.checkoutApi();
