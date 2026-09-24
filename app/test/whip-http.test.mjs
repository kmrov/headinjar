import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSignalingServer } from '../electron/signaling-server.mjs';

const offerSdp = [
  'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96', 'c=IN IP4 0.0.0.0', 'a=mid:0', 'a=sendonly', 'a=rtpmap:96 H264/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'c=IN IP4 0.0.0.0', 'a=mid:1', 'a=sendonly', 'a=rtpmap:111 opus/48000/2', '',
].join('\r\n');
const answerSdp = offerSdp.replaceAll('a=sendonly', 'a=recvonly');

test('WHIP POST returns complete SDP with a lease URL; GET, OPTIONS, DELETE and stale leases follow the resource contract', async t => {
  let disconnects = 0;
  const server = await startSignalingServer({ port: 0, acceptOffer: async offer => {
    assert.deepEqual(offer, { type: 'offer', sdp: offerSdp });
    return { type: 'answer', sdp: answerSdp };
  }, disconnect: async () => { disconnects += 1; } });
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/sdp' };
  const post = await fetch(`${server.origin}/whip`, { method: 'POST', headers, body: offerSdp });
  assert.equal(post.status, 201);
  assert.equal(post.headers.get('content-type'), 'application/sdp');
  assert.equal(await post.text(), answerSdp);
  const location = post.headers.get('location');
  assert.match(location, /^\/whip\/session\/[a-f0-9]{32}$/);
  const lease = location.split('/').at(-1);
  assert.equal((await fetch(`${server.origin}${location}`, { headers: { authorization: headers.authorization } })).status, 204);
  const preflight = await fetch(`${server.origin}/whip`, { method: 'OPTIONS', headers: {
    origin: 'https://sender.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type',
  } });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://sender.example');
  assert.equal(preflight.headers.get('accept-post'), 'application/sdp');
  assert.equal((await fetch(`${server.origin}/whip`, { headers: { authorization: headers.authorization } })).status, 204);
  assert.equal((await fetch(`${server.origin}${location}`, { method: 'DELETE', headers: { authorization: headers.authorization } })).status, 204);
  assert.equal(disconnects, 1);
  assert.equal((await fetch(`${server.origin}${location}`, { method: 'DELETE', headers: { authorization: headers.authorization } })).status, 404);
  assert.ok(lease);
});

test('WHIP requires bearer auth and valid active video RTP SDP, while unsupported methods and oversized SDP are bounded', async t => {
  const server = await startSignalingServer({ port: 0, acceptOffer: async () => ({ type: 'answer', sdp: answerSdp }) });
  t.after(() => server.close());
  const auth = { authorization: `Bearer ${server.token}` };
  assert.equal((await fetch(`${server.origin}/whip`, { method: 'POST', headers: { 'content-type': 'application/sdp' }, body: offerSdp })).status, 401);
  assert.equal((await fetch(`${server.origin}/whip`, { method: 'PATCH', headers: auth })).status, 405);
  assert.match((await fetch(`${server.origin}/whip`, { method: 'PATCH', headers: auth })).headers.get('allow'), /POST/);
  assert.equal((await fetch(`${server.origin}/whip`, { method: 'POST', headers: { ...auth, 'content-type': 'application/sdp' }, body: 'v=0\r\n' })).status, 400);
  assert.equal((await fetch(`${server.origin}/whip`, { method: 'POST', headers: { ...auth, 'content-type': 'application/sdp' }, body: offerSdp.replace('H264/90000', 'unknown/90000') })).status, 400);
  assert.equal((await fetch(`${server.origin}/whip`, { method: 'POST', headers: { ...auth, 'content-type': 'application/sdp' }, body: 'x'.repeat(256 * 1024 + 1) })).status, 413);
  const wrongType = await fetch(`${server.origin}/whip`, { method: 'POST', headers: { ...auth, 'content-type': 'text/plain' }, body: offerSdp });
  assert.equal(wrongType.status, 415);
  assert.match((await wrongType.json()).error, /application\/sdp/);
});

