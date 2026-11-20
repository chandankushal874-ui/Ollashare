import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SharedBrowserAnnotationOverlay } from "../../apps/app/src/components/shared-browser/annotation-overlay";
import { applyAnnotationEvents } from "../../apps/app/src/lib/annotation-messages";
import {
    ANNOTATION_COLORS,
    ANNOTATION_WIDTHS,
    HIGHLIGHTER_OPACITY,
    getAnnotationStrokeRenderStyle,
    type AnnotationEvent,
    type AnnotationOperation,
    type AnnotationStroke,
    type AnnotationTool,
} from "../../apps/app/src/lib/annotation-types";
import {
    FULL_VIEW_CONTROL_ROW_CLASS,
    createAnnotationStrokeId,
    findNearestErasableStroke,
    getFullViewInteractionState,
    tryReleasePointerCapture,
    trySetPointerCapture,
    type FullViewInteractionMode,
} from "../../apps/app/src/lib/screen-annotation-ui";

type Role = "host" | "guest" | "viewer";
type Layout = "regular" | "focused" | "full";
type TargetKind = "screen" | "shared-browser";

type HarnessState = {
    version: number;
    allowedGuests: string[];
    events: AnnotationEvent[];
};

const PARTICIPANTS: Record<Role, { id: string; name: string }> = {
    host: { id: "host", name: "Host" },
    guest: { id: "guest", name: "Guest" },
    viewer: { id: "viewer", name: "Viewer" },
};

const SCREENS = [
    { id: "host-screen", ownerName: "Host", label: "Host screen" },
    { id: "guest-screen", ownerName: "Guest", label: "Guest screen" },
] as const;

