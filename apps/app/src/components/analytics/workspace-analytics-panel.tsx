"use client";

import { api } from "@v1/backend/convex/_generated/api";
import type { Id } from "@v1/backend/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import {
	AlertTriangle,
	Clock3,
	DoorOpen,
	MonitorUp,
	ShieldAlert,
	UserRoundCheck,
	Users,
} from "lucide-react";
import { useState } from "react";

export type AnalyticsRange = 7 | 30 | 90;

export interface AnalyticsDay {
	dayStart: number;
	rooms: number;
	roomDurationMs: number;
	participantJoins: number;
	guestAdmissions: number;
	screenShareStarts: number;
	activeUsers: number;
	invitationFailures: number;
	roomFailures: number;
	clientFailures: number;
	securityEvents: number;
}

export interface AnalyticsResponse {
	days: number;
	start: number;
	end: number;
	collectionStartedAt: number | null;
	totals: {
		rooms: number;
		roomDurationMs: number;
		averageRoomDurationMs: number;
		participantJoins: number;
		activeUsers: number;
		failures: number;
		securityEvents: number;
	};
	daily: AnalyticsDay[];
}

export interface SecurityEventItem {
	id: string;
	event: string;
	reason: string;
	outcome: string;
	actorKind: string;
	at: number;
}

