import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from '@/lib/shared/utils';
import { t } from '@/lib/shared/i18n';
import { IMAGE_EDIT_LIMITS, type TextEdit } from '@/lib/storage/image-edit-model';
import {
  clientToImagePoint,
  type ImageCssSize,
  type Point,
} from '@/lib/editor/image-edit-geometry';
import {
  itemBounds,
  itemHandles,
  resizeItem,
  translateItem,
  type ItemHandle,
} from '@/lib/editor/image-edit-item-geometry';
import { nextStepNumber, type ImageEditItem } from '@/lib/editor/image-edit-items';
import type { ImageEditStyle } from '@/lib/editor/image-edit-style';
import { constrainDragEnd, imageEditTool, type ImageEditTool, type ImageEditToolId } from '@/lib/editor/image-edit-tools';
import {
  IMAGE_EDIT_FONT_FAMILY,
  IMAGE_EDIT_FONT_WEIGHT,
  textLineHeight,
} from '@/lib/media/image-edit-render';

interface Props {
  /** Everything placed on the image except the text currently being typed. */
  items: readonly ImageEditItem[];
  tool: ImageEditToolId;
  /** The screenshot's size in CSS pixels: the coordinate space of every item. */
  size: ImageCssSize;
  /** How the next thing drawn will look. */
  style: ImageEditStyle;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A finished drag on empty image produced a new item. */
  onCreate: (item: ImageEditItem) => void;
  /** An existing item was moved, resized or nudged. */
  onUpdate: (item: ImageEditItem) => void;
  onDelete: (id: string) => void;
  /** The item as it looks mid-gesture (null when no gesture is running), for live previews. */
  onDraft: (item: ImageEditItem | null) => void;
  /** The text item being typed into, if any. */
  editingText: TextEdit | null;
  onStartTextEdit: (id: string) => void;
  /** `null` cancels the edit. */
  onFinishTextEdit: (text: string | null) => void;
  /** Dragging empty image with the pointer tool pans the workspace instead. */
  onPanStart?: (event: PointerEvent<HTMLElement>) => void;
  disabled?: boolean;
}

type Session =
  | { mode: 'create'; tool: ImageEditTool; origin: Point }
  | { mode: 'move'; start: ImageEditItem; origin: Point }
  | { mode: 'resize'; start: ImageEditItem; handle: ItemHandle; origin: Point };

const HANDLE_POSITION: Record<string, string> = {
  nw: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  n: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  ne: 'left-full top-0 -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  e: 'left-full top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
  se: 'left-full top-full -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize',
  s: 'left-1/2 top-full -translate-x-1/2 -translate-y-1/2 cursor-ns-resize',
  sw: 'left-0 top-full -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize',
  w: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize',
};

/** Pixels a keyboard nudge moves the selected item; Shift moves further. */
const NUDGE = 1;
const NUDGE_LARGE = 10;
/** On-screen width of the invisible stroke that lets thin lines be grabbed. */
const HIT_STROKE = 14;
/** Two presses on the same text within this window start editing it. */
const DOUBLE_PRESS_MS = 350;

const percent = (value: number, total: number): string => `${(value / total) * 100}%`;

function boxStyle(item: ImageEditItem, size: ImageCssSize) {
  const box = itemBounds(item);
  return {
    left: percent(box.x, size.width),
    top: percent(box.y, size.height),
    width: percent(box.width, size.width),
    height: percent(box.height, size.height),
  };
}

/** Where an arrow's end handle sits inside the arrow's own box. */
function arrowHandleStyle(item: Extract<ImageEditItem, { kind: 'arrow' }>, handle: 'from' | 'to') {
  const box = itemBounds(item);
  const point = handle === 'from' ? item.from : item.to;
  return {
    left: percent(point.x - box.x, box.width),
    top: percent(point.y - box.y, box.height),
  };
}

/** Shapes that are grabbed by their outline, so clicking inside reaches whatever is under them. */
const isStrokeHit = (item: ImageEditItem): boolean => item.kind === 'rect' || item.kind === 'ellipse' || item.kind === 'arrow';

/** Dims everything outside the crop, so the area that will be kept stands out. */
function CropShade({ bounds, size }: { bounds: { x: number; y: number; width: number; height: number }; size: ImageCssSize }) {
  const top = percent(bounds.y, size.height);
  const bottomStart = percent(bounds.y + bounds.height, size.height);
  const left = percent(bounds.x, size.width);
  const rightStart = percent(bounds.x + bounds.width, size.width);
  const shade = 'pointer-events-none absolute bg-black/55';
  return (
    <div aria-hidden="true" data-howbeam-crop-shade className="pointer-events-none absolute inset-0">
      <div className={shade} style={{ left: 0, top: 0, width: '100%', height: top }} />
      <div className={shade} style={{ left: 0, top: bottomStart, width: '100%', bottom: 0 }} />
      <div className={shade} style={{ left: 0, top, width: left, height: percent(bounds.height, size.height) }} />
      <div className={shade} style={{ left: rightStart, top, right: 0, height: percent(bounds.height, size.height) }} />
    </div>
  );
}

