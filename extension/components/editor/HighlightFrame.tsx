import { HIGHLIGHT_COLOR, HIGHLIGHT_FILL_COLOR } from '@/lib/media/annotation-contract';

interface HighlightFrameBox {
  left: number;
  top: number;
  width: number;
  height: number;
  borderWidth: number;
  borderRadius: number;
}

interface Props {
  box: HighlightFrameBox;
  /** Annotation order, published as a hook for the multi-highlight tests. */
  order?: number;
}

/** The rendered twin of the raster compositor's highlight frame — single- and multi- thumbnails share it so exports match what the editor showed. */
export default function HighlightFrame({ box, order }: Props) {
  return (
    <div
      data-howbeam-annotation-frame={order}
      className="pointer-events-none absolute box-border"
      style={{
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        border: `${box.borderWidth}px solid ${HIGHLIGHT_COLOR}`,
        borderRadius: `${box.borderRadius}px`,
        backgroundColor: HIGHLIGHT_FILL_COLOR,
      }}
    />
  );
}
