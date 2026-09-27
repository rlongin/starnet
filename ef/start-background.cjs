'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

function portInUse(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Port check timed out; no process started.')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve(false) : reject(error));
  });
}

async function launch({ directory = __dirname, env = process.env, node = process.execPath,
  probe = portInUse, spawnProcess = spawn } = {}) {
  const port = Number(env.EF_STUDIO_PORT || 8797);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid EF_STUDIO_PORT.');
  const entry = path.join(directory, 'start.cjs');
  if (!fs.existsSync(entry)) throw new Error('EF launcher is missing: ' + entry);
  const logDirectory = path.join(path.resolve(env.EF_STUDIO_DATA || path.join(os.homedir(), '.ef-agent-studio')), 'logs');
  fs.mkdirSync(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, 'startup.log');
  const log = message => fs.appendFileSync(logPath, new Date().toISOString() + ' ' + message + '\n');
  if (await probe(port)) {
    log('Port ' + port + ' is already in use; did not launch another instance.');
    return { started: false, logPath, port };
  }
  const output = fs.openSync(logPath, 'a');
  try {
    const child = spawnProcess(node, [entry], {
      cwd: path.dirname(directory), env, detached: true, windowsHide: true,
      stdio: ['ignore', output, output],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    log('Started EF launcher, PID ' + child.pid + ', from ' + directory + '.');
    return { started: true, logPath, port };
  } finally { fs.closeSync(output); }
}

if (require.main === module) launch().then(result => {
  console.log(result.started ? 'EF Agent Studio launched in the background.' : 'Port already in use; no second instance launched.');
  console.log('Startup log: ' + result.logPath);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { launch, portInUse };
