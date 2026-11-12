export type BenchmarkMode = 'activation' | 'annotation';

export interface TargetAccuracyCase {
  id: string;
  category: string;
  mode: BenchmarkMode;
  pointKey: string;
  exactKey: string;
  acceptedKeys?: string[];
  pointRatio?: { x: number; y: number };
  minimumIoU?: number;
}

export interface ReplayCase {
  id: string;
  category: string;
  targetKey?: string;
  expectedKey?: string;
  frameSelector?: '#same-origin-frame' | '#cross-origin-frame';
  targetSelector?: string;
  expectedSelector?: string;
  eventKey: string;
  forbiddenEventKeys?: string[];
  minimumIoU?: number;
}

export const ACTIVATION_CASES: TargetAccuracyCase[] = [
  {
    id: 'primary-button-from-label',
    category: 'native-control',
    mode: 'activation',
    pointKey: 'primary-button-label',
    exactKey: 'primary-button',
  },
  {
    id: 'primary-button-from-svg',
    category: 'native-control',
    mode: 'activation',
    pointKey: 'primary-button-icon',
    exactKey: 'primary-button',
  },
  {
    id: 'icon-toolbar-from-svg',
    category: 'native-control',
    mode: 'activation',
    pointKey: 'toolbar-icon-glyph',
    exactKey: 'toolbar-icon-button',
  },
  {
    id: 'navigation-from-badge',
    category: 'native-control',
    mode: 'activation',
    pointKey: 'nav-link-badge',
    exactKey: 'nav-link',
  },
  {
    id: 'menu-item-from-shortcut',
    category: 'native-control',
    mode: 'activation',
    pointKey: 'menu-item-shortcut',
    exactKey: 'menu-item',
  },
  {
    id: 'aria-button-from-label',
    category: 'aria-semantic',
    mode: 'activation',
    pointKey: 'custom-role-label',
    exactKey: 'custom-role-button',
  },
  {
    id: 'delegated-card-from-copy',
    category: 'delegated-listener',
    mode: 'activation',
    pointKey: 'delegated-card-copy',
    exactKey: 'delegated-card',
  },
  { id: 'email-input', category: 'form-control', mode: 'activation', pointKey: 'email-input', exactKey: 'email-input' },
  {
    id: 'select-control',
    category: 'form-control',
    mode: 'activation',
    pointKey: 'workspace-select',
    exactKey: 'workspace-select',
  },
  {
    id: 'checkbox-from-copy',
    category: 'form-control',
    mode: 'activation',
    pointKey: 'checkbox-copy',
    exactKey: 'checkbox-label',
    acceptedKeys: ['checkbox-input'],
  },
  {
    id: 'tab-from-label',
    category: 'aria-semantic',
    mode: 'activation',
    pointKey: 'tab-label',
    exactKey: 'tab-button',
  },
  {
    id: 'switch-from-knob',
    category: 'aria-semantic',
    mode: 'activation',
    pointKey: 'switch-knob',
    exactKey: 'switch-control',
  },
  {
    id: 'toast-dismiss-from-glyph',
    category: 'native-control',
    mode: 'activation',
    pointKey: 'toast-close-glyph',
    exactKey: 'toast-close',
  },
  {
    id: 'details-summary-from-label',
    category: 'native-control',
    mode: 'activation',
    pointKey: 'details-summary-label',
    exactKey: 'details-summary',
  },
  {
    id: 'contenteditable-from-copy',
    category: 'aria-semantic',
    mode: 'activation',
    pointKey: 'editable-copy',
    exactKey: 'editable-surface',
  },
  {
    id: 'transparent-activation-overlay',
    category: 'occlusion',
    mode: 'activation',
    pointKey: 'activation-underlay-button',
    exactKey: 'activation-overlay',
  },
  {
    id: 'dense-toolbar-neighbor',
    category: 'dense-layout',
    mode: 'activation',
    pointKey: 'dense-target-glyph',
    exactKey: 'dense-target',
  },
  {
    id: 'scaled-button',
    category: 'transform',
    mode: 'activation',
    pointKey: 'scaled-label',
    exactKey: 'scaled-button',
    minimumIoU: 0.9,
  },
  {
    id: 'rotated-button',
    category: 'transform',
    mode: 'activation',
    pointKey: 'rotated-label',
    exactKey: 'rotated-button',
    minimumIoU: 0.9,
  },
  {
    id: 'clipped-control',
    category: 'clipping',
    mode: 'activation',
    pointKey: 'clipped-visible-target',
    exactKey: 'clipped-visible-target',
    minimumIoU: 0.9,
  },
  {
    id: 'wrapped-inline-fragment',
    category: 'inline-fragment',
    mode: 'activation',
    pointKey: 'wrapped-link-line',
    exactKey: 'wrapped-link-line',
    minimumIoU: 0.9,
  },
  {
    id: 'standalone-svg',
    category: 'rendering-surface',
    mode: 'activation',
    pointKey: 'svg-control-dot',
    exactKey: 'svg-control',
  },
  {
    id: 'canvas-surface',
    category: 'rendering-surface',
    mode: 'activation',
    pointKey: 'canvas-control',
    exactKey: 'canvas-control',
  },
  {
    id: 'image-map-area',
    category: 'image-map',
    mode: 'activation',
    pointKey: 'map-area-region',
    exactKey: 'map-area-region',
    minimumIoU: 0.9,
  },
  {
    id: 'open-shadow-control',
    category: 'shadow-dom',
    mode: 'activation',
    pointKey: 'open-shadow-icon',
    exactKey: 'open-shadow-button',
  },
  {
    id: 'closed-shadow-control',
    category: 'shadow-dom',
    mode: 'activation',
    pointKey: 'closed-shadow-icon',
    exactKey: 'closed-shadow-button',
  },
];

