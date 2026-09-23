const SOURCE_STATUSES = new Set(['preparing', 'ready', 'running', 'stalled', 'disconnected', 'error']);
const STATE_KEYS = [
  'sourceStatus', 'sourceCompatible', 'displayConfirmed', 'rendererReady',
  'armed', 'blackout', 'hold', 'sceneRevision',
];
const READY_KEYS = ['sourceCompatible', 'displayConfirmed', 'rendererReady'];

export function createOutputState() {
  return {
    sourceStatus: 'disconnected',
    sourceCompatible: false,
    displayConfirmed: false,
    rendererReady: false,
    armed: false,
    blackout: false,
    hold: false,
    sceneRevision: 0,
  };
}

export function getOutputMode(state) {
  validateState(state);
  if (state.blackout || !isReady(state) || !state.armed) return 'black';
  return state.hold ? 'held' : 'live';
}

export function transitionOutput(state, event) {
  validateState(state);
  validateEvent(event);

  const next = { ...state };
  switch (event.type) {
    case 'source-status':
      next.sourceStatus = event.status;
      if (event.status !== 'running') {
        next.armed = false;
        next.hold = false;
      }
      break;
    case 'source-compatible':
      next.sourceCompatible = event.compatible;
      if (!event.compatible) disarm(next);
      break;
    case 'display-confirmed':
      next.displayConfirmed = event.confirmed;
      if (!event.confirmed) disarm(next);
      break;
    case 'renderer-ready':
      next.rendererReady = event.ready;
      if (!event.ready) disarm(next);
      break;
    case 'resume':
      if (!isReady(state)) throw new RangeError('Output is not ready to resume');
      next.armed = true;
      break;
    case 'stop':
      next.armed = false;
      next.hold = false;
      break;
    case 'blackout':
      next.blackout = event.enabled;
      break;
    case 'hold':
      if (event.enabled && (!state.armed || !isReady(state))) {
        throw new RangeError('Output is not ready to hold');
      }
      next.hold = event.enabled;
      break;
    case 'scene-revision':
      next.sceneRevision = Math.max(state.sceneRevision, event.revision);
      break;
  }
  return next;
}

function isReady(state) {
  return state.sourceStatus === 'running' && READY_KEYS.every((key) => state[key]);
}

function disarm(state) {
  state.armed = false;
  state.hold = false;
}

function validateState(state) {
  if (!isPlainRecord(state) || !hasExactKeys(state, STATE_KEYS)) {
    throw new RangeError('Invalid output state shape');
  }
  if (!SOURCE_STATUSES.has(state.sourceStatus)
    || typeof state.sourceCompatible !== 'boolean'
    || typeof state.displayConfirmed !== 'boolean'
    || typeof state.rendererReady !== 'boolean'
    || typeof state.armed !== 'boolean'
    || typeof state.blackout !== 'boolean'
    || typeof state.hold !== 'boolean'
    || !Number.isSafeInteger(state.sceneRevision)
    || state.sceneRevision < 0) {
    throw new RangeError('Invalid output state value');
  }
  if ((state.armed || state.hold) && !isReady(state)) {
    throw new RangeError('Incoherent output state');
  }
  if (state.hold && !state.armed) throw new RangeError('Incoherent output state');
}

function validateEvent(event) {
  if (!isPlainRecord(event) || typeof event.type !== 'string') {
    throw new RangeError('Invalid output event');
  }
  const fields = {
    'source-status': ['type', 'status'],
    'source-compatible': ['type', 'compatible'],
    'display-confirmed': ['type', 'confirmed'],
    'renderer-ready': ['type', 'ready'],
    resume: ['type'],
    stop: ['type'],
    blackout: ['type', 'enabled'],
    hold: ['type', 'enabled'],
    'scene-revision': ['type', 'revision'],
  }[event.type];
  if (!fields || !hasExactKeys(event, fields)) throw new RangeError('Invalid output event shape');
  if (event.type === 'source-status' && !SOURCE_STATUSES.has(event.status)) {
    throw new RangeError('Invalid source status');
  }
  if (['source-compatible', 'display-confirmed', 'renderer-ready', 'blackout', 'hold'].includes(event.type)
    && typeof event[event.type === 'source-compatible' ? 'compatible'
      : event.type === 'display-confirmed' ? 'confirmed'
        : event.type === 'renderer-ready' ? 'ready' : 'enabled'] !== 'boolean') {
    throw new RangeError('Expected a boolean event value');
  }
  if (event.type === 'scene-revision'
    && (!Number.isSafeInteger(event.revision) || event.revision < 0)) {
    throw new RangeError('Invalid scene revision');
  }
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record, expected) {
  const keys = Reflect.ownKeys(record);
  return keys.length === expected.length && keys.every((key) => typeof key === 'string' && expected.includes(key));
}
