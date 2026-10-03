import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startLanAnnouncement } from '../electron/lan-announcement.mjs';

test('advertisement contains no token and ends with its server', async () => {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = signal => { assert.equal(signal, 'SIGTERM'); process.emit('exit', 0); };
  let invocation;
  const pending = startLanAnnouncement({ name: 'Head in Jar', port: 19840, address: '192.168.1.10',
    spawn: (command, args) => { invocation = [command, args]; return process; } });
  process.stderr.emit('data', Buffer.from("Established under name 'Head in Jar'\n"));
  const announcement = await pending;
  assert.equal(invocation[0], 'avahi-publish-service');
  assert.deepEqual(invocation[1], ['-s', 'Head in Jar', '_headinjar._tcp', '19840',
    'protocol=1', 'auth=local', 'whip=/whip', 'scheme=http', 'address=192.168.1.10']);
  await announcement.close();
});

test('protected announcement advertises bearer auth without publishing the token', async () => {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = () => process.emit('exit', 0);
  let args;
  const pending = startLanAnnouncement({ name: 'Head in Jar', port: 19840, address: '192.168.1.10',
    auth: 'bearer', spawn: (_command, value) => { args = value; return process; } });
  process.stderr.emit('data', Buffer.from('Established under name'));
  await (await pending).close();
  assert.ok(args.includes('auth=bearer'));
  assert.equal(args.some(value => value.includes('token=')), false);
});
