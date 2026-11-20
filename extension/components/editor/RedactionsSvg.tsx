import { useId } from 'react';
import { REDACTION_COLOR } from '@/lib/media/annotation-contract';
import {
  getExpandedRedactionBounds,
  mosaicStrokeCap,
  mosaicStrokePath,
  mosaicStrokeWidth,
} from '@/lib/media/redaction-render';
import type { PixelateRedaction, Redaction } from '@/lib/storage/models';

interface Props {
  redactions: readonly Redaction[];
  /** The screenshot's size in CSS pixels, the coordinate space of `redactions`. */
  width: number;
  height: number;
  /** An image of the screenshot's size whose pixels under every stroke are the
   * mosaic. Null paints strokes solid until it exists. */
  mosaicUrl: string | null;
}

function StrokeShape({ stroke, color }: { stroke: PixelateRedaction; color: string }) {
  const cap = mosaicStrokeCap(stroke);
  return (
    <>
      <path
        d={mosaicStrokePath(stroke.points)}
        fill="none"
        stroke={color}
        strokeWidth={mosaicStrokeWidth(stroke)}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={cap.cx} cy={cap.cy} r={cap.r} fill={color} />
    </>
  );
}

/** Privacy masks as SVG, drawn exactly as the raster compositor draws them, in their stored order. */
export default function RedactionsSvg({ redactions, width, height, mosaicUrl }: Props) {
  const idPrefix = useId();
  return (
    <svg
      className="absolute inset-0 size-full"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {redactions.map((redaction, index) => {
        if (redaction.kind === 'solid') {
          const bounds = getExpandedRedactionBounds(redaction.bounds, width, height);
          return bounds && (
            <rect
              key={redaction.id}
              data-howbeam-redaction={redaction.id}
              x={bounds.x}
              y={bounds.y}
              width={bounds.width}
              height={bounds.height}
              fill={REDACTION_COLOR}
            />
          );
        }
        if (!mosaicUrl) {
          return (
            <g key={redaction.id} data-howbeam-redaction={redaction.id}>
              <StrokeShape stroke={redaction} color={REDACTION_COLOR} />
            </g>
          );
        }
        const maskId = `${idPrefix}-mosaic-${index}`;
        return (
          <g key={redaction.id} data-howbeam-redaction={redaction.id}>
            <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
              <StrokeShape stroke={redaction} color="#fff" />
            </mask>
            <image href={mosaicUrl} x={0} y={0} width={width} height={height} preserveAspectRatio="none" mask={`url(#${maskId})`} />
          </g>
        );
      })}
    </svg>
  );
}
