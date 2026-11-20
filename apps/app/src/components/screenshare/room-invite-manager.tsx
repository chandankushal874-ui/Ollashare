"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type RoomInviteManagerProps = {
	roomCode: string;
};

type SafeInviteMetadata = {
	id: Id<"screenshareGuestInvites">;
	label?: string;
	requireApproval: boolean;
	passwordProtected: boolean;
	expiresAt: number;
	maxUses: number;
	uses: number;
	revokedAt?: number;
};

type PendingAdmissionMetadata = {
	id: Id<"screenshareGuestAdmissionRequests">;
	displayName: string;
	createdAt: number;
};

const EXPIRY_PRESETS = [
	{ label: "15 minutes", value: 15 * 60_000 },
	{ label: "1 hour", value: 60 * 60_000 },
	{ label: "24 hours", value: 24 * 60 * 60_000 },
	{ label: "7 days", value: 7 * 24 * 60 * 60_000 },
] as const;

const createGuestInviteSecureRef = makeFunctionReference<"action">(
	"screenshare:createGuestInviteSecure",
);

export function RoomInviteManager({ roomCode }: RoomInviteManagerProps) {
	const invites = useQuery(api.screenshare.listGuestInvites, {
		code: roomCode,
	});
	const pending = useQuery(api.screenshare.listGuestAdmissionRequests, {
		code: roomCode,
	});
	const createInvite = useAction(createGuestInviteSecureRef);
	const revokeInvite = useMutation(api.screenshare.revokeGuestInvite);
	const revokeAll = useMutation(api.screenshare.revokeGuestInvites);
	const decide = useMutation(api.screenshare.decideGuestAdmission);
	const [label, setLabel] = useState("");
	const [password, setPassword] = useState("");
	const [expiresInMs, setExpiresInMs] = useState(
		EXPIRY_PRESETS[1].value as number,
	);
	const [customHours, setCustomHours] = useState("");
	const [maxUses, setMaxUses] = useState(8);
	const [oneTime, setOneTime] = useState(false);
	const [requireApproval, setRequireApproval] = useState(false);
	const [busy, setBusy] = useState(false);
	const [approvalStatus, setApprovalStatus] = useState("");

	const effectiveExpiry = useMemo(() => {
		if (!customHours) return expiresInMs;
		return Math.round(Number(customHours) * 60 * 60_000);
	}, [customHours, expiresInMs]);

	const handleCreate = async (event: React.FormEvent) => {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		try {
			const result = await createInvite({
				code: roomCode,
				expiresInMs: effectiveExpiry,
				maxUses,
				oneTime,
				label: label || undefined,
				requireApproval,
				password: password || undefined,
			});
			const url = new URL("/screenshare", window.location.origin);
			url.searchParams.set("room", roomCode);
			url.hash = `guestInvite=${result.token}`;
			await navigator.clipboard.writeText(url.toString());
			setPassword("");
			toast.success("Guest invitation created and copied.");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not create invitation.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			className="space-y-4 rounded-xl border border-slate-200 bg-white p-4"
			aria-labelledby="room-invitations-title"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h2
						id="room-invitations-title"
						className="text-sm font-semibold text-slate-950"
					>
						Guest invitations
					</h2>
					<p className="text-xs text-slate-500">
						Links contain a bearer secret in the URL fragment. Share them only
						with intended guests.
					</p>
				</div>
				<button
					type="button"
					onClick={() =>
						void revokeAll({ code: roomCode }).then(() =>
							toast.success("All guest links revoked."),
						)
					}
					className="min-h-11 rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
				>
					Revoke all
				</button>
			</div>

			<form onSubmit={handleCreate} className="grid gap-3 sm:grid-cols-2">
				<label className="text-xs font-medium text-slate-700">
					Label
					<input
						value={label}
						maxLength={80}
						onChange={(event) => setLabel(event.target.value)}
						className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
						placeholder="Design review"
					/>
				</label>
				<label className="text-xs font-medium text-slate-700">
					Expiry preset
					<select
						value={expiresInMs}
						onChange={(event) => {
							setExpiresInMs(Number(event.target.value));
							setCustomHours("");
						}}
						className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
					>
						{EXPIRY_PRESETS.map((preset) => (
							<option key={preset.value} value={preset.value}>
								{preset.label}
							</option>
						))}
					</select>
				</label>
				<label className="text-xs font-medium text-slate-700">
					Custom hours (max 168)
					<input
						type="number"
						min="0.0834"
						max="168"
						step="0.25"
						value={customHours}
						onChange={(event) => setCustomHours(event.target.value)}
						className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
					/>
				</label>
				<label className="text-xs font-medium text-slate-700">
					Maximum uses
					<input
						type="number"
						min="1"
						max="100"
						value={oneTime ? 1 : maxUses}
						disabled={oneTime}
						onChange={(event) => setMaxUses(Number(event.target.value))}
						className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 disabled:bg-slate-100"
					/>
				</label>
				<label className="text-xs font-medium text-slate-700 sm:col-span-2">
					Optional password
					<input
						type="password"
						autoComplete="new-password"
						maxLength={256}
						value={password}
						onChange={(event) => setPassword(event.target.value)}
						className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2"
					/>
				</label>
				<label className="flex items-center gap-2 text-xs text-slate-700">
					<input
						type="checkbox"
						checked={oneTime}
						onChange={(event) => setOneTime(event.target.checked)}
					/>{" "}
					One-time link
				</label>
				<label className="flex items-center gap-2 text-xs text-slate-700">
					<input
						type="checkbox"
						checked={requireApproval}
						onChange={(event) => setRequireApproval(event.target.checked)}
					/>{" "}
					Require host approval
				</label>
				<button
					type="submit"
					disabled={busy}
					className="min-h-11 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60 sm:col-span-2"
				>
					{busy ? "Creating…" : "Create and copy invitation"}
				</button>
			</form>

			<div className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
					Active and recent links
				</h3>
				{invites?.length ? (
					invites.map((invite: SafeInviteMetadata) => (
						<article
							key={invite.id}
							className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 p-3 text-xs"
						>
							<div>
								<p className="font-semibold text-slate-900">
									{invite.label || "Guest link"}
								</p>
								<p className="text-slate-500">
									{invite.uses}/{invite.maxUses} uses · expires{" "}
									{new Date(invite.expiresAt).toLocaleString()} ·{" "}
									{invite.passwordProtected ? "password" : "no password"} ·{" "}
									{invite.requireApproval ? "approval" : "automatic"}
								</p>
							</div>
							<button
								type="button"
								disabled={invite.revokedAt !== undefined}
								onClick={() =>
									void revokeInvite({
										code: roomCode,
										inviteId: invite.id,
									}).then(() => toast.success("Invitation revoked."))
								}
								className="min-h-11 rounded border border-red-200 px-3 py-2 font-semibold text-red-700 disabled:opacity-40"
							>
								{invite.revokedAt ? "Revoked" : "Revoke"}
							</button>
						</article>
					))
				) : (
					<p className="text-xs text-slate-500">No invitation links yet.</p>
				)}
			</div>

			<div className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
					Pending approval
				</h3>
				<p
					className="sr-only"
					role="status"
					aria-live="polite"
					aria-atomic="true"
				>
					{approvalStatus}
				</p>
				{pending?.length ? (
					pending.map((request: PendingAdmissionMetadata) => (
						<article
							key={request.id}
							className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3"
						>
							<div>
								<p className="text-sm font-semibold text-slate-900">
									{request.displayName}
								</p>
								<p className="text-xs text-slate-500">
									Requested {new Date(request.createdAt).toLocaleTimeString()}
								</p>
							</div>
							<div className="flex gap-2">
								<DecisionButton
									label="Deny"
									onStatus={(status) =>
										setApprovalStatus(`${request.displayName}: ${status}`)
									}
									onClick={() =>
										decide({
											code: roomCode,
											requestId:
												request.id as Id<"screenshareGuestAdmissionRequests">,
											approved: false,
										})
									}
								/>
								<DecisionButton
									label="Approve"
									primary
									onStatus={(status) =>
										setApprovalStatus(`${request.displayName}: ${status}`)
									}
									onClick={() =>
										decide({
											code: roomCode,
											requestId:
												request.id as Id<"screenshareGuestAdmissionRequests">,
											approved: true,
										})
									}
								/>
							</div>
						</article>
					))
				) : (
					<p className="text-xs text-slate-500">No pending guest requests.</p>
				)}
			</div>
		</section>
	);
}

function DecisionButton({
	label,
	primary,
	onClick,
	onStatus,
}: {
	label: string;
	primary?: boolean;
	onClick: () => Promise<unknown>;
	onStatus: (status: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<button
			type="button"
			disabled={busy}
			onClick={() => {
				setBusy(true);
				onStatus(`${label.toLowerCase()} in progress`);
				void onClick()
					.then(() => onStatus(`${label.toLowerCase()} complete`))
					.catch(() => {
						onStatus(`${label.toLowerCase()} failed`);
						toast.error("Could not update request.");
					})
					.finally(() => setBusy(false));
			}}
			className={
				primary
					? "min-h-11 rounded bg-emerald-600 px-3 py-2 text-xs font-semibold text-white"
					: "min-h-11 rounded border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
			}
		>
			{busy ? "…" : label}
		</button>
	);
}
