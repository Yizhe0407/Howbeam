/** Hue in degrees [0, 360), saturation and value in [0, 1]. */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function hexToHsv(hex: string): Hsv {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: ((h * 60) + 360) % 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const saturation = clamp01(s);
  const value = clamp01(v);
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    const level = value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(level * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

/** `#rrggbb` (lowercase) for a typed `rgb`, `rrggbb`, with or without `#`; null otherwise. */
export function parseHexInput(input: string): string | null {
  const value = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(value)) return `#${value}`;
  if (/^[0-9a-f]{3}$/.test(value)) return `#${[...value].map((digit) => digit + digit).join('')}`;
  return null;
}
