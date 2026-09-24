import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeWhipSdp } from './whip-sdp.mjs';

export const MAX_SIGNALING_BODY_BYTES = 512 * 1024;
export const MAX_SIGNALING_SDP_LENGTH = 256 * 1024;
export const SIGNALING_OFFER_TIMEOUT_MS = 20_000;
export const SIGNALING_BODY_TIMEOUT_MS = 5_000;

const SAFE_CALLBACK_STATUSES = new Set([400, 409, 503]);
const FIXED_ERRORS = new Map([
  [400, 'Invalid offer.'],
  [401, 'Unauthorized.'],
  [403, 'Request origin is not allowed.'],
  [404, 'Not found.'],
  [405, 'Method not allowed.'],
  [408, 'Request timed out.'],
  [413, 'Request body is too large.'],
  [415, 'Content type must be application/json.'],
  [409, 'Receiver is busy or not ready.'],
  [422, 'WebRTC media negotiation is not supported.'],
  [500, 'Internal server error.'],
  [503, 'Signaling server is unavailable.'],
  [504, 'Offer timed out.'],
]);

class HttpError extends Error {
  constructor(statusCode, message = FIXED_ERRORS.get(statusCode)) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function startSignalingServer({
  host = '127.0.0.1',
  port = 19840,
  acceptOffer = async () => { throw new HttpError(503); },
  isBusy = () => false,
  disconnect = async () => {},
  assets = new Map(),
  offerTimeoutMs = SIGNALING_OFFER_TIMEOUT_MS,
  bodyTimeoutMs = SIGNALING_BODY_TIMEOUT_MS,
  tls,
} = {}) {
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Invalid signaling bind address');
  }
  if (typeof acceptOffer !== 'function' || typeof isBusy !== 'function' || typeof disconnect !== 'function') {
    throw new TypeError('Signaling callbacks must be functions');
  }
  const allowedAssets = validateAssets(assets);
  const secure = tls !== undefined;
  if (secure && (!tls || !tls.cert || !tls.key || (typeof tls.cert !== 'string' && !Buffer.isBuffer(tls.cert))
    || (typeof tls.key !== 'string' && !Buffer.isBuffer(tls.key)))) {
    throw new TypeError('TLS requires PEM certificate and private key');
  }
  const token = randomBytes(32).toString('hex');
  const server = secure ? createSecureServer({ cert: tls.cert, key: tls.key }) : createServer();
  server.on('error', () => {});
  server.headersTimeout = Math.max(1_000, Math.min(bodyTimeoutMs + 1_000, 10_000));
  server.requestTimeout = Math.max(server.headersTimeout + 1_000, 30_000);
  server.keepAliveTimeout = 2_000;
  server.maxRequestsPerSocket = 20;

  let activeOffer = null;
  let currentLease = null;
  let currentLeaseKind = null;
  let disconnecting = false;
  let closePromise = null;
  let closed = false;
  let origin;
  let hostAuthorities;

