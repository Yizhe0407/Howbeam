(() => {
  const entries = new Map();
  const nodes = new Map();
  const events = Object.create(null);

  const element = (id) => {
    const value = document.getElementById(id);
    if (!value) throw new Error(`Benchmark fixture is missing #${id}`);
    return value;
  };

  const register = (key, value) => {
    entries.set(key, () => value.getBoundingClientRect());
    nodes.set(key, value);
  };
  const registerRect = (key, resolve, value) => {
    entries.set(key, resolve);
    nodes.set(key, value);
  };
  const note = (key) => {
    events[key] = (events[key] || 0) + 1;
  };

  for (const id of [
    'benchmark-idle-target',
    'annotation-blank-button',
    'annotation-blank-shim',
    'annotation-semantic-button',
    'annotation-semantic-shim',
    'annotation-painted-button',
    'annotation-painted-overlay',
    'annotation-border-button',
    'annotation-border-overlay',
    'annotation-pseudo-button',
    'annotation-pseudo-host',
    'annotation-descendant-button',
    'annotation-descendant-overlay',
    'annotation-clickable-button',
    'annotation-clickable-overlay',
    'annotation-plain-button',
    'primary-button',
    'primary-button-icon',
    'primary-button-label',
    'toolbar-icon-button',
    'toolbar-icon-glyph',
    'nav-link',
    'nav-link-label',
    'nav-link-badge',
    'menu-item',
    'menu-item-label',
    'menu-item-shortcut',
    'custom-role-button',
    'custom-role-label',
    'delegated-card',
    'delegated-card-title',
    'delegated-card-copy',
    'email-field-label',
    'email-input',
    'workspace-select',
    'checkbox-label',
    'checkbox-input',
    'checkbox-copy',
    'tab-button',
    'tab-label',
    'switch-control',
    'switch-knob',
    'toast-close',
    'toast-close-glyph',
    'details-summary',
    'details-summary-label',
    'editable-surface',
    'editable-copy',
    'activation-underlay-button',
    'activation-overlay',
    'dense-target',
    'dense-target-glyph',
    'scaled-button',
    'scaled-label',
    'rotated-button',
    'rotated-label',
    'clipped-shell',
    'clipped-target',
    'wrapped-link',
    'svg-control',
    'svg-control-dot',
    'canvas-control',
    'map-image',
    'map-area',
    'open-shadow-host',
    'closed-shadow-host',
  ])
    register(id, element(id));

  const openHost = element('open-shadow-host');
  const openRoot = openHost.attachShadow({ mode: 'open' });
  openRoot.innerHTML =
    '<style>button{display:inline-flex;align-items:center;gap:7px;padding:10px 13px;border:0;border-radius:9px;background:#0f766e;color:white;font:600 14px system-ui;cursor:pointer}svg{width:17px;height:17px}</style><button id="open-shadow-button"><svg id="open-shadow-icon" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="currentColor"/></svg><span id="open-shadow-label">Open shadow</span></button>';
  register('open-shadow-button', openRoot.getElementById('open-shadow-button'));
  register('open-shadow-icon', openRoot.getElementById('open-shadow-icon'));
  register('open-shadow-label', openRoot.getElementById('open-shadow-label'));

  const closedHost = element('closed-shadow-host');
  const closedRoot = closedHost.attachShadow({ mode: 'closed' });
  closedRoot.innerHTML =
    '<style>button{display:inline-flex;align-items:center;gap:7px;margin-top:8px;padding:10px 13px;border:0;border-radius:9px;background:#7c3aed;color:white;font:600 14px system-ui;cursor:pointer}span:first-child{font-size:16px}</style><button id="closed-shadow-button"><span id="closed-shadow-icon">◆</span><span id="closed-shadow-label">Closed shadow</span></button>';
  register('closed-shadow-button', closedRoot.getElementById('closed-shadow-button'));
  register('closed-shadow-icon', closedRoot.getElementById('closed-shadow-icon'));
  register('closed-shadow-label', closedRoot.getElementById('closed-shadow-label'));

  registerRect(
    'clipped-visible-target',
    () => {
      const target = element('clipped-target').getBoundingClientRect();
      const clip = element('clipped-shell').getBoundingClientRect();
      const left = Math.max(target.left, clip.left);
      const top = Math.max(target.top, clip.top);
      const right = Math.min(target.right, clip.right);
      const bottom = Math.min(target.bottom, clip.bottom);
      return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    },
    element('clipped-target'),
  );

  registerRect(
    'wrapped-link-line',
    () => {
      const target = element('wrapped-link');
      const point = target.getBoundingClientRect();
      const x = point.left + point.width * 0.75;
      const y = point.top + point.height * 0.75;
      const rects = Array.from(target.getClientRects());
      return (
        rects.find((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) ||
        rects.at(-1) ||
        target.getBoundingClientRect()
      );
    },
    element('wrapped-link'),
  );

  registerRect(
    'map-area-region',
    () => {
      const image = element('map-image').getBoundingClientRect();
      return { x: image.left + 24, y: image.top + 20, width: 82, height: 52 };
    },
    element('map-image'),
  );

  const canvas = element('canvas-control');
  const context = canvas.getContext('2d');
  context.fillStyle = '#15223a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#60a5fa';
  context.lineWidth = 8;
  context.beginPath();
  context.moveTo(18, 104);
  context.lineTo(82, 66);
  context.lineTo(142, 82);
  context.lineTo(212, 28);
  context.lineTo(278, 48);
  context.stroke();

  element('delegated-card').addEventListener('click', () => note('delegated-card'));
  element('primary-button').addEventListener('click', () => note('primary-button'));
  element('activation-overlay').addEventListener('click', () => note('activation-overlay'));
  element('activation-underlay-button').addEventListener('click', () => note('activation-underlay-button'));
  element('annotation-clickable-overlay').addEventListener('click', () => note('annotation-clickable-overlay'));
  element('map-area').addEventListener('click', (event) => {
    event.preventDefault();
    note('map-area');
  });
  openRoot.getElementById('open-shadow-button').addEventListener('click', () => note('open-shadow-button'));
  closedRoot.getElementById('closed-shadow-button').addEventListener('click', () => note('closed-shadow-button'));

  window.benchmarkProbe = {
    rect(key) {
      const resolve = entries.get(key);
      if (!resolve) throw new Error(`Unknown benchmark geometry key: ${key}`);
      const rect = resolve();
      return { x: rect.x ?? rect.left, y: rect.y ?? rect.top, width: rect.width, height: rect.height };
    },
    scrollIntoView(key) {
      const value = nodes.get(key);
      if (!value) throw new Error(`Unknown benchmark scroll key: ${key}`);
      value.scrollIntoView({ block: 'center', inline: 'center' });
    },
    resetEvents() {
      for (const key of Object.keys(events)) delete events[key];
    },
    readEvents() {
      return { ...events };
    },
  };
})();
