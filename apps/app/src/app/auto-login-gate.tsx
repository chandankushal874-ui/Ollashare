"use client";

import { GuestAdmissionGate } from "@/components/screenshare/guest-admission-gate";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@v1/backend/convex/_generated/api";
import { useConvexAuth, useQuery } from "convex/react";
import { usePathname, useSearchParams } from "next/navigation";
import {
	type ReactNode,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

export function AutoLoginGate({ children }: { children: ReactNode }) {
	return (
		<Suspense fallback={<p role="status">Connecting securely...</p>}>
			<SessionGate>{children}</SessionGate>
		</Suspense>
	);
}

function SessionGate({ children }: { children: ReactNode }) {
	const { isLoading, isAuthenticated } = useConvexAuth();
	const { signIn } = useAuthActions();
	const pathname =
		(usePathname() ?? "/").replace(/^\/(en|fr|es)(?=\/|$)/, "") || "/";
	const search = useSearchParams();
	const publicPage = /^\/(login|signup|landing)(\/|$)/.test(pathname);
	const roomCode =
		(search.get("room") ?? search.get("code"))?.trim().toUpperCase() ?? "";
	const [guestInvite, setGuestInvite] = useState<{
		resolved: boolean;
		token: string;
	}>({
		resolved: false,
		token: "",
	});
	useEffect(() => {
		const value =
			new URLSearchParams(window.location.hash.slice(1)).get("guestInvite") ??
			"";
		setGuestInvite({ resolved: true, token: value });
	}, []);
	const invitation =
		pathname === "/screenshare" && Boolean(roomCode && guestInvite.token);
	const user = useQuery(
		api.users.getUser,
		!publicPage && isAuthenticated ? {} : "skip",
	);
	const hadSession = useRef(false);
	const signingIn = useRef(false);
	const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [failed, setFailed] = useState(false);

	const signInApprovedGuest = useCallback(
		async (requestSecret: string) => {
			if (signingIn.current) return;
			signingIn.current = true;
			setFailed(false);
			try {
				const result = await signIn("anonymous", { roomCode, requestSecret });
				if (!result.signingIn)
					throw new Error("Unable to create guest session");
				retry.current = setTimeout(() => {
					signingIn.current = false;
					setFailed(true);
				}, 12_000);
			} catch (error) {
				signingIn.current = false;
				setFailed(true);
				throw error;
			}
		},
		[roomCode, signIn],
	);

	useEffect(() => {
		if (isAuthenticated) hadSession.current = true;
		if (isLoading || publicPage || !guestInvite.resolved) return;
		if (!isAuthenticated) {
			if (!invitation || hadSession.current) window.location.replace("/login");
		} else if (
			user !== undefined &&
			(!user || (user.isAnonymous && !invitation))
		) {
			window.location.replace("/login");
		}
	}, [
		isLoading,
		isAuthenticated,
		publicPage,
		invitation,
		guestInvite.resolved,
		user,
	]);

	useEffect(
		() => () => {
			if (retry.current) clearTimeout(retry.current);
		},
		[],
	);

	if (publicPage) return <>{children}</>;
	if (!guestInvite.resolved || isLoading) {
		return <GateStatus failed={false} />;
	}
	if (!isAuthenticated && invitation && !hadSession.current) {
		return (
			<GuestAdmissionGate
				roomCode={roomCode}
				guestInviteToken={guestInvite.token}
				onApproved={signInApprovedGuest}
			/>
		);
	}
	if (isAuthenticated && user && (invitation || !user.isAnonymous))
		return <>{children}</>;
	return <GateStatus failed={failed} />;
}

function GateStatus({ failed }: { failed: boolean }) {
	return (
		<section
			role="status"
			className="flex min-h-screen flex-col items-center justify-center gap-4"
		>
			<p>
				{failed
					? "Unable to authenticate this guest session."
					: "Connecting securely..."}
			</p>
			<a href="/login">Sign in again</a>
		</section>
	);
}
