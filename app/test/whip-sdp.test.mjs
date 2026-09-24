import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWhipSdp } from '../electron/whip-sdp.mjs';

const incomplete = [
  'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97', 'a=mid:0', 'a=ssrc-group:FID 100 101',
  'a=ssrc:100 cname:sender', 'a=ssrc:100 msid:stream video', '',
].join('\r\n');

const complete = incomplete.replace('a=ssrc:100 msid:stream video\r\n',
  'a=ssrc:100 msid:stream video\r\na=ssrc:101 cname:sender\r\na=ssrc:101 msid:stream video\r\n');

test('copies missing RTX cname and msid from its primary SSRC and stays idempotent', () => {
  const normalized = normalizeWhipSdp(incomplete);
  assert.equal(normalized, complete);
  assert.equal(normalizeWhipSdp(normalized), normalized);
});

test('preserves explicit RTX metadata rather than overwriting it', () => {
  const source = incomplete.replace('a=ssrc:100 msid:stream video\r\n',
    'a=ssrc:100 msid:stream video\r\na=ssrc:101 cname:explicit\r\na=ssrc:101 msid:own-stream own-track\r\n');
  assert.equal(normalizeWhipSdp(source), source);
});

test('copies only from a primary in the same video media section', () => {
  const source = [
    'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97', 'a=ssrc-group:FID 100 101',
    'm=video 9 UDP/TLS/RTP/SAVPF 98 99', 'a=ssrc-group:FID 200 201',
    'a=ssrc:200 cname:second', 'a=ssrc:200 msid:second-stream second-track', '',
  ].join('\r\n');
  const expected = source.replace('a=ssrc:200 msid:second-stream second-track\r\n',
    'a=ssrc:200 msid:second-stream second-track\r\na=ssrc:201 cname:second\r\na=ssrc:201 msid:second-stream second-track\r\n');
  assert.equal(normalizeWhipSdp(source), expected);
});

test('ends a video section before following audio and never copies audio FID metadata', () => {
  const source = [
    'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97', 'a=ssrc-group:FID 100 101',
    'a=ssrc:100 cname:video', 'a=ssrc:100 msid:video-stream video-track',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=ssrc-group:FID 200 201',
    'a=ssrc:200 cname:audio', 'a=ssrc:200 msid:audio-stream audio-track', '',
  ].join('\r\n');
  const expected = source.replace('m=audio',
    'a=ssrc:101 cname:video\r\na=ssrc:101 msid:video-stream video-track\r\nm=audio');
  assert.equal(normalizeWhipSdp(source), expected);
  assert.ok(!normalizeWhipSdp(source).includes('a=ssrc:201'));
});

test('rejects normalization when copied metadata would exceed the SDP size limit', () => {
  const groups = Array.from({ length: 5 }, (_, index) => `a=ssrc-group:FID 100 ${200 + index}`);
  const source = [
    'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97', ...groups,
    'a=ssrc:100 cname:sender', `a=ssrc:100 msid:stream ${'x'.repeat(60_000)}`, '',
  ].join('\r\n');
  assert.ok(source.length < 256 * 1024);
  assert.throws(() => normalizeWhipSdp(source), /size limit/);
});

test('measures normalized SDP size in UTF-8 bytes for multibyte metadata', () => {
  const source = [
    'v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97', 'a=ssrc-group:FID 100 101',
    'a=ssrc:100 cname:sender', `a=ssrc:100 msid:stream ${'é'.repeat(100)}`, '',
  ].join('\r\n');
  const maxLength = Buffer.byteLength(source, 'utf8') + 120;
  assert.ok(source.length < maxLength);
  assert.throws(() => normalizeWhipSdp(source, maxLength), /size limit/);
});