/** The textarea shown while a text item is typed into, sized and coloured like the final text. */
function TextEditor({
  item,
  scale,
  size,
  onFinish,
}: {
  item: TextEdit;
  scale: number;
  size: ImageCssSize;
  onFinish: (text: string | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);
  // Storage keeps text up to a limit; the box refuses more instead of the save dropping the whole item.
  const [atLimit, setAtLimit] = useState(item.text.length >= IMAGE_EDIT_LIMITS.maxTextLength);
  const finish = (text: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onFinish(text);
  };

  useLayoutEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);

  const grow = () => {
    const area = ref.current;
    if (!area) return;
    area.style.height = '0px';
    area.style.height = `${area.scrollHeight}px`;
  };
  useLayoutEffect(grow, [scale, item.fontSize, item.bounds.width]);

  const left = percent(item.bounds.x, size.width);
  const top = percent(item.bounds.y, size.height);
  return (
    <>
    <textarea
      ref={ref}
      data-howbeam-text-editor
      defaultValue={item.text}
      maxLength={IMAGE_EDIT_LIMITS.maxTextLength}
      aria-label={t().editor.imageEdit.textInput}
      rows={1}
      onInput={(event) => {
        grow();
        setAtLimit(event.currentTarget.value.length >= IMAGE_EDIT_LIMITS.maxTextLength);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          finish(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      className="absolute m-0 box-border resize-none overflow-hidden rounded-sm border-2 border-dashed border-focus bg-black/25 p-0 outline-none"
      style={{
        left,
        top,
        width: percent(item.bounds.width, size.width),
        fontFamily: IMAGE_EDIT_FONT_FAMILY,
        fontWeight: IMAGE_EDIT_FONT_WEIGHT,
        fontSize: item.fontSize * scale,
        lineHeight: `${textLineHeight(item.fontSize) * scale}px`,
        color: item.color,
      }}
    />
    {atLimit && (
      <span
        role="status"
        data-howbeam-text-limit
        className="pointer-events-none absolute -translate-y-full rounded-sm bg-card px-1.5 py-0.5 text-xs font-bold text-foreground shadow"
        style={{ left, top }}
      >
        {t().editor.imageEdit.textLimitReached(IMAGE_EDIT_LIMITS.maxTextLength)}
      </span>
    )}
    </>
  );
}

/**
 * Interactive layer placed exactly over the screenshot. It owns pointer and
 * keyboard interaction for every item kind (create by dragging, select, move,
 * resize by handle, nudge, delete, edit text) and reports finished gestures
 * upward; it never persists anything itself. What a gesture would produce is
 * also reported mid-drag (`onDraft`) so the workspace can show the real result
 * live, not just an outline. Holding Shift reshapes a gesture (square, 45°,
 * locked direction) and is tracked live, so pressing it mid-drag takes effect.
 */
export default function ImageEditLayer({
  items,
  tool,
  size,
  style,
  selectedId,
  onSelect,
  onCreate,
  onUpdate,
  onDelete,
  onDraft,
  editingText,
  onStartTextEdit,
  onFinishTextEdit,
  onPanStart,
  disabled = false,
}: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  const lastPointRef = useRef<Point | null>(null);
  const [draft, setDraft] = useState<ImageEditItem | null>(null);
  const [scale, setScale] = useState(1);
  const lastDownRef = useRef<{ id: string; time: number } | null>(null);
  const activeTool = imageEditTool(tool);
  /** A drawing tool draws, even when the press lands on something already there: only the
   * pointer moves items. (The crop tool is the exception: it works on the one crop.) */
  const drawsOverItems = activeTool.create !== undefined && tool !== 'crop';

  // Screen pixels per screenshot CSS pixel: the text editor needs it to match the on-screen text size.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return undefined;
    const measure = () => setScale(layer.getBoundingClientRect().width / size.width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, [size.width]);

  useEffect(() => () => onDraft(null), [onDraft]);

  function pointFromEvent(event: PointerEvent | { clientX: number; clientY: number }): Point {
    const rect = layerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return clientToImagePoint({ x: event.clientX, y: event.clientY }, rect, size);
  }

  function begin(event: PointerEvent, session: Session) {
    if (disabled || event.button !== 0) return;
    sessionRef.current = session;
    lastPointRef.current = pointFromEvent(event);
    layerRef.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }

  function focusItem(id: string) {
    const chrome = Array.from(layerRef.current?.querySelectorAll<HTMLElement>('[data-howbeam-edit-item]') ?? []);
    chrome.find((element) => element.dataset.howbeamEditItem === id)?.focus({ preventScroll: true });
  }

  function beginCreate(event: PointerEvent) {
    onSelect(null);
    begin(event, { mode: 'create', tool: activeTool, origin: pointFromEvent(event) });
  }

  function beginMove(event: PointerEvent, item: ImageEditItem) {
    if (disabled) return;
    if (drawsOverItems) {
      // Items let presses through to the image while drawing; should one still land here, it draws too.
      beginCreate(event);
      return;
    }
    onSelect(item.id);
    focusItem(item.id);
    // The layer captures the pointer, which retargets click events to itself, so a
    // double press on text is recognised here instead of through `dblclick`.
    const previous = lastDownRef.current;
    lastDownRef.current = { id: item.id, time: event.timeStamp };
    if (item.kind === 'text' && previous?.id === item.id && event.timeStamp - previous.time < DOUBLE_PRESS_MS) {
      lastDownRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      onStartTextEdit(item.id);
      return;
    }
    begin(event, { mode: 'move', start: item, origin: pointFromEvent(event) });
  }

  function handleLayerPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (!activeTool.create) {
      onSelect(null);
      onPanStart?.(event);
      return;
    }
    beginCreate(event);
  }

  /** What the gesture produces with the pointer at `point`; Shift reshapes it. */
  function draftFor(session: Session, point: Point, shift: boolean): ImageEditItem | null {
    if (session.mode === 'create') {
      const to = shift ? constrainDragEnd(session.tool, session.origin, point, size) : point;
      return session.tool.create?.({ from: session.origin, to, size, style, nextNumber: nextStepNumber(items) }) ?? null;
    }
    let dx = point.x - session.origin.x;
    let dy = point.y - session.origin.y;
    if (session.mode === 'move') {
      // Shift locks a move to its dominant axis.
      if (shift) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      return translateItem(session.start, dx, dy, size);
    }
    return resizeItem(session.start, session.handle, dx, dy, size, { constrain: shift });
  }

  function refreshDraft(point: Point, shift: boolean) {
    const session = sessionRef.current;
    if (!session) return;
    lastPointRef.current = point;
    const next = draftFor(session, point, shift);
    setDraft(next);
    onDraft(next);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    refreshDraft(pointFromEvent(event), event.shiftKey);
  }

  // Pressing or releasing Shift mid-drag reshapes the gesture without waiting for the next pointer move.
  useEffect(() => {
    const onShift = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Shift' || !sessionRef.current || !lastPointRef.current) return;
      refreshDraft(lastPointRef.current, event.type === 'keydown');
    };
    window.addEventListener('keydown', onShift);
    window.addEventListener('keyup', onShift);
    return () => {
      window.removeEventListener('keydown', onShift);
      window.removeEventListener('keyup', onShift);
    };
  });

  /** Ends the gesture. The result is computed from where the pointer was released, so a press
   * and release without any movement in between (a click) still produces its item. */
  function finish(event: PointerEvent<HTMLDivElement> | null) {
    const session = sessionRef.current;
    sessionRef.current = null;
    lastPointRef.current = null;
    setDraft(null);
    onDraft(null);
    if (!event || !session) return;
    const result = draftFor(session, pointFromEvent(event), event.shiftKey);
    if (!result) return;
    if (session.mode === 'create') onCreate(result);
    else if (JSON.stringify(result) !== JSON.stringify(session.start)) onUpdate(result);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>, item: ImageEditItem) {
    if (disabled) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onDelete(item.id);
      return;
    }
    if (event.key === 'Enter' && item.kind === 'text') {
      event.preventDefault();
      onStartTextEdit(item.id);
      return;
    }
    const step = event.shiftKey ? NUDGE_LARGE : NUDGE;
    const delta: Record<string, Point | undefined> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    onUpdate(translateItem(item, move.x, move.y, size));
  }

  // The item being gestured over shows its draft; a brand-new draft has no stored counterpart yet.
  const shown = items.map((item) => (draft && draft.id === item.id ? draft : item));
  const isNewDraft = draft !== null && !items.some((item) => item.id === draft.id);
  const chromeItems = isNewDraft && draft ? [...shown, draft] : shown;
  const typingId = editingText?.id;
  const hitSvgItems = chromeItems.filter((item) => isStrokeHit(item) && item.id !== typingId);

  function renderChrome(item: ImageEditItem) {
    const isCrop = item.kind === 'crop';
    // The crop tool is modal: only the crop can be touched, and the crop can only be touched in it.
    const inert = tool === 'crop' ? !isCrop : isCrop;
    // Drawing tools reach through items to the image beneath (the selected item's handles stay usable).
    const passThrough = inert || drawsOverItems;
    const selected = isCrop ? tool === 'crop' : item.id === selectedId;
    const isNew = isNewDraft && draft?.id === item.id;
    const strokeOnly = isStrokeHit(item);
    // An ellipse is framed by its bounding box: `rounded-full` on a wide box draws a pill, not the ellipse, and the handles then float off the frame.
    const round = item.kind === 'step';
    return (
      <div
        key={item.id}
        role="button"
        tabIndex={disabled || isNew || inert ? -1 : 0}
        aria-label={t().editor.imageEdit.itemLabel(item.kind)}
        aria-pressed={selected}
        data-howbeam-edit-item={item.id}
        data-howbeam-edit-kind={item.kind}
        className={cn(
          'absolute box-border outline-none',
          (strokeOnly || passThrough) && 'pointer-events-none',
          round && 'rounded-full',
          item.kind === 'arrow'
            ? ''
            : isCrop
              ? 'border-2 border-white shadow-[0_0_0_1px_rgb(0_0_0/0.5)]'
              : selected || isNew
                ? 'border-2 border-focus'
                : 'border-2 border-transparent hover:border-dashed hover:border-focus/70',
          !disabled && !strokeOnly && !passThrough && 'cursor-move',
        )}
        style={boxStyle(item, size)}
        onPointerDown={(event) => beginMove(event, item)}
        onFocus={() => onSelect(item.id)}
        onKeyDown={(event) => handleKeyDown(event, item)}
      >
        {selected && !disabled && itemHandles(item).map((handle) => (
          <span
            key={handle}
            data-howbeam-edit-handle={handle}
            className={cn(
              'pointer-events-auto absolute size-2.5 border-2 border-focus bg-card',
              handle === 'from' || handle === 'to' ? '-translate-x-1/2 -translate-y-1/2 cursor-move rounded-full' : HANDLE_POSITION[handle],
            )}
            style={item.kind === 'arrow' && (handle === 'from' || handle === 'to') ? arrowHandleStyle(item, handle) : undefined}
            onPointerDown={(event) => begin(event, { mode: 'resize', start: item, handle, origin: pointFromEvent(event) })}
          />
        ))}
      </div>
    );
  }

  const cropItem = chromeItems.find((item) => item.kind === 'crop') ?? null;
  const boxLike = chromeItems.filter((item) => !isStrokeHit(item) && item.kind !== 'crop' && item.id !== typingId);
  const strokeLike = chromeItems.filter((item) => isStrokeHit(item) && item.id !== typingId);

  return (
    <div
      ref={layerRef}
      data-howbeam-image-edit-layer
      className={cn(
        'pointer-events-auto absolute inset-0 touch-none select-none',
        disabled
          ? 'cursor-not-allowed'
          : tool === 'text'
            ? 'cursor-text'
            : activeTool.create ? 'cursor-crosshair' : 'cursor-default',
      )}
      onPointerDown={handleLayerPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finish}
      onPointerCancel={() => finish(null)}
    >
      {/* Outlined shapes are grabbed by their stroke, so clicking inside a box reaches whatever is under it. */}
      <svg
        className="pointer-events-none absolute inset-0 size-full"
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {hitSvgItems.filter(() => tool !== 'crop' && !drawsOverItems).map((item) => {
          const hit = {
            fill: 'none',
            stroke: 'transparent',
            strokeWidth: HIT_STROKE,
            vectorEffect: 'non-scaling-stroke' as const,
            pointerEvents: 'stroke' as const,
            className: disabled ? undefined : 'cursor-move',
            onPointerDown: (event: PointerEvent<SVGElement>) => beginMove(event as unknown as PointerEvent, item),
          };
          if (item.kind === 'rect') {
            return <rect key={item.id} x={item.bounds.x} y={item.bounds.y} width={item.bounds.width} height={item.bounds.height} {...hit} />;
          }
          if (item.kind === 'ellipse') {
            return (
              <ellipse
                key={item.id}
                cx={item.bounds.x + item.bounds.width / 2}
                cy={item.bounds.y + item.bounds.height / 2}
                rx={item.bounds.width / 2}
                ry={item.bounds.height / 2}
                {...hit}
              />
            );
          }
          if (item.kind === 'arrow') {
            return <line key={item.id} x1={item.from.x} y1={item.from.y} x2={item.to.x} y2={item.to.y} strokeLinecap="round" {...hit} />;
          }
          return null;
        })}
      </svg>
      {strokeLike.map(renderChrome)}
      {boxLike.map(renderChrome)}
      {cropItem && (
        <>
          <CropShade bounds={cropItem.bounds} size={size} />
          {renderChrome(cropItem)}
        </>
      )}
      {editingText && <TextEditor key={editingText.id} item={editingText} scale={scale} size={size} onFinish={onFinishTextEdit} />}
    </div>
  );
}
