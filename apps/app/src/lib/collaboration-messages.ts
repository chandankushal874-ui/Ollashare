import type { AnnotationPermissionSnapshot } from "./annotation-messages";

const presenterMessages = new Set([
	"STAGE_MODE_CHANGE",
	"PRESENTATION_SLIDE_CHANGE",
	"PRESENTATION_NOTES_SYNC",
	"PRESENTATION_FULL_SYNC",
]);
const noGuestAnnotationPermissions: AnnotationPermissionSnapshot = {
	permittedGuestIds: [],
};

export function acceptsCollaborationMessage(
	data: Record<string, unknown>,
	sender: string | undefined,
	host: string | null,
	_annotationPermissions: AnnotationPermissionSnapshot = noGuestAnnotationPermissions,
) {
	if (data.type === "CHAT_MESSAGE" || data.type === "CHAT_HISTORY_SYNC")
		return false;
	if (presenterMessages.has(String(data.type))) {
		if (!sender || sender !== host) return false;
		if (
			data.notes !== undefined &&
			(typeof data.notes !== "string" || data.notes.length > 4000)
		)
			return false;
		if (
			data.slideIndex !== undefined &&
			(typeof data.slideIndex !== "number" ||
				!Number.isInteger(data.slideIndex) ||
				data.slideIndex < 0 ||
				data.slideIndex > 1000)
		)
			return false;
		if (data.votes !== undefined) {
			if (
				!data.votes ||
				typeof data.votes !== "object" ||
				Array.isArray(data.votes)
			)
				return false;
			if (
				Object.entries(data.votes).some(
					([key, value]) =>
						!["A", "B", "C"].includes(key) ||
						typeof value !== "number" ||
						!Number.isInteger(value) ||
						value < 0 ||
						value > 1000,
				)
			)
				return false;
		}
	}
	if (String(data.type).startsWith("SCREEN_ANNOTATION_")) return false;
	if (data.type === "PRESENTATION_VOTE")
		return !!sender && ["A", "B", "C"].includes(String(data.option));
	return true;
}
