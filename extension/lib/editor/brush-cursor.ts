/**
 * The mosaic brush outline as the system cursor. The operating system draws
 * its cursor straight onto the screen, so it moves with the hand; an outline
 * drawn by the page always trails it by the frames the page takes to reach the
 * screen. Browsers refuse cursor images past a size limit, so a brush bigger
 * than that on screen has no system cursor and the page draws its outline.
 */

/** Largest cursor image browsers show, in device pixels. */
export const MAX_CURSOR_PIXELS = 128;

/** White ring inside a dark one, so the outline shows on any background. */
const RING = 2;
const EDGE = 1;

/**
 * The CSS `cursor` value for a brush `diameter` CSS px wide on screen, or null
 * when the cursor image would be larger than browsers show.
 */
export function brushCursor(diameter: number, devicePixelRatio: number): string | null {
  const radius = diameter / 2;
  const size = Math.ceil(diameter + (RING + EDGE) * 2);
  if (!Number.isFinite(size) || size <= 0 || size * Math.max(devicePixelRatio, 1) > MAX_CURSOR_PIXELS) return null;
  const centre = size / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<circle cx="${centre}" cy="${centre}" r="${radius + RING / 2}" fill="none" stroke="rgba(0,0,0,0.6)" stroke-width="${RING + EDGE * 2}"/>`
    + `<circle cx="${centre}" cy="${centre}" r="${radius + RING / 2}" fill="none" stroke="#fff" stroke-width="${RING}"/>`
    + '</svg>';
  const hotspot = Math.round(centre);
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot} ${hotspot}, crosshair`;
}
