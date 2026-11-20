"use client";

import {
	initialGuestAdmissionState,
	isTerminalGuestAdmissionStatus,
	reduceGuestAdmission,
} from "@/lib/guest-admission-state";
import { api } from "@v1/backend/convex/_generated/api";
import { useAction, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEffect, useReducer, useRef } from "react";

type GuestAdmissionGateProps = {
	roomCode: string;
	guestInviteToken: string;
	onApproved: (requestSecret: string) => Promise<void> | void;
};

const createGuestAdmissionRequestSecureRef = makeFunctionReference<"action">(
	"screenshare:createGuestAdmissionRequestSecure",
);

export function GuestAdmissionGate({
	roomCode,
	guestInviteToken,
	onApproved,
}: GuestAdmissionGateProps) {
	const [state, dispatch] = useReducer(
		reduceGuestAdmission,
		initialGuestAdmissionState,
	);
	const createRequest = useAction(createGuestAdmissionRequestSecureRef);
	const pollRequest = useMutation(api.screenshare.pollGuestAdmission);
	const signingIn = useRef(false);

	useEffect(() => {
		if (state.status !== "pending" || !state.requestSecret) return;
		const requestSecret = state.requestSecret;
		let cancelled = false;
		const poll = async () => {
			try {
				const result = await pollRequest({ roomCode, requestSecret });
				if (cancelled) return;
				const status = result.status as
					| "pending"
					| "approved"
					| "denied"
					| "consumed"
					| "expired";
				dispatch({ type: "polled", status, expiresAt: result.expiresAt });
			} catch {
				if (!cancelled) dispatch({ type: "failure" });
			}
		};
		const timer = window.setInterval(() => void poll(), 2500);
		void poll();
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [pollRequest, roomCode, state.requestSecret, state.status]);

	useEffect(() => {
		if (
			state.status !== "approved" ||
			!state.requestSecret ||
			signingIn.current
		)
			return;
		signingIn.current = true;
		void Promise.resolve(onApproved(state.requestSecret)).catch(() => {
			signingIn.current = false;
			dispatch({
				type: "failure",
				message: "Unable to create the guest session.",
			});
		});
	}, [onApproved, state.requestSecret, state.status]);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		dispatch({ type: "submit" });
		if (!state.displayName.trim()) return;
		try {
			const result = await createRequest({
				roomCode,
				guestInviteToken,
				displayName: state.displayName,
				password: state.password || undefined,
			});
			dispatch({
				type: "created",
				status: result.status,
				requestSecret: result.requestSecret,
				expiresAt: result.expiresAt,
			});
		} catch {
			dispatch({ type: "failure" });
		}
	};

	if (state.status === "pending") {
		return (
			<GateShell title="Waiting for host approval">
				<p className="text-sm text-slate-600" role="status">
					Your request was sent. Keep this page open while the host reviews it.
				</p>
			</GateShell>
		);
	}

	if (state.status === "approved") {
		return (
			<GateShell title="Approved">
				<p className="text-sm text-slate-600" role="status">
					Creating your secure guest session…
				</p>
			</GateShell>
		);
	}

	if (isTerminalGuestAdmissionStatus(state.status)) {
		return (
			<GateShell
				title={
					state.status === "denied" ? "Request denied" : "Invitation expired"
				}
			>
				<p className="text-sm text-slate-600">
					{state.status === "denied"
						? "The host did not approve this admission request."
						: "This invitation or admission request is no longer valid."}
				</p>
			</GateShell>
		);
	}

	return (
		<GateShell title="Join screenshare">
			<form className="space-y-4" onSubmit={submit}>
				<div>
					<label
						htmlFor="guest-display-name"
						className="mb-1 block text-sm font-medium text-slate-800"
					>
						Display name
					</label>
					<input
						id="guest-display-name"
						autoComplete="name"
						maxLength={50}
						value={state.displayName}
						onChange={(event) =>
							dispatch({ type: "edit", displayName: event.target.value })
						}
						className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-200"
						required
					/>
				</div>
				<div>
					<label
						htmlFor="guest-invite-password"
						className="mb-1 block text-sm font-medium text-slate-800"
					>
						Invitation password{" "}
						<span className="font-normal text-slate-500">(if required)</span>
					</label>
					<input
						id="guest-invite-password"
						type="password"
						autoComplete="current-password"
						maxLength={256}
						value={state.password}
						onChange={(event) =>
							dispatch({ type: "edit", password: event.target.value })
						}
						className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-200"
					/>
				</div>
				{state.message && (
					<p role="alert" className="text-sm text-red-600">
						{state.message}
					</p>
				)}
				<button
					type="submit"
					disabled={state.status === "submitting"}
					className="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:cursor-wait disabled:opacity-60"
				>
					{state.status === "submitting" ? "Verifying…" : "Request access"}
				</button>
			</form>
		</GateShell>
	);
}

function GateShell({
	title,
	children,
}: { title: string; children: React.ReactNode }) {
	return (
		<main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
			<section
				className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
				aria-labelledby="guest-admission-title"
			>
				<h1
					id="guest-admission-title"
					className="mb-2 text-xl font-semibold text-slate-950"
				>
					{title}
				</h1>
				<p className="mb-5 text-sm text-slate-500">
					Guest access is limited to this room and invitation.
				</p>
				{children}
			</section>
		</main>
	);
}
