/**
 * Firebase Cloud Functions - 일정 알림 발송
 * 매분 실행 → 알림 시각이 된 일정 → FCM 푸시
 */
const { onSchedule }    = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getMessaging }  = require('firebase-admin/messaging');

initializeApp();
const db  = getFirestore();
const fcm = getMessaging();

const KST = 9 * 60; // UTC+9 오프셋(분)

function nowKST() {
  return new Date(Date.now() + KST * 60000);
}
function pad(n) { return String(n).padStart(2, '0'); }

/* 알림 발송 시각 계산 → "YYYY-MM-DD HH:mm" 반환 */
function calcNotifTime(ev) {
  const { startDate, startTime, allDay, notifMinutes } = ev;
  if (!notifMinutes || !startDate) return null;

  if (allDay || notifMinutes === 'allday') {
    return `${startDate} 09:00`;
  }
  const mins = parseInt(notifMinutes, 10);
  if (isNaN(mins)) return null;

  const [h, m] = (startTime || '09:00').split(':').map(Number);
  const baseUTC   = new Date(`${startDate}T${pad(h)}:${pad(m)}:00+09:00`);
  const notifUTC  = new Date(baseUTC.getTime() - mins * 60000);
  const kst       = new Date(notifUTC.getTime() + KST * 60000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth()+1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

exports.sendScheduledNotifications = onSchedule(
  {
    schedule:  'every 1 minutes',
    timeZone:  'Asia/Seoul',
    region:    'asia-northeast3',
    memory:    '256MiB',
  },
  async () => {
    const kst    = nowKST();
    const today  = `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth()+1)}-${pad(kst.getUTCDate())}`;
    const nowStr = `${today} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
    console.log(`[알림 체크] KST: ${nowStr}`);

    const [evSnap, tokenSnap] = await Promise.all([
      db.collection('events')
        .where('startDate', '>=', today)
        .where('notifMinutes', '!=', null)
        .get(),
      db.collection('fcm_tokens').get()
    ]);

    if (evSnap.empty || tokenSnap.empty) {
      console.log('대상 없음');
      return;
    }

    const tokens = tokenSnap.docs.map(d => d.data().token).filter(Boolean);
    const batch  = db.batch();
    const jobs   = [];

    for (const evDoc of evSnap.docs) {
      const ev = evDoc.data();
      if (calcNotifTime(ev) !== nowStr) continue;

      /* 중복 방지 */
      const key     = `${evDoc.id}_${nowStr.replace(/\D/g,'_')}`;
      const sentRef = db.collection('sent_notifs').doc(key);
      const sent    = await sentRef.get();
      if (sent.exists) continue;

      /* 알림 본문 */
      const title = `📅 ${ev.title || '(제목 없음)'}`;
      let body = '';
      if (ev.allDay || ev.notifMinutes === 'allday') {
        body = '오늘 종일 일정입니다';
      } else {
        const mins = parseInt(ev.notifMinutes, 10);
        body = `${ev.startTime || ''} ${
          mins === 0   ? '지금 시작합니다' :
          mins < 60    ? `${mins}분 후 시작` :
          mins === 60  ? '1시간 후 시작'    :
          mins === 120 ? '2시간 후 시작'    : '오늘의 일정'
        }${ev.location ? ' · ' + ev.location : ''}`;
      }

      /* FCM 메시지 구성
         - notification 필드: Android foreground, Windows 토스트
         - data 필드: iOS Background (APNs content-available)
         - apns.payload: iOS 알림음 강제 지정
         - android.notification.sound: Android 알림음 강제 지정 */
      const message = {
        tokens,
        notification: { title, body },   /* 기본 알림 (Android/Web) */
        data: {                           /* 모든 플랫폼 data 함께 전송 */
          title,
          body,
          eventId: evDoc.id,
        },
        android: {
          priority: 'high',
          notification: {
            sound:       'default',       /* Android 기본 알림음 */
            channelId:   'calendar_alerts_v2',
            priority:    'max',
            visibility:  'public',
            defaultSound: true,
            defaultVibrateTimings: true,
          },
        },
        apns: {                           /* iOS (APNs) 설정 */
          headers: {
            'apns-priority': '10',        /* 즉시 전송 */
          },
          payload: {
            aps: {
              sound: 'default',           /* iOS 기본 알림음 */
              badge: 1,
              'content-available': 1,     /* 백그라운드 실행 허용 */
              'mutable-content': 1,
              alert: { title, body },
            },
          },
        },
        webpush: {                        /* 브라우저 Web Push */
          headers: { Urgency: 'high' },
          notification: {
            title, body,
            icon:     'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="18" fill="#1a1a2e"/><text x="48" y="68" text-anchor="middle" font-size="56">📅</text></svg>'),
            silent:   false,
            vibrate:  [300, 100, 300],
            renotify: true,
            tag:      evDoc.id,
            requireInteraction: false,
          },
        },
      };

      jobs.push(
        fcm.sendEachForMulticast(message).then(res => {
          console.log(`발송 [${evDoc.id}]: 성공 ${res.successCount} / 실패 ${res.failureCount}`);
          /* 만료 토큰 삭제 */
          res.responses.forEach((r, i) => {
            if (!r.success && (
              r.error?.code === 'messaging/registration-token-not-registered' ||
              r.error?.code === 'messaging/invalid-registration-token'
            )) {
              db.collection('fcm_tokens').doc(tokens[i]).delete().catch(() => {});
            }
          });
        })
      );
      batch.set(sentRef, { eventId: evDoc.id, sentAt: Timestamp.now() });
    }

    await Promise.all(jobs);
    await batch.commit();
    console.log(`처리 완료: ${jobs.length}건`);
  }
);
