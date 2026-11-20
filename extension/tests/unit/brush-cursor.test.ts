import { describe, expect, it } from 'vitest';
import { brushCursor, MAX_CURSOR_PIXELS } from '@/lib/editor/brush-cursor';

describe('brushCursor', () => {
  it('is a ring centred on the hotspot, falling back to a crosshair', () => {
    const cursor = brushCursor(32, 1)!;
    expect(cursor).toMatch(/^url\("data:image\/svg\+xml,.+"\) 19 19, crosshair$/);
    const svg = decodeURIComponent(cursor.slice('url("data:image/svg+xml,'.length, cursor.indexOf('")')));
    expect(svg).toContain('width="38" height="38"');
    expect(svg).toContain('cx="19" cy="19" r="17"');
  });

  it('gives up when the image would be bigger than browsers show, counting device pixels', () => {
    expect(brushCursor(MAX_CURSOR_PIXELS - 6, 1)).not.toBeNull();
    expect(brushCursor(MAX_CURSOR_PIXELS - 5, 1)).toBeNull();
    expect(brushCursor(60, 2)).toBeNull();
    expect(brushCursor(56, 2)).not.toBeNull();
  });
});
