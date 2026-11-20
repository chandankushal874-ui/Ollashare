import { current, json, requireToken } from "@/lib/shared-browser-server";
export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: Request) { const roomCode = new URL(request.url).searchParams.get("roomCode"); if (!roomCode || !/^[A-Za-z0-9_-]{1,128}$/.test(roomCode)) return json({ code: "INVALID_ROOM", message: "Invalid room" }, 400); try { return json(await current(roomCode, await requireToken())); } catch { return json({ code: "UNAUTHENTICATED", message: "Unable to load Shared Browser" }, 401); } }
