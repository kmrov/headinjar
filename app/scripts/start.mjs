import { spawn } from 'node:child_process';
import electron from 'electron';
import { fileURLToPath } from 'node:url';

// Ozone is selected before the main module executes. Pass this at launch.
const args = process.platform === 'linux' ? ['--ozone-platform=x11'] : [];
const child = spawn(electron, [fileURLToPath(new URL('..', import.meta.url)), ...args, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
