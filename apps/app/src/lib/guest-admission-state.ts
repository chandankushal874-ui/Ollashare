export type GuestAdmissionStatus =
	| "collecting"
	| "submitting"
	| "pending"
	| "approved"
	| "denied"
	| "expired"
	| "failed";

export type GuestAdmissionState = {
	status: GuestAdmissionStatus;
	displayName: string;
	password: string;
	requestSecret?: string;
	expiresAt?: number;
	message?: string;
};

export type GuestAdmissionEvent =
	| { type: "edit"; displayName?: string; password?: string }
	| { type: "submit" }
	| {
			type: "created";
			status: "pending" | "approved";
			requestSecret: string;
			expiresAt: number;
	  }
	| {
			type: "polled";
			status: "pending" | "approved" | "denied" | "consumed" | "expired";
			expiresAt?: number;
	  }
	| { type: "failure"; message?: string }
	| { type: "retry" };

export const initialGuestAdmissionState: GuestAdmissionState = {
	status: "collecting",
	displayName: "",
	password: "",
};

export function reduceGuestAdmission(
	state: GuestAdmissionState,
	event: GuestAdmissionEvent,
): GuestAdmissionState {
	switch (event.type) {
		case "edit":
			return {
				...state,
				status: state.status === "failed" ? "collecting" : state.status,
				displayName: event.displayName ?? state.displayName,
				password: event.password ?? state.password,
				message: undefined,
			};
		case "submit":
			if (!state.displayName.trim()) {
				return { ...state, status: "failed", message: "Enter a display name." };
			}
			return { ...state, status: "submitting", message: undefined };
		case "created":
			return {
				...state,
				status: event.status,
				requestSecret: event.requestSecret,
				expiresAt: event.expiresAt,
				password: "",
				message: undefined,
			};
		case "polled":
			return {
				...state,
				status: event.status === "consumed" ? "expired" : event.status,
				expiresAt: event.expiresAt ?? state.expiresAt,
				message: undefined,
			};
		case "failure":
			return {
				...state,
				status: "failed",
				password: "",
				message: event.message ?? "Invitation could not be verified.",
			};
		case "retry":
			return {
				status: "collecting",
				displayName: state.displayName,
				password: "",
			};
	}
}

export function isTerminalGuestAdmissionStatus(
	status: GuestAdmissionStatus,
): boolean {
	return status === "denied" || status === "expired";
}
