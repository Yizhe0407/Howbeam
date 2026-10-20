import type { Bounds } from '../storage/models';
import {
  BADGE_RADIUS,
  CALLOUT_SPACING,
  MARKER_RADIUS,
  type Annotation,
  type AnnotationLayout,
  type AnnotationPoint,
} from './annotation-contract';
import {
  adaptiveSidePaddings,
  coincident,
  fitBoundsInViewport,
  fitHighlightFrame,
  fitPointInViewport,
  forEachNearbyPair,
  inflateBoundsPerSide,
  pointBounds,
  unionBounds,
} from './annotation-geometry';
import {
  badgeOverlaps,
  BoundsSpatialIndex,
  pickPerimeterBadge,
  placeGroupCallouts,
  placeOrderedSlots,
  PointSpatialIndex,
} from './annotation-callouts';

const CALLOUT_GAP = 14;
const ANCHOR_TIE_EPSILON = 8;
const LANE_NUDGE_ATTEMPTS = 3;

/** Coordinates grouping, collision-safe frames and callout placement. Geometry
 * and spatial-index primitives live in dedicated modules so preview/export
 * layout callers retain this stable public facade. */

export function layoutAnnotations(
  annotations: Annotation[],
  viewportWidth: number,
  viewportHeight: number,
): AnnotationLayout[] {
  return layoutWithProvisional(annotations, viewportWidth, viewportHeight, null).layouts;
}

/**
 * Same layout, plus one not-yet-committed target (the hover preview). It is
 * framed and padded as a single and every badge dodges it, exactly as if it
 * were committed — but it never joins a group and gets no badge, so hovering
 * cannot flip a committed target into a marker. `provisionalFrame` is the
 * frame it will have once committed.
 */
