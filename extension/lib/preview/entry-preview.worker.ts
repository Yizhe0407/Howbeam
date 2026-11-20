import { renderEntryRaster, type EntryRasterInput, type EntryRasterOptions } from '../export/entry-render';

export interface EntryPreviewRequest {
  id: number;
  input: EntryRasterInput;
  options: EntryRasterOptions;
}

export type EntryPreviewResponse =
  | { id: number; blob: Blob }
  | { id: number; error: string };

/** Renders entry previews off the editor's main thread: decoding a full
 * screenshot, burning in its masks and re-encoding it takes long enough to
 * drop frames wherever the page is scrolling or typing at the time. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<EntryPreviewRequest>) => void) | null;
  postMessage(message: EntryPreviewResponse): void;
};

scope.onmessage = ({ data: { id, input, options } }) => {
  renderEntryRaster(input, options).then(
    (blob) => scope.postMessage({ id, blob }),
    (error: unknown) => scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
  );
};