const styles = `
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  * { box-sizing: border-box; }
  html, body, #root { margin: 0; min-height: 100%; background: #020617; color: #e2e8f0; }
  button, select { font: inherit; }
  button { min-height: 44px; }
  .app { min-height: 100vh; padding: 12px; }
  .top { position: relative; z-index: 90; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .button { min-height: 44px; min-width: 44px; border: 1px solid #475569; border-radius: 8px; background: #1e293b; color: #e2e8f0; padding: 8px 12px; cursor: pointer; }
  .button[aria-pressed="true"], .button.active { background: #7659ef; border-color: #a78bfa; color: white; }
  .button.danger { background: #451a1a; border-color: #ef4444; }
  .button:disabled { opacity: .42; cursor: not-allowed; }
  .grant { background: #14532d; border-color: #22c55e; }
  .status { font-size: 12px; color: #94a3b8; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .grid.focused { grid-template-columns: minmax(0, 1fr); max-width: 1100px; margin: 0 auto; }
  .grid.full { position: fixed; inset: 0; z-index: 80; padding: 70px 10px 10px; background: #000; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tile { min-width: 0; overflow: hidden; border: 1px solid #334155; border-radius: 12px; background: #0f172a; box-shadow: 0 8px 30px rgba(0,0,0,.35); }
  .tile-head { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; padding: 8px; border-bottom: 1px solid #334155; }
  .tile-title { font-size: 13px; font-weight: 700; }
  .toolbar { display: flex; min-width: 0; max-width: 100%; align-items: center; gap: 4px; overflow-x: auto; overscroll-behavior-x: contain; padding: 4px; border: 1px solid #475569; border-radius: 8px; background: #111827; scrollbar-width: none; touch-action: pan-x; }
  .toolbar::-webkit-scrollbar { display: none; }
  .tool { min-width: 44px; min-height: 44px; flex: 0 0 auto; border: 0; border-radius: 6px; background: transparent; color: #cbd5e1; padding: 7px; }
  .tool[aria-pressed="true"] { background: #7659ef; color: white; }
  .swatch { width: 32px; min-width: 32px; height: 32px; border-radius: 999px; border: 3px solid transparent; }
  .swatch[aria-pressed="true"] { border-color: white; outline: 2px solid #7659ef; }
  .width { min-height: 44px; flex: 0 0 auto; border: 1px solid #475569; border-radius: 6px; background: #020617; color: #e2e8f0; padding: 0 8px; }
  .surface { position: relative; aspect-ratio: 16/9; width: 100%; overflow: hidden; background: linear-gradient(135deg, #111827, #0f172a 48%, #172554); touch-action: none; }
  .surface.enabled { cursor: crosshair; outline: 2px solid #f59e0b; outline-offset: -2px; }
  .surface.control { cursor: default; outline: 2px solid #38bdf8; outline-offset: -2px; }
  .surface svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .surface-label { position: absolute; inset: 0; display: grid; place-items: center; color: #64748b; font-size: 18px; pointer-events: none; }
  .draw-badge { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); border: 1px solid #f59e0b88; border-radius: 999px; background: #0f172add; padding: 5px 10px; color: #fde68a; font-size: 11px; pointer-events: none; }
  .full-hud { position: fixed; z-index: 100; top: max(8px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); display: flex; min-width: 0; max-width: calc(100vw - 16px); align-items: center; gap: 8px; overflow-x: auto; overscroll-behavior-x: contain; border: 1px solid #38bdf866; border-radius: 12px; background: #0f172aee; padding: 6px; touch-action: pan-x; scrollbar-width: none; }
  .full-hud > * { min-height: 44px; flex: 0 0 auto; }
  .full-hud::-webkit-scrollbar { display: none; }
  .mode-group { display: flex; flex: 0 0 auto; border: 1px solid #475569; border-radius: 8px; padding: 2px; }
  .mode-group button { min-height: 44px; min-width: 70px; border: 0; border-radius: 6px; background: transparent; color: #cbd5e1; }
  .mode-group button[aria-pressed="true"] { background: #7659ef; color: white; }
  .shared-browser { margin-top: 12px; border: 1px solid #334155; border-radius: 12px; padding: 8px; background: #0f172a; }
  .browser-stage { position: relative; height: 260px; overflow: hidden; border-radius: 8px; background: linear-gradient(145deg, #f8fafc, #cbd5e1); }
  .browser-toolbar { margin-bottom: 8px; min-height: 44px; }
  .browser-stage canvas { min-height: 100%; }
  .permission-note { min-height: 44px; display: flex; align-items: center; color: #94a3b8; font-size: 12px; }
  @media (max-width: 600px) {
    .app { padding: 8px; }
    .grid, .grid.full { grid-template-columns: minmax(0, 1fr); }
    .grid.full { overflow-y: auto; padding-top: 72px; }
    .tile-head { align-items: stretch; }
    .tile-head > .toolbar { width: 100%; }
    .surface { min-height: 190px; }
    .full-hud { justify-content: flex-start; }
    .swatch { width: 44px; min-width: 44px; height: 44px; }
  }
`;

async function getState(): Promise<HarnessState> {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`state ${response.status}`);
    return response.json();
}

async function postAction(payload: Record<string, unknown>) {
    const response = await fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(data.error ?? `action ${response.status}`));
    return data;
}

function useHarnessState() {
    const [state, setState] = useState<HarnessState>({ version: 0, allowedGuests: [], events: [] });
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        let timer: number | undefined;
        const poll = async () => {
            try {
                const next = await getState();
                if (active) {
                    setState(next);
                    setError(null);
                }
            } catch (reason) {
                if (active) setError(reason instanceof Error ? reason.message : String(reason));
            } finally {
                if (active) timer = window.setTimeout(poll, 80);
            }
        };
        void poll();
        return () => {
            active = false;
            if (timer !== undefined) window.clearTimeout(timer);
        };
    }, []);
    return { state, error };
}

