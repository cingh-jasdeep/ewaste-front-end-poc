// Service worker: runs even when no tab is open, so it can show push alerts.
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'E-waste Pickup', body: '' };
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body }));
});

// Tapping the notification opens (or focuses) the app, which then refetches
// fresh data through TanStack Query.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin);
      return tab ? tab.focus() : self.clients.openWindow('/');
    })
  );
});
