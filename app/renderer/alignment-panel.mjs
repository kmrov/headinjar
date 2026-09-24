import { fittedSourceRect, sourcePointAt, zoomAtCursor } from './alignment-source-view.mjs';

export function createAlignmentPanel(root, controlsRoot = document, { onSourcePoint, onSelect, onRemove, onClear } = {}) {
  const image = root.querySelector('.alignment-image');
  const liveImage = root.querySelector('.alignment-live-image');
  const markers = root.querySelector('.alignment-markers');
  const list = controlsRoot.querySelector('.alignment-list');
  const status = root.querySelector('.alignment-step');
  const frame = root.querySelector('.alignment-image-frame');
  const fitSource = root.querySelector('#alignment-source-fit');
  const remove = controlsRoot.querySelector('[data-alignment-remove]');
  const clear = controlsRoot.querySelector('[data-alignment-clear]');
  let currentPairs = [];
  let pendingSourcePoint = null;
  let liveFrameSessionId = null;
  let hasLiveFrame = false;
  let lastRender = null;
  let sourceIdentity = null;
  let referenceDimensionKey = '';
  let sourceView = { zoom: 1, panX: 0, panY: 0 };
  let panGesture = null;
  const dimension = element => element === image
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: liveImage.width, height: liveImage.height };
  const displayedImage = () => !liveImage.hidden ? liveImage : !image.hidden ? image : null;
  const contentBounds = () => {
    const bounds = frame.getBoundingClientRect();
    return {
      left: bounds.left + frame.clientLeft,
      top: bounds.top + frame.clientTop,
      width: frame.clientWidth,
      height: frame.clientHeight,
    };
  };
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
    const rect = fittedSourceRect(frame.clientWidth, frame.clientHeight, sourceWidth, sourceHeight, sourceView);
    if (!rect) return;
    [...markers.children].forEach((marker, index) => {
      const point = currentPairs[index]?.source ?? (index === currentPairs.length ? pendingSourcePoint : null);
      if (!point) return;
      marker.style.left = `${rect.left + point.u * rect.width}px`;
      marker.style.top = `${rect.top + point.v * rect.height}px`;
    });
  }
  function applySourceView() {
    const transform = `translate(${sourceView.panX}px, ${sourceView.panY}px) scale(${sourceView.zoom})`;
    image.style.transformOrigin = liveImage.style.transformOrigin = '0 0';
    image.style.transform = liveImage.style.transform = transform;
    frame.dataset.sourceZoom = String(sourceView.zoom);
    fitSource.disabled = sourceView.zoom === 1 && sourceView.panX === 0 && sourceView.panY === 0;
    positionMarkers();
  }
  function resetSourceView() {
    endPan();
    sourceView = { zoom: 1, panX: 0, panY: 0 };
    applySourceView();
  }
  function sourcePoint(event) {
    const displayed = displayedImage();
    if (!displayed) return null;
    const source = dimension(displayed);
    return sourcePointAt(event, contentBounds(), source, sourceView);
  }
  function onImageLoad() {
    const size = dimension(image);
    if (size.width && size.height) {
      const nextKey = `${size.width}x${size.height}`;
      if (referenceDimensionKey && referenceDimensionKey !== nextKey && sourceIdentity?.startsWith('reference:')) resetSourceView();
      referenceDimensionKey = nextKey;
    }
    applySourceView();
  }
  image.addEventListener('load', onImageLoad);
  const onResize = () => applySourceView();
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(frame);

  function onWheel(event) {
    if (!displayedImage()) return;
    event.preventDefault();
    const bounds = contentBounds();
    const deltaScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
    const requestedZoom = sourceView.zoom * Math.exp(-event.deltaY * deltaScale * 0.001);
    sourceView = zoomAtCursor(sourceView, requestedZoom, event.clientX - bounds.left, event.clientY - bounds.top);
    applySourceView();
  }
  function onPointerDown(event) {
    if (event.button !== 1 || !displayedImage()) return;
    event.preventDefault();
    panGesture = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, panX: sourceView.panX, panY: sourceView.panY };
    frame.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event) {
    if (!panGesture || panGesture.pointerId !== event.pointerId) return;
    sourceView.panX = panGesture.panX + event.clientX - panGesture.clientX;
    sourceView.panY = panGesture.panY + event.clientY - panGesture.clientY;
    applySourceView();
  }
  function endPan(event) {
    if (!panGesture || (event?.pointerId !== undefined && panGesture.pointerId !== event.pointerId)) return;
    const pointerId = panGesture.pointerId;
    panGesture = null;
    if (frame.hasPointerCapture?.(pointerId)) frame.releasePointerCapture(pointerId);
  }
  function onAuxClick(event) { if (event.button === 1) event.preventDefault(); }
  function onContextMenu(event) { if (panGesture) event.preventDefault(); }
  frame.addEventListener('wheel', onWheel, { passive: false });
  frame.addEventListener('pointerdown', onPointerDown);
  frame.addEventListener('pointermove', onPointerMove);
  frame.addEventListener('pointerup', endPan);
  frame.addEventListener('pointercancel', endPan);
  frame.addEventListener('lostpointercapture', endPan);
  frame.addEventListener('auxclick', onAuxClick);
  frame.addEventListener('contextmenu', onContextMenu);
  fitSource.addEventListener('click', resetSourceView);

  function onReferenceClick(event) {
    if (event.button !== 0) return;
    const point = sourcePoint(event);
    if (point) onSourcePoint?.(point);
  }
  function onLiveClick(event) {
    if (event.button !== 0) return;
    const point = sourcePoint(event);
    if (point) onSourcePoint?.(point);
  }
  image.addEventListener('click', onReferenceClick);
  liveImage.addEventListener('click', onLiveClick);
  remove.addEventListener('click', () => onRemove?.());
  clear.addEventListener('click', () => onClear?.());

  function render({ snapshot, pairs = [], selected = null, pending = false, pendingSource = null, mode = 'front' }) {
      lastRender = { snapshot, pairs, selected, pending, pendingSource, mode };
      currentPairs = pairs;
      pendingSourcePoint = pendingSource;
      const source = snapshot?.source;
      const nextIdentity = source?.kind === 'webrtc'
        ? `webrtc:${source.sessionId || ''}:${source.width || 0}x${source.height || 0}`
        : `reference:${snapshot?.referencePreview || ''}`;
      if (sourceIdentity !== null && sourceIdentity !== nextIdentity) resetSourceView();
      sourceIdentity = nextIdentity;
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
        resetSourceView();
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
      if (hasLiveFrame && (liveImage.width !== frameWidth || liveImage.height !== frameHeight)) resetSourceView();
      if (liveImage.width !== frameWidth || liveImage.height !== frameHeight) {
        liveImage.width = frameWidth;
        liveImage.height = frameHeight;
      }
      liveImage.getContext('2d')?.drawImage(source, 0, 0, frameWidth, frameHeight);
      hasLiveFrame = true;
      liveFrameSessionId = sessionId;
      if (lastRender) updateSourceVisibility(lastRender.snapshot);
      applySourceView();
    },
    destroy() {
      resizeObserver.disconnect();
      image.removeEventListener('load', onImageLoad);
      image.removeEventListener('click', onReferenceClick);
      liveImage.removeEventListener('click', onLiveClick);
      frame.removeEventListener('wheel', onWheel);
      frame.removeEventListener('pointerdown', onPointerDown);
      frame.removeEventListener('pointermove', onPointerMove);
      frame.removeEventListener('pointerup', endPan);
      frame.removeEventListener('pointercancel', endPan);
      frame.removeEventListener('lostpointercapture', endPan);
      frame.removeEventListener('auxclick', onAuxClick);
      frame.removeEventListener('contextmenu', onContextMenu);
      fitSource.removeEventListener('click', resetSourceView);
      endPan();
    },
  };
}
