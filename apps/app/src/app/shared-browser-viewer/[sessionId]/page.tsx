"use client";

import { use, useEffect, useRef, useState } from "react";
import { consumeViewerFragment } from "../viewer-fragment";

type ViewerState = "connecting" | "connected" | "disconnected" | "failed";
type RfbClient = { disconnect: () => void; scaleViewport: boolean; resizeSession: boolean; viewOnly: boolean; addEventListener: (name: string, listener: () => void) => void };
type RfbConstructor = new (target: HTMLElement, url: string, options?: { shared?: boolean; wsProtocols?: string[] }) => RfbClient;

export default function SharedBrowserViewer({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = use(params);
  const targetRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbClient | null>(null);
  const tokenRef = useRef<string | null>(null);
  const [state, setState] = useState<ViewerState>("connecting");
  const [message, setMessage] = useState("Connecting to the shared browser…");

  useEffect(() => {
    let disposed = false;
    let rfb: RfbClient | undefined;
    void (async () => {
      if (!/^[A-Za-z0-9_;-]{1,160}$/.test(sessionId)) throw new Error("Invalid Shared Browser session");
      const fragmentToken = consumeViewerFragment(window.location, window.history);
      if (fragmentToken) tokenRef.current = fragmentToken;
      const token = tokenRef.current ?? "";
      if (!token || token.length > 4096 || !targetRef.current) throw new Error("The Shared Browser grant is missing or invalid");
      const payload = token.split(".")[1] ?? "";
      const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number; mode?: string; session?: string };
      if (!claims.exp || claims.exp * 1000 <= Date.now() || claims.exp * 1000 - Date.now() > 5 * 60_000 || claims.session !== sessionId) throw new Error("The Shared Browser grant has expired");
      const moduleUrl = "/shared-browser-assets/core/rfb.js";
      const { default: RFB } = await import(/* webpackIgnore: true */ moduleUrl) as { default: RfbConstructor };
      const scheme = location.protocol === "https:" ? "wss:" : "ws:";
      const socketUrl = `${scheme}//${location.host}/shared-browser-ws/v1/viewer/${encodeURIComponent(sessionId)}`;
      if (disposed || !targetRef.current) return;
      rfb = new RFB(targetRef.current, socketUrl, { shared: true, wsProtocols: ["binary", `mira-bearer.${token}`] });
      if (!rfb) throw new Error("Unable to initialize Shared Browser viewer");
      rfbRef.current = rfb;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.viewOnly = claims.mode !== "control";
      rfb.addEventListener("connect", () => { setState("connected"); setMessage(claims.mode === "control" ? "Control active" : "View only"); window.parent.postMessage({ type: "MIRA_SHARED_BROWSER_STATE", state: "connected" }, window.location.origin); });
      rfb.addEventListener("disconnect", () => { setState("disconnected"); setMessage("Connection closed. Return to Ollashare and reconnect."); window.parent.postMessage({ type: "MIRA_SHARED_BROWSER_STATE", state: "disconnected" }, window.location.origin); });
      rfb.addEventListener("securityfailure", () => { setState("failed"); setMessage("Viewer authorization failed."); window.parent.postMessage({ type: "MIRA_SHARED_BROWSER_STATE", state: "failed" }, window.location.origin); });
      window.setTimeout(() => {
        if (disposed) return;
        setState((current) => {
          if (current !== "connecting") return current;
          setMessage("The VM browser did not complete the RFB handshake. Return to Ollashare and retry.");
          window.parent.postMessage({ type: "MIRA_SHARED_BROWSER_STATE", state: "failed" }, window.location.origin);
          rfb?.disconnect();
          return "failed";
        });
      }, 15_000);
    })().catch((error) => { setState("failed"); setMessage(error instanceof Error ? error.message : "Shared Browser connection failed"); window.parent.postMessage({ type: "MIRA_SHARED_BROWSER_STATE", state: "failed" }, window.location.origin); });
    return () => { disposed = true; if (rfbRef.current === rfb) rfbRef.current = null; rfb?.disconnect(); };
  }, [sessionId]);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const refresh = () => {
      const rfb = rfbRef.current;
      if (!rfb) return;
      rfb.scaleViewport = false;
      requestAnimationFrame(() => { if (rfbRef.current === rfb) rfb.scaleViewport = true; });
    };
    const observer = new ResizeObserver(refresh);
    observer.observe(target);
    document.addEventListener("fullscreenchange", refresh);
    window.addEventListener("resize", refresh);
    return () => {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", refresh);
      window.removeEventListener("resize", refresh);
    };
  }, []);

  return (
    <main
      data-mira-shared-browser-root="viewer"
      data-session-id={sessionId}
      data-connection-state={state}
      className="relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-black text-white"
    >
      <div
        ref={targetRef}
        data-mira-novnc-target="display"
        className="h-full w-full [&_canvas]:h-full [&_canvas]:w-full"
      />
      {state !== "connected" && <div className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-950/90"><div className="rounded-xl border border-white/10 bg-slate-900 px-5 py-3 text-sm text-slate-200">{message}</div></div>}
      <div className="pointer-events-none absolute bottom-3 right-3 flex flex-col items-end gap-1">
        <div className="rounded-full border border-white/10 bg-slate-950/80 px-3 py-1 text-[11px] font-semibold text-slate-200">{state}</div>
        {state === "connected" && <div className="rounded-full border border-white/10 bg-slate-950/80 px-3 py-1 text-[11px] font-semibold text-slate-200">{message}</div>}
      </div>
    </main>
  );
}
