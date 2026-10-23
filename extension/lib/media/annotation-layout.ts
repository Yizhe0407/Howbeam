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
  coincident,
  fitBoundsInViewport,
  fitHighlightFrame,
  fitPointInViewport,
  forEachNearbyPair,
  padApart,
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

interface Item {
  annotation: Annotation;
  anchor: AnnotationPoint;
  /** Union-find link; a group's root has none. */
  parent?: Item;
}

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
  // Anchors are read O(n log n) times by the lane sorts and slot maps below;
  // compute each once up front instead of re-deriving inside comparators.
  const items: Item[] = annotations.map((annotation) => ({
    annotation,
    anchor: fitPointInViewport(
      {
        x: annotation.bounds.x + annotation.bounds.width / 2,
        y: annotation.bounds.y + annotation.bounds.height / 2,
      },
      MARKER_RADIUS,
      viewportWidth,
      viewportHeight,
    ),
  }));
  const find = (item: Item): Item => {
    while (item.parent) {
      if (item.parent.parent) item.parent = item.parent.parent;
      item = item.parent;
    }
    return item;
  };
  const join = (a: Item, b: Item) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) rootB.parent = rootA;
  };

  const representativeByBounds = new Map<string, Item>();
  const representatives: Item[] = [];
  for (const item of items) {
    const rect = item.annotation.bounds;
    const key = `${rect.x}:${rect.y}:${rect.width}:${rect.height}`;
    const representative = representativeByBounds.get(key);
    if (representative === undefined) {
      representativeByBounds.set(key, item);
      representatives.push(item);
    } else {
      join(representative, item);
    }
  }
  forEachNearbyPair(representatives, (item) => item.annotation.bounds, 0, (a, b) => {
    if (coincident(a.annotation.bounds, b.annotation.bounds)) join(a, b);
  });

  // Map order follows each group's first member, so singles and groups come
  // out in input order and the output stays deterministic.
  const grouped = new Map<Item, Item[]>();
  for (const item of items) {
    const root = find(item);
    const members = grouped.get(root);
    if (members) members.push(item);
    else grouped.set(root, [item]);
  }
  const singles: Item[] = [];
  const groups: Item[][] = [];
  for (const members of grouped.values()) {
    if (members.length === 1) singles.push(...members);
    else groups.push(members);
  }

  // Geometry that will actually be drawn, known before any badge is placed so
  // every badge can be tested against all of it. Padding is adaptive per side
  // (see padApart) so two frames for near-but-non-overlapping targets never
  // visually collide; the obstacle index and perimeter-badge picker below both
  // build on these final frames.
  const framed = padApart<{ bounds: Bounds; single: Item | null }>([
    ...singles.map((single) => ({ bounds: single.annotation.bounds, single })),
    ...(provisional ? [{ bounds: provisional, single: null }] : []),
  ]).map((entry) => ({ ...entry, frame: fitBoundsInViewport(entry.frame, viewportWidth, viewportHeight) }));
  // A group's markers substantially overlap by definition. One union obstacle
  // prevents thousands of coincident marker rectangles from turning every
  // nearby badge query into a linear scan.
  const markedGroups = groups.map((members) => ({
    members,
    markers: unionBounds(members.map((member) => pointBounds(member.anchor, MARKER_RADIUS))),
  }));

  const badgeIndex = new PointSpatialIndex();
  const obstacleIndex = new BoundsSpatialIndex(viewportWidth, viewportHeight);
  for (const { frame } of framed) obstacleIndex.add(frame);
  for (const { markers } of markedGroups) obstacleIndex.add(markers);
  const layouts: AnnotationLayout[] = [];

  /**
   * Lane members sorted by their anchor coordinate along the lane axis — the
   * one-sided boundary-labeling invariant that makes straight leaders to
   * sorted slots crossing-free. Runs of anchors closer than ANCHOR_TIE_EPSILON
   * read as one cluster, so within a run the step numbers win: the lane then
   * shows 1,2,3… instead of an order dictated by sub-pixel anchor jitter.
   */
  const sortAlongLane = (group: Item[], coordinate: (item: Item) => number): Item[] => {
    const byCoordinate = group
      .slice()
      .sort((a, b) => coordinate(a) - coordinate(b) || a.annotation.order - b.annotation.order);
    const ordered: Item[] = [];
    let run: Item[] = [];
    const flushRun = () => {
      run.sort((a, b) => a.annotation.order - b.annotation.order);
      ordered.push(...run);
      run = [];
    };
    for (const item of byCoordinate) {
      const last = run.at(-1);
      if (last && coordinate(item) - coordinate(last) > ANCHOR_TIE_EPSILON) flushRun();
      run.push(item);
    }
    flushRun();
    return ordered;
  };

  // Groups first, so a single's perimeter badge can dodge the lane badges.
  for (const { members: group, markers } of markedGroups) {
    const ownMarkers = new Set([markers]);
    const groupBounds = unionBounds(group.map((item) => item.annotation.bounds));
    const anchorXs = group.map((item) => item.anchor.x);
    const anchorYs = group.map((item) => item.anchor.y);
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
    let ordered: Item[];
    if (group.length <= laneCapacity) {
      ordered = sortAlongLane(group, (item) => (laneIsVertical ? item.anchor.y : item.anchor.x));
      const alongLane = ordered.map((item) => (laneIsVertical ? item.anchor.y : item.anchor.x));
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
      ordered = sortAlongLane(group, (item) => item.anchor.y);
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

    ordered.forEach(({ annotation, anchor }, position) => {
      // Both lane placers return one slot per member.
      const badge = slots[position]!;
      const dx = badge.x - anchor.x;
      const dy = badge.y - anchor.y;
      const length = Math.hypot(dx, dy) || 1;
      const start = { x: anchor.x + (dx / length) * MARKER_RADIUS, y: anchor.y + (dy / length) * MARKER_RADIUS };
      const end = { x: badge.x - (dx / length) * BADGE_RADIUS, y: badge.y - (dy / length) * BADGE_RADIUS };
      layouts.push({
        order: annotation.order,
        frame: fitHighlightFrame(annotation.bounds, viewportWidth, viewportHeight),
        anchor,
        markerOnly: true,
        badgeAnchor: badge,
        callout: badge,
        leader: length > MARKER_RADIUS + BADGE_RADIUS ? [start, end] : [],
      });
    });
  }

  for (const { single, frame } of framed) {
    if (!single) continue;
    const badgeAnchor = pickPerimeterBadge(frame, obstacleIndex, badgeIndex, viewportWidth, viewportHeight);
    badgeIndex.add(badgeAnchor);
    layouts.push({
      order: single.annotation.order,
      frame,
      anchor: single.anchor,
      markerOnly: false,
      badgeAnchor,
      callout: null,
      leader: [],
    });
  }

  return {
    layouts: layouts.sort((a, b) => a.order - b.order),
    provisionalFrame: framed.find((entry) => entry.single === null)?.frame ?? null,
  };
}
