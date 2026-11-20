import {
	type AnnotationStroke,
	getAnnotationStrokeRenderStyle,
} from "../annotation-types";
import type { RecordingRect } from "./canvas-compositor";

export interface RecordingAnnotationInput {
	committed: readonly AnnotationStroke[];
	draft?: AnnotationStroke | null;
}

function clampNormalized(value: number): number {
	return Math.max(0, Math.min(1, value));
}

export function annotationPointToCanvas(
	point: { u: number; v: number },
	imageRect: RecordingRect,
): { x: number; y: number } {
	return {
		x: imageRect.x + clampNormalized(point.u) * imageRect.width,
		y: imageRect.y + clampNormalized(point.v) * imageRect.height,
	};
}

export function drawAnnotationStroke(
	context: CanvasRenderingContext2D,
	stroke: AnnotationStroke,
	imageRect: RecordingRect,
): void {
	if (stroke.points.length === 0) return;
	const style = getAnnotationStrokeRenderStyle(stroke);
	const scale = Math.max(
		0.5,
		Math.min(imageRect.width, imageRect.height) / 1080,
	);
	context.save();
	context.beginPath();
	context.rect(imageRect.x, imageRect.y, imageRect.width, imageRect.height);
	context.clip();
	context.globalAlpha = style.opacity;
	context.globalCompositeOperation = "source-over";
	context.strokeStyle = stroke.color;
	context.fillStyle = stroke.color;
	context.lineWidth = Math.max(1, style.lineWidth * scale);
	context.lineCap = "round";
	context.lineJoin = "round";
	const firstPoint = stroke.points[0];
	if (!firstPoint) {
		context.restore();
		return;
	}
	const first = annotationPointToCanvas(firstPoint, imageRect);
	if (stroke.points.length === 1) {
		context.beginPath();
		context.arc(first.x, first.y, context.lineWidth / 2, 0, Math.PI * 2);
		context.fill();
		context.restore();
		return;
	}
	context.beginPath();
	context.moveTo(first.x, first.y);
	for (let index = 1; index < stroke.points.length; index += 1) {
		const previousPoint = stroke.points[index - 1];
		const currentPoint = stroke.points[index];
		if (!previousPoint || !currentPoint) continue;
		const previous = annotationPointToCanvas(previousPoint, imageRect);
		const current = annotationPointToCanvas(currentPoint, imageRect);
		context.quadraticCurveTo(
			previous.x,
			previous.y,
			(previous.x + current.x) / 2,
			(previous.y + current.y) / 2,
		);
	}
	const lastPoint = stroke.points.at(-1);
	if (!lastPoint) {
		context.restore();
		return;
	}
	const last = annotationPointToCanvas(lastPoint, imageRect);
	context.lineTo(last.x, last.y);
	context.stroke();
	context.restore();
}

export function renderAnnotations(
	context: CanvasRenderingContext2D,
	annotations: RecordingAnnotationInput,
	imageRect: RecordingRect,
): void {
	for (const stroke of annotations.committed) {
		drawAnnotationStroke(context, stroke, imageRect);
	}
	if (annotations.draft)
		drawAnnotationStroke(context, annotations.draft, imageRect);
}
