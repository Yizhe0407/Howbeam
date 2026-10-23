import {
  Circle,
  Crop,
  EyeOff,
  Hash,
  MousePointer2,
  MoveUpRight,
  RectangleHorizontal,
  Type,
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
import { CROP_ITEM_ID, newItemId, type ImageEditItem, type ImageEditItemKind } from './image-edit-items';
import { STYLE_FIELDS, type ImageEditStyle, type StyleField } from './image-edit-style';

export type ImageEditToolId = 'select' | 'text' | 'arrow' | 'rect' | 'ellipse' | 'step' | 'redact' | 'crop';

/** Width of a text box made by a plain click instead of a drag. */
const DEFAULT_TEXT_WIDTH = 240;

interface CreateInput {
  from: Point;
  to: Point;
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
  /** Style controls shown while this tool is active and nothing is selected. */
  styleFields: readonly StyleField[];
}

function boxFromDrag({ from, to, size }: CreateInput) {
  const bounds = boundsFromPoints(from, to, size);
  return isUsableItemBounds(bounds) ? bounds : null;
}

/** A text box dragged out takes the dragged width; a click makes a default-width box at that spot. */
function textFromDrag(input: CreateInput): ImageEditItem {
  const { from, to, size, style } = input;
  const dragged = boundsFromPoints(from, to, size);
  const width = Math.min(dragged.width >= MIN_TEXT_WIDTH ? dragged.width : DEFAULT_TEXT_WIDTH, size.width);
  const x = dragged.width >= MIN_TEXT_WIDTH ? dragged.x : Math.min(from.x, Math.max(size.width - width, 0));
  const y = dragged.width >= MIN_TEXT_WIDTH ? dragged.y : from.y;
  // Empty until typed: the workspace holds it as a draft and stores it only once it has text.
  return fitTextHeight({
    id: newItemId(),
    kind: 'text',
    bounds: { x, y, width, height: style.fontSize },
    text: '',
    fontSize: style.fontSize,
    color: style.color,
    look: style.look,
  });
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
    create: ({ from, to, style }) => (
      Math.hypot(to.x - from.x, to.y - from.y) < MIN_ARROW_LENGTH
        ? null
        : { id: newItemId(), kind: 'arrow', from, to, width: style.strokeWidth, color: style.color }
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
        ? { id: newItemId(), kind: 'rect', bounds, width: input.style.strokeWidth, color: input.style.color, fill: input.style.fill }
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
        ? { id: newItemId(), kind: 'ellipse', bounds, width: input.style.strokeWidth, color: input.style.color, fill: input.style.fill }
        : null;
    },
    styleFields: STYLE_FIELDS.ellipse,
  },
  {
    id: 'step',
    icon: Hash,
    label: () => t().editor.imageEdit.tools.step,
    hint: () => t().editor.imageEdit.hints.step,
    shortcut: 'n',
    creates: 'step',
    // The marker follows the pointer until it is released, so it can be placed precisely.
    create: ({ to, style, nextNumber }) => ({
      id: newItemId(),
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
    icon: EyeOff,
    label: () => t().editor.imageEdit.tools.redact,
    hint: () => t().editor.imageEdit.hints.redact,
    shortcut: 'm',
    creates: 'redaction',
    constraint: 'square',
    create: (input) => {
      const bounds = boxFromDrag(input);
      return bounds ? { id: newItemId(), kind: 'redaction', bounds } : null;
    },
    styleFields: [],
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
