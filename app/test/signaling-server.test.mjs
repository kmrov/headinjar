import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startSignalingServer } from '../electron/signaling-server.mjs';

const offer = { type: 'offer', sdp: 'v=0\r\n' };

async function withServer(options, run) {
  const server = await startSignalingServer({ port: 0, ...options });
  try { await run(server); }
  finally { await server.close(); }
}

function postOffer(server, body = offer, extraHeaders = {}) {
  return fetch(`${server.origin}/api/offer`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function requestStatus(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

test('serves only public info and supplied assets with a fragment bearer URL', async () => {
  await withServer({
    assets: new Map([
      ['/sender', { body: '<html>sender</html>', contentType: 'text/html; charset=utf-8' }],
      ['/webrtc-sender.mjs', { body: 'export {};', contentType: 'text/javascript; charset=utf-8' }],
    ]),
  }, async server => {
    assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(server.token, /^[a-f0-9]{64}$/);
    assert.equal(server.connectionUrl, `${server.origin}/sender#token=${server.token}`);

    const info = await fetch(`${server.origin}/api/info`);
    assert.equal(info.status, 200);
    assert.deepEqual(await info.json(), { name: 'headinjar', protocol: 1 });
    assert.match(info.headers.get('cache-control'), /no-store/i);
    assert.equal(info.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(info.headers.get('referrer-policy'), 'no-referrer');

    assert.equal(await requestStatus(`${server.origin}/api/info`, {
      headers: { host: `localhost:${new URL(server.origin).port}` },
    }), 200);

    const page = await fetch(`${server.origin}/sender`);
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<html>sender</html>');
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(`${server.origin}/webrtc-sender.mjs`)).status, 200);
    assert.equal((await fetch(`${server.origin}/not-whitelisted`)).status, 404);
  });
});

test('rejects untrusted host and origin, and requires the per-run bearer for offers', async () => {
  await withServer({ acceptOffer: async () => ({ type: 'answer', sdp: 'v=0\r\n' }) }, async server => {
    assert.equal((await postOffer(server, offer, { authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await postOffer(server, offer, { origin: 'http://evil.example' })).status, 403);
    assert.equal(await requestStatus(`${server.origin}/api/info`, { headers: { host: 'evil.example' } }), 403);
    assert.equal((await postOffer(server, offer, { origin: server.origin })).status, 200);
    const accepted = await postOffer(server);
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get('x-headinjar-session'), /^[a-f0-9]{32}$/);
    assert.deepEqual(await accepted.json(), { type: 'answer', sdp: 'v=0\r\n' });
  });
});

test('rejects unsupported methods, content types, malformed descriptions, and oversized bodies', async () => {
  await withServer({ acceptOffer: async () => ({ type: 'answer', sdp: 'v=0' }) }, async server => {
    assert.equal((await fetch(`${server.origin}/api/offer`, { method: 'GET' })).status, 405);
    assert.equal((await fetch(`${server.origin}/missing`, { method: 'POST' })).status, 404);
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'text/plain' };
    assert.equal((await fetch(`${server.origin}/api/offer`, { method: 'POST', headers, body: 'x' })).status, 415);
    assert.equal((await postOffer(server, '{')).status, 400);
    assert.equal((await postOffer(server, { type: 'answer', sdp: 'v=0' })).status, 400);
    assert.equal((await postOffer(server, { type: 'offer', sdp: 'x'.repeat(256 * 1024 + 1) })).status, 400);
    assert.equal((await postOffer(server, 'x'.repeat(512 * 1024 + 1))).status, 413);
  });
});

test('reserves one pending offer and maps readiness and callback errors to bounded responses', async () => {
  let release;
  await withServer({
    acceptOffer: () => new Promise(resolve => { release = resolve; }),
  }, async server => {
    const first = postOffer(server);
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal((await postOffer(server)).status, 409);
    release({ type: 'answer', sdp: 'v=0' });
    assert.equal((await first).status, 200);
  });

  await withServer({ isBusy: () => true, acceptOffer: async () => assert.fail('must stay busy') }, async server => {
    const response = await postOffer(server);
    assert.equal(response.status, 409);
    assert.ok((await response.text()).length < 300);
  });

  await withServer({ acceptOffer: async () => { const error = new Error('not ready'); error.statusCode = 409; throw error; } }, async server => {
    assert.equal((await postOffer(server)).status, 409);
  });
});

test('aborts the request-owned offer when the client disconnects or its deadline expires', async () => {
  let aborted;
  let accepting = false;
  await withServer({
    acceptOffer: (_offer, { signal }) => new Promise((_, reject) => {
      accepting = true;
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  }, async server => {
    const request = http.request(`${server.origin}/api/offer`, {
      method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    });
    request.on('error', () => {});
    request.write(JSON.stringify(offer));
    request.end();
    while (!accepting) await new Promise(resolve => setTimeout(resolve, 1));
    request.destroy();
    while (!aborted) await new Promise(resolve => setTimeout(resolve, 1));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(aborted, true);
  });

  let timedOut = false;
  await withServer({
    offerTimeoutMs: 20,
    acceptOffer: (_offer, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      timedOut = true;
      reject(signal.reason);
    }, { once: true })),
  }, async server => {
    const response = await postOffer(server);
    assert.equal(response.status, 504);
    assert.equal(timedOut, true);
  });

  let bodyTimedOut = false;
  await withServer({
    bodyTimeoutMs: 20,
    acceptOffer: async () => assert.fail('must not accept incomplete request body'),
  }, async server => {
    const request = http.request(`${server.origin}/api/offer`, {
      method: 'POST', headers: {
        authorization: `Bearer ${server.token}`, 'content-type': 'application/json', 'content-length': '100',
      },
    }, response => {
      bodyTimedOut = response.statusCode === 504;
      response.resume();
    });
    request.on('error', () => {});
    request.write('{');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(bodyTimedOut, true);
    request.destroy();
  });
});

test('DELETE disconnects the session and close cancels pending work and revokes the token', async () => {
  let disconnects = 0;
  const options = {
    port: 0,
    disconnect: async () => { disconnects += 1; },
    acceptOffer: async () => ({ type: 'answer', sdp: 'v=0' }),
  };
  const server = await startSignalingServer(options);
  let replacement;
  try {
    const accepted = await postOffer(server);
    const lease = accepted.headers.get('x-headinjar-session');
    assert.match(lease, /^[a-f0-9]{32}$/);
    const missingLeaseDelete = await fetch(`${server.origin}/api/session`, { method: 'DELETE', headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(missingLeaseDelete.status, 409);
    assert.equal(disconnects, 0);
    const deleted = await fetch(`${server.origin}/api/session`, {
      method: 'DELETE', headers: { authorization: `Bearer ${server.token}`, 'x-headinjar-session': lease },
    });
    assert.equal(deleted.status, 204);
    assert.equal(disconnects, 1);
    const oldOrigin = server.origin;
    const oldToken = server.token;
    await server.close();
    assert.equal(disconnects, 2);

    replacement = await startSignalingServer({ ...options, port: 0 });
    assert.notEqual(replacement.token, oldToken);
    assert.equal((await fetch(`${oldOrigin}/api/info`).catch(() => null)), null);
    assert.equal((await postOffer(replacement, offer, { authorization: `Bearer ${oldToken}` })).status, 401);
  } finally {
    await server.close();
    await replacement?.close();
  }
});

test('reports a fixed-port collision instead of silently binding elsewhere', async () => {
  const first = await startSignalingServer({ port: 0 });
  try {
    const port = Number(new URL(first.origin).port);
    await assert.rejects(startSignalingServer({ port }), error => error?.code === 'EADDRINUSE');
    assert.equal(new URL(first.origin).port, String(port));
  } finally { await first.close(); }
});

test('close aborts a pending offer and disconnects the receiver', async () => {
  let aborted = false;
  let accepting = false;
  let disconnected = 0;
  const server = await startSignalingServer({
    port: 0,
    disconnect: () => { disconnected += 1; },
    acceptOffer: (_offer, { signal }) => {
      accepting = true;
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true }));
    },
  });
  const pending = postOffer(server);
  while (!accepting) await new Promise(resolve => setTimeout(resolve, 1));
  await server.close();
  assert.equal(aborted, true);
  assert.equal(disconnected, 1);
  const response = await pending.catch(() => null);
  assert.equal(response, null);
});

test('DELETE cancels an incomplete offer before it can reach the receiver', async () => {
  let acceptCount = 0;
  let disconnectCount = 0;
  const server = await startSignalingServer({
    port: 0,
    bodyTimeoutMs: 500,
    acceptOffer: async () => { acceptCount += 1; return { type: 'answer', sdp: 'v=0' }; },
    disconnect: async () => { disconnectCount += 1; },
  });
  const request = http.request(`${server.origin}/api/offer`, {
    method: 'POST', headers: {
      authorization: `Bearer ${server.token}`, 'content-type': 'application/json', 'content-length': '100',
    },
  });
  request.on('error', () => {});
  request.write('{');
  request.destroy();
  await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(acceptCount, 0);
  assert.equal(disconnectCount, 0);
  await server.close();
  assert.equal(disconnectCount, 1);
});

test('a stale sender DELETE cannot cancel or disconnect its pending successor', async () => {
  const resolvers = [];
  const signals = [];
  let disconnects = 0;
  const server = await startSignalingServer({
    port: 0,
    disconnect: () => { disconnects += 1; },
    acceptOffer: (_offer, { signal }) => new Promise(resolve => {
      signals.push(signal);
      resolvers.push(resolve);
    }),
  });
  try {
    const first = postOffer(server);
    await waitFor(() => resolvers.length === 1);
    resolvers[0]({ type: 'answer', sdp: 'v=0' });
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    const firstLease = firstResponse.headers.get('x-headinjar-session');

    const successor = postOffer(server);
    await waitFor(() => resolvers.length === 2);
    const staleDelete = await fetch(`${server.origin}/api/session`, {
      method: 'DELETE', headers: {
        authorization: `Bearer ${server.token}`, 'x-headinjar-session': firstLease,
      },
    });
    assert.equal(staleDelete.status, 409);
    assert.equal(signals[1].aborted, false);
    assert.equal(disconnects, 0);

    resolvers[1]({ type: 'answer', sdp: 'v=0' });
    const successorResponse = await successor;
    const successorLease = successorResponse.headers.get('x-headinjar-session');
    assert.equal(successorResponse.status, 200);
    assert.match(successorLease, /^[a-f0-9]{32}$/);
    assert.notEqual(successorLease, firstLease);

    const deleted = await fetch(`${server.origin}/api/session`, {
      method: 'DELETE', headers: {
        authorization: `Bearer ${server.token}`, 'x-headinjar-session': successorLease,
      },
    });
    assert.equal(deleted.status, 204);
    assert.equal(disconnects, 1);
    const replay = await fetch(`${server.origin}/api/session`, {
      method: 'DELETE', headers: {
        authorization: `Bearer ${server.token}`, 'x-headinjar-session': successorLease,
      },
    });
    assert.equal(replay.status, 409);
    assert.equal(disconnects, 1);
  } finally { await server.close(); }
});

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
