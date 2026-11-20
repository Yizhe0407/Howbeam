import {
  Circle,
  Crop,
  MousePointer2,
  MoveUpRight,
  RectangleHorizontal,
  Type,
  createLucideIcon,
  type LucideIcon,
} from 'lucide-react';
import { t } from '@/lib/shared/i18n';
import {
  boundsFromPoints,
  constrainToSquare,
  isUsableItemBounds,
  snapToAngle,
  type ImageCssSize,
  type Point,
} from './image-edit-geometry';
import { fitTextHeight, MIN_ARROW_LENGTH, MIN_TEXT_WIDTH } from './image-edit-item-geometry';
import { CROP_ITEM_ID, type ImageEditItem, type ImageEditItemKind } from './image-edit-items';
import { STYLE_FIELDS, type ImageEditStyle, type StyleField } from './image-edit-style';
import { MOSAIC_BRUSH_LIMITS } from '@/lib/storage/models';

// A solid bar, drawn the way a redaction renders in the export.
const RedactIcon = createLucideIcon('Redact', [
  ['rect', { x: '3', y: '8', width: '18', height: '8', rx: '1.5', fill: 'currentColor', key: 'bar' }],
]);

// A checkerboard of soft and solid cells, the way a mosaic stroke renders.
const MosaicIcon = createLucideIcon('Mosaic', [
  ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2', key: 'frame' }],
  ['rect', { x: '3', y: '3', width: '6', height: '6', fill: 'currentColor', stroke: 'none', key: 'a' }],
  ['rect', { x: '15', y: '3', width: '6', height: '6', fill: 'currentColor', stroke: 'none', key: 'b' }],
  ['rect', { x: '9', y: '9', width: '6', height: '6', fill: 'currentColor', stroke: 'none', key: 'c' }],
  ['rect', { x: '3', y: '15', width: '6', height: '6', fill: 'currentColor', stroke: 'none', key: 'd' }],
  ['rect', { x: '15', y: '15', width: '6', height: '6', fill: 'currentColor', stroke: 'none', key: 'e' }],
]);

// A numbered circle, the marker this tool draws.
const StepIcon = createLucideIcon('Step', [
  ['circle', { cx: '12', cy: '12', r: '10', key: 'ring' }],
  ['path', { d: 'M10.5 9 12.5 7.5V16.5', key: 'one' }],
]);

export type ImageEditToolId = 'select' | 'text' | 'arrow' | 'rect' | 'ellipse' | 'step' | 'redact' | 'mosaic' | 'crop';

/** Width of a text box made by a plain click instead of a drag. */
const DEFAULT_TEXT_WIDTH = 240;

interface CreateInput {
  /** The identity of what the gesture makes: one per gesture, from its first draft to the stored item. */
  id: string;
  from: Point;
  to: Point;
  /** Every point the pointer passed through, given to tools whose gesture is a stroke. */
  path?: readonly Point[];
  size: ImageCssSize;
  style: ImageEditStyle;
  /** The number a new marker would take. */
  nextNumber: number;
}

/** What Shift does to a drag with this tool. */
type DragConstraint = 'square' | 'angle';

export interface ImageEditTool {
  id: ImageEditToolId;
  icon: LucideIcon;
  label: () => string;
  hint: () => string;
  /** Single key that switches to the tool. */
  shortcut: string;
  /** The item kind a drag on empty image creates; null for the pointer tool. */
  creates: ImageEditItemKind | null;
  /** Builds the item for a finished drag, or null when the gesture was too small to mean anything. */
  create?: (input: CreateInput) => ImageEditItem | null;
  /** How Shift reshapes the drag. */
  constraint?: DragConstraint;
  /** 'stroke' paints along the pointer's path instead of spanning from where it was pressed to where it is. */
  gesture?: 'drag' | 'stroke';
  /** Style controls shown while this tool is active and nothing is selected. */
  styleFields: readonly StyleField[];
}

function boxFromDrag({ from, to, size }: CreateInput) {
  const bounds = boundsFromPoints(from, to, size);
  return isUsableItemBounds(bounds) ? bounds : null;
}

/** A text box dragged out takes the dragged width; a click makes a default-width box at that spot. */
function textFromDrag(input: CreateInput): ImageEditItem {
  const { id, from, to, size, style } = input;
  const dragged = boundsFromPoints(from, to, size);
  const width = Math.min(dragged.width >= MIN_TEXT_WIDTH ? dragged.width : DEFAULT_TEXT_WIDTH, size.width);
  const x = dragged.width >= MIN_TEXT_WIDTH ? dragged.x : Math.min(from.x, Math.max(size.width - width, 0));
  const y = dragged.width >= MIN_TEXT_WIDTH ? dragged.y : from.y;
  // Empty until typed: the workspace holds it as a draft and stores it only once it has text.
  return fitTextHeight({
    id,
    kind: 'text',
    bounds: { x, y, width, height: style.fontSize },
    text: '',
    fontSize: style.fontSize,
    color: style.color,
    look: style.look,
  });
}

/** Closest two consecutive points of a stored stroke may be, in CSS px: denser input adds nothing visible. */
const MIN_STROKE_STEP = 2;

/**
 * Adds a pointer position to a stroke being painted, in place. Positions closer
 * than a visible step to the last one kept are skipped, except the one where
 * the stroke ends (`end`), which is always kept; storage's point limit is never
 * passed (the end then takes the last place). A stroke only ever grows at its
 * end while it is painted, so what is already painted never has to change.
 */
