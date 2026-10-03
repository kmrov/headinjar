import test from 'node:test';
import assert from 'node:assert/strict';
import { listLanInterfaces } from '../electron/local-network.mjs';

test('LAN choices contain only private IPv4 interfaces with usable subnets', () => {
  const found = listLanInterfaces({
    eth0: [{ family: 'IPv4', address: '192.168.8.12', cidr: '192.168.8.12/24', internal: false }],
    vpn0: [{ family: 'IPv4', address: '10.1.2.3', cidr: '10.1.2.3/16', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }],
    public0: [{ family: 'IPv4', address: '8.8.8.8', cidr: '8.8.8.8/24', internal: false }],
  });
  assert.deepEqual(found, [
    { name: 'eth0', address: '192.168.8.12', prefixLength: 24 },
    { name: 'vpn0', address: '10.1.2.3', prefixLength: 16 },
  ]);
});
