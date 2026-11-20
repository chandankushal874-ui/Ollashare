import { cronJobs, makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval(
	"screenshare retention cleanup",
	{ minutes: 5 },
	internal.screenshare.retention.cleanupScreenshareData,
	{},
);
crons.interval(
	"screenshare zombie rooms watchdog",
	{ minutes: 1 },
	internal.screenshare.rooms.autoEndStaleRooms,
	{},
);
crons.interval(
	"screenshare LiveKit teardown outbox",
	{ minutes: 1 },
	internal.screenshareLiveKitTeardown.dispatchDueLiveKitTeardowns,
	{},
);
crons.interval(
	"screenshare LiveKit participant outbox",
	{ minutes: 1 },
	internal.screenshareLiveKitParticipant
		.dispatchDueLiveKitParticipantOperations,
	{},
);
crons.interval(
	"screenshare local recording lease cleanup",
	{ minutes: 1 },
	internal.screenshare.cleanupLocalRecordings,
	{},
);
crons.interval(
	"screenshare annotation retention",
	{ minutes: 1 },
	internal.screenshare.cleanupAnnotationEvents,
	{},
);
crons.interval(
	"screenshare guest invitation retention",
	{ minutes: 5 },
	internal.screenshare.cleanupGuestInvitationData,
	{},
);
crons.daily(
	"workspace screenshare analytics retention",
	{ hourUTC: 3, minuteUTC: 15 },
	internal.analytics.cleanupAnalytics,
	{},
);
crons.daily(
	"workspace screenshare analytics duration backfill",
	{ hourUTC: 3, minuteUTC: 30 },
	internal.analytics.backfillEndedRoomDurations,
	{},
);
crons.interval(
	"validated upload retention",
	{ minutes: 5 },
	makeFunctionReference<"mutation">("uploads:cleanup"),
	{},
);
crons.interval(
	"shared browser security retention",
	{ minutes: 5 },
	internal.sharedBrowser.cleanupSharedBrowserData,
	{},
);
crons.interval(
	"shared browser revocation delivery",
	{ seconds: 5 },
	internal.sharedBrowserRevocations.deliverSharedBrowserRevocations,
	{},
);
crons.interval(
	"anonymous identity retention",
	{ hours: 1 },
	internal.security.cleanupAnonymousIdentities,
	{},
);
crons.interval(
	"account deletion continuation",
	{ minutes: 1 },
	internal.users.continueAccountDeletions,
	{},
);
export default crons;
