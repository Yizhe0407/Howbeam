/** Decodes an image for drawing onto a canvas; its own module so tests can stand in for it. */
export function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}