  server.on('request', (request, response) => {
    try { handleRequest(request, response); }
    catch { sendError(response, new HttpError(500), request); }
  });

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeHttpServer(server);
    throw new Error('Signaling server did not bind a TCP address');
  }
  const actualHost = address.address;
  const publicHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  origin = `${secure ? 'https' : 'http'}://${publicHost}:${address.port}`;
  const authorities = new Set([authority(host, address.port), authority(actualHost, address.port)]);
  if (isLoopbackHost(host) || isLoopbackHost(actualHost)) authorities.add(`localhost:${address.port}`);
  hostAuthorities = authorities;

  function handleRequest(request, response) {
    setSecurityHeaders(response);
    const reject = statusCode => sendError(response, new HttpError(statusCode), request);
    if (closed) return reject(503);
    if (!hostAuthorities.has(String(request.headers.host ?? '').toLowerCase())) {
      return reject(403);
    }
    const requestOrigin = request.headers.origin;

    let url;
    try {
      if (typeof request.url !== 'string' || !request.url.startsWith('/')) throw new Error('Invalid target');
      url = new URL(request.url, origin);
      if (url.origin !== origin) throw new Error('Invalid target');
    } catch {
      return reject(400);
    }
    const isWhipPath = url.pathname === '/whip' || url.pathname.startsWith('/whip/');
    if (!isWhipPath && requestOrigin !== undefined && requestOrigin !== origin) return reject(403);

    if (url.pathname === '/whip') {
      setWhipCors(response, requestOrigin);
      if (request.method === 'OPTIONS') {
        response.setHeader('accept-post', 'application/sdp');
        response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
        response.setHeader('access-control-allow-headers', 'Authorization, Content-Type');
        response.writeHead(200, { 'content-length': 0 });
        return response.end();
      }
      if (request.method === 'GET') {
        if (!hasValidBearer(request, token)) return reject(401);
        response.writeHead(204, { 'content-length': 0 });
        return response.end();
      }
      if (request.method === 'POST') {
        if (!hasValidBearer(request, token)) return reject(401);
        return handleWhipOffer(request, response);
      }
      response.setHeader('allow', 'GET, POST, OPTIONS');
      return reject(405);
    }
    const whipSession = /^\/whip\/session\/([a-f0-9]{32})$/.exec(url.pathname);
    if (whipSession) {
      setWhipCors(response, requestOrigin);
      if (request.method === 'OPTIONS') {
        response.setHeader('access-control-allow-methods', 'GET, DELETE, OPTIONS');
        response.setHeader('access-control-allow-headers', 'Authorization');
        response.writeHead(200, { 'content-length': 0 });
        return response.end();
      }
      if (!hasValidBearer(request, token)) return reject(401);
      if (request.method === 'GET') {
        if (currentLeaseKind !== 'whip' || currentLease !== whipSession[1]) return sendError(response, new HttpError(404), request);
        response.writeHead(204, { 'content-length': 0 });
        return response.end();
      }
      if (request.method === 'DELETE') return handleWhipDisconnect(request, response, whipSession[1]);
      response.setHeader('allow', 'GET, DELETE, OPTIONS');
      return reject(405);
    }
    if (url.pathname.startsWith('/whip/')) return reject(404);

    if (url.pathname === '/api/info') {
      if (request.method !== 'GET') return reject(405);
      return sendJson(response, 200, { name: 'headinjar', protocol: 1 });
    }
    if (url.pathname === '/api/offer') {
      if (request.method !== 'POST') return reject(405);
      if (!hasValidBearer(request, token)) return reject(401);
      return handleOffer(request, response);
    }
    if (url.pathname === '/api/session') {
      if (request.method !== 'DELETE') return reject(405);
      if (!hasValidBearer(request, token)) return reject(401);
      return handleDisconnect(request, response);
    }
    if (url.pathname === '/sender' || url.pathname === '/webrtc-sender.mjs') {
      if (request.method !== 'GET') return reject(405);
      const asset = allowedAssets.get(url.pathname);
      if (!asset) return reject(404);
      if (url.pathname === '/sender' && /^text\/html(?:;|$)/i.test(asset.contentType)) {
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; object-src 'none'; base-uri 'none'");
      }
      response.writeHead(200, { 'content-type': asset.contentType, 'content-length': asset.body.length });
      response.end(asset.body);
      return;
    }
    return reject(404);
  }

  function handleOffer(request, response) {
    if (activeOffer || disconnecting) return sendError(response, new HttpError(409), request);
    const operation = { controller: new AbortController(), response, request };
    activeOffer = operation;
    const abortForDisconnect = () => abortOperation(operation, new Error('Client disconnected'));
    const abortForResponseClose = () => {
      if (!response.writableEnded) abortForDisconnect();
    };
    request.once('aborted', abortForDisconnect);
    response.once('close', abortForResponseClose);

    void processOffer(operation).then(answer => {
      if (response.destroyed || operation.controller.signal.aborted) {
        clearOwnedLease(operation);
        return;
      }
      response.setHeader('X-Headinjar-Session', operation.lease);
      sendJson(response, 200, answer);
    }).catch(error => {
      clearOwnedLease(operation);
      const mayReportCancellation = operation.timeoutError || operation.cancelledByDelete || operation.internalFailure;
      if (!response.destroyed && (!operation.controller.signal.aborted || mayReportCancellation)) sendError(response, error, request);
    }).finally(() => {
      request.off('aborted', abortForDisconnect);
      response.off('close', abortForResponseClose);
      if (activeOffer === operation) activeOffer = null;
    });
  }

  async function processOffer(operation) {
    try {
      const { request } = operation;
      const contentType = String(request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') throw new HttpError(415);
      const contentEncoding = String(request.headers['content-encoding'] ?? 'identity').toLowerCase();
      if (contentEncoding !== 'identity') throw new HttpError(415);
      const declaredLength = Number(request.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SIGNALING_BODY_BYTES) throw new HttpError(413);

      const body = await readRequestBody(request, operation.controller.signal, bodyTimeoutMs);
      const parsed = parseJsonBody(body);
      const offer = validateOffer(parsed);
      if (await isBusy()) throw new HttpError(409);
      operation.lease = randomBytes(16).toString('hex');
      currentLease = operation.lease;
      currentLeaseKind = 'json';
      const answer = await acceptWithDeadline(offer, operation, acceptOffer, offerTimeoutMs);
      return validateAnswer(answer);
    } catch (error) {
      if (operation.lease) {
        operation.internalFailure = true;
        abortOperation(operation, new Error('Invalid signaling answer or failed session'));
      }
      clearOwnedLease(operation);
      if (operation.controller.signal.aborted && !error?.statusCode) throw new HttpError(503);
      if (error instanceof HttpError) throw error;
      const statusCode = SAFE_CALLBACK_STATUSES.has(error?.statusCode) ? error.statusCode : 500;
      throw new HttpError(statusCode, callbackMessage(error, statusCode));
    }
  }

  function handleWhipOffer(request, response) {
    if (activeOffer || disconnecting) return sendError(response, new HttpError(409), request);
    const operation = { controller: new AbortController(), response, request };
    activeOffer = operation;
    const abort = () => abortOperation(operation, new Error('Client disconnected'));
    const close = () => { if (!response.writableEnded) abort(); };
    request.once('aborted', abort);
    response.once('close', close);
    void processWhipOffer(operation).then(answer => {
      if (response.destroyed || operation.controller.signal.aborted) { clearOwnedLease(operation); return; }
      response.setHeader('location', `/whip/session/${operation.lease}`);
      response.writeHead(201, { 'content-type': 'application/sdp', 'content-length': Buffer.byteLength(answer.sdp) });
      response.end(answer.sdp);
    }).catch(error => {
      clearOwnedLease(operation);
      if (!response.destroyed && (!operation.controller.signal.aborted || operation.internalFailure || operation.timeoutError || operation.cancelledByDelete)) sendError(response, error, request);
    }).finally(() => {
      request.off('aborted', abort);
      response.off('close', close);
      if (activeOffer === operation) activeOffer = null;
    });
  }

  async function processWhipOffer(operation) {
    try {
      const contentType = String(operation.request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/sdp') throw new HttpError(415, 'Content type must be application/sdp.');
      if (String(operation.request.headers['content-encoding'] ?? 'identity').toLowerCase() !== 'identity') throw new HttpError(415, 'Unsupported WHIP request encoding.');
      const declaredLength = Number(operation.request.headers['content-length']);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_SIGNALING_SDP_LENGTH) throw new HttpError(413);
      const body = await readRequestBody(operation.request, operation.controller.signal, bodyTimeoutMs, MAX_SIGNALING_SDP_LENGTH);
      let sdp;
      try { sdp = normalizeWhipSdp(decodeSdp(body), MAX_SIGNALING_SDP_LENGTH); }
      catch (error) {
        if (error instanceof RangeError) throw new HttpError(413);
        throw error;
      }
      const offer = validateWhipOffer(sdp);
      if (await isBusy()) throw new HttpError(409);
      return await acceptWhip(offer, operation);
    } catch (error) {
      const alreadyAborted = operation.controller.signal.aborted;
      if (operation.lease) {
        operation.internalFailure = true;
        abortOperation(operation, new Error('Invalid WHIP answer or failed WHIP session'));
      }
      clearOwnedLease(operation);
      if (alreadyAborted && !error?.statusCode) throw operation.timeoutError ?? new HttpError(503);
      if (error instanceof HttpError) throw error;
      const statusCode = SAFE_CALLBACK_STATUSES.has(error?.statusCode) ? error.statusCode : operation.lease ? 422 : 500;
      throw new HttpError(statusCode, callbackMessage(error, statusCode));
    }
  }

  async function acceptWhip(offer, operation) {
    operation.lease = randomBytes(16).toString('hex');
    currentLease = operation.lease;
    currentLeaseKind = 'whip';
    const answer = await acceptWithDeadline(offer, operation, acceptOffer, offerTimeoutMs);
    let checkedAnswer;
    try { checkedAnswer = validateAnswer(answer); }
    catch { throw new HttpError(422); }
    const valid = validateWhipAnswer(checkedAnswer.sdp, offer.sdp);
    return { type: 'answer', sdp: valid };
  }

  async function handleWhipDisconnect(request, response, lease) {
    if (currentLeaseKind !== 'whip' || !currentLease || lease !== currentLease) return sendError(response, new HttpError(404), request);
    return disconnectLease(response, lease);
  }

  async function handleDisconnect(request, response) {
    const lease = request.headers['x-headinjar-session'];
    if (typeof lease !== 'string' || !/^[a-f0-9]{32}$/.test(lease) || currentLeaseKind !== 'json' || !currentLease || lease !== currentLease) {
      return sendError(response, new HttpError(409), request);
    }
    return disconnectLease(response, lease);
  }

  async function disconnectLease(response, lease) {
    const leaseKind = currentLeaseKind;
    currentLease = null;
    currentLeaseKind = null;
    disconnecting = true;
    try {
      if (activeOffer?.lease === lease) {
        const operation = activeOffer;
        operation.cancelledByDelete = true;
        abortOperation(operation, new Error('Session disconnected'));
        activeOffer = null;
      }
      await disconnect();
      if (!response.destroyed) {
        response.writeHead(204, { 'content-length': 0 });
        response.end();
      }
    } catch {
      if (!closed && currentLease === null) {
        currentLease = lease;
        currentLeaseKind = leaseKind;
      }
      sendError(response, new HttpError(503));
    } finally {
      disconnecting = false;
    }
  }

  function clearOwnedLease(operation) {
    if (operation.lease && currentLease === operation.lease) { currentLease = null; currentLeaseKind = null; }
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    currentLease = null;
    currentLeaseKind = null;
    if (activeOffer) {
      abortOperation(activeOffer, new Error('Signaling server closed'));
      activeOffer = null;
    }
    closePromise = Promise.allSettled([
      Promise.resolve().then(() => disconnect()),
      closeHttpServer(server),
    ]).then(results => {
      const closeFailure = results[1];
      if (closeFailure.status === 'rejected') throw closeFailure.reason;
      if (results[0].status === 'rejected') throw results[0].reason;
    });
    return closePromise;
  }

  return Object.freeze({ origin, token, whipUrl: `${origin}/whip`, connectionUrl: `${origin}/sender#token=${token}`, close });
}