export function extendStroke(points: Point[], point: Point, end = false): void {
  const last = points.at(-1);
  const kept = { x: point.x, y: point.y };
  if (!last) {
    points.push(kept);
    return;
  }
  const moved = end ? point.x !== last.x || point.y !== last.y : Math.hypot(point.x - last.x, point.y - last.y) >= MIN_STROKE_STEP;
  if (!moved) return;
  if (points.length < MOSAIC_BRUSH_LIMITS.maxPoints) points.push(kept);
  else if (end) points[points.length - 1] = kept;
}

/** The points a stroke keeps from a whole pointer path, by the same rule as painting it. */
export function strokePoints(path: readonly Point[]): Point[] {
  const kept: Point[] = [];
  path.forEach((point, index) => extendStroke(kept, point, index === path.length - 1));
  return kept;
}

/** Applies Shift to a drag end point for tools that have a constraint. */
export function constrainDragEnd(tool: ImageEditTool, from: Point, to: Point, size: ImageCssSize): Point {
  if (tool.constraint === 'square') return constrainToSquare(from, to, size);
  if (tool.constraint === 'angle') return snapToAngle(from, to, size);
  return to;
}

/** Order here is the order of the toolbar. Add future tools to this list. */
export const IMAGE_EDIT_TOOLS: readonly [ImageEditTool, ...ImageEditTool[]] = [
  {
    id: 'select',
    icon: MousePointer2,
    label: () => t().editor.imageEdit.tools.select,
    hint: () => t().editor.imageEdit.hints.select,
    shortcut: 'v',
    creates: null,
    styleFields: [],
  },
  {
    id: 'text',
    icon: Type,
    label: () => t().editor.imageEdit.tools.text,
    hint: () => t().editor.imageEdit.hints.text,
    shortcut: 't',
    creates: 'text',
    create: textFromDrag,
    styleFields: STYLE_FIELDS.text,
  },
  {
    id: 'arrow',
    icon: MoveUpRight,
    label: () => t().editor.imageEdit.tools.arrow,
    hint: () => t().editor.imageEdit.hints.arrow,
    shortcut: 'a',
    creates: 'arrow',
    constraint: 'angle',
    create: ({ id, from, to, style }) => (
      Math.hypot(to.x - from.x, to.y - from.y) < MIN_ARROW_LENGTH
        ? null
        : { id, kind: 'arrow', from, to, width: style.strokeWidth, color: style.color }
    ),
    styleFields: STYLE_FIELDS.arrow,
  },
  {
    id: 'rect',
    icon: RectangleHorizontal,
    label: () => t().editor.imageEdit.tools.rect,
    hint: () => t().editor.imageEdit.hints.rect,
    shortcut: 'r',
    creates: 'rect',
    constraint: 'square',
    create: (input) => {
      const bounds = boxFromDrag(input);
      return bounds
        ? { id: input.id, kind: 'rect', bounds, width: input.style.strokeWidth, color: input.style.color, fill: input.style.fill }
        : null;
    },
    styleFields: STYLE_FIELDS.rect,
  },
  {
    id: 'ellipse',
    icon: Circle,
    label: () => t().editor.imageEdit.tools.ellipse,
    hint: () => t().editor.imageEdit.hints.ellipse,
    shortcut: 'o',
    creates: 'ellipse',
    constraint: 'square',
    create: (input) => {
      const bounds = boxFromDrag(input);
      return bounds
        ? { id: input.id, kind: 'ellipse', bounds, width: input.style.strokeWidth, color: input.style.color, fill: input.style.fill }
        : null;
    },
    styleFields: STYLE_FIELDS.ellipse,
  },
  {
    id: 'step',
    icon: StepIcon,
    label: () => t().editor.imageEdit.tools.step,
    hint: () => t().editor.imageEdit.hints.step,
    shortcut: 'n',
    creates: 'step',
    // The marker follows the pointer until it is released, so it can be placed precisely.
    create: ({ id, to, style, nextNumber }) => ({
      id,
      kind: 'step',
      center: to,
      radius: style.markerRadius,
      number: nextNumber,
      color: style.color,
    }),
    styleFields: STYLE_FIELDS.step.filter((field) => field !== 'number'),
  },
  {
    id: 'redact',
    icon: RedactIcon,
    label: () => t().editor.imageEdit.tools.redact,
    hint: () => t().editor.imageEdit.hints.redact,
    shortcut: 'm',
    creates: 'redaction',
    constraint: 'square',
    create: (input) => {
      const bounds = boxFromDrag(input);
      return bounds ? { id: input.id, kind: 'redaction', bounds } : null;
    },
    styleFields: [],
  },
  {
    id: 'mosaic',
    icon: MosaicIcon,
    label: () => t().editor.imageEdit.tools.mosaic,
    hint: () => t().editor.imageEdit.hints.mosaic,
    shortcut: 'b',
    creates: 'mosaic',
    gesture: 'stroke',
    create: ({ id, from, to, path, style }) => {
      const points = strokePoints(path ?? [from, to]);
      return points.length === 0 ? null : { id, kind: 'mosaic', points, size: style.brushSize };
    },
    styleFields: ['brushSize'],
  },
  {
    id: 'crop',
    icon: Crop,
    label: () => t().editor.imageEdit.tools.crop,
    hint: () => t().editor.imageEdit.hints.crop,
    shortcut: 'c',
    creates: 'crop',
    constraint: 'square',
    create: (input) => {
      const bounds = boxFromDrag(input);
      return bounds ? { id: CROP_ITEM_ID, kind: 'crop', bounds } : null;
    },
    styleFields: [],
  },
];

export function imageEditTool(id: ImageEditToolId): ImageEditTool {
  return IMAGE_EDIT_TOOLS.find((tool) => tool.id === id) ?? IMAGE_EDIT_TOOLS[0];
}

export function toolForShortcut(key: string): ImageEditTool | undefined {
  return IMAGE_EDIT_TOOLS.find((tool) => tool.shortcut === key.toLowerCase());
}
