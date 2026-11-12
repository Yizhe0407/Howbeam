/** Returns a finite, positive screenshot-pixel-to-CSS-pixel scale. Corrupt or
 * invalid metadata must never create infinite/zero viewport geometry. */
export function getValidScreenshotScale(value: number | null | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 1;
}
