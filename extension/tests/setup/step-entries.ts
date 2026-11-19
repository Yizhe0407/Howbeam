import { type StepEntry } from '@/lib/storage/models';

/** Single-step timeline entry fixture shared by the StepRail integration tests. */
export function makeEntry(id: string, order: number): StepEntry {
  return {
    kind: 'single',
    step: {
      id,
      sessionId: 'session-1',
      order,
      screenshotBlob: new Blob(['image'], { type: 'image/png' }),
      bounds: { x: 10, y: 10, width: 20, height: 20 },
      devicePixelRatio: 1,
      screenshotScale: 1,
      title: '',
      description: `Step ${order + 1}`,
      url: 'https://example.com/',
      timestamp: order,
    },
  };
}
