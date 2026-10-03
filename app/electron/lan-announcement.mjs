import { spawn as nodeSpawn } from 'node:child_process';

export function startLanAnnouncement({ name, port, address, scheme = 'http', auth = 'local', spawn = nodeSpawn }) {
  if (typeof name !== 'string' || !name || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof address !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)
    || !['http', 'https'].includes(scheme) || !['local', 'bearer'].includes(auth)) {
    throw new TypeError('Invalid LAN announcement');
  }
  const child = spawn('avahi-publish-service', ['-s', name, '_headinjar._tcp', String(port),
    'protocol=1', `auth=${auth}`, 'whip=/whip', `scheme=${scheme}`, `address=${address}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  child.once('exit', () => { exited = true; });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('error', fail);
      child.off('exit', exit);
      child.stdout.off('data', ready);
      child.stderr.off('data', ready);
      if (error) reject(error);
      else resolve({ close: () => new Promise(done => {
        if (exited) return done();
        child.once('exit', done);
        child.kill('SIGTERM');
      }) });
    };
    const fail = error => finish(new Error(`Could not advertise Head in Jar: ${error.message}`));
    const exit = () => finish(new Error('mDNS announcement stopped before registration'));
    const ready = data => { if (String(data).includes('Established under name')) finish(); };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('Timed out advertising Head in Jar over mDNS'));
    }, 5000);
    child.once('error', fail);
    child.once('exit', exit);
    child.stdout.on('data', ready);
    child.stderr.on('data', ready);
  });
}
