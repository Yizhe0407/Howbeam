import { t } from '@/lib/shared/i18n';
import type { Point, Size } from '@/lib/shared/geometry';

export const RECORDING_TOOLBAR_CORNER_KEY = 'howbeam:recordingToolbarCorner';

export type RecordingToolbarCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface ToolbarViewport {
  width: number;
  height: number;
}

export function isRecordingToolbarCorner(value: unknown): value is RecordingToolbarCorner {
  return value === 'top-left' || value === 'top-right' || value === 'bottom-left' || value === 'bottom-right';
}

export function clampToolbarPosition(
  point: Point,
  size: Size,
  viewport: ToolbarViewport,
  margin: number,
): Point {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  return {
    x: Math.min(maxX, Math.max(margin, point.x)),
    y: Math.min(maxY, Math.max(margin, point.y)),
  };
}

export function positionForToolbarCorner(
  corner: RecordingToolbarCorner,
  size: Size,
  viewport: ToolbarViewport,
  margin: number,
): Point {
  return clampToolbarPosition(
    {
      x: corner.endsWith('right') ? viewport.width - size.width - margin : margin,
      y: corner.startsWith('bottom') ? viewport.height - size.height - margin : margin,
    },
    size,
    viewport,
    margin,
  );
}

export function snapToolbarCorner(
  point: Point,
  size: Size,
  viewport: ToolbarViewport,
): RecordingToolbarCorner {
  const horizontal = point.x + size.width / 2 < viewport.width / 2 ? 'left' : 'right';
  const vertical = point.y + size.height / 2 < viewport.height / 2 ? 'top' : 'bottom';
  return `${vertical}-${horizontal}`;
}

export function toolbarCornerLabel(corner: RecordingToolbarCorner): string {
  return t().toolbar.corner[corner];
}
