"use client";

import type { MobileRoomOrientation } from "@/lib/use-mobile-room-layout";
import { X } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useId,
	useRef,
} from "react";

const FOCUSABLE_SELECTOR = [
	"button:not([disabled])",
	"[href]",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"[tabindex]:not([tabindex='-1'])",
].join(",");

type MobileRoomSheetProps = {
	id: string;
	open: boolean;
	title: string;
	orientation: MobileRoomOrientation;
	viewportHeight: number;
	viewportOffsetTop: number;
	viewportOffsetLeft: number;
	isKeyboardOpen: boolean;
	onClose: () => void;
	children?: ReactNode;
};

export function MobileRoomSheet({
	id,
	open,
	title,
	orientation,
	viewportHeight,
	viewportOffsetTop,
	viewportOffsetLeft,
	isKeyboardOpen,
	onClose,
	children,
}: MobileRoomSheetProps) {
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const returnFocusRef = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!open) return;
		returnFocusRef.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const focusFrame = requestAnimationFrame(() =>
			closeButtonRef.current?.focus(),
		);

		return () => {
			cancelAnimationFrame(focusFrame);
			document.body.style.overflow = previousOverflow;
			requestAnimationFrame(() => returnFocusRef.current?.focus());
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				onClose();
				return;
			}
			if (event.key !== "Tab") return;
			const focusable = Array.from(
				dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ??
					[],
			).filter((element) => element.getClientRects().length > 0);
			if (focusable.length === 0) {
				event.preventDefault();
				dialogRef.current?.focus();
				return;
			}
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown, true);
		return () => document.removeEventListener("keydown", handleKeyDown, true);
	}, [onClose, open]);

	if (!open) return null;

	const visualStyle = {
		top: viewportOffsetTop,
		left: viewportOffsetLeft,
		height: viewportHeight,
	} satisfies CSSProperties;
	const isPortrait = orientation === "portrait";

	return (
		<div
			className="fixed z-[90] w-[var(--mobile-room-viewport-width,100vw)]"
			style={visualStyle}
			data-mobile-room-sheet-root="true"
		>
			<button
				type="button"
				aria-label="Close room panel"
				className="absolute inset-0 h-full w-full bg-slate-950/45 backdrop-blur-[2px] motion-reduce:backdrop-blur-none"
				onClick={onClose}
			/>
			<div
				ref={dialogRef}
				id={id}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				className={`absolute flex min-h-0 flex-col overflow-hidden border-[#dedee5] bg-white text-[#08080b] shadow-2xl outline-none motion-safe:transition-transform motion-safe:duration-200 motion-reduce:transition-none ${isPortrait ? "inset-x-0 bottom-0 max-h-[min(78dvh,calc(var(--mobile-room-viewport-height)-4rem))] rounded-t-2xl border-x border-t pb-[env(safe-area-inset-bottom)]" : "bottom-0 right-0 top-0 w-[min(380px,88vw)] rounded-l-2xl border-y border-l pb-[env(safe-area-inset-bottom)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]"}`}
				data-orientation={orientation}
				data-keyboard-open={isKeyboardOpen ? "true" : "false"}
			>
				<header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[#dedee5] bg-[#fbfbfd] px-[max(1rem,env(safe-area-inset-left))] py-2">
					<div className="min-w-0">
						{isPortrait && (
							<div className="mx-auto mb-1 h-1 w-10 rounded-full bg-slate-300" />
						)}
						<h2 id={titleId} className="truncate text-sm font-semibold">
							{title}
						</h2>
					</div>
					<button
						ref={closeButtonRef}
						type="button"
						onClick={onClose}
						aria-label={`Close ${title}`}
						className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-xl bg-[#f0f1f5] text-[#4e535f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7659ef]"
					>
						<X className="h-5 w-5" aria-hidden="true" />
					</button>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[max(0.75rem,env(safe-area-inset-left))] py-3 [overflow-wrap:anywhere]">
					{children}
				</div>
			</div>
		</div>
	);
}
