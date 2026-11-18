/* מהדק: app shell is network-first so updates arrive at once; libraries are cached so the app also works offline. */
const APP='mahdek-app-v5', LIBS='mahdek-libs-v1';
const SHELL=['./','./index.html','./manifest.webmanifest','./favicon.svg','./icon-192.png','./icon-512.png'];
const CDN='https://cdnjs.cloudflare.com/ajax/libs/';
const LIB_URLS=[CDN+'pdf-lib/1.17.1/pdf-lib.min.js',CDN+'pdf.js/3.11.174/pdf.worker.min.js',CDN+'pdf.js/3.11.174/pdf.min.js',
  CDN+'mammoth/1.6.0/mammoth.browser.min.js',CDN+'xlsx/0.18.5/xlsx.full.min.js',CDN+'html2pdf.js/0.10.1/html2pdf.bundle.min.js',
  CDN+'jszip/3.10.1/jszip.min.js','https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'];
/* On install, keep the app and every tool it loads, so it works without internet from the start */
self.addEventListener('install',e=>{
  self.skipWaiting();
  e.waitUntil(Promise.all([
    caches.open(APP).then(c=>c.addAll(SHELL)).catch(()=>{}),
    caches.open(LIBS).then(c=>Promise.all(LIB_URLS.map(u=>c.match(u).then(m=>m||fetch(u,{mode:'cors'}).then(r=>{ if(r.ok) return c.put(u,r); }).catch(()=>{})))))
  ]));
});
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==APP&&k!==LIBS).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET') return;
  const u=new URL(r.url);
  if(u.origin===self.location.origin){
    e.respondWith(fetch(r,{cache:'no-cache'}).then(res=>{ const cp=res.clone(); caches.open(APP).then(c=>c.put(r,cp)); return res; })
      .catch(()=>caches.match(r).then(m=>m||caches.match('./index.html'))));
    return;
  }
  if(/(^|\.)(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|tessdata\.projectnaptha\.com)$/.test(u.hostname)){
    e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{ if(res.ok||res.type==='opaque'){ const cp=res.clone(); caches.open(LIBS).then(c=>c.put(r,cp)); } return res; })));
  }
});
