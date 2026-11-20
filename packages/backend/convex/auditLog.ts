import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Plain audit helper — kept dependency-free (no orgs import) so any mutation can call it
 * without creating an import cycle. Records an action into the auditLogs table.
 */
export async function audit(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces"> | undefined,
  userId: Id<"users">,
  action: string,
  meta?: unknown,
) {
  let actorName = "Unknown";
  let actorEmail: string | undefined = undefined;
  try {
    const user = await ctx.db.get(userId);
    if (user) {
      actorName = user.name ?? user.username ?? user.email?.split("@")[0] ?? "User";
      actorEmail = user.email ?? undefined;
    }
  } catch {}

  await ctx.db.insert("auditLogs", {
    workspaceId,
    userId,
    action,
    actorName,
    actorEmail,
    meta: meta ?? null,
    at: Date.now(),
  });
}
