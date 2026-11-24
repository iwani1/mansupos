'use strict';

// Cash drawer: the drawer plugs into the receipt printer's RJ11 drawer port.
// Opening it means sending the standard ESC/POS "pulse" command (ESC p m t1 t2)
// to that printer as RAW data through the normal print spooler, so no
// extra driver or native module is needed. The printer name and bytes are
// passed to the fixed script through environment variables, never by
// building a command line from them.
const { spawn } = require('node:child_process');
const path = require('node:path');

// ESC p <connector> <on 25×2 ms> <off 250×2 ms>. Connector 0 = pin 2 (most
// drawers), 1 = pin 5.
function kickBytes(pin = 2) {
  return Buffer.from([0x1b, 0x70, pin === 5 ? 0x01 : 0x00, 0x19, 0xfa]);
}

// Windows: write RAW bytes with winspool (OpenPrinter/StartDocPrinter
// "RAW"/WritePrinter). Constant script; inputs only via environment.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MansuRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int len, out int written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("Printer not found (" + Marshal.GetLastWin32Error() + ")");
    try {
      if (StartDocPrinter(h, 1, new DOCINFO { pDocName = "Mansu POS cash drawer", pDataType = "RAW" }) == 0) throw new Exception("Printer refused the job (" + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        int written;
        if (!WritePrinter(h, data, data.Length, out written) || written != data.Length) throw new Exception("Printer did not accept the command (" + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
[MansuRawPrint]::Send($env:MANSU_DRAWER_PRINTER, [Convert]::FromBase64String($env:MANSU_DRAWER_BYTES))
`;

function windowsCommand() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function run(command, args, { env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let errorText = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('The printer did not answer in time.')); }, timeoutMs);
    child.stderr.on('data', chunk => { if (errorText.length < 4000) errorText += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        const reason = (errorText.match(/Exception[^:]*: "?([^"\r\n]+)/) || errorText.match(/([^\r\n]+)\s*$/) || [])[1];
        reject(new Error(reason ? reason.trim().slice(0, 200) : `exit code ${code}`));
      }
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

async function openDrawer(printer, pin = 2, { platform = process.platform, timeoutMs = 20000 } = {}) {
  if (typeof printer !== 'string' || !printer.trim()) throw new Error('No receipt printer is chosen.');
  const bytes = kickBytes(pin);
  if (platform === 'win32') {
    await run(windowsCommand(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT], {
      env: { ...process.env, MANSU_DRAWER_PRINTER: printer, MANSU_DRAWER_BYTES: bytes.toString('base64') }, timeoutMs,
    });
  } else {
    // CUPS (development and tests): send the same bytes untouched.
    await run('lp', ['-s', '-d', printer, '-o', 'raw'], { env: process.env, input: bytes, timeoutMs });
  }
}

module.exports = { kickBytes, openDrawer, WINDOWS_SCRIPT };
