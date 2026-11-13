import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const types = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' };
const maxBytes = 2 * 1024 * 1024;

// Only Woo images hosted on the already-approved store are eligible. Never
// fetch arbitrary catalogue URLs, follow redirects into a private network, or
// allow an image URL to escape the local cache. Missing images use the UI's
// existing branded placeholder; they do not prevent an offline sale.
export async function cacheProductImages(store, directory, fetchImpl = fetch, onProgress = () => {}) {
  const host = new URL(store.setting('origin')).hostname;
  const storeHost = new URL(store.session().config.storeUrl).hostname;
  if (!host.endsWith('.mansutrendzgh.com') || !['mansutrendzgh.com','www.mansutrendzgh.com'].includes(storeHost)) return 0;
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const items = store.rawCatalog().products.flatMap(p => [p.image,...(p.variations || []).map(v => v.image)]);
  const urls = [...new Set(items.filter(Boolean))];
  let cached = 0;
  for (const source of urls) {
    let url;
    try { url = new URL(source); } catch { continue; }
    if (url.protocol !== 'https:' || !['mansutrendzgh.com','www.mansutrendzgh.com'].includes(url.hostname) || url.port || url.username || url.password) continue;
    if (store.db.prepare('SELECT 1 FROM image_map WHERE url=?').get(source)) continue;
    let response;
    try { response = await fetchImpl(url, { redirect:'error', signal:AbortSignal.timeout(12000), headers:{Accept:'image/png,image/jpeg,image/webp'} }); }
    catch { continue; }
    const extension = types[(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()];
    if (!response.ok || !extension || Number(response.headers.get('content-length') || 0) > maxBytes) { await response.body?.cancel(); continue; }
    const bytes = [];
    let length = 0;
    try {
      for await (const chunk of response.body) { length += chunk.length; if (length > maxBytes) throw new Error('Image exceeds cache limit.'); bytes.push(chunk); }
      const filename = `${createHash('sha256').update(source).digest('hex')}.${extension}`;
      // Exclusive create; no untrusted path or image data can replace an
      // existing file. The DB mapping is saved only AFTER the file is durable.
      const file = path.join(directory,filename);
      try { await fs.writeFile(file,Buffer.concat(bytes),{flag:'wx',mode:0o600}); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      store.rememberImage(source,filename);
      cached++;
      if (cached % 10 === 0) onProgress(cached);
    } catch { /* Keep prior cache and retry the missing image on next refresh. */ }
  }
  if (cached) onProgress(cached);
  return cached;
}
