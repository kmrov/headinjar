const STORAGE_KEY = 'headinjar.workspace-layout.v1';
const DIVIDER_WIDTH = 8;
const PREVIEW_MIN = 560;
const SOURCE_MIN = 210;
const SOURCE_MAX = 420;
const INSPECTOR_MIN = 280;
const INSPECTOR_MAX = 500;
const KEY_STEP = 16;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createWorkspaceLayout({ workspace, sources, sourceDivider, inspector, inspectorDivider, toggle }) {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { stored = null; }
  const initialSource = sources.getBoundingClientRect().width;
  const initialInspector = inspector.getBoundingClientRect().width;
  let sourceWidth = Number.isFinite(stored?.sourceWidth) ? stored.sourceWidth : initialSource;
  let inspectorWidth = Number.isFinite(stored?.inspectorWidth) ? stored.inspectorWidth : initialInspector;
  let collapsed = stored?.collapsed === true;
  let layout;

  function fit(preferredSide = 'inspector') {
    const available = workspace.clientWidth - (collapsed ? 1 : 2) * DIVIDER_WIDTH - PREVIEW_MIN;
    let source = collapsed ? 0 : clamp(sourceWidth, SOURCE_MIN, SOURCE_MAX);
    let right = clamp(inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX);
    if (source + right > available) {
      if (preferredSide === 'source' && !collapsed) {
        source = Math.max(SOURCE_MIN, Math.min(source, available - right));
        right = Math.min(right, available - source);
      } else {
        right = Math.max(INSPECTOR_MIN, Math.min(right, available - source));
        source = Math.min(source, available - right);
      }
    }
    return { source, inspector: right, available };
  }

  function render(preferredSide) {
    layout = fit(preferredSide);
    workspace.style.setProperty('--source-width', `${layout.source}px`);
    workspace.style.setProperty('--inspector-width', `${layout.inspector}px`);
    workspace.classList.toggle('is-source-collapsed', collapsed);
    sources.hidden = collapsed;
    sourceDivider.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', collapsed ? 'Show sources panel' : 'Hide sources panel');
    toggle.title = collapsed ? 'Show sources panel' : 'Hide sources panel';
    sourceDivider.setAttribute('aria-valuemin', String(SOURCE_MIN));
    sourceDivider.setAttribute('aria-valuemax', String(Math.max(SOURCE_MIN, Math.min(SOURCE_MAX, layout.available - layout.inspector))));
    sourceDivider.setAttribute('aria-valuenow', String(Math.round(layout.source)));
    inspectorDivider.setAttribute('aria-valuemin', String(INSPECTOR_MIN));
    inspectorDivider.setAttribute('aria-valuemax', String(Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, layout.available - layout.source))));
    inspectorDivider.setAttribute('aria-valuenow', String(Math.round(layout.inspector)));
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ sourceWidth, inspectorWidth, collapsed })); } catch { /* Layout still works without storage. */ }
  }

  function resize(side, requested) {
    if (side === 'source') sourceWidth = requested;
    else inspectorWidth = requested;
    render(side);
  }

  function finish(side) {
    if (side === 'source') sourceWidth = layout.source;
    else inspectorWidth = layout.inspector;
    save();
  }

  function bindDivider(divider, side) {
    divider.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startingX = event.clientX;
      const startingWidth = layout[side];
      divider.setPointerCapture(event.pointerId);
      divider.classList.add('is-dragging');
      document.body.classList.add('is-resizing-panels');
      const move = moveEvent => resize(side, startingWidth + (moveEvent.clientX - startingX) * (side === 'source' ? 1 : -1));
      const end = () => {
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', end);
        divider.removeEventListener('pointercancel', end);
        divider.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing-panels');
        finish(side);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', end);
      divider.addEventListener('pointercancel', end);
    });
    divider.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const minimum = side === 'source' ? SOURCE_MIN : INSPECTOR_MIN;
      const maximum = side === 'source' ? SOURCE_MAX : INSPECTOR_MAX;
      const direction = side === 'source' ? 1 : -1;
      const next = event.key === 'Home' ? minimum
        : event.key === 'End' ? maximum
          : layout[side] + (event.key === 'ArrowRight' ? 1 : -1) * direction * KEY_STEP * (event.shiftKey ? 3 : 1);
      resize(side, next);
      finish(side);
    });
    divider.addEventListener('dblclick', () => {
      resize(side, side === 'source' ? initialSource : initialInspector);
      finish(side);
    });
  }

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    render();
    save();
  });
  bindDivider(sourceDivider, 'source');
  bindDivider(inspectorDivider, 'inspector');
  const onWindowResize = () => render();
  window.addEventListener('resize', onWindowResize);
  render();

  return { destroy: () => window.removeEventListener('resize', onWindowResize) };
}