export function layoutWithProvisional(
  annotations: Annotation[],
  viewportWidth: number,
  viewportHeight: number,
  provisional: Bounds | null,
): { layouts: AnnotationLayout[]; provisionalFrame: Bounds | null } {
  const count = annotations.length;
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const join = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  const rawBounds = annotations.map((annotation) => annotation.bounds);
  const representativeByBounds = new Map<string, number>();
  const representatives: number[] = [];
  for (let index = 0; index < rawBounds.length; index++) {
    const rect = rawBounds[index];
    const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    const representative = representativeByBounds.get(key);
    if (representative === undefined) {
      representativeByBounds.set(key, index);
      representatives.push(index);
    } else {
      join(representative, index);
    }
  }
  const representativeBounds = representatives.map((index) => rawBounds[index]);
  forEachNearbyPair(representativeBounds, 0, (a, b) => {
    if (coincident(representativeBounds[a], representativeBounds[b])) join(representatives[a], representatives[b]);
  });

  const grouped = new Map<number, number[]>();
  for (let index = 0; index < count; index++) {
    const root = find(index);
    (grouped.get(root) ?? grouped.set(root, []).get(root)!).push(index);
  }

  // Stable ordering keeps the output deterministic for identical input.
  const singles: number[] = [];
  const groups: number[][] = [];
  for (const indexes of grouped.values()) {
    if (indexes.length === 1) singles.push(indexes[0]);
    else groups.push(indexes.slice().sort((a, b) => a - b));
  }
  singles.sort((a, b) => a - b);
  groups.sort((a, b) => a[0] - b[0]);

  // Anchors are read O(n log n) times by the lane sorts and slot maps below;
  // compute each once up front instead of re-deriving inside comparators.
  const anchors: AnnotationPoint[] = annotations.map(({ bounds }) =>
    fitPointInViewport(
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      MARKER_RADIUS,
      viewportWidth,
      viewportHeight,
    ),
  );

  // Geometry that will actually be drawn, known before any badge is placed so
  // every badge can be tested against all of it. Padding is adaptive per side
  // (see adaptiveSidePaddings) so two frames for near-but-non-overlapping
  // targets never visually collide; the obstacle index and perimeter-badge
  // picker below both build on these final frames.
  const singleRawBounds = singles.map((index) => annotations[index].bounds);
  if (provisional) singleRawBounds.push(provisional);
  const singlePaddings = adaptiveSidePaddings(singleRawBounds);
  const singleFrames = singleRawBounds.map((bounds, position) =>
    fitBoundsInViewport(
      inflateBoundsPerSide(bounds, singlePaddings[position]),
      viewportWidth,
      viewportHeight,
    ),
  );
  const groupMembers = groups.flat();
  const markerRectOf = (index: number): Bounds => pointBounds(anchors[index], MARKER_RADIUS);
  const markerRects = new Map(groupMembers.map((index) => [index, markerRectOf(index)]));
  // A group's markers substantially overlap by definition. One union obstacle
  // prevents thousands of coincident marker rectangles from turning every
  // nearby badge query into a linear scan.
  const groupMarkerObstacles = groups.map((group) => unionBounds(group.map((index) => markerRects.get(index)!)));

  const badgeIndex = new PointSpatialIndex();
  const obstacleIndex = new BoundsSpatialIndex(viewportWidth, viewportHeight);
  for (const frame of singleFrames) obstacleIndex.add(frame);
  for (const marker of groupMarkerObstacles) obstacleIndex.add(marker);
  const layouts: AnnotationLayout[] = [];

  /**
   * Lane members sorted by their anchor coordinate along the lane axis — the
   * one-sided boundary-labeling invariant that makes straight leaders to
   * sorted slots crossing-free. Runs of anchors closer than ANCHOR_TIE_EPSILON
   * read as one cluster, so within a run the step numbers win: the lane then
   * shows 1,2,3… instead of an order dictated by sub-pixel anchor jitter.
   */
  const sortAlongLane = (group: number[], coordinate: (index: number) => number): number[] => {
    const byCoordinate = group
      .slice()
      .sort((a, b) => coordinate(a) - coordinate(b) || annotations[a].order - annotations[b].order);
    const ordered: number[] = [];
    let run: number[] = [];
    const flushRun = () => {
      run.sort((a, b) => annotations[a].order - annotations[b].order);
      ordered.push(...run);
      run = [];
    };
    for (const index of byCoordinate) {
      if (run.length > 0 && coordinate(index) - coordinate(run[run.length - 1]) > ANCHOR_TIE_EPSILON) flushRun();
      run.push(index);
    }
    flushRun();
    return ordered;
  };

  // Groups first, so a single's perimeter badge can dodge the lane badges.
  groups.forEach((group, groupPosition) => {
    const ownMarkers = new Set([groupMarkerObstacles[groupPosition]]);
    const groupBounds = unionBounds(group.map((index) => annotations[index].bounds));
    const anchorXs = group.map((index) => anchors[index].x);
    const anchorYs = group.map((index) => anchors[index].y);
    const spreadX = Math.max(...anchorXs) - Math.min(...anchorXs);
    const spreadY = Math.max(...anchorYs) - Math.min(...anchorYs);

    // The lane runs along the axis the anchors spread on: a row of targets
    // gets its badges above/below sorted by x, a column (or a point cluster)
    // gets a side lane sorted by y. A lane on the wrong axis degenerates into
    // a lattice of near-parallel leaders.
    const laneIsVertical = spreadY >= spreadX;
    const laneExtent = laneIsVertical ? viewportHeight : viewportWidth;
    const laneCapacity =
      laneExtent > BADGE_RADIUS * 2 ? Math.floor((laneExtent - BADGE_RADIUS * 2) / CALLOUT_SPACING) + 1 : 0;

    let slots: AnnotationPoint[];
    let ordered: number[];
    if (group.length <= laneCapacity) {
      ordered = sortAlongLane(group, (index) => (laneIsVertical ? anchors[index].y : anchors[index].x));
      const alongLane = ordered.map((index) => (laneIsVertical ? anchors[index].y : anchors[index].x));
      const slotCoordinates = placeOrderedSlots(alongLane, CALLOUT_SPACING, BADGE_RADIUS, laneExtent - BADGE_RADIUS);

      // The lane's cross-axis position: just outside the cluster on whichever
      // side has more room. If badges or frames placed earlier already occupy
      // it, the whole lane nudges further out — as a block, so the sorted slot
      // order (and with it crossing-freeness) survives.
      const crossExtent = laneIsVertical ? viewportWidth : viewportHeight;
      const clusterStart = laneIsVertical ? groupBounds.x : groupBounds.y;
      const clusterEnd = laneIsVertical
        ? groupBounds.x + groupBounds.width
        : groupBounds.y + groupBounds.height;
      const laneOutward = crossExtent - clusterEnd >= clusterStart;
      const laneBase = laneOutward
        ? Math.min(crossExtent - BADGE_RADIUS, clusterEnd + CALLOUT_GAP + BADGE_RADIUS)
        : Math.max(BADGE_RADIUS, clusterStart - CALLOUT_GAP - BADGE_RADIUS);
      const toPoints = (cross: number) =>
        slotCoordinates.map((coordinate) =>
          laneIsVertical ? { x: cross, y: coordinate } : { x: coordinate, y: cross },
        );
      const collisions = (points: AnnotationPoint[]) =>
        points.reduce(
          (sum, point) => sum + (badgeOverlaps(point, badgeIndex, obstacleIndex, ownMarkers) ? 1 : 0),
          0,
        );
      slots = toPoints(laneBase);
      let bestCollisions = collisions(slots);
      for (let attempt = 1; attempt <= LANE_NUDGE_ATTEMPTS && bestCollisions > 0; attempt++) {
        const nudged = laneBase + attempt * CALLOUT_SPACING * (laneOutward ? 1 : -1);
        if (nudged < BADGE_RADIUS || nudged > crossExtent - BADGE_RADIUS) break;
        const candidate = toPoints(nudged);
        const candidateCollisions = collisions(candidate);
        if (candidateCollisions < bestCollisions) {
          slots = candidate;
          bestCollisions = candidateCollisions;
        }
        if (candidateCollisions === 0) break;
      }
      for (const slot of slots) badgeIndex.add(slot);
    } else {
      // More badges than one lane can hold: fall back to the deterministic
      // multi-column side grid. Order along each column still follows the
      // anchor sort, which keeps the common case of a huge duplicate stack
      // readable even though cross-column leaders may touch.
      ordered = sortAlongLane(group, (index) => anchors[index].y);
      const leftSpace = groupBounds.x;
      const rightSpace = viewportWidth - (groupBounds.x + groupBounds.width);
      const laneOnRight = rightSpace >= leftSpace;
      const laneX = laneOnRight
        ? Math.min(viewportWidth - BADGE_RADIUS, groupBounds.x + groupBounds.width + CALLOUT_GAP + BADGE_RADIUS)
        : Math.max(BADGE_RADIUS, groupBounds.x - CALLOUT_GAP - BADGE_RADIUS);
      const startY = Math.max(
        BADGE_RADIUS,
        Math.min(groupBounds.y + BADGE_RADIUS, viewportHeight - BADGE_RADIUS - CALLOUT_SPACING * (ordered.length - 1)),
      );
      slots = placeGroupCallouts(
        ordered.length,
        laneX,
        startY,
        laneOnRight,
        obstacleIndex,
        badgeIndex,
        ownMarkers,
        viewportWidth,
        viewportHeight,
      );
    }

    ordered.forEach((index, position) => {
      const anchor = anchors[index];
      const badge = slots[position];
      const dx = badge.x - anchor.x;
      const dy = badge.y - anchor.y;
      const length = Math.hypot(dx, dy) || 1;
      const start = { x: anchor.x + (dx / length) * MARKER_RADIUS, y: anchor.y + (dy / length) * MARKER_RADIUS };
      const end = { x: badge.x - (dx / length) * BADGE_RADIUS, y: badge.y - (dy / length) * BADGE_RADIUS };
      layouts.push({
        order: annotations[index].order,
        frame: fitHighlightFrame(annotations[index].bounds, viewportWidth, viewportHeight),
        anchor,
        markerOnly: true,
        badgeAnchor: badge,
        callout: badge,
        leader: length > MARKER_RADIUS + BADGE_RADIUS ? [start, end] : [],
      });
    });
  });

  singles.forEach((index, position) => {
    const frame = singleFrames[position];
    const badgeAnchor = pickPerimeterBadge(frame, obstacleIndex, badgeIndex, viewportWidth, viewportHeight);
    badgeIndex.add(badgeAnchor);
    layouts.push({
      order: annotations[index].order,
      frame,
      anchor: anchors[index],
      markerOnly: false,
      badgeAnchor,
      callout: null,
      leader: [],
    });
  });

  return {
    layouts: layouts.sort((a, b) => a.order - b.order),
    provisionalFrame: provisional ? singleFrames[singles.length] : null,
  };
}
