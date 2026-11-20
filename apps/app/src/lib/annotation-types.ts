export type AnnotationTargetType = "screen" | "shared-browser";
export type AnnotationStrokeTool = "pen" | "highlighter";
export type AnnotationTool = AnnotationStrokeTool | "eraser";
export interface AnnotationTarget {
  targetKind: AnnotationTargetType;
  targetId: string;
}

export interface AnnotationPoint {
  u: number;
  v: number;
}

export interface AnnotationStroke {
  id: string;
  authorId: string;
  authorName: string;
  targetType: AnnotationTargetType;
  targetId: string;
  color: string;
  width: number;
  tool?: AnnotationStrokeTool;
  opacity?: number;
  points: AnnotationPoint[];
  createdAt: number;
}

export type AnnotationOperation =
  | { kind: "stroke"; strokeId: string; color: string; width: number; tool?: AnnotationStrokeTool; opacity?: number; points: AnnotationPoint[] }
  | { kind: "erase"; strokeId: string }
  | { kind: "clear"; scope: "own" | "all" };

export interface AnnotationEvent {
  sequence: number;
  targetKind?: AnnotationTargetType;
  targetId?: string;
  kind: "stroke" | "erase" | "clear";
  actorId: string;
  actorName: string;
  strokeId?: string;
  color?: string;
  width?: number;
  tool?: AnnotationStrokeTool;
  opacity?: number;
  points?: AnnotationPoint[];
  clearScope?: "own" | "all";
  createdAt: number;
}

export interface AnnotationPermissionSnapshot {
  allowedUserIds: ReadonlySet<string>;
}

export const ANNOTATION_COLORS = ["#f59e0b", "#ef4444", "#22c55e", "#38bdf8", "#a78bfa", "#f8fafc"] as const;
export const ANNOTATION_WIDTHS = [2, 4, 8, 12] as const;
export const HIGHLIGHTER_OPACITY = 0.35;
export const HIGHLIGHTER_WIDTH_MULTIPLIER = 2;

export function getAnnotationStrokeRenderStyle(
  stroke: Pick<AnnotationStroke, "tool" | "width" | "opacity">,
) {
  const tool = stroke.tool ?? "pen";
  return {
    lineWidth: stroke.width * (tool === "highlighter" ? HIGHLIGHTER_WIDTH_MULTIPLIER : 1),
    opacity: tool === "highlighter" ? (stroke.opacity ?? HIGHLIGHTER_OPACITY) : 1,
  };
}
