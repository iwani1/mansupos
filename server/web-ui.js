import express from 'express';
import path from 'node:path';

// The production SPA must answer GET / directly. Relying exclusively on a
// wildcard fallback left / returning 404 in the live pilot while /index.html
// worked. Keep /api handlers registered in createApp before this UI mount.
export function mountProductionUi(app,{dist,mode}) {
  const entry=path.join(dist,'index.html');
  const serveEntry=(_req,res)=>res.sendFile(entry,{
    headers:{'Cache-Control':'no-cache'},
  });
  // Never expose demo illustrations on production live/staging services.
  if(mode!=='demo')app.use('/demo',(_req,res)=>res.sendStatus(404));
  app.get('/',serveEntry);
  app.use(express.static(dist,{
    index:false,
    maxAge:0,
    setHeaders(res,filePath){
      if(filePath.endsWith(`${path.sep}sw.js`))res.setHeader('Cache-Control','no-store');
      else if(filePath.endsWith('.html')||filePath.endsWith('.webmanifest'))
        res.setHeader('Cache-Control','no-cache');
      else if(filePath.includes(`${path.sep}assets${path.sep}`))
        res.setHeader('Cache-Control','public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control','public, max-age=3600, must-revalidate');
    },
  }));
  app.get('/{*path}',serveEntry);
}
