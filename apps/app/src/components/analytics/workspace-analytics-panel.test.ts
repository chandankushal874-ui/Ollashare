import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
const panelSource = readFileSync(
	new URL("./workspace-analytics-panel.tsx", import.meta.url),
	"utf8",
);
const activitySource = readFileSync(
	new URL("../../app/[locale]/(dashboard)/activity/page.tsx", import.meta.url),
	"utf8",
);

describe("workspace analytics UI contract", () => {
	test("provides owner/admin-gated Activity analytics tab and 7/30/90 ranges", () => {
		expect(activitySource).toContain("{isWorkspaceAdmin && (");
		expect(activitySource).toContain('setActiveTab("analytics")');
		expect(activitySource).toContain("<WorkspaceAnalyticsPanel");
		expect(panelSource).toContain("([7, 30, 90] as const)");
		expect(panelSource).toContain("aria-pressed={range === days}");
	});

	test("renders summary cards, empty/collection state, trends and sanitized labels", () => {
		for (const label of [
			"Rooms",
			"Total time",
			"Average duration",
			"Participant joins",
			"Unique active users",
			"Failures",
			"Security events",
		]) {
			expect(panelSource).toContain(label);
		}
		expect(panelSource).toContain("No analytics collected in this range");
		expect(panelSource).toContain("No historical active-user data is inferred");
		expect(panelSource).toContain("Daily room trend");
		expect(panelSource).toContain("Sanitized security events");
		expect(panelSource).not.toContain("event.payload");
	});

	test("uses dependency-free accessible responsive SVG/CSS presentation", () => {
		expect(panelSource).toContain("<svg");
		expect(panelSource).toContain('role="img"');
		expect(panelSource).toContain("overflow-x-auto");
		expect(panelSource).toContain("grid-cols-2");
		expect(panelSource).toContain("lg:grid-cols-4");
		expect(panelSource).toContain("sm:grid-cols-[1fr_auto]");
		expect(panelSource).not.toMatch(
			/from\s+["'](?:recharts|chart\.js|visx|d3)["']/,
		);
	});

	test("includes readable duration and fixed-enum security label formatters", () => {
		expect(panelSource).toContain("Math.round(durationMs / 60_000)");
		expect(panelSource).toContain('split("_")');
		expect(panelSource).toContain("securityLabel(event.event)");
		expect(panelSource).toContain("securityLabel(event.reason)");
		expect(panelSource).toContain("securityLabel(event.outcome)");
		expect(panelSource).toContain("securityLabel(event.actorKind)");
	});
});
