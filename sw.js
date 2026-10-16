// sw.js - MC-Lite phone: receives Web Push and opens the right screen. iOS web push has NO action buttons, so the deep link
// travels in the notification's data/tag and a tap opens the app there.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'MC-Lite', { body: d.body || '', tag: d.tag || d.url || 'mclite', data: { url: d.url || '/' }, icon: 'icon-192.png', badge: 'icon-192.png' }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const c = cs.find((x) => x.url.startsWith(self.registration.scope));
    return c && c.focus ? c.navigate(url).then((n) => (n || c).focus()).catch(() => self.clients.openWindow(url)) : self.clients.openWindow(url);
  }));
});
