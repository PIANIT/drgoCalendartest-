/* ================================================
   firebase-messaging-sw.js
   - index.html 과 같은 폴더(루트)에 위치해야 함
   ================================================ */
importScripts('https://www.gstatic.com/firebasejs/12.9.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.9.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            "AIzaSyDnEOATYmwq0WJr6pCl-86-Q3ZEQjrrfeY",
  authDomain:        "drgo-calender.firebaseapp.com",
  projectId:         "drgo-calender",
  storageBucket:     "drgo-calender.firebasestorage.app",
  messagingSenderId: "163730741115",
  appId:             "1:163730741115:web:73a06d5b1cf1a477734fde"
});

const messaging = firebase.messaging();

/* 백그라운드 메시지 수신 */
messaging.onBackgroundMessage(payload => {
  const { title = '📅 일정 알림', body = '' } = payload.notification || {};
  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-96.png',
    tag: payload.data?.eventId || 'calendar-notif',
    renotify: true,
    data: payload.data || {}
  });
});

/* 알림 클릭 시 앱 열기 */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client)
          return client.focus();
      }
      return clients.openWindow('/');
    })
  );
});
