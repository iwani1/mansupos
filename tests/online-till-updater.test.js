import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUpdater, readSignature, samePublisher, windowsPowershellEnv, SIGNATURE_SCRIPT, INSTALL_ARGS } = require('../desktop/online/updater.cjs');
const { newerRelease, TILL } = require('../desktop/online/policy.cjs');

const SHOP = 'CN=MansutRENDZGH, O=MansutRENDZGH, L=Accra, C=GH';
const installer = Buffer.from('MZ fake signed installer bytes');
const hash = crypto.createHash('sha256').update(installer).digest('hex');
const release = { version: '2.1.0', url: 'https://mansupos.com/download/Mansu-POS-2.1.0.exe', sha256: hash };

// Fake world: PowerShell answers per file, fetch serves the installer, spawn records the call.
function world({ platform = 'win32', own = { status: 'Valid', subject: SHOP }, candidate = { status: 'Valid', subject: SHOP },
  body = installer, finalUrl = release.url, status = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mansu-updater-'));
  const calls = { run: [], spawn: [], fetch: [] };
  const run = async (command, args, { env }) => {
    calls.run.push({ command, args, file: env.MANSU_SIGNED_FILE });
    const answer = env.MANSU_SIGNED_FILE === 'C:\\Mansu POS\\Mansu POS.exe' ? own : candidate;
    return JSON.stringify(answer);
  };
  const fetch = async (url, options) => {
    calls.fetch.push({ url, options });
    return { ok: status === 200, status, url: finalUrl, headers: new Map([['content-length', String(body.length)]]), arrayBuffer: async () => body };
  };
  const spawn = (file, args, options) => { calls.spawn.push({ file, args, options }); return { unref() {} }; };
  const updater = createUpdater({ platform, execPath: 'C:\\Mansu POS\\Mansu POS.exe', updatesDir: path.join(dir, 'updates'),
    downloadHosts: TILL.downloadHosts, fetch, run, spawn, fs });
  return { updater, calls, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a validly signed till stages a matching, same-publisher update and installs it silently on close', async t => {
  const w = world(); t.after(w.cleanup);
  assert.equal(await w.updater.signedTill(), true);
  assert.deepEqual(await w.updater.stage(release), { staged: true, version: '2.1.0' });
  assert.equal(w.updater.stagedVersion(), '2.1.0');
  assert.equal(w.calls.fetch[0].url, release.url);
  // The candidate's path reaches PowerShell only through the environment.
  const check = w.calls.run.at(-1);
  assert.match(check.file, /Mansu-POS-2\.1\.0-Setup\.exe$/);
  assert.ok(!check.args.some(arg => arg.includes(check.file)));
  assert.equal(check.args.at(-1), SIGNATURE_SCRIPT);
  assert.equal(w.updater.installStaged(), true);
  assert.equal(w.calls.spawn.length, 1);
  assert.deepEqual(w.calls.spawn[0].args, INSTALL_ARGS);
  assert.deepEqual(INSTALL_ARGS, ['/S', '--updated', '--force-run']);
  assert.equal(w.calls.spawn[0].options.detached, true);
  assert.equal(w.updater.stagedVersion(), null, 'installs once');
  assert.equal(w.updater.installStaged(), false);
});

test('an unsigned till, or a till that is not on Windows, never downloads or installs', async t => {
  for (const options of [{ own: { status: 'NotSigned', subject: '' } }, { own: { status: 'HashMismatch', subject: SHOP } }, { platform: 'linux' }]) {
    const w = world(options); t.after(w.cleanup);
    assert.equal(await w.updater.signedTill(), false);
    const result = await w.updater.stage(release);
    assert.equal(result.staged, false);
    assert.match(result.reason, /not code-signed/);
    assert.equal(w.calls.fetch.length, 0);
    assert.equal(w.updater.installStaged(), false);
    assert.equal(w.calls.spawn.length, 0);
  }
});

test('a download is refused unless its hash, signature, publisher and host all check out', async t => {
  const cases = [
    [{ body: Buffer.from('tampered') }, /does not match the published SHA-256/],
    [{ candidate: { status: 'NotSigned', subject: '' } }, /not validly signed/],
    [{ candidate: { status: 'HashMismatch', subject: SHOP } }, /not validly signed/],
    [{ candidate: { status: 'Valid', subject: 'CN=Someone Else, O=Other, C=GH' } }, /different publisher/],
    [{ finalUrl: 'https://evil.example/Mansu-POS.exe' }, /host the till does not trust/],
    [{ finalUrl: 'http://mansupos.com/Mansu-POS.exe' }, /host the till does not trust/],
    [{ status: 404 }, /download failed \(404\)/],
    [{ body: Buffer.alloc(0) }, /empty or too large/],
  ];
  for (const [options, reason] of cases) {
    const w = world(options); t.after(w.cleanup);
    const result = await w.updater.stage(release);
    assert.equal(result.staged, false, String(reason));
    assert.match(result.reason, reason);
    assert.equal(w.updater.installStaged(), false);
    assert.equal(w.calls.spawn.length, 0);
    const left = fs.existsSync(path.join(w.dir, 'updates')) ? fs.readdirSync(path.join(w.dir, 'updates')) : [];
    assert.deepEqual(left, [], 'a refused download is not left behind');
  }
  const w = world(); t.after(w.cleanup);
  assert.match((await w.updater.stage({ ...release, sha256: undefined })).reason, /no SHA-256/);
  assert.equal(w.calls.fetch.length, 0);
});

test('a staged installer that changes on disk before closing is not run', async t => {
  const w = world(); t.after(w.cleanup);
  await w.updater.stage(release);
  const file = path.join(w.dir, 'updates', 'Mansu-POS-2.1.0-Setup.exe');
  fs.writeFileSync(file, Buffer.from('swapped after staging'));
  assert.equal(w.updater.installStaged(), false);
  assert.equal(w.calls.spawn.length, 0);
});

test('signature reading tolerates PowerShell failures and odd output', async () => {
  const failed = await readSignature('x.exe', async () => { throw new Error('no powershell'); });
  assert.equal(failed.status, 'Unknown');
  assert.equal(failed.subject, '');
  assert.match(failed.error, /no powershell/);
  assert.equal((await readSignature('x.exe', async () => 'not json')).status, 'Unknown');
  assert.deepEqual(await readSignature('x.exe', async () => '{"status":"Valid","subject":"CN=A"}\r\n'), { status: 'Valid', subject: 'CN=A' });
  assert.equal(samePublisher({ status: 'Valid', subject: 'CN=A' }, { status: 'Valid', subject: 'CN=A' }), true);
  assert.equal(samePublisher({ status: 'Valid', subject: '' }, { status: 'Valid', subject: '' }), false);
  assert.equal(samePublisher({ status: 'NotSigned', subject: 'CN=A' }, { status: 'Valid', subject: 'CN=A' }), false);
});

test('Windows PowerShell is started without an inherited PowerShell 7 module path', async () => {
  const env = windowsPowershellEnv({ MANSU_SIGNED_FILE: 'C:\\x.exe' }, { PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', Path: 'C:\\Windows' });
  assert.equal('PSModulePath' in env, false);
  assert.equal(env.Path, 'C:\\Windows');
  assert.equal(env.MANSU_SIGNED_FILE, 'C:\\x.exe');
  assert.equal('psmodulepath' in windowsPowershellEnv({}, { psmodulepath: 'x' }), false);
  let seen;
  await readSignature('C:\\x.exe', async (_command, _args, { env: passed }) => { seen = passed; return '{"status":"NotSigned","subject":""}'; });
  assert.ok(!Object.keys(seen).some(key => key.toUpperCase() === 'PSMODULEPATH'));
});

test('the release notice passes a valid SHA-256 through to the updater', () => {
  const sha = 'A'.repeat(64);
  assert.equal(newerRelease({ version: '2.1.0', url: 'https://mansupos.com/x.exe', sha256: sha }, '2.0.0').sha256, 'a'.repeat(64));
  assert.equal('sha256' in newerRelease({ version: '2.1.0', url: 'https://mansupos.com/x.exe', sha256: 'nope' }, '2.0.0'), false);
  assert.equal('sha256' in newerRelease({ version: '2.1.0', url: 'https://mansupos.com/x.exe' }, '2.0.0'), false);
});