export function formatDuration(durationMs: number): string {
	const totalMinutes = Math.max(0, Math.round(durationMs / 60_000));
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function securityLabel(value: string): string {
	return value
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function TrendChart({ daily }: { daily: AnalyticsDay[] }) {
	const width = 720;
	const height = 180;
	const padding = 18;
	const maximum = Math.max(1, ...daily.map((day) => day.rooms));
	const points = daily
		.map((day, index) => {
			const x =
				padding +
				(index / Math.max(1, daily.length - 1)) * (width - padding * 2);
			const y =
				height - padding - (day.rooms / maximum) * (height - padding * 2);
			return `${x},${y}`;
		})
		.join(" ");

	return (
		<div className="overflow-x-auto" aria-label="Daily room trend">
			<svg
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				aria-labelledby="analytics-trend-title analytics-trend-description"
				className="h-48 min-w-[38rem] w-full"
			>
				<title id="analytics-trend-title">Daily rooms trend</title>
				<desc id="analytics-trend-description">
					Rooms created per UTC day in the selected range.
				</desc>
				<line
					x1={padding}
					y1={height - padding}
					x2={width - padding}
					y2={height - padding}
					stroke="#334155"
				/>
				<polyline
					points={points}
					fill="none"
					stroke="#38bdf8"
					strokeWidth="3"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
				{daily.map((day, index) => {
					const x =
						padding +
						(index / Math.max(1, daily.length - 1)) * (width - padding * 2);
					const y =
						height - padding - (day.rooms / maximum) * (height - padding * 2);
					return (
						<circle key={day.dayStart} cx={x} cy={y} r="3" fill="#7dd3fc">
							<title>{`${new Date(day.dayStart).toLocaleDateString()}: ${day.rooms} rooms`}</title>
						</circle>
					);
				})}
			</svg>
		</div>
	);
}

export function WorkspaceAnalyticsView({
	range,
	onRangeChange,
	analytics,
	securityEvents,
}: {
	range: AnalyticsRange;
	onRangeChange: (range: AnalyticsRange) => void;
	analytics: AnalyticsResponse | undefined;
	securityEvents: SecurityEventItem[] | undefined;
}) {
	if (!analytics) {
		return (
			<div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-12 text-center text-sm text-slate-400">
				Loading workspace analytics…
			</div>
		);
	}

	const hasData =
		analytics.totals.rooms > 0 ||
		analytics.totals.participantJoins > 0 ||
		analytics.totals.securityEvents > 0;
	const cards = [
		{
			label: "Rooms",
			value: analytics.totals.rooms.toLocaleString(),
			icon: DoorOpen,
		},
		{
			label: "Total time",
			value: formatDuration(analytics.totals.roomDurationMs),
			icon: Clock3,
		},
		{
			label: "Average duration",
			value: formatDuration(analytics.totals.averageRoomDurationMs),
			icon: MonitorUp,
		},
		{
			label: "Participant joins",
			value: analytics.totals.participantJoins.toLocaleString(),
			icon: Users,
		},
		{
			label: "Unique active users",
			value: analytics.totals.activeUsers.toLocaleString(),
			icon: UserRoundCheck,
		},
		{
			label: "Failures",
			value: analytics.totals.failures.toLocaleString(),
			icon: AlertTriangle,
		},
		{
			label: "Security events",
			value: analytics.totals.securityEvents.toLocaleString(),
			icon: ShieldAlert,
		},
	];

	return (
		<section
			className="space-y-6"
			aria-labelledby="workspace-analytics-heading"
		>
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h2
						id="workspace-analytics-heading"
						className="text-base font-semibold text-white"
					>
						Workspace screenshare analytics
					</h2>
					<p className="mt-1 text-xs text-slate-400">
						UTC daily aggregates. Unique users are daily pseudonymous counts and
						are not distinct across days.
					</p>
				</div>
				<div
					className="inline-flex self-start rounded-xl border border-slate-800 bg-slate-950 p-1"
					aria-label="Analytics date range"
				>
					{([7, 30, 90] as const).map((days) => (
						<button
							key={days}
							type="button"
							aria-pressed={range === days}
							onClick={() => onRangeChange(days)}
							className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${range === days ? "bg-sky-500 text-white" : "text-slate-400 hover:text-white"}`}
						>
							{days} days
						</button>
					))}
				</div>
			</div>

			<div
				className="grid grid-cols-2 gap-3 lg:grid-cols-4 2xl:grid-cols-7"
				data-testid="analytics-summary-grid"
			>
				{cards.map(({ label, value, icon: Icon }) => (
					<article
						key={label}
						className="min-w-0 rounded-xl border border-slate-800 bg-slate-900/70 p-4"
					>
						<Icon className="h-4 w-4 text-sky-400" aria-hidden="true" />
						<p className="mt-3 text-[11px] font-medium text-slate-400">
							{label}
						</p>
						<p className="mt-1 truncate text-xl font-bold text-white">
							{value}
						</p>
					</article>
				))}
			</div>

			{!hasData ? (
				<div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-10 text-center">
					<MonitorUp className="mx-auto h-8 w-8 text-slate-500" />
					<h3 className="mt-3 text-sm font-semibold text-white">
						No analytics collected in this range
					</h3>
					<p className="mx-auto mt-1 max-w-lg text-xs text-slate-400">
						{analytics.collectionStartedAt
							? `Collection began ${new Date(analytics.collectionStartedAt).toLocaleDateString()}. Earlier activity is not inferred, except bounded ended-room duration backfill.`
							: "Collection starts when this analytics model is deployed. No historical active-user data is inferred."}
					</p>
				</div>
			) : (
				<div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5">
					<div className="mb-3">
						<h3 className="text-sm font-semibold text-white">
							Daily room trend
						</h3>
						<p className="text-xs text-slate-400">
							Rooms created by day. Hover or focus chart points for values.
						</p>
					</div>
					<TrendChart daily={analytics.daily} />
				</div>
			)}

			<div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60">
				<div className="border-b border-slate-800 px-4 py-3 sm:px-5">
					<h3 className="text-sm font-semibold text-white">
						Sanitized security events
					</h3>
					<p className="mt-0.5 text-xs text-slate-400">
						Fixed labels only; no identities, network data, payloads, URLs,
						tokens, or exception text.
					</p>
				</div>
				{securityEvents === undefined ? (
					<p className="p-8 text-center text-xs text-slate-500">
						Loading security events…
					</p>
				) : securityEvents.length === 0 ? (
					<p className="p-8 text-center text-xs text-slate-500">
						No sanitized security events in the available 30-day detail window.
					</p>
				) : (
					<ul className="divide-y divide-slate-800/80">
						{securityEvents.map((event) => (
							<li
								key={event.id}
								className="grid gap-2 px-4 py-3 text-xs sm:grid-cols-[1fr_auto] sm:items-center sm:px-5"
							>
								<div className="min-w-0">
									<p className="font-semibold text-slate-200">
										{securityLabel(event.event)}
									</p>
									<p className="mt-0.5 text-slate-400">
										{securityLabel(event.reason)} ·{" "}
										{securityLabel(event.outcome)} ·{" "}
										{securityLabel(event.actorKind)}
									</p>
								</div>
								<time
									className="text-slate-500"
									dateTime={new Date(event.at).toISOString()}
								>
									{new Date(event.at).toLocaleString()}
								</time>
							</li>
						))}
					</ul>
				)}
			</div>
		</section>
	);
}

export function WorkspaceAnalyticsPanel({
	workspaceId,
}: { workspaceId: Id<"workspaces"> }) {
	const [range, setRange] = useState<AnalyticsRange>(30);
	const analytics = useQuery(api.analytics.getWorkspaceAnalytics, {
		workspaceId,
		days: range,
	});
	const securityEvents = useQuery(api.analytics.listSecurityEvents, {
		workspaceId,
		days: Math.min(range, 30),
		limit: 100,
	});

	return (
		<WorkspaceAnalyticsView
			range={range}
			onRangeChange={setRange}
			analytics={analytics as AnalyticsResponse | undefined}
			securityEvents={securityEvents as SecurityEventItem[] | undefined}
		/>
	);
}
