import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_PRESENTATION_CSS,
  type CapturePresentationAdapter,
  withCapturePresentation,
} from '@/lib/capture/capture-presentation';

function adapter(events: string[]): CapturePresentationAdapter {
  return {
    insert: vi.fn(async () => { events.push('insert'); }),
    settle: vi.fn(async () => { events.push('settle'); }),
    remove: vi.fn(async () => { events.push('remove'); }),
  };
}

describe('withCapturePresentation', () => {
  it('settles after presentation setup and restores presentation after capture', async () => {
    const events: string[] = [];
    const value = await withCapturePresentation(adapter(events), async () => {
      events.push('capture');
      return 'image';
    });

    expect(value).toBe('image');
    expect(events).toEqual(['insert', 'settle', 'capture', 'remove']);
  });

  it.each(['settle', 'capture'] as const)('restores presentation when %s fails', async (failurePoint) => {
    const events: string[] = [];
    const captureError = new Error(`${failurePoint} failed`);
    const captureAdapter = adapter(events);
    if (failurePoint === 'settle') {
      captureAdapter.settle = vi.fn(async () => {
        events.push('settle');
        throw captureError;
      });
    }

    await expect(withCapturePresentation(captureAdapter, async () => {
      events.push('capture');
      if (failurePoint === 'capture') throw captureError;
      return 'image';
    })).rejects.toBe(captureError);

    expect(events.at(-1)).toBe('remove');
  });

  it('does not remove CSS when presentation setup itself fails', async () => {
    const events: string[] = [];
    const insertError = new Error('insert failed');
    const captureAdapter = adapter(events);
    captureAdapter.insert = vi.fn(async () => {
      events.push('insert');
      throw insertError;
    });

    await expect(withCapturePresentation(captureAdapter, async () => 'image')).rejects.toBe(insertError);
    expect(events).toEqual(['insert']);
  });

  it('preserves both errors if capture and restoration fail', async () => {
    const captureAdapter = adapter([]);
    const captureError = new Error('capture failed');
    const restoreError = new Error('restore failed');
    captureAdapter.remove = vi.fn(async () => { throw restoreError; });

    const failure = await withCapturePresentation(captureAdapter, async () => {
      throw captureError;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([captureError, restoreError]);
  });
});

describe('CAPTURE_PRESENTATION_CSS', () => {
  it('hides Howbeam interaction hosts without changing page layout', () => {
    expect(CAPTURE_PRESENTATION_CSS).toContain('[data-howbeam-snapshot-shield]');
    expect(CAPTURE_PRESENTATION_CSS).toContain('[data-howbeam-step-preview]');
    expect(CAPTURE_PRESENTATION_CSS).toContain('[data-howbeam-region-capture]');
    expect(CAPTURE_PRESENTATION_CSS).toContain('[data-howbeam-recording-toolbar]');
    expect(CAPTURE_PRESENTATION_CSS).toContain('opacity: 0 !important');
  });

  it('keeps the hidden hosts hit-testable so input aimed at them never falls through to the page', () => {
    // visibility:hidden would stop hit-testing: a toolbar press during a
    // capture would land on (and be recorded against) the page underneath.
    expect(CAPTURE_PRESENTATION_CSS).not.toMatch(/visibility\s*:\s*hidden\s*!important/);
    expect(CAPTURE_PRESENTATION_CSS).not.toMatch(/pointer-events\s*:\s*none/);
  });

  it('only makes root scrollbar paint transparent without changing layout properties', () => {
    expect(CAPTURE_PRESENTATION_CSS).toContain(':root::-webkit-scrollbar-thumb');
    expect(CAPTURE_PRESENTATION_CSS).toContain('body::-webkit-scrollbar-track');
    expect(CAPTURE_PRESENTATION_CSS).toContain('scrollbar-color: transparent transparent');
    expect(CAPTURE_PRESENTATION_CSS).toContain('scrollbar-color: auto');
    expect(CAPTURE_PRESENTATION_CSS).toContain('scrollbar-color: auto !important');
    expect(CAPTURE_PRESENTATION_CSS).not.toMatch(/body\s*\{[^}]*scrollbar-color:\s*transparent/s);
    expect(CAPTURE_PRESENTATION_CSS).toContain(':root > :not(body)');
    expect(CAPTURE_PRESENTATION_CSS).toContain('body *');
    expect(CAPTURE_PRESENTATION_CSS).not.toMatch(/overflow|scrollbar-width|\bwidth\s*:|display\s*:/);
    expect(CAPTURE_PRESENTATION_CSS).not.toMatch(/(^|,)\s*\*\s*(,|\{)/m);
  });
});
