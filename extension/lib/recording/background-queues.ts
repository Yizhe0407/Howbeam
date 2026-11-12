export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const MIN_CAPTURE_INTERVAL_MS = 500;
let lastCaptureAt = 0;
let captureChain: Promise<unknown> = Promise.resolve();
export function queueCapture<T>(task: () => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    return task();
  };
  const result = captureChain.then(run, run);
  captureChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export class StaleCaptureError extends Error {}
