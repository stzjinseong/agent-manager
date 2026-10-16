// ---------- 예약 · 반복 실행 ----------
// 역할 이름에 지시를 정해 둔 시각에 넣는다. 종류:
//   once     — 한 번, at(ms)
//   daily    — 매일(또는 고른 요일) time 'HH:MM' (이 PC 의 시각)
//   interval — everyMin 분마다 (5분 이상)
// 실제로 넣는 일(워커 찾기 · 한도 확인 · assignTask)은 server.js 의 run 이 한다. 여기서는 언제 돌릴지만 정하고 결과를 남긴다.
// 놓친 회차(그 시각에 워커가 꺼져 있었거나 서버가 꺼져 있었음)는 예약마다 고른다 — whenOff:
//   'wait' — 미뤄 두었다가(pendingSince) 그 역할의 워커가 다시 뜨면 넣는다. 반복 예약도 밀린 회차는 한 번만(쌓지 않음), 24시간 지나면 넘어감
//   'skip' — 그 회차는 넘어간다
// 저장: config.schedules (profiles.json) — 항목 { id, role, text, kind, at?, time?, days?, everyMin?, whenOff, enabled, nextRun, pendingSince?, lastRun, lastResult, createdAt }
export const MIN_INTERVAL = 5;
const RETRY_MS = 60_000, RETRY_MAX = 10;   // 입력창이 막혀 못 넣으면 1분마다 다시, 10번까지
const MISSED_ONCE_MS = 10 * 60_000;        // 'skip' 인 한 번 예약도 서버가 꺼져 있어 놓친 지 10분 안이면 늦게라도 넣는다
const WAIT_MAX_MS = 24 * 3600_000;         // 'wait' 로 미뤄 둔 회차를 기다리는 한도

// 다음 실행 시각 (after 보다 뒤). 못 정하면 null
export function nextRunOf(s, after = Date.now()) {
  if (s.kind === 'once') return s.at > after ? s.at : null;
  if (s.kind === 'interval') {
    const step = Math.max(MIN_INTERVAL, Number(s.everyMin) || 0) * 60_000;
    const base = s.lastRun || s.createdAt || after;
    let t = base + step;
    if (t <= after) t = after + step - ((after - base) % step); // 꺼져 있던 동안 밀린 회차는 건너뛰고 다음 칸으로
    return t;
  }
  if (s.kind === 'daily') {
    const [h, m] = String(s.time || '').split(':').map(Number);
    if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) return null;
    const days = Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
    const d = new Date(after);
    for (let i = 0; i < 8; i++) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
      if (c.getTime() > after && days.includes(c.getDay())) return c.getTime();
    }
  }
  return null;
}

