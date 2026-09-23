const clamp = value => Math.max(0, Math.min(1, value));

// The panel edits projector-frame correspondences, independent of texture landmarks.
export function createPhysicalCalibration(parent, { onEdit, onState, onMarker, getLandmarks, onError }) {
  const root = document.createElement('section');
  root.id = 'physical-calibration';
  root.className = 'physical-calibration';
  root.innerHTML = `
    <h2>Physical alignment</h2>
    <p class="physical-help">Match the projected crosshair to the same landmark on the real head. Start with eyes, nose and chin.</p>
    <div class="physical-actions">
      <button id="physical-edit" type="button">Edit points</button>
      <button id="physical-reuse" type="button">Use model landmarks</button>
      <button id="physical-add" type="button">Add point</button>
    </div>
    <p id="physical-status" role="status"></p>
    <div id="physical-pairs" class="physical-pairs" aria-label="Physical landmark pairs"></div>
    <div class="physical-target">
      <label>Target X, px<input id="physical-x" type="number" min="0" step="1"></label>
      <label>Target Y, px<input id="physical-y" type="number" min="0" step="1"></label>
    </div>
    <div class="physical-nudge" aria-label="Move projected crosshair">
      <button type="button" data-nudge="left" aria-label="Move crosshair left">←</button>
      <button type="button" data-nudge="up" aria-label="Move crosshair up">↑</button>
      <button type="button" data-nudge="down" aria-label="Move crosshair down">↓</button>
      <button type="button" data-nudge="right" aria-label="Move crosshair right">→</button>
    </div>
    <p class="physical-help">Arrows: 1 px · Shift: 10 px. Drag orange markers in preview. Blue marks show the original model points.</p>
    <div class="physical-actions">
      <button id="physical-apply" type="button">Apply alignment</button>
      <button id="physical-remove" type="button">Remove point</button>
      <button id="physical-reset" type="button">Reset alignment</button>
    </div>
    <p class="physical-help">At least 3 points spread across the face. Adjust the camera first: changing camera, model pose or output size resets these points.</p>`;
  parent.prepend(root);
  const q = selector => root.querySelector(selector);
  let snapshot = null, selected = null, editing = false, picking = false, visible = false;
  let draft = null, pending = false, lastMarker = '', note = '';
  const pairs = () => draft ?? snapshot?.project.projector.calibration?.pairs ?? [];
  const point = () => pairs()[selected]?.target;
  const dimensions = () => snapshot?.project.output ?? { width: 1920, height: 1080 };
  function publishMarker() {
    const value = visible && editing && point() ? { point: point(), index: selected } : null;
    const key = JSON.stringify(value);
    if (key !== lastMarker) {
      lastMarker = key;
      Promise.resolve(onMarker(value)).catch(onError);
    }
  }
  function render() {
    const current = pairs();
    if (selected !== null && !current[selected]) selected = current.length ? current.length - 1 : null;
    const hasMesh = Boolean(snapshot?.project.mesh);
    q('#physical-edit').textContent = editing ? 'Finish editing' : 'Edit points';
    q('#physical-edit').disabled = !hasMesh || pending;
    q('#physical-edit').setAttribute('aria-pressed', String(editing));
    q('#physical-add').disabled = !hasMesh || current.length >= 12 || pending;
    q('#physical-reuse').disabled = !hasMesh || pending;
    q('#physical-apply').disabled = current.length < 3 || pending;
    q('#physical-remove').disabled = selected === null || pending;
    q('#physical-reset').disabled = !snapshot || pending;
    q('#physical-status').textContent = note || (picking ? 'Click a landmark on the digital head.' : editing
      ? snapshot?.mode !== 'live' ? 'Resume output to see the crosshair on the real head.' : `Move crosshair ${selected === null ? '' : selected + 1} onto the real landmark, then select the next point.`
      : `${current.length} points · ${current.length < 3 ? 'Add or reuse landmarks to begin.' : 'Edit points, then apply to update the projection.'}`);
    const list = q('#physical-pairs');
    list.replaceChildren();
    current.forEach((pair, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = String(index + 1);
      button.classList.toggle('is-selected', index === selected);
      button.setAttribute('aria-label', `Physical landmark ${index + 1}`);
      button.setAttribute('aria-pressed', String(index === selected));
      button.disabled = pending;
      button.addEventListener('click', () => select(index));
      list.append(button);
    });
    const { width, height } = dimensions();
    for (const [axis, size] of [['x', width], ['y', height]]) {
      const input = q(`#physical-${axis}`);
      input.max = String(size - 1);
      input.disabled = !editing || !point() || pending;
      if (document.activeElement !== input) input.value = point() ? String(Math.round(point()[axis === 'x' ? 'u' : 'v'] * (size - 1))) : '';
    }
    root.querySelectorAll('[data-nudge]').forEach(button => { button.disabled = !editing || !point() || pending; });
    onState({ active: visible && editing, picking, selected, pairs: current });
    publishMarker();
  }
  async function commit(command, { finish = false } = {}) {
    pending = true; render();
    try {
      const next = await onEdit(command);
      if (next?.project) snapshot = next;
      if (finish) { editing = false; picking = false; }
    } catch (error) { onError(error); }
    finally { pending = false; draft = null; render(); }
  }
  function select(index) {
    if (pending) return;
    selected = index; editing = true; picking = false; note = ''; render();
  }
  function dragTarget(index, target, complete = false) {
    if (pending || !pairs()[index]) return;
    selected = index; editing = true; note = '';
    draft = pairs().map((pair, i) => i === index ? { ...pair, target: { u: clamp(target.u), v: clamp(target.v) } } : pair);
    render();
    if (complete) return commit({ type: 'calibration-pairs', value: draft });
  }
  function nudge(direction, amount, complete) {
    if (!editing || !point() || pending) return;
    const { width, height } = dimensions();
    const next = { ...point() };
    if (direction === 'left') next.u -= amount / (width - 1 || 1);
    if (direction === 'right') next.u += amount / (width - 1 || 1);
    if (direction === 'up') next.v -= amount / (height - 1 || 1);
    if (direction === 'down') next.v += amount / (height - 1 || 1);
    dragTarget(selected, next, complete);
  }
  q('#physical-edit').addEventListener('click', () => { editing = !editing; picking = editing && !pairs().length; note = ''; render(); });
  q('#physical-add').addEventListener('click', () => { editing = true; picking = true; note = ''; render(); });
  q('#physical-reuse').addEventListener('click', () => {
    const landmarks = getLandmarks();
    if (!landmarks.length) { note = 'No visible model landmarks. Add points here, or mark the digital model in Front → Align first.'; render(); return; }
    draft = landmarks.slice(0, 12).map(source => ({ source, target: { ...source } }));
    selected = 0; editing = true; picking = false;
    const total = snapshot?.project.placement.alignment?.pairs.length ?? landmarks.length;
    note = landmarks.length < total ? `${landmarks.length} of ${total} model points reused. Others are outside the frame or have no visible surface. Select a point and move its crosshair.` : '';
    commit({ type: 'calibration-pairs', value: draft });
  });
  q('#physical-apply').addEventListener('click', () => commit({ type: 'calibration-apply', value: pairs() }, { finish: true }));
  q('#physical-remove').addEventListener('click', () => commit({ type: 'calibration-pairs', value: pairs().filter((_, index) => index !== selected) }));
  q('#physical-reset').addEventListener('click', () => { selected = null; note = ''; commit({ type: 'calibration-reset' }, { finish: true }); });
  for (const axis of ['x', 'y']) q(`#physical-${axis}`).addEventListener('change', event => {
    if (!point()) return;
    const value = Number(event.target.value);
    if (!Number.isFinite(value) || event.target.value === '') { render(); return; }
    const size = dimensions()[axis === 'x' ? 'width' : 'height'];
    dragTarget(selected, { ...point(), [axis === 'x' ? 'u' : 'v']: value / (size - 1 || 1) }, true);
  });
  root.querySelectorAll('[data-nudge]').forEach(button => button.addEventListener('click', event => nudge(button.dataset.nudge, event.shiftKey ? 10 : 1, true)));
  function keydown(event) {
    if (!visible || !editing || !point() || !event.key.startsWith('Arrow') || event.altKey || event.ctrlKey || event.metaKey || /INPUT|SELECT|TEXTAREA/.test(event.target.tagName)) return;
    event.preventDefault(); nudge(event.key.slice(5).toLowerCase(), event.shiftKey ? 10 : 1, false);
  }
  function keyup(event) {
    if (visible && editing && draft && event.key.startsWith('Arrow')) { event.preventDefault(); commit({ type: 'calibration-pairs', value: draft }); }
  }
  document.addEventListener('keydown', keydown);
  document.addEventListener('keyup', keyup);
  return {
    render(value) {
      if (snapshot && snapshot.displayId !== value.displayId) {
        draft = null; editing = false; picking = false;
      }
      if (snapshot && (snapshot.project.id !== value.project.id || (snapshot.project.projector.calibration?.pairs.length ?? 0) > 0 && !(value.project.projector.calibration?.pairs.length))) {
        draft = null; selected = null; editing = false; picking = false;
      }
      if (!value.calibrationMarker) lastMarker = '';
      snapshot = value; render();
    },
    setVisible(value) { visible = value; if (!value) { editing = false; picking = false; draft = null; } render(); },
    addSource(source) {
      if (!editing || !picking || pending || pairs().length >= 12) return;
      draft = [...pairs(), { source, target: { ...source } }]; selected = draft.length - 1; picking = false; note = '';
      return commit({ type: 'calibration-pairs', value: draft });
    },
    select, dragTarget,
    cancelDrag() { draft = null; render(); },
    destroy() { document.removeEventListener('keydown', keydown); document.removeEventListener('keyup', keyup); onMarker(null); root.remove(); },
  };
}
