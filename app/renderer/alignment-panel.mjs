const clamp = (value) => Math.max(0, Math.min(1, value));

export function createAlignmentPanel(root, controlsRoot = document, { onSourcePoint, onSelect, onRemove, onClear } = {}) {
  const image = root.querySelector('.alignment-image');
  const liveImage = root.querySelector('.alignment-live-image');
  const markers = root.querySelector('.alignment-markers');
  const list = controlsRoot.querySelector('.alignment-list');
  const status = root.querySelector('.alignment-step');
  const frame = root.querySelector('.alignment-image-frame');
  const remove = controlsRoot.querySelector('[data-alignment-remove]');
  const clear = controlsRoot.querySelector('[data-alignment-clear]');
  let currentPairs = [];
  let pendingSourcePoint = null;
  let liveFrameSessionId = null;
  let hasLiveFrame = false;
  let lastRender = null;
  const dimension = element => element === image
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: liveImage.width, height: liveImage.height };
  const displayedImage = () => !liveImage.hidden ? liveImage : !image.hidden ? image : null;
  function updateSourceVisibility(snapshot) {
    const source = snapshot?.source;
    const showLive = source?.kind === 'webrtc' && hasLiveFrame
      && (!source.sessionId || source.sessionId === liveFrameSessionId);
    image.hidden = source?.kind === 'webrtc' || !snapshot?.referencePreview;
    liveImage.hidden = !showLive;
    const empty = root.querySelector('.alignment-empty');
    empty.hidden = showLive || (source?.kind !== 'webrtc' && Boolean(snapshot?.referencePreview));
    empty.textContent = source?.kind === 'webrtc'
      ? 'Waiting for WebRTC video. The reference image stays hidden while WebRTC is selected.'
      : 'Add a reference image to align.';
    root.querySelector('.alignment-source-heading strong').textContent = source?.kind === 'webrtc' ? 'Live video source' : 'Reference image';
  }

  function positionMarkers() {
    const displayed = displayedImage();
    if (!displayed) return;
    const { width: sourceWidth, height: sourceHeight } = dimension(displayed);
    if (!sourceWidth || !sourceHeight) return;
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    const offsetX = (width - drawWidth) / 2;
    const offsetY = (height - drawHeight) / 2;
    [...markers.children].forEach((marker, index) => {
      const point = currentPairs[index]?.source ?? (index === currentPairs.length ? pendingSourcePoint : null);
      if (!point) return;
      marker.style.left = `${((offsetX + point.u * drawWidth) / width) * 100}%`;
      marker.style.top = `${((offsetY + point.v * drawHeight) / height) * 100}%`;
    });
  }
  image.addEventListener('load', positionMarkers);
  const resizeObserver = new ResizeObserver(positionMarkers);
  resizeObserver.observe(frame);

  function sourcePoint(event, target) {
    const { width: sourceWidth, height: sourceHeight } = dimension(target);
    if (!sourceWidth || !sourceHeight) return null;
    const box = target.getBoundingClientRect();
    const scale = Math.min(box.width / sourceWidth, box.height / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    const left = box.left + (box.width - width) / 2;
    const top = box.top + (box.height - height) / 2;
    if (event.clientX < left || event.clientX > left + width || event.clientY < top || event.clientY > top + height) return null;
    return { u: clamp((event.clientX - left) / width), v: clamp((event.clientY - top) / height) };
  }

  image.addEventListener('click', (event) => {
    const point = sourcePoint(event, image);
    if (point) onSourcePoint?.(point);
  });
  liveImage.addEventListener('click', (event) => {
    const point = sourcePoint(event, liveImage);
    if (point) onSourcePoint?.(point);
  });
  remove.addEventListener('click', () => onRemove?.());
  clear.addEventListener('click', () => onClear?.());

  function render({ snapshot, pairs = [], selected = null, pending = false, pendingSource = null, mode = 'front' }) {
      lastRender = { snapshot, pairs, selected, pending, pendingSource, mode };
      currentPairs = pairs;
      pendingSourcePoint = pendingSource;
      const preview = snapshot?.referencePreview;
      if (preview && image.src !== preview) image.src = preview;
      if (!preview) image.removeAttribute('src');
      updateSourceVisibility(snapshot);
      markers.replaceChildren();
      pairs.forEach((pair, index) => {
        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'alignment-marker';
        marker.classList.toggle('is-selected', index === selected);
        marker.textContent = String(index + 1);
        marker.setAttribute('aria-label', `Select landmark pair ${index + 1}`);
        marker.addEventListener('click', (event) => { event.stopPropagation(); onSelect?.(index); });
        markers.append(marker);
      });
      if (pendingSource) {
        const marker = document.createElement('span');
        marker.className = 'alignment-marker is-pending';
        marker.setAttribute('aria-label', `Pending source point ${pairs.length + 1}`);
        marker.textContent = String(pairs.length + 1);
        markers.append(marker);
      }
      list.replaceChildren();
      pairs.forEach((pair, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'alignment-pair';
        row.classList.toggle('is-selected', index === selected);
        row.setAttribute('aria-pressed', String(index === selected));
        row.innerHTML = `<span class="alignment-pair-number">${index + 1}</span><span>Image ${pair.source.u.toFixed(3)}, ${pair.source.v.toFixed(3)}<small>Surface ${pair.target.u.toFixed(3)}, ${pair.target.v.toFixed(3)}</small></span><i class="ph ph-caret-right" aria-hidden="true"></i>`;
        row.addEventListener('click', () => onSelect?.(index));
        list.append(row);
      });
      const next = pending ? 'Click the matching point on the model.' : 'Click a point on the image, then the model.';
      status.textContent = mode === 'uv' ? 'Switch to Front mapping to place landmarks.' : next;
      root.classList.toggle('is-awaiting-target', pending);
      remove.disabled = selected === null || selected >= pairs.length;
      clear.disabled = pairs.length === 0;
      controlsRoot.querySelector('[data-alignment-apply]').disabled = pairs.length < 3;
      controlsRoot.querySelector('.alignment-count').textContent = `${pairs.length} / 12`;
      positionMarkers();
  }

  return {
    render,
    setLiveFrame(source, { sessionId = null, width, height } = {}) {
      if (!source) {
        hasLiveFrame = false;
        liveFrameSessionId = null;
        liveImage.width = liveImage.height = 1;
        liveImage.getContext('2d')?.clearRect(0, 0, 1, 1);
        if (lastRender) updateSourceVisibility(lastRender.snapshot);
        positionMarkers();
        return;
      }
      const size = dimension(source);
      const frameWidth = width || size.width;
      const frameHeight = height || size.height;
      if (!frameWidth || !frameHeight) return;
      if (liveImage.width !== frameWidth || liveImage.height !== frameHeight) {
        liveImage.width = frameWidth;
        liveImage.height = frameHeight;
      }
      liveImage.getContext('2d')?.drawImage(source, 0, 0, frameWidth, frameHeight);
      hasLiveFrame = true;
      liveFrameSessionId = sessionId;
      if (lastRender) updateSourceVisibility(lastRender.snapshot);
      positionMarkers();
    },
    destroy() { resizeObserver.disconnect(); },
  };
}