test('WHIP shares exclusivity with JSON and an invalid answer is returned after aborting its session', async t => {
  let aborted = false;
  let release;
  let firstOffer = true;
  const server = await startSignalingServer({ port: 0, acceptOffer: (offer, { signal }) => {
    if (firstOffer) { firstOffer = false; return new Promise(resolve => { release = resolve; }); }
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return { type: 'answer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\n' };
  } });
  t.after(() => server.close());
  const pending = fetch(`${server.origin}/whip`, { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/sdp',
  }, body: offerSdp });
  await waitFor(() => Boolean(release));
  const legacy = await fetch(`${server.origin}/api/offer`, { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ type: 'offer', sdp: 'v=0' }) });
  assert.equal(legacy.status, 409);
  release({ type: 'answer', sdp: answerSdp });
  assert.equal((await pending).status, 201);

  const invalid = await fetch(`${server.origin}/whip`, { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/sdp',
  }, body: offerSdp });
  assert.equal(invalid.status, 422);
  assert.equal(aborted, true);
});

test('WHIP callback SDP rejection returns 422 and cancels the rejected runtime', async t => {
  let aborted = false;
  const server = await startSignalingServer({ port: 0, acceptOffer: (_offer, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    throw new Error('Chromium rejected the remote SDP');
  } });
  t.after(() => server.close());
  const response = await fetch(`${server.origin}/whip`, { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/sdp',
  }, body: offerSdp });
  assert.equal(response.status, 422);
  assert.equal(aborted, true);
});

test('WHIP normalizes missing RTX SSRC metadata before invoking the receiver callback', async t => {
  const original = [
    'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:0', 'a=sendonly', 'a=rtpmap:111 opus/48000/2',
    'm=video 9 UDP/TLS/RTP/SAVPF 106 105', 'a=mid:1', 'a=sendonly', 'a=rtpmap:106 H264/90000',
    'a=rtpmap:105 rtx/90000', 'a=fmtp:105 apt=106', 'a=ssrc-group:FID 10 11',
    'a=ssrc:10 cname:sender', 'a=ssrc:10 msid:stream video', '',
  ].join('\r\n');
  const normalized = original.replace('a=ssrc:10 msid:stream video\r\n',
    'a=ssrc:10 msid:stream video\r\na=ssrc:11 cname:sender\r\na=ssrc:11 msid:stream video\r\n');
  const server = await startSignalingServer({ port: 0, acceptOffer: async offer => {
    assert.equal(offer.sdp, normalized);
    return { type: 'answer', sdp: normalized.replaceAll('a=sendonly', 'a=recvonly') };
  } });
  t.after(() => server.close());
  const response = await fetch(server.whipUrl, { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/sdp',
  }, body: original });
  assert.equal(response.status, 201);
});

test('failed WHIP disconnect keeps its lease available for a retry', async t => {
  let disconnects = 0;
  const server = await startSignalingServer({ port: 0, acceptOffer: async () => ({ type: 'answer', sdp: answerSdp }), disconnect: async () => {
    disconnects += 1;
    if (disconnects === 1) throw new Error('temporary disconnect failure');
  } });
  t.after(() => server.close());
  const accepted = await fetch(server.whipUrl, { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/sdp',
  }, body: offerSdp });
  const resource = accepted.headers.get('location');
  const requestHeaders = { authorization: `Bearer ${server.token}` };
  assert.equal((await fetch(`${server.origin}${resource}`, { method: 'DELETE', headers: requestHeaders })).status, 503);
  assert.equal((await fetch(`${server.origin}${resource}`, { headers: requestHeaders })).status, 204);
  assert.equal((await fetch(`${server.origin}${resource}`, { method: 'DELETE', headers: requestHeaders })).status, 204);
  assert.equal(disconnects, 2);
});

