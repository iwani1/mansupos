/** Simultaneous independent WP-CLI processes on fresh MySQL; never production. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const wp = process.env.MANSU_CI_WP_PATH;
const cli = process.env.MANSU_CI_WP_CLI;
const worker = process.env.MANSU_CI_RACE_WORKER;
if (!wp || !cli || !worker || !fs.existsSync(path.join(wp,'wp-config.php')) ||
    !fs.existsSync(cli) || !fs.existsSync(worker)) {
  throw new Error('Disposable WP/MySQL race dependencies are missing.');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch(stage, dir, kind, side = '', channel = '') {
  const child = spawn('php', [cli, 'eval-file', worker, '--path=' + wp, '--skip-themes'], {
    env: { ...process.env, MANSU_RACE_STAGE: stage, MANSU_RACE_DIR: dir,
      MANSU_RACE_KIND: kind, MANSU_RACE_SIDE: side, MANSU_RACE_CHANNEL: channel },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', x => { output += x.toString(); });
  child.stderr.on('data', x => { output += x.toString(); });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(output) :
      reject(new Error('Race ' + stage + '/' + side + ' exit ' + code + ': ' + output.slice(-2200))));
  });
  // The barrier may reject before we await these worker completions.
  void completed.catch(() => {});
  return { child, completed };
}
async function ready(dir, processes) {
  const deadline = Date.now() + 22000;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(dir, 'ready-a')) &&
        fs.existsSync(path.join(dir, 'ready-b'))) return;
    if (processes.some(p => p.child.exitCode !== null)) break;
    await sleep(15);
  }
  throw new Error('Two independent checkout processes did not reach the shared start barrier.');
}
async function race(i, kind, channels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-woo-concurrent-'));
  const processes = [];
  try {
    await launch('setup', dir, kind).completed;
    const a = launch('worker', dir, kind, 'a', channels[0]);
    const b = launch('worker', dir, kind, 'b', channels[1]);
    processes.push(a, b);
    await ready(dir, processes);
    fs.writeFileSync(path.join(dir, 'start'), 'go', { flag: 'wx' });
    await Promise.all(processes.map(p => p.completed));
    const observations = ['a','b'].map(side =>
      JSON.parse(fs.readFileSync(path.join(dir, 'result-' + side + '.json'), 'utf8')));
    const winners = observations.filter(r => r.success);
    if (winners.length !== 1) {
      throw new Error('Last-unit collision in concurrent race ' + (i + 1) + ': ' + JSON.stringify(observations));
    }
    if (!observations.every(r => r.orderId == null || Number.isSafeInteger(r.orderId))) {
      throw new Error('Invalid original Woo order mapping in concurrent checkout.');
    }
    await launch('verify', dir, kind).completed;
    console.log('REAL_WOO_CONCURRENT_RACE_OK ' + (i + 1) + ' ' + kind + ' ' +
      channels.join('-') + ' winner=' + winners[0].channel + ' exactly-one-owner-hold');
  } finally {
    for (const p of processes) {
      if (p.child.exitCode === null) p.child.kill('SIGKILL');
    }
    await Promise.allSettled(processes.map(p => p.completed));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const cases = [
  ['simple', ['website','pos']],
  ['simple', ['pos','website']],
  ['simple', ['pos','pos']],
  ['simple', ['pos','pos']],
  ['shared', ['website','pos']],
  ['shared', ['pos','website']],
];
for (let i = 0; i < cases.length; i++) await race(i, ...cases[i]);
console.log('REAL_WOO_CONCURRENT_OK ' + cases.length +
  ' two-process, same-last-unit Woo/MySQL races; disposable CI only.');