function ScreenAnnotationToolbar({
    targetId,
    enabled,
    tool,
    color,
    width,
    canClear,
    isHost,
    onToggle,
    onTool,
    onColor,
    onWidth,
    onClear,
}: {
    targetId: string;
    enabled: boolean;
    tool: AnnotationTool;
    color: string;
    width: number;
    canClear: boolean;
    isHost: boolean;
    onToggle: () => void;
    onTool: (tool: AnnotationTool) => void;
    onColor: (color: string) => void;
    onWidth: (width: number) => void;
    onClear: () => void;
}) {
    return (
        <div className="toolbar" role="toolbar" aria-label={`Screen annotation tools for ${targetId}`} data-testid={`toolbar-${targetId}`}>
            <button className="tool" type="button" title={enabled ? "Stop drawing" : "Draw"} aria-label={`Draw on ${targetId}`} aria-pressed={enabled} onClick={onToggle}>Draw</button>
            <button className="tool" type="button" title="Pen" aria-label={`Pen ${targetId}`} aria-pressed={tool === "pen"} onClick={() => onTool("pen")}>Pen</button>
            <button className="tool" type="button" title="Highlighter" aria-label={`Highlighter ${targetId}`} aria-pressed={tool === "highlighter"} onClick={() => onTool("highlighter")}>Highlight</button>
            <button className="tool" type="button" title="Eraser" aria-label={`Eraser ${targetId}`} aria-pressed={tool === "eraser"} onClick={() => onTool("eraser")}>Erase</button>
            {ANNOTATION_COLORS.map((item) => (
                <button key={item} className="swatch" type="button" aria-label={`Color ${item} ${targetId}`} aria-pressed={color === item} style={{ backgroundColor: item }} onClick={() => onColor(item)} />
            ))}
            <select className="width" aria-label={`Annotation width ${targetId}`} value={width} onChange={(event) => onWidth(Number(event.target.value))}>
                {ANNOTATION_WIDTHS.map((item) => <option key={item} value={item}>{item}px</option>)}
            </select>
            <button className="tool" type="button" title={isHost ? "Clear all annotations" : "Clear my annotations"} aria-label={`${isHost ? "Clear all" : "Clear own"} ${targetId}`} disabled={!canClear} onClick={onClear}>Clear</button>
        </div>
    );
}

