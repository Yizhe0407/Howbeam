import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex, parseHexInput } from '@/lib/editor/hsv-color';
import { IMAGE_EDIT_PRESET_COLORS } from '@/lib/storage/image-edit-model';

describe('hsv colour', () => {
  it('round-trips every preset and the primaries', () => {
    for (const hex of [...IMAGE_EDIT_PRESET_COLORS, '#ff0000', '#00ff00', '#0000ff', '#808080']) {
      expect(hsvToHex(hexToHsv(hex))).toBe(hex);
    }
  });

  it('reads hue, saturation and value', () => {
    expect(hexToHsv('#00ff00')).toEqual({ h: 120, s: 1, v: 1 });
    expect(hexToHsv('#000000')).toEqual({ h: 0, s: 0, v: 0 });
  });

  it('accepts typed hex with or without # and in short form', () => {
    expect(parseHexInput('FF4747')).toBe('#ff4747');
    expect(parseHexInput(' #abc ')).toBe('#aabbcc');
    expect(parseHexInput('12345')).toBeNull();
    expect(parseHexInput('gggggg')).toBeNull();
  });
});
