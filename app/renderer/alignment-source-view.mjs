export function fittedSourceRect(frameWidth, frameHeight, sourceWidth, sourceHeight, { zoom = 1, panX = 0, panY = 0 } = {}) {
  if (![frameWidth, frameHeight, sourceWidth, sourceHeight, zoom, panX, panY].every(Number.isFinite)
    || frameWidth <= 0 || frameHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0 || zoom <= 0) return null;
  const fitScale = Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight);
  const width = sourceWidth * fitScale;
  const height = sourceHeight * fitScale;
  return {
    left: panX + ((frameWidth - width) / 2) * zoom,
    top: panY + ((frameHeight - height) / 2) * zoom,
    width: width * zoom,
    height: height * zoom,
  };
}

export function sourcePointAt(event, frameBounds, source, view = {}) {
  if (!frameBounds || !source) return null;
  const rect = fittedSourceRect(frameBounds.width, frameBounds.height, source.width, source.height, view);
  if (!rect || !Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY)) return null;
  const x = event.clientX - frameBounds.left;
  const y = event.clientY - frameBounds.top;
  if (x < rect.left || x > rect.left + rect.width || y < rect.top || y > rect.top + rect.height) return null;
  return { u: (x - rect.left) / rect.width, v: (y - rect.top) / rect.height };
}

export function zoomAtCursor(view, requestedZoom, cursorX, cursorY) {
  const zoom = Math.max(1, Math.min(8, requestedZoom));
  const previousZoom = Math.max(1, Math.min(8, view?.zoom || 1));
  const panX = Number.isFinite(view?.panX) ? view.panX : 0;
  const panY = Number.isFinite(view?.panY) ? view.panY : 0;
  const ratio = zoom / previousZoom;
  return {
    zoom,
    panX: cursorX - (cursorX - panX) * ratio,
    panY: cursorY - (cursorY - panY) * ratio,
  };
}