function ScreenSurface({
    targetId,
    label,
    participant,
    enabled,
    remoteInputEnabled,
    tool,
    color,
    width,
    strokes,
    canEraseAll,
}: {
    targetId: string;
    label: string;
    participant: { id: string; name: string };
    enabled: boolean;
    remoteInputEnabled: boolean;
    tool: AnnotationTool;
    color: string;
    width: number;
    strokes: AnnotationStroke[];
    canEraseAll: boolean;
}) {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const activePointer = useRef<number | null>(null);
    const draftRef = useRef<AnnotationStroke | null>(null);
    const [draft, setDraft] = useState<AnnotationStroke | null>(null);

    const pointFromEvent = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return {
            u: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
            v: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
        };
    }, []);

    const cancel = useCallback((element?: Element, pointerId = activePointer.current) => {
        if (element && pointerId !== null) tryReleasePointerCapture(element, pointerId);
        activePointer.current = null;
        draftRef.current = null;
        setDraft(null);
    }, []);

    useEffect(() => {
        if (!enabled || remoteInputEnabled) cancel(surfaceRef.current ?? undefined);
    }, [cancel, enabled, remoteInputEnabled]);

    useEffect(() => {
        const onBlur = () => cancel(surfaceRef.current ?? undefined);
        window.addEventListener("blur", onBlur);
        return () => window.removeEventListener("blur", onBlur);
    }, [cancel]);

    const submit = useCallback(async (operation: AnnotationOperation) => {
        await postAction({ type: "operation", participantId: participant.id, participantName: participant.name, targetKind: "screen", targetId, operation });
    }, [participant.id, participant.name, targetId]);

    return (
        <div
            ref={surfaceRef}
            className={`surface ${enabled ? "enabled" : ""} ${remoteInputEnabled ? "control" : ""}`}
            data-testid={`surface-${targetId}`}
            data-annotation-enabled={String(enabled)}
            data-remote-input-enabled={String(remoteInputEnabled)}
            onPointerDown={(event) => {
                if (!enabled || remoteInputEnabled || activePointer.current !== null) return;
                const point = pointFromEvent(event);
                if (tool === "eraser") {
                    const hit = findNearestErasableStroke(strokes, point, participant.id, canEraseAll);
                    if (hit) void submit({ kind: "erase", strokeId: hit.id });
                    return;
                }
                trySetPointerCapture(event.currentTarget, event.pointerId);
                activePointer.current = event.pointerId;
                const next: AnnotationStroke = {
                    id: createAnnotationStrokeId(),
                    authorId: participant.id,
                    authorName: participant.name,
                    targetType: "screen",
                    targetId,
                    color,
                    width,
                    tool: tool === "highlighter" ? "highlighter" : "pen",
                    opacity: tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1,
                    points: [point],
                    createdAt: Date.now(),
                };
                draftRef.current = next;
                setDraft(next);
            }}
            onPointerMove={(event) => {
                if (activePointer.current !== event.pointerId || !draftRef.current) return;
                const point = pointFromEvent(event);
                const next = { ...draftRef.current, points: [...draftRef.current.points, point] };
                draftRef.current = next;
                setDraft(next);
            }}
            onPointerUp={(event) => {
                if (activePointer.current !== event.pointerId) return;
                const completed = draftRef.current;
                cancel(event.currentTarget, event.pointerId);
                if (completed && completed.points.length > 1) {
                    void submit({
                        kind: "stroke",
                        strokeId: completed.id,
                        color: completed.color,
                        width: completed.width,
                        tool: completed.tool,
                        opacity: completed.opacity,
                        points: completed.points,
                    });
                }
            }}
            onPointerCancel={(event) => cancel(event.currentTarget, event.pointerId)}
            onLostPointerCapture={(event) => cancel(event.currentTarget, event.pointerId)}
        >
            <div className="surface-label">{label}</div>
            <svg aria-label={`Screen annotations ${targetId}`} viewBox="0 0 1000 562.5" preserveAspectRatio="none">
                {[...strokes, ...(draft ? [draft] : [])].map((stroke) => {
                    const style = getAnnotationStrokeRenderStyle(stroke);
                    return (
                        <polyline
                            key={stroke.id}
                            data-stroke-id={stroke.id}
                            data-author-id={stroke.authorId}
                            data-tool={stroke.tool ?? "pen"}
                            points={stroke.points.map((point) => `${point.u * 1000},${point.v * 562.5}`).join(" ")}
                            fill="none"
                            stroke={stroke.color}
                            strokeWidth={style.lineWidth}
                            strokeOpacity={style.opacity}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                        />
                    );
                })}
            </svg>
            {enabled && <div className="draw-badge">Draw mode active</div>}
        </div>
    );
}

function ScreenTile({
    screen,
    role,
    participant,
    canDraw,
    activeTarget,
    setActiveTarget,
    tool,
    setTool,
    color,
    setColor,
    width,
    setWidth,
    strokes,
    remoteInputEnabled,
}: {
    screen: typeof SCREENS[number];
    role: Role;
    participant: { id: string; name: string };
    canDraw: boolean;
    activeTarget: string | null;
    setActiveTarget: React.Dispatch<React.SetStateAction<string | null>>;
    tool: AnnotationTool;
    setTool: React.Dispatch<React.SetStateAction<AnnotationTool>>;
    color: string;
    setColor: React.Dispatch<React.SetStateAction<string>>;
    width: number;
    setWidth: React.Dispatch<React.SetStateAction<number>>;
    strokes: AnnotationStroke[];
    remoteInputEnabled: boolean;
}) {
    const enabled = canDraw && activeTarget === screen.id && !remoteInputEnabled;
    const canClear = strokes.some((stroke) => role === "host" || stroke.authorId === participant.id);
    return (
        <section className="tile" data-testid={`tile-${screen.id}`}>
            <header className="tile-head">
                <span className="tile-title">{screen.label}</span>
                {canDraw ? (
                    <ScreenAnnotationToolbar
                        targetId={screen.id}
                        enabled={enabled}
                        tool={tool}
                        color={color}
                        width={width}
                        canClear={canClear}
                        isHost={role === "host"}
                        onToggle={() => setActiveTarget((current) => current === screen.id ? null : screen.id)}
                        onTool={setTool}
                        onColor={(next) => { setColor(next); if (tool === "eraser") setTool("pen"); }}
                        onWidth={setWidth}
                        onClear={() => void postAction({ type: "operation", participantId: participant.id, participantName: participant.name, targetKind: "screen", targetId: screen.id, operation: { kind: "clear", scope: role === "host" ? "all" : "own" } })}
                    />
                ) : <span className="permission-note" data-testid={`no-tools-${screen.id}`}>View only</span>}
            </header>
            <ScreenSurface
                targetId={screen.id}
                label={screen.label}
                participant={participant}
                enabled={enabled}
                remoteInputEnabled={remoteInputEnabled}
                tool={tool}
                color={color}
                width={width}
                strokes={strokes}
                canEraseAll={role === "host"}
            />
        </section>
    );
}