// 들어온 값 정리 — 화면이 보낸 것을 그대로 믿지 않는다
export function cleanSchedule(x, prev = {}) {
  const kind = ['once', 'daily', 'interval'].includes(x.kind) ? x.kind : prev.kind || 'daily';
  const s = {
    id: prev.id || `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    role: String(x.role ?? prev.role ?? '').trim().slice(0, 40),
    text: String(x.text ?? prev.text ?? '').trim().slice(0, 4000),
    kind, enabled: x.enabled ?? prev.enabled ?? true,
    whenOff: (x.whenOff ?? prev.whenOff) === 'skip' ? 'skip' : 'wait',
    createdAt: prev.createdAt || Date.now(), lastRun: prev.lastRun || null, lastResult: prev.lastResult || null,
  };
  if (kind === 'once') s.at = Number(x.at ?? prev.at) || 0;
  if (kind === 'daily') {
    s.time = /^\d{1,2}:\d{2}$/.test(x.time ?? prev.time ?? '') ? (x.time ?? prev.time) : '09:00';
    s.days = [...new Set((x.days ?? prev.days ?? []).map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  }
  if (kind === 'interval') s.everyMin = Math.max(MIN_INTERVAL, Math.round(Number(x.everyMin ?? prev.everyMin) || 60));
  if (!s.role) return { error: '역할을 고르세요' };
  if (!s.text) return { error: '지시 내용이 비어 있습니다' };
  if (kind === 'once' && !(s.at > Date.now()) && !(prev.pendingSince && prev.at === s.at)) return { error: '지난 시각입니다' };
  s.nextRun = s.enabled ? nextRunOf(s) : null;
  // 고쳐도 미뤄 둔 회차는 이어 간다(끄거나 '건너뛰기'로 바꾸면 버림)
  if (prev.pendingSince && s.enabled && s.whenOff === 'wait') s.pendingSince = prev.pendingSince;
  return { s };
}

// list(): config.schedules 배열 · save(): 저장 + 상태 방송 · isLive(role): 그 역할의 워커가 떠 있나
// run(s): { ok } | { off: 사유 }(워커 꺼짐) | { skip: 사유 } | { retry: 사유 }
export function createScheduler({ list, save, run, isLive }) {
  const wait = (s) => s.whenOff !== 'skip';
  // 미뤄 둔다: 결과에 사유를 남기고, 반복이면 다음 회차는 그대로 잡아 둔다
  function defer(s, why, at = Date.now()) {
    s.pendingSince ||= at;
    s.retries = 0;
    s.lastResult = { t: Date.now(), wait: why };
    s.nextRun = s.kind === 'once' ? null : nextRunOf(s, Date.now());
  }
  // 서버가 꺼져 있던 사이 지나간 회차
  const now = Date.now();
  for (const s of list()) {
    if (!s.enabled || !s.nextRun || s.nextRun > now) { if (s.enabled && !s.nextRun && !s.pendingSince) s.nextRun = nextRunOf(s, now); continue; }
    if (wait(s)) { defer(s, '서버가 꺼져 있어 놓침 — 워커가 있으면 곧 넣음', s.nextRun); continue; }
    if (s.kind === 'once') {
      if (now - s.nextRun > MISSED_ONCE_MS) { s.enabled = false; s.nextRun = null; s.lastResult = { t: now, skip: '서버가 꺼져 있어 놓침' }; }
      continue;
    }
    s.nextRun = nextRunOf(s, now);
  }
  save();

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      for (const s of list()) {
        if (!s.enabled) continue;
        // 미뤄 둔 회차: 너무 오래 기다렸으면 넘어가고, 워커가 돌아왔으면 넣는다
        if (s.pendingSince && now - s.pendingSince > WAIT_MAX_MS) {
          s.pendingSince = null;
          s.lastResult = { t: now, skip: '워커가 24시간 안에 돌아오지 않아 넘어감' };
          if (s.kind === 'once') s.enabled = false;
          save();
          continue;
        }
        const due = s.nextRun && s.nextRun <= now;
        const back = s.pendingSince && !s.retries && isLive(s.role);
        if (due || back) await fire(s);
      }
    } finally { busy = false; }
  }

  // 한 번 돌린다. manual 이면 '지금 실행'(다음 회차는 그대로 · 미루지 않음)
  async function fire(s, manual = false) {
    let r;
    try { r = await run(s); } catch (e) { r = { skip: `오류: ${e.message}` }; }
    const now = Date.now();
    if (r.off && wait(s) && !manual) { defer(s, `${r.off} — 돌아오면 넣음`); save(); return s.lastResult; }
    if (r.retry && !manual && (s.retries || 0) < RETRY_MAX) {
      s.retries = (s.retries || 0) + 1;
      s.nextRun = now + RETRY_MS;
      s.lastResult = { t: now, retry: `${r.retry} — 1분 뒤 다시 (${s.retries}/${RETRY_MAX})` };
      save();
      return s.lastResult;
    }
    s.lastResult = { t: now, ...(r.ok ? { ok: true } : { skip: r.skip || r.off || r.retry || '실패' }) };
    s.retries = 0;
    if (r.ok) s.lastRun = now;
    if (!manual) {
      s.pendingSince = null;
      if (s.kind === 'once') { s.enabled = false; s.nextRun = null; }
      else s.nextRun = nextRunOf(s, now);
    } else if (r.ok) s.pendingSince = null; // 지금 실행으로 넣었으면 미뤄 둔 회차도 끝
    save();
    return s.lastResult;
  }

  setInterval(tick, 15_000);
  setTimeout(tick, 5000);
  return { tick, fire };
}