function validateAssets(assets) {
  if (!(assets instanceof Map)) throw new TypeError('assets must be a Map');
  const allowed = new Map();
  for (const [path, asset] of assets) {
    if (!['/sender', '/webrtc-sender.mjs'].includes(path)) continue;
    if (!asset || (typeof asset.body !== 'string' && !Buffer.isBuffer(asset.body))
      || typeof asset.contentType !== 'string' || /[\r\n]/.test(asset.contentType)) {
      throw new TypeError(`Invalid signaling asset for ${path}`);
    }
    allowed.set(path, { body: Buffer.isBuffer(asset.body) ? asset.body : Buffer.from(asset.body), contentType: asset.contentType });
  }
  return allowed;
}

function authority(host, port) {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${bracketed.toLowerCase()}:${port}`;
}

function isLoopbackHost(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
    || normalized.startsWith('127.');
}

function hasValidBearer(request, token) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function setSecurityHeaders(response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
}

function sendJson(response, statusCode, value) {
  if (response.destroyed || response.writableEnded) return;
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  response.end(body);
}

function sendError(response, error, request) {
  if (response.destroyed || response.writableEnded) return;
  const statusCode = Number.isInteger(error?.statusCode) && FIXED_ERRORS.has(error.statusCode) ? error.statusCode : 500;
  if (request && !request.complete) {
    request.pause();
    response.shouldKeepAlive = false;
    response.setHeader('connection', 'close');
  }
  sendJson(response, statusCode, { error: error?.message || FIXED_ERRORS.get(statusCode) });
}

function callbackMessage(error, statusCode) {
  const allowed = typeof error?.publicMessage === 'string' ? error.publicMessage : FIXED_ERRORS.get(statusCode);
  return allowed.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 180) || FIXED_ERRORS.get(statusCode);
}

function readRequestBody(request, signal, timeoutMs, maxBytes = MAX_SIGNALING_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
      signal.removeEventListener('abort', onSignalAbort);
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        request.pause();
        finish(new HttpError(413));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, total));
    const onError = () => finish(new HttpError(400));
    const onAborted = () => finish(new HttpError(503));
    const onSignalAbort = () => finish(new HttpError(503));
    const timer = setTimeout(() => finish(new HttpError(504)), timeoutMs);
    timer.unref?.();
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
    signal.addEventListener('abort', onSignalAbort, { once: true });
    if (signal.aborted) onSignalAbort();
  });
}

function setWhipCors(response, requestOrigin) {
  response.setHeader('access-control-allow-origin', requestOrigin || '*');
  response.setHeader('vary', 'Origin');
  response.setHeader('access-control-max-age', '600');
}

function decodeSdp(buffer) {
  let sdp;
  try { sdp = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new HttpError(400); }
  if (!sdp || sdp.length > MAX_SIGNALING_SDP_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(sdp)) throw new HttpError(400);
  return sdp;
}

const VIDEO_CODECS = new Set(['vp8', 'vp9', 'h264', 'av1', 'av1x', 'h265', 'hevc']);
const AUDIO_CODECS = new Set(['opus', 'pcmu', 'pcma', 'g722', 'isac', 'multiopus', 'aac']);

function parseSdpMedia(sdp) {
  const lines = sdp.split(/\r?\n/).filter(Boolean);
  if (lines[0] !== 'v=0' || !lines.some(line => line.startsWith('o=')) || !lines.some(line => line.startsWith('s='))
    || !lines.some(line => line.startsWith('t='))) throw new HttpError(400);
  const media = [];
  let current = null;
  const sessionDirections = lines.slice(0, lines.findIndex(line => line.startsWith('m=')) < 0 ? lines.length : lines.findIndex(line => line.startsWith('m=')))
    .filter(line => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line));
  for (const line of lines) {
    if (line.startsWith('m=')) {
      const match = /^m=(\S+)\s+(\d+)(?:\/\d+)?\s+(\S+)\s+(.+)$/.exec(line);
      if (!match) throw new HttpError(400);
      const formats = match[4].trim().split(/\s+/);
      if (!formats.length || formats.some(format => !/^\d+$/.test(format))) throw new HttpError(400);
      current = { kind: match[1].toLowerCase(), port: Number(match[2]), protocol: match[3].toUpperCase(), formats, lines: [], bundleOnly: false };
      media.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
      if (line === 'a=bundle-only') current.bundleOnly = true;
    }
  }
  if (!media.length) throw new HttpError(400);
  return media.map(section => {
    if (!/^UDP\/TLS\/RTP\/SAVP/.test(section.protocol) || !Number.isInteger(section.port) || section.port < 0 || section.port > 65535) throw new HttpError(400);
    const maps = new Map();
    for (const line of section.lines) {
      const match = /^a=rtpmap:(\d+)\s+([^/\s]+)\//i.exec(line);
      if (match) maps.set(match[1], match[2].toLowerCase());
    }
    const direction = section.lines.find(line => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line))?.slice(2)
      ?? sessionDirections.at(-1)?.slice(2) ?? 'sendrecv';
    const active = section.port !== 0 || section.bundleOnly;
    const acceptedFormats = section.formats.filter(format => {
      let codec = maps.get(format);
      if (!codec && section.kind === 'audio' && format === '0') codec = 'pcmu';
      if (!codec && section.kind === 'audio' && format === '8') codec = 'pcma';
      return section.kind === 'video' ? VIDEO_CODECS.has(codec) : section.kind === 'audio' ? AUDIO_CODECS.has(codec) : false;
    });
    return { ...section, active, direction, acceptedFormats };
  });
}

function validateWhipOffer(sdp) {
  const media = parseSdpMedia(sdp);
  const videos = media.filter(section => section.kind === 'video');
  if (videos.length !== 1 || !videos[0].active || !videos[0].acceptedFormats.length) throw new HttpError(400);
  for (const section of media) {
    if (!['video', 'audio'].includes(section.kind) || media.filter(item => item.kind === section.kind).length > 1) throw new HttpError(400);
    if (!section.active) {
      if (section.kind === 'video') throw new HttpError(400);
      continue;
    }
    if (!section.acceptedFormats.length || !['sendonly', 'sendrecv'].includes(section.direction)) throw new HttpError(400);
  }
  return { type: 'offer', sdp };
}

function validateWhipAnswer(answerSdp, offerSdp) {
  let offer;
  let answer;
  try { offer = parseSdpMedia(offerSdp); answer = parseSdpMedia(answerSdp); }
  catch { throw new HttpError(422); }
  if (answer.length !== offer.length || answer.some(section => !section.active)) throw new HttpError(422);
  for (let i = 0; i < offer.length; i += 1) {
    const offered = offer[i];
    const negotiated = answer[i];
    if (offered.kind !== negotiated.kind || negotiated.direction !== 'recvonly'
      || !offered.acceptedFormats.some(format => negotiated.formats.includes(format) && negotiated.acceptedFormats.includes(format))) {
      throw new HttpError(422);
    }
  }
  if (!answer.some(section => section.kind === 'video')) throw new HttpError(422);
  return answerSdp;
}

function parseJsonBody(buffer) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new HttpError(400); }
  try { return JSON.parse(text); }
  catch { throw new HttpError(400); }
}

function validateOffer(value) {
  if (!plainObject(value) || Object.keys(value).length !== 2 || value.type !== 'offer'
    || typeof value.sdp !== 'string' || value.sdp.length === 0 || value.sdp.length > MAX_SIGNALING_SDP_LENGTH) {
    throw new HttpError(400);
  }
  return { type: 'offer', sdp: value.sdp };
}

function validateAnswer(value) {
  if (!plainObject(value) || Object.keys(value).length !== 2 || value.type !== 'answer'
    || typeof value.sdp !== 'string' || value.sdp.length === 0 || value.sdp.length > MAX_SIGNALING_SDP_LENGTH) {
    throw new HttpError(500);
  }
  return { type: 'answer', sdp: value.sdp };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function acceptWithDeadline(offer, operation, callback, timeoutMs) {
  const { signal } = operation.controller;
  if (signal.aborted) return Promise.reject(new HttpError(503));
  const callbackPromise = Promise.resolve().then(() => {
    if (signal.aborted) throw new HttpError(503);
    return callback(offer, { signal });
  });
  callbackPromise.catch(() => {});
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(operation.timeoutError ?? new HttpError(503));
    };
    const timer = setTimeout(() => {
      operation.timeoutError = new HttpError(504);
      operation.controller.abort(new Error('Signaling offer timed out'));
      cleanup();
      reject(operation.timeoutError);
    }, timeoutMs);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    callbackPromise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

function abortOperation(operation, reason) {
  if (!operation.controller.signal.aborted) operation.controller.abort(reason);
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    try {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections?.();
    } catch (error) {
      reject(error);
    }
  });
}
