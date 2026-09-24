const DEFAULT_POLL_INTERVAL_MS = 16;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FAILURES = 3;
const MAX_CONSUMER_ID_LENGTH = 128;

/** Publish only when a consumer asks for the latest decoded frame. */
export function createFramePublisher({
  channelName,
  BroadcastChannel: BroadcastChannelClass = globalThis.BroadcastChannel,
  createImageBitmap: makeBitmap = globalThis.createImageBitmap,
} = {}) {
  validateChannelName(channelName);
  if (typeof BroadcastChannelClass !== 'function') throw new Error('BroadcastChannel is not available.');
  if (typeof makeBitmap !== 'function') throw new Error('ImageBitmap capture is not available.');
  const channel = new BroadcastChannelClass(channelName);
  let source = null;
  let generation = 0;
  let activeRequest = null;
  let closed = false;

  function postEmpty(request) {
    try { channel.postMessage({ type: 'empty', ...request }); } catch { /* A closing consumer can ignore an empty response. */ }
  }

  function onMessage(event) {
    const message = event.data;
    if (closed) return;
    if (message?.type === 'cancel' && isPullMessage({ ...message, type: 'pull' })) {
      if (activeRequest && matchesRequest(activeRequest.request, message)) activeRequest.cancelled = true;
      return;
    }
    if (!isPullMessage(message)) return;
    const request = {
      consumerId: message.consumerId,
      sessionId: message.sessionId,
      generation: message.generation,
      requestId: message.requestId,
    };
    if (activeRequest) {
      postEmpty(request);
      return;
    }
    if (!source || source.sessionId !== message.sessionId) {
      postEmpty(request);
      return;
    }

    const operation = { request, sourceGeneration: generation, cancelled: false };
    activeRequest = operation;
    void (async () => {
      let bitmap = null;
      try {
        bitmap = await makeBitmap(source.video);
        if (closed || activeRequest !== operation || operation.cancelled
          || operation.sourceGeneration !== generation || !source || source.sessionId !== request.sessionId) {
          return;
        }
        const width = Number(bitmap?.width ?? bitmap?.displayWidth);
        const height = Number(bitmap?.height ?? bitmap?.displayHeight);
        if (!bitmap || typeof bitmap.close !== 'function' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new Error('A decoded video frame could not be captured.');
        }
        channel.postMessage({ type: 'frame', ...request, width, height, bitmap });
      } catch (error) {
        if (!closed && !operation.cancelled && operation.sourceGeneration === generation) {
          try { channel.postMessage({ type: 'error', ...request, message: error instanceof Error ? error.message : String(error) }); }
          catch { /* A closing consumer will observe its request timeout. */ }
        }
      } finally {
        bitmap?.close?.();
        if (activeRequest === operation) activeRequest = null;
      }
    })();
  }

  channel.addEventListener?.('message', onMessage);
  if (!channel.addEventListener) channel.onmessage = onMessage;

  function publish(video, sessionId) {
    if (closed) return false;
    if (!video || typeof sessionId !== 'string' || !sessionId) {
      clear();
      return false;
    }
    if (!source || source.sessionId !== sessionId || source.video !== video) {
      generation += 1;
      source = { video, sessionId };
    }
    return true;
  }

  function clear() {
    if (closed) return;
    generation += 1;
    source = null;
    if (activeRequest) {
      activeRequest.cancelled = true;
      postEmpty(activeRequest.request);
    }
  }

  function close() {
    if (closed) return;
    clear();
    closed = true;
    channel.removeEventListener?.('message', onMessage);
    channel.onmessage = null;
    channel.close();
  }

  return Object.freeze({ publish, clear, close });
}

