import type { Bounds } from '../storage/models';
import { BADGE_RADIUS, CALLOUT_SPACING, type AnnotationPoint } from './annotation-contract';
import { distanceToBounds, fitPointInViewport } from './annotation-geometry';

const BADGE_CLEARANCE = 4;

export function placeOrderedSlots(targets: number[], spacing: number, lo: number, hi: number): number[] {
  const shifted = targets.map((value, index) => value - index * spacing);
  const pools: { sum: number; weight: number; mean: number }[] = [];
  for (const value of shifted) {
    let sum = value;
    let weight = 1;
    for (let previous = pools.at(-1); previous && previous.mean >= sum / weight; previous = pools.at(-1)) {
      pools.pop();
      sum += previous.sum;
      weight += previous.weight;
    }
    pools.push({ sum, weight, mean: sum / weight });
  }
  const slots: number[] = [];
  for (const pool of pools) {
    for (let member = 0; member < pool.weight; member++) slots.push(pool.mean + slots.length * spacing);
  }

  const min = slots[0];
  const max = slots.at(-1);
  if (min === undefined || max === undefined) return [];
  const room = hi - lo;
  if (room <= 0) return slots.map(() => (lo + hi) / 2);
  const span = max - min;
  if (span > room) return slots.map((value) => lo + ((value - min) / span) * room);
  const shift = min < lo ? lo - min : max > hi ? hi - max : 0;
  return slots.map((value) => value + shift);
}

function perimeterCandidates(frame: Bounds): [AnnotationPoint, ...AnnotationPoint[]] {
  const { x, y, width: w, height: h } = frame;
  return [
    { x: x + w, y }, { x: x + w, y: y + h / 2 }, { x, y: y + h / 2 }, { x, y },
    { x: x + w, y: y + h }, { x, y: y + h }, { x: x + w / 2, y }, { x: x + w / 2, y: y + h },
  ];
}

function fitsInViewport(point: AnnotationPoint, viewportWidth: number, viewportHeight: number): boolean {
  return point.x - BADGE_RADIUS >= 0 && point.x + BADGE_RADIUS <= viewportWidth && point.y - BADGE_RADIUS >= 0 && point.y + BADGE_RADIUS <= viewportHeight;
}

function clampToViewport(point: AnnotationPoint, viewportWidth: number, viewportHeight: number): AnnotationPoint {
  return fitPointInViewport(point, BADGE_RADIUS, viewportWidth, viewportHeight);
}

export class BoundsSpatialIndex {
  private readonly cells = new Map<string, Bounds[]>();
  private readonly oversized = new Set<Bounds>();
  private readonly columns: number;
  private readonly rows: number;
  private static readonly MAX_CELLS_PER_RECT = 256;

  constructor(private readonly width: number, private readonly height: number, private readonly cellSize = 64) {
    this.columns = Math.max(1, Math.ceil(Math.max(width, 0) / cellSize));
    this.rows = Math.max(1, Math.ceil(Math.max(height, 0) / cellSize));
  }

  add(rect: Bounds): void {
    const left = Math.max(0, rect.x);
    const top = Math.max(0, rect.y);
    const right = Math.min(this.width, rect.x + rect.width);
    const bottom = Math.min(this.height, rect.y + rect.height);
    if (right < left || bottom < top) return;
    const minColumn = this.cell(left, this.columns);
    const maxColumn = this.cell(right, this.columns);
    const minRow = this.cell(top, this.rows);
    const maxRow = this.cell(bottom, this.rows);
    const coveredCells = (maxColumn - minColumn + 1) * (maxRow - minRow + 1);
    if (coveredCells > BoundsSpatialIndex.MAX_CELLS_PER_RECT) { this.oversized.add(rect); return; }
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const key = `${column}:${row}`;
        const entries = this.cells.get(key);
        if (entries) entries.push(rect);
        else this.cells.set(key, [rect]);
      }
    }
  }

  near(point: AnnotationPoint, radius: number): Bounds[] {
    const minColumn = this.cell(point.x - radius, this.columns);
    const maxColumn = this.cell(point.x + radius, this.columns);
    const minRow = this.cell(point.y - radius, this.rows);
    const maxRow = this.cell(point.y + radius, this.rows);
    const matches = new Set<Bounds>();
    for (const rect of this.oversized) {
      if (rect.x <= point.x + radius && rect.x + rect.width >= point.x - radius && rect.y <= point.y + radius && rect.y + rect.height >= point.y - radius) matches.add(rect);
    }
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        for (const rect of this.cells.get(`${column}:${row}`) ?? []) matches.add(rect);
      }
    }
    return [...matches];
  }

  private cell(value: number, count: number): number { return Math.max(0, Math.min(count - 1, Math.floor(value / this.cellSize))); }
}

