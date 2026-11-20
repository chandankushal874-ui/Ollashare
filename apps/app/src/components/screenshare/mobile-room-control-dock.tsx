"use client";

import {
	Ellipsis,
	MessageSquare,
	MonitorPlay,
	ScreenShare,
	Square,
	Users,
} from "lucide-react";
import type { ReactNode } from "react";

export type MobileRoomSheetKind = "screens" | "participants" | "chat" | "more";

type DockButtonProps = {
	label: string;
	icon: ReactNode;
	active?: boolean;
	disabled?: boolean;
	controls?: string;
	badge?: number;
	onClick: () => void;
};

function DockButton({
	label,
	icon,
	active = false,
	disabled = false,
	controls,
	badge,
	onClick,
}: DockButtonProps) {
	return (
		<button
			type="button"
			disabled={disabled}
			onClick={(event) => {
				event.currentTarget.focus();
				onClick();
			}}
			aria-label={label}
			aria-expanded={controls ? active : undefined}
			aria-controls={controls}
			className={`relative flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1.5 py-1 text-[10px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7659ef] focus-visible:ring-offset-2 focus-visible:ring-offset-white motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-45 ${active ? "bg-[#ece9ff] text-[#5d42d6]" : "text-[#4e535f] active:bg-[#f0f1f5]"}`}
		>
			<span className="relative flex h-5 w-5 items-center justify-center">
				{icon}
				{Boolean(badge) && (
					<span className="absolute -right-2 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] leading-none text-white">
						{badge && badge > 99 ? "99+" : badge}
					</span>
				)}
			</span>
			<span className="max-w-full truncate">{label}</span>
		</button>
	);
}

type MobileRoomControlDockProps = {
	isSharing: boolean;
	shareDisabled?: boolean;
	activeSheet: MobileRoomSheetKind | null;
	sheetId: string;
	participantCount: number;
	unreadCount: number;
	onToggleShare: () => void;
	onOpenSheet: (sheet: MobileRoomSheetKind) => void;
};

export function MobileRoomControlDock({
	isSharing,
	shareDisabled = false,
	activeSheet,
	sheetId,
	participantCount,
	unreadCount,
	onToggleShare,
	onOpenSheet,
}: MobileRoomControlDockProps) {
	return (
		<nav
			aria-label="Room controls"
			data-mobile-room-dock="true"
			className="fixed inset-x-0 bottom-0 z-[80] border-t border-[#dedee5] bg-white/95 px-[max(0.5rem,env(safe-area-inset-left))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-12px_32px_rgba(31,31,56,0.12)] backdrop-blur-xl motion-reduce:backdrop-blur-none"
		>
			<div className="mx-auto flex w-full max-w-xl items-stretch gap-1">
				<DockButton
					label={isSharing ? "Stop" : "Share"}
					icon={
						isSharing ? (
							<Square className="h-5 w-5 fill-current" aria-hidden="true" />
						) : (
							<ScreenShare className="h-5 w-5" aria-hidden="true" />
						)
					}
					disabled={shareDisabled}
					onClick={onToggleShare}
				/>
				<DockButton
					label="Screens"
					icon={<MonitorPlay className="h-5 w-5" aria-hidden="true" />}
					active={activeSheet === "screens"}
					controls={sheetId}
					onClick={() => onOpenSheet("screens")}
				/>
				<DockButton
					label={`People ${participantCount}`}
					icon={<Users className="h-5 w-5" aria-hidden="true" />}
					active={activeSheet === "participants"}
					controls={sheetId}
					onClick={() => onOpenSheet("participants")}
				/>
				<DockButton
					label="Chat"
					icon={<MessageSquare className="h-5 w-5" aria-hidden="true" />}
					active={activeSheet === "chat"}
					controls={sheetId}
					badge={unreadCount}
					onClick={() => onOpenSheet("chat")}
				/>
				<DockButton
					label="More"
					icon={<Ellipsis className="h-5 w-5" aria-hidden="true" />}
					active={activeSheet === "more"}
					controls={sheetId}
					onClick={() => onOpenSheet("more")}
				/>
			</div>
		</nav>
	);
}
