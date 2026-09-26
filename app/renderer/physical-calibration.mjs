const clamp = value => Math.max(0, Math.min(1, value));

// Projector-frame correspondences are independent of texture landmarks.
export function createPhysicalCalibration(parent, { onEdit, onState, onMarker, getLandmarks, onError }) {
  const root = document.createElement('section');
  root.id = 'physical-calibration';
  root.className = 'physical-calibration';
  root.innerHTML = `
    <div class="inspector-title-row"><h2>Points on the model</h2></div>
    <p class="physical-help">Drag each point in the preview until its projected mark lands on the same place on the real surface.</p>
    <div id="physical-pairs" class="physical-pairs" aria-label="Model landmarks"></div>
    <p id="physical-status" role="status"></p>
    <div class="physical-actions">
      <button id="physical-add" type="button">Add point</button>
      <button id="physical-reseed" type="button" title="Replace projector points and correction with current Align points. Undo restores them.">Recreate from Align</button>
      <button id="physical-apply" type="button">Apply</button>
    </div>`;
  parent.append(root);
  const q = selector => root.querySelector(selector);
  let snapshot = null, selected = null, picking = false, visible = false;
  let draft = null, pending = false, lastMarker = '', autoSeededProjectId = null;
  const pairs = () => draft ?? snapshot?.project.projector.calibration?.pairs ?? [];

  function publishMarker() {
    const point = pairs()[selected]?.target;
    const value = visible && point ? { point, index: selected } : null;
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
    q('#physical-add').disabled = !hasMesh || current.length >= 12 || pending;
    const placement = snapshot?.project.placement;
    const landmarkCount = placement?.mappingMode === 'wrap'
      ? placement.wrap?.alignment.pairs.length : placement?.alignment?.pairs?.length;
    q('#physical-reseed').disabled = !hasMesh || !landmarkCount || pending;
    q('#physical-apply').disabled = current.length < 3 || pending;
    q('#physical-status').textContent = picking
      ? 'Click a new point on the model in the preview.'
      : !current.length ? 'No model points yet. Add at least three points to begin.'
        : current.length < 3 ? 'Add at least three points to apply calibration.'
          : !snapshot?.displayId ? 'Choose display to see a point on the real surface.'
            : snapshot?.mode === 'held' ? 'Release Hold to see the selected point on the real surface.'
              : snapshot?.mode !== 'live' ? 'Start projection to see the selected point on the real surface.'
            : 'Select a point and drag its orange mark in the preview.';
    const list = q('#physical-pairs');
    list.replaceChildren();
    current.forEach((pair, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = String(index + 1);
      button.classList.toggle('is-selected', index === selected);
      button.setAttribute('aria-label', `Model point ${index + 1}`);
      button.setAttribute('aria-pressed', String(index === selected));
      button.disabled = pending;
      button.addEventListener('click', () => select(index));
      list.append(button);
    });
    onState({ active: visible, picking, selected, pairs: current });
    publishMarker();
  }

  async function commit(command, { clearSelection = false } = {}) {
    pending = true;
    render();
    try {
      const next = await onEdit(command);
      if (next?.project) snapshot = next;
      if (clearSelection) selected = null;
    } catch (error) { onError(error); }
    finally { pending = false; draft = null; render(); }
  }

  function seedModelPoints() {
    if (!visible || pending || !snapshot?.project.mesh || pairs().length || autoSeededProjectId === snapshot.project.id) return;
    const landmarks = getLandmarks().slice(0, 12);
    if (!landmarks.length) return;
    autoSeededProjectId = snapshot.project.id;
    draft = landmarks.map(source => ({ source, target: { ...source } }));
    selected = 0;
    commit({ type: 'calibration-pairs', value: draft });
  }

  function select(index) {
    if (pending || !pairs()[index]) return;
    selected = index;
    picking = false;
    render();
  }

  function dragTarget(index, target, complete = false) {
    if (pending || !pairs()[index]) return;
    selected = index;
    draft = pairs().map((pair, i) => i === index
      ? { ...pair, target: { u: clamp(target.u), v: clamp(target.v) } }
      : pair);
    render();
    if (complete) return commit({ type: 'calibration-pairs', value: draft });
  }

  q('#physical-add').addEventListener('click', () => { picking = true; render(); });
  q('#physical-reseed').addEventListener('click', () => {
    const landmarks = getLandmarks().slice(0, 12);
    if (!landmarks.length) return onError(new Error('No Align points are visible in the projector preview.'));
    draft = landmarks.map(source => ({ source, target: { ...source } }));
    selected = 0;
    picking = false;
    return commit({ type: 'calibration-reseed', value: draft });
  });
  q('#physical-apply').addEventListener('click', () => commit({ type: 'calibration-apply', value: pairs() }, { clearSelection: true }));
  return {
    render(value) {
      if (snapshot?.project.id !== value.project.id) {
        draft = null;
        selected = null;
        picking = false;
        autoSeededProjectId = null;
      }
      if (snapshot && (snapshot.displayId && snapshot.displayId !== value.displayId
        || snapshot.output?.armed && !value.output?.armed)) selected = null;
      if (!value.calibrationMarker) lastMarker = '';
      snapshot = value;
      render();
      seedModelPoints();
    },
    setVisible(value) {
      visible = value;
      if (!value) { picking = false; draft = null; }
      render();
      seedModelPoints();
    },
    addSource(source) {
      if (!visible || !picking || pending || pairs().length >= 12) return;
      draft = [...pairs(), { source, target: { ...source } }];
      selected = draft.length - 1;
      picking = false;
      return commit({ type: 'calibration-pairs', value: draft });
    },
    select,
    dragTarget,
    cancelDrag() { draft = null; render(); },
    destroy() { onMarker(null); root.remove(); },
  };
}
