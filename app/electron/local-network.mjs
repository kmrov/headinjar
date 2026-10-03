import { networkInterfaces } from 'node:os';

export function listLanInterfaces(interfaces = networkInterfaces()) {
  return Object.entries(interfaces).flatMap(([name, addresses]) => (addresses || []).flatMap(item => {
    if (item.family !== 'IPv4' || item.internal || !isPrivateIPv4(item.address)) return [];
    const prefixLength = Number(item.cidr?.split('/')[1]);
    if (!Number.isInteger(prefixLength) || prefixLength < 8 || prefixLength > 32) return [];
    return [{ name, address: item.address, prefixLength }];
  }));
}

function isPrivateIPv4(address) {
  const parts = address?.split('.').map(Number);
  if (!parts || parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
    || parts[0] === 192 && parts[1] === 168;
}
