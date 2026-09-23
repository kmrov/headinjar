const clamp = (value) => Math.max(0, Math.min(1, value));

export function createAlignmentPanel(root, controlsRoot = document, { onSourcePoint, onSelect, onRemove, onClear } = {}) {
  const image = root.querySelector('.alignment-image');
  const markers = root.querySelector('.alignment-markers');
  const list = controlsRoot.querySelector('.alignment-list');
  const status = root.querySelector('.alignment-step');
  const frame = root.querySelector('.alignment-image-frame');
  const remove = controlsRoot.querySelector('[data-alignment-remove]');
  const clear = controlsRoot.querySelector('[data-alignment-clear]');
  let currentPairs = [];

  function positionMarkers() {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    const offsetX = (width - drawWidth) / 2;
    const offsetY = (height - drawHeight) / 2;
    [...markers.children].forEach((marker, index) => {
      const point = currentPairs[index]?.source;
      if (!point) return;
      marker.style.left = `${((offsetX + point.u * drawWidth) / width) * 100}%`;
      marker.style.top = `${((offsetY + point.v * drawHeight) / height) * 100}%`;
    });
  }
  image.addEventListener('load', positionMarkers);
  const resizeObserver = new ResizeObserver(positionMarkers);
  resizeObserver.observe(frame);

  function sourcePoint(event) {
    if (!image.naturalWidth || !image.naturalHeight) return null;
    const box = image.getBoundingClientRect();
    const scale = Math.min(box.width / image.naturalWidth, box.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const left = box.left + (box.width - width) / 2;
    const top = box.top + (box.height - height) / 2;
    if (event.clientX < left || event.clientX > left + width || event.clientY < top || event.clientY > top + height) return null;
    return { u: clamp((event.clientX - left) / width), v: clamp((event.clientY - top) / height) };
  }

  image.addEventListener('click', (event) => {
    const point = sourcePoint(event);
    if (point) onSourcePoint?.(point);
  });
  remove.addEventListener('click', () => onRemove?.());
  clear.addEventListener('click', () => onClear?.());

  return {
    render({ snapshot, pairs = [], selected = null, pending = false, mode = 'front' }) {
      currentPairs = pairs;
      const preview = snapshot?.referencePreview;
      if (preview && image.src !== preview) image.src = preview;
      if (!preview) image.removeAttribute('src');
      image.hidden = !preview;
      root.querySelector('.alignment-empty').hidden = Boolean(preview);
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
    },
  };
}
