/**
 * Firebase Cloud Functions - 일정 알림 발송
 *
 * 동작 방식:
 *   1. 매분 실행 (pubsub schedule)
 *   2. Firestore events 컬렉션에서 "지금으로부터 알림 시간이 된" 일정 탐색
 *   3. fcm_tokens 컬렉션의 모든 토큰에 FCM 푸시 발송
 *   4. 중복 발송 방지: notified_at 필드에 발송 완료 기록
 */

const { onSchedule }   = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db  = getFirestore();
const fcm = getMessaging();

/* 한국 시간 오프셋 (UTC+9) */
const KST_OFFSET = 9 * 60;

function nowKST() {
  const now = new Date();
  return new Date(now.getTime() + KST_OFFSET * 60000);
}

function toKST(d) {
  return new Date(d.getTime() + KST_OFFSET * 60000);
}

/* "YYYY-MM-DD HH:mm" 형태로 알림 발송 시각 계산 */
function calcNotifTime(ev) {
  const { startDate, startTime, allDay, notifMinutes } = ev;
  if (!notifMinutes) return null;

  if (allDay || notifMinutes === 'allday') {
    /* 종일 일정 → 당일 오전 9시 KST */
    return `${startDate} 09:00`;
  }

  const minutes = parseInt(notifMinutes, 10);
  if (isNaN(minutes)) return null;

  /* 시작 시간에서 minutes 분 전 */
  const [h, m] = (startTime || '09:00').split(':').map(Number);
  const base = new Date(`${startDate}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+09:00`);
  const notifAt = new Date(base.getTime() - minutes * 60000);
  const kst = toKST(notifAt);
  const yyyy = kst.getUTCFullYear();
  const mm   = String(kst.getUTCMonth()+1).padStart(2,'0');
  const dd   = String(kst.getUTCDate()).padStart(2,'0');
  const hh   = String(kst.getUTCHours()).padStart(2,'0');
  const min  = String(kst.getUTCMinutes()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

exports.sendScheduledNotifications = onSchedule(
  {
    schedule:  'every 1 minutes',
    timeZone:  'Asia/Seoul',
    region:    'asia-northeast3',   /* 서울 리전 */
    memory:    '256MiB',
  },
  async () => {
    const kst     = nowKST();
    const yyyy    = kst.getUTCFullYear();
    const mm      = String(kst.getUTCMonth()+1).padStart(2,'0');
    const dd      = String(kst.getUTCDate()).padStart(2,'0');
    const hh      = String(kst.getUTCHours()).padStart(2,'0');
    const min     = String(kst.getUTCMinutes()).padStart(2,'0');
    const nowStr  = `${yyyy}-${mm}-${dd} ${hh}:${min}`;  /* 현재 분(KST) */
    const today   = `${yyyy}-${mm}-${dd}`;

    console.log(`[알림 체크] 현재 KST: ${nowStr}`);

    /* 오늘 이후 일정 중 알림 설정된 것만 가져오기 */
    const evSnap = await db.collection('events')
      .where('startDate', '>=', today)
      .where('notifMinutes', '!=', null)
      .get();

    if (evSnap.empty) { console.log('알림 대상 일정 없음'); return; }

    /* FCM 토큰 전체 로드 */
    const tokenSnap = await db.collection('fcm_tokens').get();
    if (tokenSnap.empty) { console.log('등록된 토큰 없음'); return; }
    const tokens = tokenSnap.docs.map(d => d.data().token).filter(Boolean);

    const batch   = db.batch();
    const pushJobs = [];

    for (const evDoc of evSnap.docs) {
      const ev   = evDoc.data();
      const notifTime = calcNotifTime(ev);
      if (!notifTime) continue;
      if (notifTime !== nowStr) continue;           /* 이번 분이 아니면 스킵 */

      /* 중복 방지: 이미 발송된 알림인지 확인 */
      const notifKey  = `${evDoc.id}_${nowStr.replace(/[^0-9]/g,'_')}`;
      const sentRef   = db.collection('sent_notifs').doc(notifKey);
      const sentSnap  = await sentRef.get();
      if (sentSnap.exists) { console.log(`이미 발송: ${notifKey}`); continue; }

      /* 알림 텍스트 구성 */
      const title = `📅 ${ev.title || '(제목 없음)'}`;
      let body = '';
      if (ev.allDay || ev.notifMinutes === 'allday') {
        body = `오늘 종일 일정입니다`;
      } else {
        const mins = parseInt(ev.notifMinutes, 10);
        const timeLabel = mins === 0   ? '지금 시작'
          : mins < 60  ? `${mins}분 후 시작`
          : mins === 60  ? '1시간 후 시작'
          : mins === 120 ? '2시간 후 시작'
          : '내일 일정';
        body = `${ev.startTime || ''} ${timeLabel}${ev.location ? ' · ' + ev.location : ''}`;
      }

      /* FCM 멀티캐스트 발송 */
      pushJobs.push(
        fcm.sendEachForMulticast({ tokens, notification: { title, body }, data: { eventId: evDoc.id } })
          .then(res => {
            console.log(`발송 완료 [${evDoc.id}]: 성공 ${res.successCount}, 실패 ${res.failureCount}`);
            /* 만료된 토큰 정리 */
            res.responses.forEach((r, i) => {
              if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
                db.collection('fcm_tokens').doc(tokens[i]).delete().catch(()=>{});
              }
            });
          })
      );

      /* 발송 기록 저장 (TTL 48시간) */
      batch.set(sentRef, { eventId: evDoc.id, sentAt: Timestamp.now() });
    }

    await Promise.all(pushJobs);
    await batch.commit();
    console.log(`[완료] 처리된 알림: ${pushJobs.length}건`);
  }
);
