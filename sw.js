/* מהדק: app shell is network-first so updates arrive at once; libraries are cached so the app also works offline. */
const APP='mahdek-app-v1', LIBS='mahdek-libs-v1';
const SHELL=['./','./index.html','./manifest.webmanifest','./favicon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>{ self.skipWaiting(); e.waitUntil(caches.open(APP).then(c=>c.addAll(SHELL)).catch(()=>{})); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==APP&&k!==LIBS).map(k=>caches.delete(k)))).then(()=>self.clients.claim())); });
self.addEventListener('fetch',e=>{
  const r=e.request; if(r.method!=='GET') return;
  const u=new URL(r.url);
  if(u.origin===self.location.origin){
    e.respondWith(fetch(r).then(res=>{ const cp=res.clone(); caches.open(APP).then(c=>c.put(r,cp)); return res; })
      .catch(()=>caches.match(r).then(m=>m||caches.match('./index.html'))));
    return;
  }
  if(/(^|\.)(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|tessdata\.projectnaptha\.com)$/.test(u.hostname)){
    e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{ if(res.ok||res.type==='opaque'){ const cp=res.clone(); caches.open(LIBS).then(c=>c.put(r,cp)); } return res; })));
  }
});