function App() {
    const role = (new URLSearchParams(window.location.search).get("role") as Role) || "viewer";
    const participant = PARTICIPANTS[role] ?? PARTICIPANTS.viewer;
    const { state, error } = useHarnessState();
    const [layout, setLayout] = useState<Layout>("regular");
    const [focusedTarget, setFocusedTarget] = useState<string>(SCREENS[0].id);
    const [activeTarget, setActiveTarget] = useState<string | null>(null);
    const [tool, setTool] = useState<AnnotationTool>("pen");
    const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]);
    const [width, setWidth] = useState<number>(ANNOTATION_WIDTHS[1]);
    const [remoteControlActive, setRemoteControlActive] = useState(false);
    const [fullViewMode, setFullViewMode] = useState<FullViewInteractionMode>("control");
    const [browserToolbar, setBrowserToolbar] = useState<HTMLDivElement | null>(null);

    const canDraw = role === "host" || state.allowedGuests.includes(participant.id);
    useEffect(() => {
        if (!canDraw) setActiveTarget(null);
    }, [canDraw]);
    useEffect(() => {
        if (!remoteControlActive) setFullViewMode("control");
    }, [remoteControlActive]);

    const strokesByTarget = useMemo(() => {
        const result: Record<string, AnnotationStroke[]> = {};
        for (const screen of SCREENS) {
            result[screen.id] = applyAnnotationEvents([], state.events.filter((event) => event.targetKind === "screen" && event.targetId === screen.id), "screen", screen.id);
        }
        result["browser-session"] = applyAnnotationEvents([], state.events.filter((event) => event.targetKind === "shared-browser" && event.targetId === "browser-session"), "shared-browser", "browser-session");
        return result;
    }, [state.events]);

    const visibleScreens = layout === "focused" ? SCREENS.filter((screen) => screen.id === focusedTarget) : SCREENS;
    const interaction = getFullViewInteractionState({
        mode: fullViewMode,
        remoteControlActive: layout === "full" && remoteControlActive,
        annotationAllowed: canDraw,
        annotationSelected: activeTarget === focusedTarget,
    });
    const remoteTarget = layout === "full" && remoteControlActive ? focusedTarget : null;

    const submitBrowserOperation = useCallback(async (operation: AnnotationOperation) => {
        await postAction({ type: "operation", participantId: participant.id, participantName: participant.name, targetKind: "shared-browser", targetId: "browser-session", operation });
    }, [participant.id, participant.name]);

    return (
        <main className="app" data-role={role} data-state-version={state.version}>
            <style>{styles}</style>
            <div className="top">
                <div>
                    <strong>Annotation acceptance harness — {participant.name}</strong>
                    <div className="status" data-testid="status">version {state.version}{error ? ` • ${error}` : ""} • {canDraw ? "drawing allowed" : "view only"}</div>
                </div>
                <div className="row">
                    {(["regular", "focused", "full"] as const).map((item) => (
                        <button key={item} className="button" type="button" aria-pressed={layout === item} onClick={() => setLayout(item)} data-testid={`layout-${item}`}>{item}</button>
                    ))}
                    {layout === "focused" && SCREENS.map((screen) => (
                        <button key={screen.id} className="button" type="button" aria-pressed={focusedTarget === screen.id} onClick={() => setFocusedTarget(screen.id)}>{screen.label}</button>
                    ))}
                    {role === "host" && (
                        <button className={`button ${state.allowedGuests.includes("guest") ? "danger" : "grant"}`} type="button" data-testid="permission-toggle" onClick={() => void postAction({ type: state.allowedGuests.includes("guest") ? "revoke" : "grant", participantId: "host", guestId: "guest" })}>
                            {state.allowedGuests.includes("guest") ? "Revoke guest drawing" : "Grant guest drawing"}
                        </button>
                    )}
                    {role === "host" && layout === "full" && (
                        <button className="button" type="button" aria-pressed={remoteControlActive} data-testid="remote-control-toggle" onClick={() => { setFocusedTarget("guest-screen"); setRemoteControlActive((current) => !current); }}>Remote control</button>
                    )}
                </div>
            </div>

            {layout === "full" && remoteControlActive && role === "host" && (
                <div className={`full-hud ${FULL_VIEW_CONTROL_ROW_CLASS}`} data-testid="full-view-hud">
                    <span>Remote guest screen</span>
                    <div className="mode-group" role="group" aria-label="Full View interaction mode">
                        <button type="button" aria-pressed={fullViewMode === "draw"} disabled={!canDraw} onClick={() => { setActiveTarget(focusedTarget); setFullViewMode("draw"); }}>Draw</button>
                        <button type="button" aria-pressed={fullViewMode === "control"} onClick={() => setFullViewMode("control")}>Control</button>
                    </div>
                    <span data-testid="interaction-state">draw:{String(interaction.annotationEnabled)} control:{String(interaction.remoteInputEnabled)}</span>
                    <button className="button danger" type="button" onClick={() => setRemoteControlActive(false)}>Release Control</button>
                </div>
            )}

            <div className={`grid ${layout}`} data-testid={`screen-grid-${layout}`}>
                {visibleScreens.map((screen) => {
                    const inRemoteFullView = remoteTarget === screen.id;
                    const remoteInputEnabled = inRemoteFullView && interaction.remoteInputEnabled;
                    const effectiveActiveTarget = inRemoteFullView && fullViewMode === "control" ? null : activeTarget;
                    return (
                        <ScreenTile
                            key={screen.id}
                            screen={screen}
                            role={role}
                            participant={participant}
                            canDraw={canDraw}
                            activeTarget={effectiveActiveTarget}
                            setActiveTarget={setActiveTarget}
                            tool={tool}
                            setTool={setTool}
                            color={color}
                            setColor={setColor}
                            width={width}
                            setWidth={setWidth}
                            strokes={strokesByTarget[screen.id] ?? []}
                            remoteInputEnabled={remoteInputEnabled}
                        />
                    );
                })}
            </div>

            {layout !== "full" && (
                <section className="shared-browser" data-testid="shared-browser-fixture">
                    <div ref={setBrowserToolbar} className="browser-toolbar" />
                    <div className="browser-stage">
                        <SharedBrowserAnnotationOverlay
                            sessionId="browser-session"
                            participantId={participant.id}
                            isHost={role === "host"}
                            interactive
                            permissions={{ allowedUserIds: new Set(state.allowedGuests) }}
                            toolbarContainer={browserToolbar}
                            initialStrokes={strokesByTarget["browser-session"] ?? []}
                            onSubmitOperation={submitBrowserOperation}
                        />
                    </div>
                </section>
            )}
        </main>
    );
}

createRoot(document.getElementById("root")!).render(<App />);
