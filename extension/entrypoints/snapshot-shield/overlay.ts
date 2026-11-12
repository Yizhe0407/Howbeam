import { snapshotRectKey, type SnapshotShieldSelection } from '@/lib/recording/snapshot-shield-protocol';
import {
  BADGE_RADIUS,
  type AnnotationLayout,
  HIGHLIGHT_LINE_WIDTH,
  HIGHLIGHT_RADIUS,
  LEADER_LINE_WIDTH,
  MARKER_INNER_RADIUS,
  MARKER_RADIUS,
  MARKER_RING_WIDTH,
} from '@/lib/media/annotation-contract';
import { getBadgeFontSize } from '@/lib/media/annotation-geometry';
import { layoutWithProvisional } from '@/lib/media/annotation-layout';
import type { Rect } from '@/lib/shared/geometry';

function placeBox(element: HTMLElement, frame: Rect): void {
  element.style.left = `${frame.x}px`;
  element.style.top = `${frame.y}px`;
  element.style.width = `${frame.width}px`;
  element.style.height = `${frame.height}px`;
}

export interface SnapshotOverlay {
  preview(rect: Rect | null): void;
  /** Draws exactly these marks (a mark's id is its number), keeping the nodes of marks that stay. */
  setMarks(marks: ReadonlyArray<SnapshotShieldSelection & { id: number }>): void;
  relayout(): void;
  /** Flashes a committed annotation. */
  pulse(id: number): void;
}

