/* ================================================
   firebase-messaging-sw.js
   반드시 index.html 과 같은 루트 폴더에 위치
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

const ICON  = './icon-192.png';
const BADGE = './icon-192.png';

/* ─────────────────────────────────────────────
   백그라운드 메시지 수신 (앱이 닫혔을 때)
   silent:false + vibrate → Android/iOS 알림음+진동
───────────────────────────────────────────── */
messaging.onBackgroundMessage(payload => {
  console.log('[SW] 백그라운드 메시지:', payload);

  const title = payload.notification?.title
             || payload.data?.title
             || '📅 일정 알림';
  const body  = payload.notification?.body
             || payload.data?.body
             || '';
  const tag   = payload.data?.eventId || 'cal-notif';

  return self.registration.showNotification(title, {
    body,
    icon:     ICON,
    badge:    BADGE,
    tag,
    renotify:  true,
    silent:    false,       /* OS 기본 알림음 사용 */
    vibrate:   [300, 100, 300, 100, 300],
    requireInteraction: false,
    timestamp: Date.now(),
    data: {
      ...(payload.data || {}),
      url: self.location.origin + '/'
    }
  });
});

/* ─────────────────────────────────────────────
   알림 클릭 → 앱 포커스 또는 새 탭
───────────────────────────────────────────── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.location.origin + '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        for (const c of list) {
          if (c.url.startsWith(self.location.origin) && 'focus' in c)
            return c.focus();
        }
        return clients.openWindow(url);
      })
  );
});

/* SW 즉시 활성화 */
self.addEventListener('install',  e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
