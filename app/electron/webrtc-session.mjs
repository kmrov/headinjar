import { randomUUID } from 'node:crypto';

export const WEBRTC_PENDING_TIMEOUT_MS = 15_000;
export const MAX_SDP_LENGTH = 256 * 1024;
const STATUSES = new Set(['preparing', 'running', 'stalled', 'disconnected', 'error']);

export function validateDescription(value, type) {
  if (!plainRecord(value) || !exactKeys(value, ['type', 'sdp'])
    || value.type !== type || typeof value.sdp !== 'string'
    || value.sdp.length === 0 || value.sdp.length > MAX_SDP_LENGTH) {
    throw new RangeError(`Invalid WebRTC ${type} description`);
  }
  return { type, sdp: value.sdp };
}

export function validateWebRTCStatus(value) {
  if (!plainRecord(value) || !exactKeys(value, ['sessionId', 'status', 'width', 'height', 'detail'])
    || typeof value.sessionId !== 'string' || !value.sessionId
    || !STATUSES.has(value.status)
    || !Number.isSafeInteger(value.width) || value.width < 0
    || !Number.isSafeInteger(value.height) || value.height < 0
    || typeof value.detail !== 'string' || value.detail.length > 1024) {
    throw new RangeError('Invalid WebRTC status');
  }
  if ((value.width === 0) !== (value.height === 0)) throw new RangeError('Invalid WebRTC dimensions');
  if (value.status === 'running' && (value.width === 0 || value.height === 0)) {
    throw new RangeError('Running WebRTC status requires positive video dimensions');
  }
  return { ...value };
}

export function createWebRTCSessionController({
  sendOffer,
  sendReset,
  onStatus = () => {},
  onDimensionsChanged = () => {},
  timeoutMs = WEBRTC_PENDING_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  createSessionId = randomUUID,
}) {
  let sourceKind = 'reference';
  let currentSessionId = null;
  let status = 'disconnected';
  let detail = 'Static reference image';
  let width = 0;
  let height = 0;
  let pending = null;

  const snapshot = () => ({ kind: sourceKind, status, connected: status === 'running', detail, sessionId: currentSessionId, width, height });
  const emit = () => onStatus(snapshot());
  const resetOutputSession = (sessionId) => {
    if (!sessionId) return;
    try { sendReset?.({ sessionId }); } catch { /* Output may already be shutting down. */ }
  };
  const rejectPending = (message) => {
    if (!pending) return;
    const item = pending;
    pending = null;
    clearTimeoutFn(item.timer);
    item.reject(new Error(message));
  };
  const reset = (nextKind = sourceKind, reason = 'WebRTC session reset') => {
    rejectPending(reason);
    resetOutputSession(currentSessionId);
    currentSessionId = null;
    sourceKind = nextKind;
    status = nextKind === 'reference' ? 'running' : 'disconnected';
    detail = nextKind === 'reference' ? 'Static reference image' : reason;
    width = 0;
    height = 0;
    emit();
    return snapshot();
  };

  return Object.freeze({
    snapshot,
    selectSource(kind) {
      if (!['reference', 'webrtc'].includes(kind)) throw new RangeError('Unsupported source kind');
      reset(kind, 'Source changed');
      return snapshot();
    },
    acceptOffer(rawOffer) {
      if (sourceKind !== 'webrtc') throw new Error('Select WebRTC as the source first');
      const offer = validateDescription(rawOffer, 'offer');
      resetOutputSession(currentSessionId);
      rejectPending('Replaced by a newer offer');
      const sessionId = createSessionId();
      currentSessionId = sessionId;
      status = 'preparing';
      detail = 'Creating answer; ICE gathering may take a few seconds.';
      width = 0;
      height = 0;
      const answerPromise = new Promise((resolve, reject) => {
        const timer = setTimeoutFn(() => {
          if (pending?.sessionId !== sessionId) return;
          const item = pending;
          pending = null;
          clearTimeoutFn(item.timer);
          resetOutputSession(sessionId);
          currentSessionId = null;
          status = 'disconnected';
          detail = 'WebRTC answer timed out after 15 seconds. Connect again.';
          width = 0;
          height = 0;
          emit();
          item.reject(new Error(detail));
        }, timeoutMs);
        pending = { sessionId, resolve, reject, timer };
      });
      emit();
      try { sendOffer({ sessionId, offer }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectPending(message);
        resetOutputSession(sessionId);
        currentSessionId = null;
        status = 'error';
        detail = message;
        emit();
      }
      return answerPromise;
    },
    receiveAnswer(payload) {
      if (!plainRecord(payload) || typeof payload.sessionId !== 'string'
        || payload.sessionId !== currentSessionId || !pending || pending.sessionId !== payload.sessionId) return false;
      if (exactKeys(payload, ['sessionId', 'error'])) {
        if (typeof payload.error !== 'string' || !payload.error || payload.error.length > 1024) throw new RangeError('Invalid WebRTC error');
        const item = pending;
        pending = null;
        clearTimeoutFn(item.timer);
        resetOutputSession(currentSessionId);
        currentSessionId = null;
        status = 'error';
        detail = payload.error;
        width = 0;
        height = 0;
        emit();
        item.reject(new Error(payload.error));
        return true;
      }
      if (!exactKeys(payload, ['sessionId', 'answer'])) return false;
      const answer = validateDescription(payload.answer, 'answer');
      const item = pending;
      pending = null;
      clearTimeoutFn(item.timer);
      item.resolve(answer);
      return true;
    },
    receiveStatus(rawStatus) {
      const next = validateWebRTCStatus(rawStatus);
      if (!currentSessionId || next.sessionId !== currentSessionId || sourceKind !== 'webrtc') return false;
      const dimensionsChanged = Boolean((width || height) && (next.width !== width || next.height !== height));
      if (!dimensionsChanged && status === next.status && detail === next.detail
        && width === next.width && height === next.height) return true;
      status = next.status;
      detail = next.detail;
      width = next.width;
      height = next.height;
      if (dimensionsChanged) onDimensionsChanged(snapshot());
      emit();
      return true;
    },
    reset(reason) { return reset(sourceKind, reason); },
    outputClosed() { return reset(sourceKind, 'Output closed. Reopen output and connect again.'); },
    editorClosed() { reset('webrtc', 'Editor closed'); },
  });
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
}