/** Pull frames only while enabled; each received bitmap is closed after onFrame returns. */
export function createFrameConsumer({
  channelName,
  onFrame = () => {},
  onError = () => {},
  BroadcastChannel: BroadcastChannelClass = globalThis.BroadcastChannel,
  setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxFailures = DEFAULT_MAX_FAILURES,
  createId = defaultId,
} = {}) {
  validateChannelName(channelName);
  if (typeof BroadcastChannelClass !== 'function') throw new Error('BroadcastChannel is not available.');
  if (typeof onFrame !== 'function' || typeof onError !== 'function') throw new TypeError('Frame callbacks must be functions.');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0 || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0
    || !Number.isInteger(maxFailures) || maxFailures < 1) throw new RangeError('Invalid frame transport limits.');
  const channel = new BroadcastChannelClass(channelName);
  const consumerId = createId();
  let sourceSessionId = null;
  let generation = 0;
  let nextRequestId = 0;
  let enabled = false;
  let closed = false;
  let failures = 0;
  let pending = null;
  let timer = null;

  function clearTimer() {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  }

  function cancelPending() {
    if (!pending) return;
    const request = pending;
    pending = null;
    clearTimer();
    try { channel.postMessage({ type: 'cancel', consumerId, sessionId: request.sessionId, generation: request.generation, requestId: request.requestId }); }
    catch { /* The publisher may have closed with this consumer. */ }
  }

  function scheduleNext(delay = pollIntervalMs) {
    clearTimer();
    if (closed || !enabled || !sourceSessionId || pending) return;
    timer = setTimeoutFn(() => { timer = null; requestFrame(); }, delay);
  }

  function failRequest(error) {
    failures += 1;
    if (failures >= maxFailures) {
      enabled = false;
      try { onError(error instanceof Error ? error : new Error(String(error))); }
      catch { /* Consumer error reporting must not break bitmap cleanup. */ }
      return;
    }
    scheduleNext(pollIntervalMs);
  }

  function requestFrame() {
    if (closed || !enabled || !sourceSessionId || pending) return;
    const request = {
      consumerId,
      sessionId: sourceSessionId,
      generation,
      requestId: ++nextRequestId,
    };
    pending = request;
    try { channel.postMessage({ type: 'pull', ...request }); }
    catch (error) {
      pending = null;
      failRequest(error);
      return;
    }
    timer = setTimeoutFn(() => {
      timer = null;
      if (!isCurrentPending(request)) return;
      pending = null;
      try { channel.postMessage({ type: 'cancel', ...request }); } catch { /* Retry path is bounded. */ }
      failRequest(new Error('Timed out waiting for a video frame.'));
    }, requestTimeoutMs);
  }

  function isCurrentPending(request) {
    return pending?.consumerId === request.consumerId && pending.requestId === request.requestId
      && pending.generation === request.generation && pending.sessionId === request.sessionId;
  }

  function onMessage(event) {
    const message = event.data;
    if (!message || message.consumerId !== consumerId || !pending || !isCurrentPending(message)) {
      if (message?.type === 'frame') message.bitmap?.close?.();
      return;
    }
    if (message.type === 'empty') {
      pending = null;
      clearTimer();
      failures = 0;
      scheduleNext();
      return;
    }
    if (message.type === 'error') {
      pending = null;
      clearTimer();
      failRequest(new Error(typeof message.message === 'string' ? message.message : 'Video frame capture failed.'));
      return;
    }
    if (message.type !== 'frame') return;
    const request = pending;
    pending = null;
    clearTimer();
    const bitmap = message.bitmap;
    const dimensionsValid = Number.isFinite(message.width) && message.width > 0
      && Number.isFinite(message.height) && message.height > 0
      && bitmap && typeof bitmap.close === 'function';
    let callbackError = null;
    try {
      if (!dimensionsValid) {
        failRequest(new Error('Received an invalid video frame.'));
        return;
      }
      if (closed || !enabled || request.generation !== generation || request.sessionId !== sourceSessionId) {
        return;
      }
      failures = 0;
      onFrame(bitmap, { sessionId: request.sessionId, width: message.width, height: message.height });
    } catch (error) {
      callbackError = error instanceof Error ? error : new Error(String(error));
    } finally {
      bitmap?.close?.();
      if (callbackError) {
        enabled = false;
        clearTimer();
        try { onError(callbackError); } catch { /* Keep transport shutdown independent from error reporting. */ }
      }
      scheduleNext();
    }
  }

  channel.addEventListener?.('message', onMessage);
  if (!channel.addEventListener) channel.onmessage = onMessage;

  function setSource(sessionId) {
    const nextSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
    if (nextSessionId === sourceSessionId) return;
    cancelPending();
    sourceSessionId = nextSessionId;
    generation += 1;
    failures = 0;
    if (enabled && sourceSessionId) requestFrame();
  }

  function setEnabled(value) {
    const nextEnabled = Boolean(value);
    if (nextEnabled === enabled) return;
    enabled = nextEnabled;
    failures = 0;
    if (enabled) requestFrame();
    else { clearTimer(); cancelPending(); }
  }

  function close() {
    if (closed) return;
    enabled = false;
    clearTimer();
    cancelPending();
    closed = true;
    channel.removeEventListener?.('message', onMessage);
    channel.onmessage = null;
    channel.close();
  }

  return Object.freeze({ setSource, setEnabled, close });
}

function validateChannelName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new TypeError('A valid media channel name is required.');
}

function isPullMessage(message) {
  return message?.type === 'pull' && typeof message.consumerId === 'string'
    && message.consumerId.length > 0 && message.consumerId.length <= MAX_CONSUMER_ID_LENGTH
    && typeof message.sessionId === 'string' && message.sessionId.length > 0
    && Number.isSafeInteger(message.generation) && message.generation >= 0
    && Number.isSafeInteger(message.requestId) && message.requestId > 0;
}

function matchesRequest(left, right) {
  return left.consumerId === right.consumerId && left.sessionId === right.sessionId
    && left.generation === right.generation && left.requestId === right.requestId;
}

function defaultId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
