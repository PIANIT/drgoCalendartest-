/**
 * Firebase Cloud Functions - Discord Webhook 알림
 * 매분 실행 → 알림 시각이 된 일정 → Discord로 메시지 전송
 */
const { onSchedule }    = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const https = require('https');

initializeApp();
const db = getFirestore();

/* ── Discord 웹훅 URL ── */
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1476134717832302777/1JOwl81U3ZDFEzm98g2FSqYVMcVOZjOB1EiLcCdRXXL_GnpgPDC_fv-cuwSKpOFq7SZ1';

/* ── 유틸 ── */
const KST = 9 * 60;
const pad = n => String(n).padStart(2, '0');

function nowKST() {
  return new Date(Date.now() + KST * 60000);
}

function calcNotifTime(ev) {
  const { startDate, startTime, allDay, notifMinutes } = ev;
  if (!notifMinutes || !startDate) return null;

  if (allDay || notifMinutes === 'allday') {
    return `${startDate} 09:00`;
  }
  const mins = parseInt(notifMinutes, 10);
  if (isNaN(mins)) return null;

  const [h, m] = (startTime || '09:00').split(':').map(Number);
  const baseUTC  = new Date(`${startDate}T${pad(h)}:${pad(m)}:00+09:00`);
  const notifUTC = new Date(baseUTC.getTime() - mins * 60000);
  const kst      = new Date(notifUTC.getTime() + KST * 60000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth()+1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`;
}

/* ── Discord Webhook POST ── */
function sendDiscord(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(DISCORD_WEBHOOK);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── 색상별 Embed 색상 ── */
const EMBED_COLORS = {
  gold:   0xC8B08A,
  blue:   0x8AB4C8,
  red:    0xC87A7A,
  green:  0x7AC87A,
  purple: 0xA07AC8,
};

const TYPE_LABELS = {
  gold:   '개인의뢰',
  blue:   '사내업무',
  red:    '휴가관련',
  green:  '촬영관련',
  purple: '미팅/내방',
};

/* ── 알림 본문 구성 ── */
function buildMessage(ev) {
  const color = ev.color || 'gold';
  const typeLabel = TYPE_LABELS[color] || '일정';

  /* 시간 표시 */
  let timeStr = '';
  if (ev.allDay || ev.notifMinutes === 'allday') {
    timeStr = '종일';
  } else {
    timeStr = ev.startTime || '';
    if (ev.endTime) timeStr += ` ~ ${ev.endTime}`;
  }

  /* 알림 타이밍 설명 */
  let notifDesc = '';
  if (ev.allDay || ev.notifMinutes === 'allday') {
    notifDesc = '오늘 종일 일정';
  } else {
    const mins = parseInt(ev.notifMinutes, 10);
    notifDesc = mins === 0   ? '지금 시작합니다' :
                mins < 60   ? `${mins}분 후 시작` :
                mins === 60  ? '1시간 후 시작'   :
                mins === 120 ? '2시간 후 시작'   : '일정 알림';
  }

  /* Discord Embed 구성 */
  const fields = [];
  if (timeStr)      fields.push({ name: '⏰ 시간',  value: timeStr,      inline: true });
  if (typeLabel)    fields.push({ name: '📌 유형',  value: typeLabel,    inline: true });
  if (ev.location)  fields.push({ name: '📍 장소',  value: ev.location,  inline: false });
  if (ev.name)      fields.push({ name: '👤 담당',  value: ev.name,      inline: true });
  if (ev.address)   fields.push({ name: '🏠 주소',  value: ev.address,   inline: false });
  if (ev.desc)      fields.push({ name: '📝 메모',  value: ev.desc.slice(0, 200), inline: false });

  return {
    username:   '📅 캘린더 알림',
    avatar_url: 'https://cdn.discordapp.com/embed/avatars/0.png',
    embeds: [{
      title:       `📅 ${ev.title || '(제목 없음)'}`,
      description: `**${notifDesc}**`,
      color:       EMBED_COLORS[color] || EMBED_COLORS.gold,
      fields,
      footer: {
        text: `${ev.startDate}${ev.endDate && ev.endDate !== ev.startDate ? ' ~ ' + ev.endDate : ''}`
      },
      timestamp: new Date().toISOString(),
    }]
  };
}

/* ── 메인 스케줄 함수 ── */
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

    const evSnap = await db.collection('events')
      .where('startDate', '>=', today)
      .where('notifMinutes', '!=', null)
      .get();

    if (evSnap.empty) { console.log('대상 없음'); return; }

    const batch = db.batch();
    const jobs  = [];

    for (const evDoc of evSnap.docs) {
      const ev = evDoc.data();
      if (calcNotifTime(ev) !== nowStr) continue;

      /* 중복 방지 */
      const key     = `${evDoc.id}_${nowStr.replace(/\D/g, '_')}`;
      const sentRef = db.collection('sent_notifs').doc(key);
      const sent    = await sentRef.get();
      if (sent.exists) { console.log(`이미 발송: ${key}`); continue; }

      /* Discord 전송 */
      const payload = buildMessage(ev);
      jobs.push(
        sendDiscord(payload)
          .then(status => console.log(`Discord 발송 [${evDoc.id}]: HTTP ${status}`))
          .catch(e => console.error(`Discord 실패 [${evDoc.id}]:`, e.message))
      );

      batch.set(sentRef, { eventId: evDoc.id, sentAt: Timestamp.now() });
    }

    await Promise.all(jobs);
    await batch.commit();
    console.log(`완료: ${jobs.length}건`);
  }
);
