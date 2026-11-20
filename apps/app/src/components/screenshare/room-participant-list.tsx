"use client";

import { MousePointer2, Pencil, UserMinus, Users } from "lucide-react";

export type RoomParticipant = {
	id: string;
	name: string;
	role?: string;
	isSharing?: boolean;
	canAnnotate?: boolean;
	controlStatus?: "idle" | "requesting" | "active";
};

type RoomParticipantListProps = {
	participants: RoomParticipant[];
	currentParticipantId?: string | null;
	isHost: boolean;
	onToggleAnnotation?: (participantId: string, allowed: boolean) => void;
	onRequestControl?: (participantId: string) => void;
	onReleaseControl?: (participantId: string) => void;
	onKick?: (participantId: string, participantName: string) => void;
};

export function RoomParticipantList({
	participants,
	currentParticipantId,
	isHost,
	onToggleAnnotation,
	onRequestControl,
	onReleaseControl,
	onKick,
}: RoomParticipantListProps) {
	return (
		<section aria-labelledby="compact-participants-title" className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div>
					<h3 id="compact-participants-title" className="text-sm font-semibold">
						Participants
					</h3>
					<p className="text-xs text-[#666b77]">
						Connection and sharing status update live.
					</p>
				</div>
				<span className="rounded-full bg-[#ece9ff] px-2.5 py-1 text-xs font-semibold text-[#5d42d6]">
					{participants.length} live
				</span>
			</div>

			{participants.length === 0 ? (
				<div className="flex flex-col items-center rounded-2xl border border-dashed border-[#dedee5] bg-[#fbfbfd] p-6 text-center">
					<Users className="mb-2 h-6 w-6 text-[#878b96]" aria-hidden="true" />
					<p className="text-sm font-semibold">No participants yet</p>
					<p className="mt-1 text-xs text-[#666b77]">
						Invite people to join this room.
					</p>
				</div>
			) : (
				<ul className="space-y-2">
					{participants.map((participant) => {
						const isCurrent = participant.id === currentParticipantId;
						const isParticipantHost = participant.role === "host";
						const canModerate = isHost && !isCurrent && !isParticipantHost;
						return (
							<li
								key={participant.id}
								className="rounded-2xl border border-[#dedee5] bg-white p-3 shadow-sm"
							>
								<div className="flex min-w-0 items-start gap-3">
									<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#ece9ff] text-sm font-bold text-[#5d42d6]">
										{participant.name.charAt(0).toUpperCase() || "?"}
									</span>
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-1.5">
											<span className="max-w-full truncate text-sm font-semibold">
												{participant.name}
											</span>
											{isCurrent && (
												<span className="text-[11px] text-[#666b77]">You</span>
											)}
											{isParticipantHost && (
												<span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-700">
													Host
												</span>
											)}
										</div>
										<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
											<span
												className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${participant.isSharing ? "bg-emerald-100 text-emerald-700" : "bg-[#f0f1f5] text-[#666b77]"}`}
											>
												<span
													className={`h-1.5 w-1.5 rounded-full ${participant.isSharing ? "bg-emerald-500" : "bg-slate-400"}`}
												/>
												{participant.isSharing ? "Sharing" : "Viewing"}
											</span>
											{participant.canAnnotate && !isParticipantHost && (
												<span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800">
													Can draw
												</span>
											)}
											{participant.controlStatus &&
												participant.controlStatus !== "idle" && (
													<span className="rounded-full bg-sky-100 px-2 py-0.5 font-semibold text-sky-700">
														{participant.controlStatus === "active"
															? "Control active"
															: "Control requested"}
													</span>
												)}
										</div>
									</div>
								</div>

								{canModerate && (
									<div className="mt-3 flex flex-wrap gap-2 border-t border-[#dedee5] pt-3">
										<button
											type="button"
											aria-pressed={participant.canAnnotate}
											onClick={() =>
												onToggleAnnotation?.(
													participant.id,
													!participant.canAnnotate,
												)
											}
											className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
										>
											<Pencil className="h-4 w-4" aria-hidden="true" />
											{participant.canAnnotate
												? "Revoke drawing"
												: "Allow drawing"}
										</button>
										{participant.isSharing &&
											(participant.controlStatus === "active" ? (
												<button
													type="button"
													onClick={() => onReleaseControl?.(participant.id)}
													className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
												>
													<MousePointer2
														className="h-4 w-4"
														aria-hidden="true"
													/>
													Release control
												</button>
											) : (
												<button
													type="button"
													disabled={participant.controlStatus === "requesting"}
													onClick={() => onRequestControl?.(participant.id)}
													className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-55"
												>
													<MousePointer2
														className="h-4 w-4"
														aria-hidden="true"
													/>
													{participant.controlStatus === "requesting"
														? "Requesting…"
														: "Request control"}
												</button>
											))}
										<button
											type="button"
											onClick={() => onKick?.(participant.id, participant.name)}
											className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
										>
											<UserMinus className="h-4 w-4" aria-hidden="true" />
											Kick
										</button>
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