export class PointSpatialIndex {
  private readonly cells = new Map<string, AnnotationPoint[]>();
  constructor(private readonly cellSize = BADGE_RADIUS * 2 + BADGE_CLEARANCE) {}
  add(point: AnnotationPoint): void {
    const key = this.key(point.x, point.y);
    const entries = this.cells.get(key);
    if (entries) entries.push(point); else this.cells.set(key, [point]);
  }
  near(point: AnnotationPoint, radius: number): AnnotationPoint[] {
    const minX = Math.floor((point.x - radius) / this.cellSize);
    const maxX = Math.floor((point.x + radius) / this.cellSize);
    const minY = Math.floor((point.y - radius) / this.cellSize);
    const maxY = Math.floor((point.y + radius) / this.cellSize);
    const matches: AnnotationPoint[] = [];
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) matches.push(...(this.cells.get(`${x}:${y}`) ?? []));
    return matches;
  }
  private key(x: number, y: number): string { return `${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`; }
}

export function badgeOverlaps(point: AnnotationPoint, badges: PointSpatialIndex, rects: BoundsSpatialIndex, ignoredRects?: Set<Bounds>): boolean {
  const badgeDistance = BADGE_RADIUS * 2 + BADGE_CLEARANCE;
  if (badges.near(point, badgeDistance).some((badge) => Math.hypot(point.x - badge.x, point.y - badge.y) < badgeDistance)) return true;
  const rectDistance = BADGE_RADIUS + BADGE_CLEARANCE;
  return rects.near(point, rectDistance).some((rect) => !ignoredRects?.has(rect) && distanceToBounds(point, rect) < rectDistance);
}

function calloutAxes(preferredX: number, preferredStartY: number, count: number, viewportWidth: number, viewportHeight: number, laneOnRight: boolean): { xs: number[]; ys: number[] } {
  const clamped = clampToViewport({ x: preferredX, y: preferredStartY }, viewportWidth, viewportHeight);
  if (viewportWidth <= BADGE_RADIUS * 2 || viewportHeight <= BADGE_RADIUS * 2) return { xs: [clamped.x], ys: [clamped.y] };
  const minX = BADGE_RADIUS;
  const maxX = viewportWidth - BADGE_RADIUS;
  const xs = [clamped.x];
  const preferredDirection = laneOnRight ? 1 : -1;
  for (let distance = CALLOUT_SPACING; distance <= viewportWidth + CALLOUT_SPACING; distance += CALLOUT_SPACING) { const x = clamped.x + distance * preferredDirection; if (x >= minX && x <= maxX) xs.push(x); }
  for (let distance = CALLOUT_SPACING; distance <= viewportWidth + CALLOUT_SPACING; distance += CALLOUT_SPACING) { const x = clamped.x - distance * preferredDirection; if (x >= minX && x <= maxX) xs.push(x); }
  const minY = BADGE_RADIUS;
  const maxY = viewportHeight - BADGE_RADIUS;
  const rowCapacity = Math.floor((maxY - minY) / CALLOUT_SPACING) + 1;
  const startY = count > rowCapacity ? minY : clamped.y;
  const ys: number[] = [];
  for (let y = startY; y <= maxY; y += CALLOUT_SPACING) ys.push(y);
  for (let y = startY - CALLOUT_SPACING; y >= minY; y -= CALLOUT_SPACING) ys.push(y);
  return { xs, ys };
}

export function placeGroupCallouts(count: number, preferredX: number, preferredStartY: number, laneOnRight: boolean, obstacleRects: BoundsSpatialIndex, placedBadges: PointSpatialIndex, ignoredRects: Set<Bounds>, viewportWidth: number, viewportHeight: number): AnnotationPoint[] {
  const { xs, ys } = calloutAxes(preferredX, preferredStartY, count, viewportWidth, viewportHeight, laneOnRight);
  const candidateCount = xs.length * ys.length;
  const candidateAt = (index: number): AnnotationPoint | undefined => {
    if (index < 0 || index >= candidateCount || ys.length === 0) return undefined;
    const x = xs[Math.floor(index / ys.length)];
    const y = ys[index % ys.length];
    return x === undefined || y === undefined ? undefined : { x, y };
  };
  const slots: AnnotationPoint[] = [];
  let candidateIndex = 0;
  for (let position = 0; position < count; position++) {
    let candidate = candidateAt(candidateIndex);
    while (candidate && badgeOverlaps(candidate, placedBadges, obstacleRects, ignoredRects)) { candidateIndex++; candidate = candidateAt(candidateIndex); }
    const slot = candidate ?? candidateAt(candidateCount > 0 ? position % candidateCount : -1) ?? { x: 0, y: 0 };
    if (candidate) candidateIndex++;
    slots.push(slot);
    placedBadges.add(slot);
  }
  return slots;
}

export function pickPerimeterBadge(frame: Bounds, obstacleRects: BoundsSpatialIndex, placedBadges: PointSpatialIndex, viewportWidth: number, viewportHeight: number): AnnotationPoint {
  const candidates = perimeterCandidates(frame).filter((point) => fitsInViewport(point, viewportWidth, viewportHeight));
  const ignored = new Set([frame]);
  for (const point of candidates) if (!badgeOverlaps(point, placedBadges, obstacleRects, ignored)) return point;
  return clampToViewport(perimeterCandidates(frame)[0], viewportWidth, viewportHeight);
}
