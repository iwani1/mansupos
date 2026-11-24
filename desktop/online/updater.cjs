'use strict';

// Signed automatic updates for the Windows till.
//
// Switched on only when THIS running till is itself code-signed: Windows must
// report a Valid Authenticode signature on its own .exe. Unsigned QA builds
// keep the "a new version is available" notice and never install anything.
//
// Flow: the daily check finds a newer release in the platform's feed (version,
// HTTPS url, SHA-256) -> the installer is downloaded from an allowed host ->
// its SHA-256 must equal the feed's -> Windows must report a Valid signature
// from the SAME publisher (certificate subject) as the running till -> it is
// staged. The staged installer runs silently when staff close the till (or
// choose Help -> Install update now) and reopens the till afterwards. Nothing
// installs while the till is open, so a sale is never interrupted.
//
// Every outside effect (fetch, PowerShell, spawn, files) is passed in, so the
// whole flow is tested on any OS (tests/online-till-updater.test.js).
const crypto = require('node:crypto');
const path = require('node:path');

const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
const INSTALL_ARGS = ['/S', '--updated', '--force-run']; // electron-builder NSIS: silent, then reopen the app

// Constant script: the file path arrives only through an environment variable,
// never by building a command line from it.
const SIGNATURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$s = Get-AuthenticodeSignature -LiteralPath $env:MANSU_SIGNED_FILE
$subject = ''
if ($s.SignerCertificate) { $subject = $s.SignerCertificate.Subject }
[pscustomobject]@{ status = [string]$s.Status; subject = [string]$subject } | ConvertTo-Json -Compress
`;

function powershellPath(env = process.env) {
  return path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// Windows PowerShell 5.1 must find its OWN modules (Get-AuthenticodeSignature
// lives in Microsoft.PowerShell.Security). A PSModulePath inherited from
// PowerShell 7 (e.g. a till started from a pwsh prompt) points it at
// incompatible PS7 modules, so drop it and let 5.1 use its defaults.
function windowsPowershellEnv(extra, env = process.env) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'));
  return { ...clean, ...extra };
}

// run(command, args, { env, timeoutMs }) resolves with stdout text. Any
// failure reads as 'Unknown' (never as signed); `error` says why.
async function readSignature(file, run) {
  try {
    const out = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SIGNATURE_SCRIPT],
      { env: windowsPowershellEnv({ MANSU_SIGNED_FILE: file }), timeoutMs: 30000 });
    const parsed = JSON.parse(String(out).trim());
    return { status: String(parsed.status || ''), subject: String(parsed.subject || '') };
  } catch (error) {
    return { status: 'Unknown', subject: '', error: String(error?.message || error).slice(0, 300) };
  }
}

// Same publisher: both Valid and the certificate subject (CN, O, L, C...) is
// identical. A renewed certificate for the same business keeps its subject.
const samePublisher = (own, candidate) => own.status === 'Valid' && candidate.status === 'Valid' &&
  own.subject.length > 0 && own.subject === candidate.subject;

// Runs a program and resolves with its stdout (no shell; inputs via env only).
function runCapture(command, args, { env, timeoutMs }) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out.')); }, timeoutMs);
    child.stdout.on('data', chunk => { if (out.length < 8000) out += chunk; });
    child.stderr.on('data', chunk => { if (err.length < 4000) err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit code ${code}${err.trim() ? `: ${err.trim().replace(/\s+/g, ' ')}` : ''}`));
    });
  });
}

const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

function createUpdater({ platform = process.platform, execPath, updatesDir, downloadHosts, fetch, run, spawn, fs }) {
  let ownSignature = null;
  let staged = null; // { version, file, sha256 }

  async function signedTill() {
    if (platform !== 'win32') return false;
    if (!ownSignature) ownSignature = await readSignature(execPath, run);
    return ownSignature.status === 'Valid' && ownSignature.subject.length > 0;
  }

  // release: { version, url, sha256 } from newerRelease(). Resolves with
  // { staged: true, version } or { staged: false, reason }.
  async function stage(release) {
    if (!(await signedTill())) return { staged: false, reason: 'This till is not code-signed, so it does not install updates by itself.' };
    if (!release || !/^[0-9a-f]{64}$/.test(String(release.sha256 || ''))) return { staged: false, reason: 'The release notice has no SHA-256.' };
    if (staged && staged.version === release.version) return { staged: true, version: release.version };
    let response;
    try {
      response = await fetch(release.url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60000) });
    } catch { return { staged: false, reason: 'The download failed.' }; }
    let finalUrl;
    try { finalUrl = new URL(response.url || release.url); } catch { return { staged: false, reason: 'The download address is not valid.' }; }
    if (finalUrl.protocol !== 'https:' || !downloadHosts.includes(finalUrl.hostname)) return { staged: false, reason: 'The download came from a host the till does not trust.' };
    if (!response.ok) return { staged: false, reason: `The download failed (${response.status}).` };
    const length = Number(response.headers?.get?.('content-length') || 0);
    if (length > MAX_INSTALLER_BYTES) return { staged: false, reason: 'The download is too large.' };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_INSTALLER_BYTES) return { staged: false, reason: 'The download is empty or too large.' };
    if (sha256(bytes) !== release.sha256) return { staged: false, reason: 'The download does not match the published SHA-256.' };
    fs.mkdirSync(updatesDir, { recursive: true });
    const file = path.join(updatesDir, `Mansu-POS-${release.version}-Setup.exe`);
    fs.writeFileSync(file, bytes);
    const signature = await readSignature(file, run);
    if (!samePublisher(ownSignature, signature)) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
      return { staged: false, reason: signature.status === 'Valid' ? 'The update is signed by a different publisher.' : 'The update is not validly signed.' };
    }
    staged = { version: release.version, file, sha256: release.sha256 };
    return { staged: true, version: release.version };
  }

  // Runs the staged installer, detached, so it can replace the till after it
  // exits. Re-checks the file first: anything changed since staging is refused.
  function installStaged() {
    if (!staged) return false;
    let bytes;
    try { bytes = fs.readFileSync(staged.file); } catch { staged = null; return false; }
    if (sha256(bytes) !== staged.sha256) { staged = null; return false; }
    const child = spawn(staged.file, INSTALL_ARGS, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref?.();
    staged = null;
    return true;
  }

  return { signedTill, stage, installStaged, stagedVersion: () => staged?.version || null };
}

module.exports = { createUpdater, readSignature, runCapture, windowsPowershellEnv, samePublisher, SIGNATURE_SCRIPT, INSTALL_ARGS, MAX_INSTALLER_BYTES };