export const ANNOTATION_CASES: TargetAccuracyCase[] = [
  {
    id: 'pierces-paintless-shim',
    category: 'occlusion',
    mode: 'annotation',
    pointKey: 'annotation-blank-button',
    exactKey: 'annotation-blank-button',
  },
  {
    id: 'keeps-semantic-shim',
    category: 'occlusion',
    mode: 'annotation',
    pointKey: 'annotation-semantic-button',
    exactKey: 'annotation-semantic-shim',
  },
  {
    id: 'keeps-painted-overlay',
    category: 'occlusion',
    mode: 'annotation',
    pointKey: 'annotation-painted-button',
    exactKey: 'annotation-painted-overlay',
  },
  {
    id: 'keeps-border-overlay',
    category: 'occlusion',
    mode: 'annotation',
    pointKey: 'annotation-border-button',
    exactKey: 'annotation-border-overlay',
  },
  {
    id: 'keeps-generated-paint',
    category: 'pseudo-paint',
    mode: 'annotation',
    pointKey: 'annotation-pseudo-button',
    exactKey: 'annotation-pseudo-host',
    minimumIoU: 0.9,
  },
  {
    id: 'keeps-painted-descendant',
    category: 'descendant-paint',
    mode: 'annotation',
    pointKey: 'annotation-descendant-button',
    exactKey: 'annotation-descendant-overlay',
  },
  {
    id: 'pierces-clickable-transparent-overlay',
    category: 'occlusion',
    mode: 'annotation',
    pointKey: 'annotation-clickable-button',
    exactKey: 'annotation-clickable-button',
  },
  {
    id: 'ordinary-annotation-control',
    category: 'native-control',
    mode: 'annotation',
    pointKey: 'annotation-plain-button',
    exactKey: 'annotation-plain-button',
  },
];

export const REPLAY_CASES: ReplayCase[] = [
  {
    id: 'primary-button-replay',
    category: 'native-control',
    targetKey: 'primary-button-label',
    expectedKey: 'primary-button',
    eventKey: 'primary-button',
  },
  {
    id: 'delegated-card-replay',
    category: 'delegated-listener',
    targetKey: 'delegated-card-copy',
    expectedKey: 'delegated-card',
    eventKey: 'delegated-card',
  },
  {
    id: 'transparent-overlay-replay',
    category: 'occlusion',
    targetKey: 'activation-underlay-button',
    expectedKey: 'activation-overlay',
    eventKey: 'activation-overlay',
    forbiddenEventKeys: ['activation-underlay-button'],
  },
  {
    id: 'image-map-replay',
    category: 'image-map',
    targetKey: 'map-area-region',
    expectedKey: 'map-area-region',
    eventKey: 'map-area',
    minimumIoU: 0.9,
  },
  {
    id: 'open-shadow-replay',
    category: 'shadow-dom',
    targetKey: 'open-shadow-icon',
    expectedKey: 'open-shadow-button',
    eventKey: 'open-shadow-button',
  },
  {
    id: 'closed-shadow-replay',
    category: 'shadow-dom',
    targetKey: 'closed-shadow-icon',
    expectedKey: 'closed-shadow-button',
    eventKey: 'closed-shadow-button',
  },
  {
    id: 'same-origin-frame-replay',
    category: 'iframe',
    frameSelector: '#same-origin-frame',
    targetSelector: '#frame-action-label',
    expectedSelector: '#frame-action',
    eventKey: 'frame-action',
    minimumIoU: 0.9,
  },
  {
    id: 'cross-origin-frame-replay',
    category: 'iframe',
    frameSelector: '#cross-origin-frame',
    targetSelector: '#frame-action-label',
    expectedSelector: '#frame-action',
    eventKey: 'frame-action',
    minimumIoU: 0.9,
  },
];