export function createOverlay(): SnapshotOverlay {
  const root = document.createElement('div');
  root.className = 'snapshot-overlay';
  root.setAttribute('aria-hidden', 'true');

  const committedLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  committedLayer.setAttribute('class', 'snapshot-overlay__committed');
  const leaderLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const targetLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const badgeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  committedLayer.append(leaderLayer, targetLayer, badgeLayer);
  const preview = document.createElement('div');
  preview.className = 'snapshot-box snapshot-box--preview';
  preview.hidden = true;
  root.append(committedLayer, preview);
  document.body.append(root);

  let committedSelections: ReadonlyArray<SnapshotShieldSelection & { id: number }> = [];
  let committedRectKeys = new Set<string>();
  let previewRect: Rect | null = null;

  const svgElement = <K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] =>
    document.createElementNS('http://www.w3.org/2000/svg', name);

  interface AnnotationElements {
    leader: SVGGElement;
    target: SVGGElement;
    badge: SVGGElement;
  }

  const elementsById = new Map<number, AnnotationElements>();
  const setAttribute = (element: Element, name: string, value: string) => {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  };
  const elementsFor = (id: number): AnnotationElements => {
    const existing = elementsById.get(id);
    if (existing) return existing;
    const leader = svgElement('g');
    const target = svgElement('g');
    const badge = svgElement('g');
    for (const element of [leader, target, badge]) {
      element.setAttribute('data-snapshot-selection-id', String(id));
    }
    leaderLayer.append(leader);
    targetLayer.append(target);
    badgeLayer.append(badge);
    const created = { leader, target, badge };
    elementsById.set(id, created);
    return created;
  };

  const reconcileLeader = (group: SVGGElement, points: string | null) => {
    if (!points) {
      if (group.firstChild) group.replaceChildren();
      return;
    }
    let leader = group.firstElementChild as SVGPolylineElement | null;
    if (!leader) {
      leader = svgElement('polyline');
      leader.setAttribute('class', 'snapshot-annotation__leader');
      leader.setAttribute('stroke-width', String(LEADER_LINE_WIDTH));
      group.append(leader);
    }
    setAttribute(leader, 'points', points);
  };

  const reconcileTarget = (group: SVGGElement, layout: AnnotationLayout) => {
    const wantsMarker = layout.markerOnly;
    const hasMarker = group.firstElementChild?.classList.contains('snapshot-annotation__marker') ?? false;
    if (!group.firstElementChild || wantsMarker !== hasMarker) {
      if (wantsMarker) {
        const marker = svgElement('circle');
        marker.setAttribute('class', 'snapshot-annotation__marker');
        marker.setAttribute('r', String(MARKER_RADIUS - MARKER_RING_WIDTH / 2));
        marker.setAttribute('stroke-width', String(MARKER_RING_WIDTH));
        const inner = svgElement('circle');
        inner.setAttribute('class', 'snapshot-annotation__marker-inner');
        inner.setAttribute('r', String(MARKER_INNER_RADIUS));
        group.replaceChildren(marker, inner);
      } else {
        const frame = svgElement('rect');
        frame.setAttribute('class', 'snapshot-annotation__frame');
        frame.setAttribute('rx', String(Math.max(0, HIGHLIGHT_RADIUS - HIGHLIGHT_LINE_WIDTH / 2)));
        frame.setAttribute('stroke-width', String(HIGHLIGHT_LINE_WIDTH));
        group.replaceChildren(frame);
      }
    }

    if (wantsMarker) {
      for (const marker of Array.from(group.children) as SVGCircleElement[]) {
        setAttribute(marker, 'cx', String(layout.anchor.x));
        setAttribute(marker, 'cy', String(layout.anchor.y));
      }
      return;
    }

    const frame = group.firstElementChild!;
    setAttribute(frame, 'x', String(layout.frame.x + HIGHLIGHT_LINE_WIDTH / 2));
    setAttribute(frame, 'y', String(layout.frame.y + HIGHLIGHT_LINE_WIDTH / 2));
    setAttribute(frame, 'width', String(Math.max(0, layout.frame.width - HIGHLIGHT_LINE_WIDTH)));
    setAttribute(frame, 'height', String(Math.max(0, layout.frame.height - HIGHLIGHT_LINE_WIDTH)));
  };

  const reconcileBadge = (group: SVGGElement, point: { x: number; y: number } | null, labelValue: number) => {
    if (!point) {
      if (group.firstChild) group.replaceChildren();
      return;
    }
    let badge = group.children[0] as SVGCircleElement | undefined;
    let label = group.children[1] as SVGTextElement | undefined;
    if (!badge || !label) {
      badge = svgElement('circle');
      badge.setAttribute('class', 'snapshot-annotation__badge');
      badge.setAttribute('r', String(BADGE_RADIUS));
      label = svgElement('text');
      label.setAttribute('class', 'snapshot-annotation__badge-label');
      group.replaceChildren(badge, label);
    }
    setAttribute(badge, 'cx', String(point.x));
    setAttribute(badge, 'cy', String(point.y));
    setAttribute(label, 'x', String(point.x));
    setAttribute(label, 'y', String(point.y));
    setAttribute(label, 'font-size', String(getBadgeFontSize(labelValue)));
    if (label.textContent !== String(labelValue)) label.textContent = String(labelValue);
  };

  const renderCommitted = () => {
    committedLayer.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
    committedLayer.setAttribute('preserveAspectRatio', 'none');
    const pendingRect = previewRect && !isCommittedRect(previewRect) ? previewRect : null;
    const { layouts, provisionalFrame } = layoutWithProvisional(
      committedSelections.map((selection) => ({
        bounds: selection.rect,
        order: selection.id,
      })),
      window.innerWidth,
      window.innerHeight,
      pendingRect,
    );
    preview.hidden = !provisionalFrame;
    if (provisionalFrame) placeBox(preview, provisionalFrame);
    const selectionById = new Map(committedSelections.map((selection) => [selection.id, selection]));

    for (const layout of layouts) {
      const selection = selectionById.get(layout.order)!;
      const elements = elementsFor(selection.id);
      reconcileLeader(
        elements.leader,
        layout.callout && layout.leader.length > 1
          ? layout.leader.map((point) => `${point.x},${point.y}`).join(' ')
          : null,
      );
      reconcileTarget(elements.target, layout);
      reconcileBadge(elements.badge, layout.callout ?? layout.badgeAnchor, selection.label);
    }
  };

  const isCommittedRect = (rect: Rect) => committedRectKeys.has(snapshotRectKey(rect));

  return {
    preview(rect: Rect | null) {
      document.body.classList.toggle('has-preview-target', Boolean(rect));
      if ((rect && previewRect && snapshotRectKey(rect) === snapshotRectKey(previewRect)) || (!rect && !previewRect))
        return;
      previewRect = rect;
      renderCommitted();
    },
    setMarks(marks) {
      const previous = new Map(committedSelections.map((mark) => [mark.id, snapshotRectKey(mark.rect)]));
      committedSelections = marks;
      committedRectKeys = new Set(marks.map((mark) => snapshotRectKey(mark.rect)));
      // A number now naming a different rect (or none) gets fresh nodes; the rest are reused.
      for (const [id, key] of previous) {
        const current = marks[id - 1];
        if (current && snapshotRectKey(current.rect) === key) continue;
        const elements = elementsById.get(id);
        elements?.leader.remove();
        elements?.target.remove();
        elements?.badge.remove();
        elementsById.delete(id);
      }
      renderCommitted();
    },
    relayout() {
      renderCommitted();
    },
    pulse(id) {
      const elements = elementsById.get(id);
      if (!elements) return;
      for (const group of [elements.target, elements.badge]) {
        group.classList.remove('is-pulsing');
        // Reflow so a second click restarts the animation.
        void group.getBoundingClientRect();
        group.classList.add('is-pulsing');
      }
    },
  };
}
