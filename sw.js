/* ═══════════════════════════════════════════
   DRGO Calendar — Service Worker
   Cache-first + Network fallback 전략
   Firebase Firestore는 온라인 필수 (캐시 제외)
═══════════════════════════════════════════ */

const CACHE_NAME    = 'drgo-cal-v2';
const RUNTIME_CACHE = 'drgo-cal-runtime-v2';

/* 설치 시 즉시 캐시할 핵심 파일 */
const PRECACHE_URLS = [
  './index.html',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  './icons/apple-touch-icon.png',
];

/* 캐시하지 않을 도메인 패턴 (Firebase, Google APIs) */
const NO_CACHE_PATTERNS = [
  /firestore\.googleapis\.com/,
  /firebase\.googleapis\.com/,
  /firebasestorage\.googleapis\.com/,
  /googleapis\.com\/identitytoolkit/,
  /gstatic\.com\/firebasejs/,
];

/* ── Install ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate : 구버전 캐시 정리 ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== RUNTIME_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch ── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* GET 요청만 처리 */
  if (request.method !== 'GET') return;

  /* Firebase / 외부 API → 네트워크 직통 (캐시 안 함) */
  if (NO_CACHE_PATTERNS.some(p => p.test(request.url))) return;

  /* Google Fonts → 런타임 캐시 (네트워크 우선) */
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        fetch(request)
          .then(res => { cache.put(request, res.clone()); return res; })
          .catch(() => caches.match(request))
      )
    );
    return;
  }

  /* 그 외 (로컬 파일) → Cache-first */
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        caches.open(RUNTIME_CACHE).then(cache => cache.put(request, res.clone()));
        return res;
      });
    }).catch(() => {
      if (request.destination === 'document') return caches.match('./index.html');
    })
  );
});

/* 빈 push 핸들러 (미래 확장용) */
self.addEventListener('push', () => {});
