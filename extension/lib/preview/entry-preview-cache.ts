import { renderEntryRaster, type EntryRasterInput, type EntryRasterOptions } from '../export/entry-render';
import type { EntryPreviewRequest, EntryPreviewResponse } from './entry-preview.worker';

/**
 * Finished entry previews, shared by every view of the editor and library.
 *
 * A preview is the entry's export raster (lib/export/entry-render), so what a
 * person sees is exactly what they copy or export: masks burned into the
 * pixels, drawings and highlight boxes painted on, nothing left as live DOM to
 * lay out, paint or keep in memory per view. Rendering happens in a worker, a
 * few at a time, newest request first: the view that asked last is the one
 * that just came on screen. Requests nobody waits for any more are dropped
 * before they start.
 */

const MAX_RUNNING = 2;
/** Finished previews no view shows any more are kept, newest first, up to this many bytes. */
const IDLE_BYTE_BUDGET = 64 * 1024 * 1024;

type Listener = (blob: Blob | null) => void;

interface Preview {
  id: string;
  input: EntryRasterInput;
  options: EntryRasterOptions;
  state: 'queued' | 'running' | 'done';
  blob?: Blob;
  consumers: number;
  listeners: Set<Listener>;
}

const sourceIds = new WeakMap<Blob, number>();
let nextSourceId = 1;
/** Insertion order is recency: a preview moves to the end whenever a view asks for it. */
const previews = new Map<string, Preview>();
const queue: Preview[] = [];
let running = 0;

function previewId(source: Blob, key: string): string {
  let sourceId = sourceIds.get(source);
  if (sourceId === undefined) {
    sourceId = nextSourceId++;
    sourceIds.set(source, sourceId);
  }
  return `${sourceId}:${key}`;
}

/** The finished preview, if it exists, so a render can show it at once. */
export function peekEntryPreview(source: Blob, key: string): Blob | undefined {
  const preview = previews.get(previewId(source, key));
  return preview?.state === 'done' ? preview.blob : undefined;
}

/**
 * Asks for the preview of `input` and calls `listener` once it is ready, with
 * null when it could not be made (a failure is not remembered: the next ask
 * tries again). Returns the release for when the view no longer needs it.
 */
export function requestEntryPreview(
  input: EntryRasterInput,
  key: string,
  options: EntryRasterOptions,
  listener: Listener,
): () => void {
  const id = previewId(input.screenshot, key);
  let preview = previews.get(id);
  if (preview) {
    previews.delete(id);
    previews.set(id, preview);
  } else {
    preview = { id, input, options, state: 'queued', consumers: 0, listeners: new Set() };
    previews.set(id, preview);
    queue.push(preview);
  }
  const held = preview;
  held.consumers++;
  if (held.state === 'done') queueMicrotask(() => listener(held.blob ?? null));
  else held.listeners.add(listener);
  pump();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.consumers--;
    held.listeners.delete(listener);
    if (held.consumers > 0) return;
    if (held.state === 'queued') {
      queue.splice(queue.indexOf(held), 1);
      previews.delete(held.id);
    }
    trimIdle();
  };
}

function pump(): void {
  while (running < MAX_RUNNING && queue.length > 0) {
    const preview = queue.pop()!;
    preview.state = 'running';
    running++;
    render(preview.input, preview.options).then(
      (blob) => finish(preview, blob),
      (error: unknown) => {
        console.error('[howbeam] failed to render a preview', error);
        finish(preview, null);
      },
    );
  }
}

function finish(preview: Preview, blob: Blob | null): void {
  running--;
  const listeners = [...preview.listeners];
  preview.listeners.clear();
  if (blob) {
    preview.state = 'done';
    preview.blob = blob;
  } else if (previews.get(preview.id) === preview) {
    previews.delete(preview.id);
  }
  for (const listener of listeners) listener(blob);
  trimIdle();
  pump();
}

function trimIdle(): void {
  let idleBytes = 0;
  for (const preview of [...previews.values()].reverse()) {
    if (preview.state !== 'done' || preview.consumers > 0) continue;
    idleBytes += preview.blob?.size ?? 0;
    if (idleBytes > IDLE_BYTE_BUDGET) previews.delete(preview.id);
  }
}

interface WorkerJob {
  request: EntryPreviewRequest;
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
}

/** undefined: not tried yet; null: this context has no usable worker, so previews render inline. */
let worker: Worker | null | undefined;
const workerJobs = new Map<number, WorkerJob>();
let nextJobId = 1;

function previewWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') return (worker = null);
  try {
    const created = new Worker(new URL('./entry-preview.worker.ts', import.meta.url), { type: 'module' });
    created.onmessage = ({ data }: MessageEvent<EntryPreviewResponse>) => {
      const job = workerJobs.get(data.id);
      if (!job) return;
      workerJobs.delete(data.id);
      if ('blob' in data) job.resolve(data.blob);
      else job.reject(new Error(data.error));
    };
    // The worker script itself failed (blocked or broken): render everything inline from now on.
    created.onerror = (event) => {
      event.preventDefault();
      console.error('[howbeam] preview worker failed; rendering previews inline', event.message);
      created.terminate();
      worker = null;
      const stranded = [...workerJobs.values()];
      workerJobs.clear();
      for (const job of stranded) renderEntryRaster(job.request.input, job.request.options).then(job.resolve, job.reject);
    };
    worker = created;
  } catch (error) {
    console.error('[howbeam] preview worker unavailable; rendering previews inline', error);
    worker = null;
  }
  return worker;
}

function render(input: EntryRasterInput, options: EntryRasterOptions): Promise<Blob> {
  const target = previewWorker();
  if (!target) return renderEntryRaster(input, options);
  return new Promise<Blob>((resolve, reject) => {
    const request: EntryPreviewRequest = { id: nextJobId++, input, options };
    workerJobs.set(request.id, { request, resolve, reject });
    target.postMessage(request);
  });
}