test('WHIP timeout returns 504 and client abort releases admission for a later offer', async t => {
  let timeoutAborted = false;
  const timeoutServer = await startSignalingServer({ port: 0, offerTimeoutMs: 20, acceptOffer: (_offer, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => { timeoutAborted = true; reject(signal.reason); }, { once: true });
  }) });
  t.after(() => timeoutServer.close());
  const timeout = await fetch(`${timeoutServer.origin}/whip`, { method: 'POST', headers: {
    authorization: `Bearer ${timeoutServer.token}`, 'content-type': 'application/sdp',
  }, body: offerSdp });
  assert.equal(timeout.status, 504);
  assert.equal(timeoutAborted, true);

  let calls = 0;
  let clientAborted = false;
  const clientServer = await startSignalingServer({ port: 0, offerTimeoutMs: 1000, acceptOffer: (_offer, { signal }) => {
    calls += 1;
    if (calls === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => {
      clientAborted = true;
      reject(signal.reason);
    }, { once: true }));
    return { type: 'answer', sdp: answerSdp };
  } });
  t.after(() => clientServer.close());
  const request = http.request(clientServer.whipUrl, { method: 'POST', headers: {
    authorization: `Bearer ${clientServer.token}`, 'content-type': 'application/sdp', 'content-length': Buffer.byteLength(offerSdp),
  } });
  request.on('error', () => {});
  request.end(offerSdp);
  await waitFor(() => calls === 1);
  request.destroy();
  await waitFor(() => clientAborted);
  const deadline = Date.now() + 1000;
  let later;
  do {
    later = await fetch(clientServer.whipUrl, { method: 'POST', headers: {
      authorization: `Bearer ${clientServer.token}`, 'content-type': 'application/sdp',
    }, body: offerSdp });
    if (later.status === 409) { await later.arrayBuffer(); await new Promise(resolve => setTimeout(resolve, 2)); }
  } while (later.status === 409 && Date.now() < deadline);
  assert.equal(later.status, 201);
  assert.equal(calls, 2);
});

test('a stale WHIP resource cannot DELETE a pending successor or cross-delete a WHIP lease through the legacy route', async t => {
  const resolvers = [];
  let disconnects = 0;
  const server = await startSignalingServer({ port: 0, disconnect: async () => { disconnects += 1; }, acceptOffer: () => new Promise(resolve => resolvers.push(resolve)) });
  t.after(() => server.close());
  const post = () => fetch(`${server.origin}/whip`, { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/sdp',
  }, body: offerSdp });
  const first = post();
  await waitFor(() => resolvers.length === 1);
  resolvers[0]({ type: 'answer', sdp: answerSdp });
  const firstResponse = await first;
  const firstResource = firstResponse.headers.get('location');
  const second = post();
  await waitFor(() => resolvers.length === 2);
  assert.equal((await fetch(`${server.origin}${firstResource}`, { method: 'DELETE', headers: { authorization: `Bearer ${server.token}` } })).status, 404);
  assert.equal((await fetch(`${server.origin}/api/session`, { method: 'DELETE', headers: {
    authorization: `Bearer ${server.token}`, 'x-headinjar-session': firstResource.split('/').at(-1),
  } })).status, 409);
  assert.equal(disconnects, 0);
  resolvers[1]({ type: 'answer', sdp: answerSdp });
  const secondResponse = await second;
  assert.equal(secondResponse.status, 201);
  assert.equal((await fetch(`${server.origin}${secondResponse.headers.get('location')}`, { method: 'DELETE', headers: { authorization: `Bearer ${server.token}` } })).status, 204);
  assert.equal(disconnects, 1);
});

test('TLS mode uses HTTPS for whipUrl and serves a raw SDP exchange; invalid TLS fails closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'headinjar-whip-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const server = await startSignalingServer({ port: 0, tls: { key: await readFile(keyPath), cert: await readFile(certPath) },
    acceptOffer: async () => ({ type: 'answer', sdp: answerSdp }) });
  t.after(() => server.close());
  assert.match(server.origin, /^https:\/\/127\.0\.0\.1:/);
  assert.equal(server.whipUrl, `${server.origin}/whip`);
  const response = await httpsRequest(server.whipUrl, {
    method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/sdp', 'content-length': Buffer.byteLength(offerSdp) },
  }, offerSdp);
  assert.equal(response.statusCode, 201);
  assert.equal(response.body, answerSdp);
  await assert.rejects(startSignalingServer({ port: 0, tls: { cert: 'invalid cert', key: 'invalid key' } }));
  await assert.rejects(startSignalingServer({ port: 0, tls: { cert: 'only cert' } }), /TLS requires/);
});

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { ...options, rejectUnauthorized: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
