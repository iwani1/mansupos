import fs from 'node:fs';
import path from 'node:path';

const dist=path.resolve('dist');
const index=fs.readFileSync(path.join(dist,'index.html'),'utf8');
if (!index.includes('./assets/') || fs.existsSync(path.join(dist,'demo'))) {
  throw new Error('Desktop package must use relative bundled assets and exclude demo illustrations. Rebuild with npm run build:desktop.');
}
// The updater is dormant for every unsigned or unapproved build. An explicitly
// approved signed release may use the PUBLIC GitHub feed; this never publishes
// a release, uploads a file, installs a plugin, or migrates a live ledger.
const signed=process.env.MANSU_SIGNED_UPDATE_BUILD==='true';
if (signed && (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD || process.env.MANSU_PUBLIC_RELEASE_APPROVED!=='true')) {
  throw new Error('Signed updates require a Windows signing certificate and explicit public-release approval. No unsigned update feed was enabled.');
}
const policy=path.resolve('desktop/update-policy.json');
fs.writeFileSync(policy,JSON.stringify({signed})+'\n',{mode:0o600});
console.log(`Desktop UI ready: local assets, no demo illustration or Woo credentials. Automatic updates ${signed?'require signed public release':'disabled'}.`);
