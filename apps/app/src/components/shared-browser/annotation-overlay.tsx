"use client";

import { ANNOTATION_LIMITS } from "@/lib/annotation-messages";
import type {
	AnnotationOperation,
	AnnotationPermissionSnapshot,
	AnnotationStroke,
	AnnotationTool,
} from "@/lib/annotation-types";
import {
	ANNOTATION_COLORS,
	ANNOTATION_WIDTHS,
	HIGHLIGHTER_OPACITY,
	getAnnotationStrokeRenderStyle,
} from "@/lib/annotation-types";
import {
	findNearestErasableStroke,
	tryReleasePointerCapture,
} from "@/lib/screen-annotation-ui";
import { Eraser, Highlighter, Pen, Trash2 } from "lucide-react";
import type { PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface SharedBrowserAnnotationOverlayProps {
	sessionId: string;
	participantId: string;
	isHost: boolean;
	browserControlActive?: boolean;
	interactive?: boolean;
	toolbarContainer?: HTMLElement | null;
	permissions: AnnotationPermissionSnapshot;
	initialStrokes?: AnnotationStroke[];
	onSubmitOperation: (operation: AnnotationOperation) => Promise<unknown>;
}

function pointFromEvent(event: PointerEvent<HTMLCanvasElement>) {
	const rect = event.currentTarget.getBoundingClientRect();
	return {
		u: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
		v: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
	};
}

export function SharedBrowserAnnotationOverlay({
	sessionId,
	participantId,
	isHost,
	browserControlActive = false,
	interactive = true,
	toolbarContainer,
	permissions,
	initialStrokes = [],
	onSubmitOperation,
}: SharedBrowserAnnotationOverlayProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const drawingRef = useRef(false);
	const pointsRef = useRef<Array<{ u: number; v: number }>>([]);
	const activePointerRef = useRef<number | null>(null);
	const strokes = initialStrokes.filter(
		(stroke) =>
			stroke.targetType === "shared-browser" && stroke.targetId === sessionId,
	);
	const [tool, setTool] = useState<AnnotationTool>("pen");
	const [color, setColor] = useState<string>(ANNOTATION_COLORS[0]);
	const [width, setWidth] = useState<number>(ANNOTATION_WIDTHS[1]);
	const [drawMode, setDrawMode] = useState(false);
	const [recordingDraft, setRecordingDraft] = useState<AnnotationStroke | null>(null);
	const canAnnotate =
		interactive && (isHost || permissions.allowedUserIds.has(participantId));
	useEffect(() => {
		if (!canAnnotate) {
			setDrawMode(false);
			drawingRef.current = false;
			pointsRef.current = [];
		}
	}, [canAnnotate]);
	useEffect(() => {
		if (browserControlActive) {
			setDrawMode(false);
			drawingRef.current = false;
			pointsRef.current = [];
		}
	}, [browserControlActive]);
	useEffect(() => {
		window.dispatchEvent(
			new CustomEvent("mira-shared-browser-annotation-draft", {
				detail: { draft: recordingDraft },
			}),
		);
		return () => {
			window.dispatchEvent(
				new CustomEvent("mira-shared-browser-annotation-draft", {
					detail: { draft: null },
				}),
			);
		};
	}, [recordingDraft]);
	useEffect(() => {
		if (!interactive) {
			setDrawMode(false);
			drawingRef.current = false;
			activePointerRef.current = null;
			pointsRef.current = [];
		}
	}, [interactive]);
	const send = useCallback(
		(operation: AnnotationOperation) => {
			if (!canAnnotate) return;
			void Promise.resolve(onSubmitOperation(operation)).catch(() => undefined);
		},
		[canAnnotate, onSubmitOperation],
	);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const draw = () => {
			const rect = canvas.getBoundingClientRect();
			const ratio = window.devicePixelRatio || 1;
			canvas.width = Math.max(1, Math.round(rect.width * ratio));
			canvas.height = Math.max(1, Math.round(rect.height * ratio));
			const context = canvas.getContext("2d");
			if (!context) return;
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, rect.width, rect.height);
			for (const stroke of strokes) {
				const renderStyle = getAnnotationStrokeRenderStyle(stroke);
				context.strokeStyle = stroke.color;
				context.lineWidth = renderStyle.lineWidth;
				context.globalAlpha = renderStyle.opacity;
				context.lineCap = "round";
				context.lineJoin = "round";
				context.beginPath();
				stroke.points.forEach((point, index) => {
					const x = point.u * rect.width;
					const y = point.v * rect.height;
					if (index === 0) context.moveTo(x, y);
					else context.lineTo(x, y);
				});
				context.stroke();
			}
			context.globalAlpha = 1;
		};
		draw();
		const observer = new ResizeObserver(draw);
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [strokes]);

	const finishStroke = useCallback(
		(pointerId?: number, cancelled = false) => {
			if (
				!drawingRef.current ||
				(pointerId !== undefined && activePointerRef.current !== pointerId)
			)
				return;
			drawingRef.current = false;
			activePointerRef.current = null;
			const points = pointsRef.current;
			pointsRef.current = [];
			setRecordingDraft(null);
			if (cancelled || points.length < 2 || !canAnnotate) return;
			if (tool === "eraser") {
				const point = points.at(-1);
				if (!point) return;
				const hit = findNearestErasableStroke(
					strokes,
					point,
					participantId,
					isHost,
				);
				if (!hit) return;
				send({ kind: "erase", strokeId: hit.id });
				return;
			}
			send({
				kind: "stroke",
				strokeId: `${participantId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				color,
				width,
				tool,
				opacity: tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1,
				points: Array.from(points),
			});
		},
		[canAnnotate, color, isHost, participantId, send, strokes, tool, width],
	);

	const clear = useCallback(() => {
		send({ kind: "clear", scope: isHost ? "all" : "own" });
	}, [isHost, send]);

	const cancelActiveStroke = useCallback(
		(element?: Element, pointerId = activePointerRef.current) => {
			if (element && pointerId !== null)
				tryReleasePointerCapture(element, pointerId);
			drawingRef.current = false;
			activePointerRef.current = null;
			pointsRef.current = [];
			setRecordingDraft(null);
		},
		[],
	);

	useEffect(() => {
		const cancelOnBlur = () =>
			cancelActiveStroke(canvasRef.current ?? undefined);
		window.addEventListener("blur", cancelOnBlur);
		return () => {
			window.removeEventListener("blur", cancelOnBlur);
			cancelActiveStroke(canvasRef.current ?? undefined);
		};
	}, [cancelActiveStroke]);

	return (
		<div className="pointer-events-none absolute inset-0 z-10">
			<canvas
				ref={canvasRef}
				aria-label="Shared Browser annotations"
				className={`absolute inset-0 h-full w-full touch-none ${drawMode ? "pointer-events-auto cursor-crosshair" : "pointer-events-none"}`}
				onPointerDown={(event) => {
					if (!drawMode || activePointerRef.current !== null) return;
					try {
						event.currentTarget.setPointerCapture(event.pointerId);
					} catch { }
					activePointerRef.current = event.pointerId;
					drawingRef.current = true;
					const firstPoint = pointFromEvent(event);
					pointsRef.current = [firstPoint];
					if (tool !== "eraser") {
						setRecordingDraft({
							id: `draft-${participantId}-${Date.now()}`,
							authorId: participantId,
							authorName: "Participant",
							targetType: "shared-browser",
							targetId: sessionId,
							color,
							width,
							tool,
							opacity: tool === "highlighter" ? HIGHLIGHTER_OPACITY : 1,
							points: [firstPoint],
							createdAt: Date.now(),
						});
					}
				}}
				onPointerMove={(event) => {
					if (
						drawingRef.current &&
						activePointerRef.current === event.pointerId &&
						pointsRef.current.length < ANNOTATION_LIMITS.maxPoints
					) {
						const point = pointFromEvent(event);
						pointsRef.current.push(point);
						setRecordingDraft((draft) =>
							draft ? { ...draft, points: [...draft.points, point] } : draft,
						);
					}
				}}
				onPointerUp={(event) => {
					finishStroke(event.pointerId);
					tryReleasePointerCapture(event.currentTarget, event.pointerId);
				}}
				onPointerCancel={(event) =>
					cancelActiveStroke(event.currentTarget, event.pointerId)
				}
				onLostPointerCapture={(event) =>
					cancelActiveStroke(event.currentTarget, event.pointerId)
				}
			/>
			{canAnnotate &&
				toolbarContainer &&
				createPortal(
					<div
						className="flex w-full min-w-0 max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-lg border border-[#dedee5] bg-white p-1.5 touch-pan-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
						role="toolbar"
						aria-label="Shared Browser annotation tools"
					>
						<button
							type="button"
							aria-pressed={drawMode}
							title={drawMode ? "Browser control mode" : "Draw mode"}
							onClick={() => setDrawMode((active) => !active)}
							className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-2 sm:p-1.5 ${drawMode ? "bg-[#7659ef] text-white" : "text-[#666b77] hover:bg-[#ece9ff] hover:text-[#5d42d6]"}`}
						>
							<Pen className="h-4 w-4" />
						</button>
						<button
							type="button"
							aria-label="Pen"
							aria-pressed={tool === "pen"}
							title="Pen"
							onClick={() => setTool("pen")}
							className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-2 sm:p-1.5 ${tool === "pen" ? "bg-[#7659ef] text-white" : "text-[#666b77] hover:bg-[#ece9ff] hover:text-[#5d42d6]"}`}
						>
							<Pen className="h-4 w-4" />
						</button>
						<button
							type="button"
							aria-label="Highlighter"
							aria-pressed={tool === "highlighter"}
							title="Highlighter"
							onClick={() => setTool("highlighter")}
							className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-2 sm:p-1.5 ${tool === "highlighter" ? "bg-[#7659ef] text-white" : "text-[#666b77] hover:bg-[#ece9ff] hover:text-[#5d42d6]"}`}
						>
							<Highlighter className="h-4 w-4" />
						</button>
						<button
							type="button"
							aria-label="Eraser"
							aria-pressed={tool === "eraser"}
							title="Eraser"
							onClick={() => setTool("eraser")}
							className={`flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-2 sm:p-1.5 ${tool === "eraser" ? "bg-[#7659ef] text-white" : "text-[#666b77] hover:bg-[#ece9ff] hover:text-[#5d42d6]"}`}
						>
							<Eraser className="h-4 w-4" />
						</button>
						{ANNOTATION_COLORS.map((item) => (
							<button
								key={item}
								type="button"
								aria-label={`Color ${item}`}
								aria-pressed={color === item}
								onClick={() => {
									setColor(item);
									if (tool === "eraser") setTool("pen");
								}}
								className={`h-11 w-11 shrink-0 rounded-full border-2 sm:h-4 sm:w-4 ${color === item ? "border-[#7659ef]" : "border-transparent"}`}
								style={{ backgroundColor: item }}
							/>
						))}
						<select
							aria-label="Annotation width"
							value={width}
							onChange={(event) => setWidth(Number(event.target.value))}
							className="min-h-11 shrink-0 rounded border border-[#dedee5] bg-[#f0f1f5] px-2 text-xs text-[#30323a] sm:px-1"
						>
							{ANNOTATION_WIDTHS.map((item) => (
								<option key={item} value={item}>
									{item}px
								</option>
							))}
						</select>
						<button
							type="button"
							title={isHost ? "Clear all annotations" : "Clear my annotations"}
							onClick={clear}
							className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded p-2 text-[#666b77] hover:bg-red-50 hover:text-red-700 sm:p-1.5"
						>
							<Trash2 className="h-4 w-4" />
						</button>
					</div>,
					toolbarContainer,
				)}
		</div>
	);
}
