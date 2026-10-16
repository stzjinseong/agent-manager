// ---------- 역할(워커)별 성장 기록 · 하루 요약 카드 ----------
// 매니저 XP(progress.js)는 한 사람 몫이라, 어느 역할이 얼마나 일했는지는 남지 않았다. 역할 이름마다
// 끝낸 작업 수(완료·중단·오류), 커밋, 도구 종류, 비용, 결정 대기 시간을 쌓고 배지로 보여 준다.
// 같은 기록을 날짜(한국 시간)별로도 쌓아 두고, 매일 오후 5시(KST)에 그날 것을 '하루 요약 카드'로 묶어 화면에 보낸다.
// 저장: data/roles.json (역할 누적 · 최근 14일 · 세션별 본 비용) · data/daily.json (최근 14장 카드)
import fs from 'node:fs';
import path from 'node:path';

const KST = 9 * 3600_000;
export const kstDay = (t = Date.now()) => new Date(t + KST).toISOString().slice(0, 10);
const kstHour = (t = Date.now()) => new Date(t + KST).getUTCHours();
export const DAILY_HOUR = 17; // 하루 요약 카드 도착 시각 (KST)
const KEEP_DAYS = 14;
const PROMPTS_PER_DAY = 30; // 역할·날짜마다 남기는 요청 글 수
const SEEN_MAX = 80;        // 세션 파일별 '이미 센 비용' 기억 수

// 도구 → 일 종류 (기록만 — 화면에는 아직 쓰지 않는다)
const TOOL_KIND = {
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'run', PowerShell: 'run',
  Read: 'read', Grep: 'read', Glob: 'read',
  WebFetch: 'web', WebSearch: 'web',
  Agent: 'agent', Task: 'agent',
};

// 배지: 조건과 이름. 화면은 아이콘 + 이름 + 조건 설명을 보여 준다
const BADGES = [
  { id: 'finisher', icon: '🏁', name: '완주왕', desc: '작업 20개 이상 · 완료율 90% 이상', ok: (r) => r.done >= 20 && r.done / ends(r) >= 0.9 },
  { id: 'committer', icon: '📦', name: '커밋 장인', desc: '커밋 50번', ok: (r) => r.commits >= 50 },
  { id: 'veteran', icon: '📅', name: '개근', desc: '일한 날 10일', ok: (r) => r.activeDays >= 10 },
  { id: 'saver', icon: '💰', name: '알뜰', desc: '작업 20개 이상 · 작업당 평균 $0.30 이하', ok: (r) => r.done >= 20 && r.cost / r.done <= 0.3 },
  { id: 'crew', icon: '🤝', name: '팀장', desc: '서브에이전트 30번', ok: (r) => r.subagents >= 30 },
  { id: 'century', icon: '💯', name: '백전노장', desc: '작업 완료 100개', ok: (r) => r.done >= 100 },
];
const ends = (r) => r.done + r.interrupted + r.failed || 1;

const freshRole = () => ({ done: 0, interrupted: 0, failed: 0, commits: 0, subagents: 0, tools: 0, kinds: {}, cost: 0, decisionMs: 0, activeDays: 0, lastDay: null, firstAt: Date.now(), lastAt: 0 });
const freshDay = () => ({ done: 0, interrupted: 0, failed: 0, commits: 0, tools: 0, cost: 0, decisionMs: 0, prompts: [] });

export function createRoleStats(dataDir) {
  const file = path.join(dataDir, 'roles.json');
  const dailyFile = path.join(dataDir, 'daily.json');
  const load = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const s = { roles: {}, days: {}, seen: {}, ...load(file) };
  const daily = { cards: [], ...load(dailyFile) }; // cards: 최신이 뒤. { date, at, seen, roles, total }

  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(s));
      } catch {}
    }, 1000);
  };
  const saveDaily = () => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(dailyFile, JSON.stringify(daily)); } catch {} };

  // 오늘(KST) 그 역할의 칸. 날짜가 바뀌면 오래된 날은 지운다
  function bump(name) {
    const r = (s.roles[name] ||= freshRole());
    const day = kstDay();
    if (r.lastDay !== day) { r.activeDays++; r.lastDay = day; }
    r.lastAt = Date.now();
    if (!s.days[day]) {
      s.days[day] = {};
      const keep = Object.keys(s.days).sort().slice(-KEEP_DAYS);
      for (const k of Object.keys(s.days)) if (!keep.includes(k)) delete s.days[k];
    }
    const d = (s.days[day][name] ||= freshDay());
    save();
    return { r, d };
  }

  // 사람이(또는 대시보드가) 보낸 요청 — 하루 요약의 '한 일' 목록. 알림 턴('<' 로 시작)은 뺀다
  function prompt(w, text) {
    const t = String(text || '').trim();
    if (!t || t.startsWith('<')) return;
    const { d } = bump(w.name);
    d.prompts.push({ t: Date.now(), text: t.replace(/\s+/g, ' ').slice(0, 140) });
    if (d.prompts.length > PROMPTS_PER_DAY) d.prompts.shift();
  }
  // 턴 끝: 'done' | 'interrupted' | 'failed'
  function end(w, how) {
    const { r, d } = bump(w.name);
    r[how]++; d[how]++;
  }
  function tool(w, name) {
    const { r, d } = bump(w.name);
    r.tools++; d.tools++;
    const k = TOOL_KIND[name];
    if (k) r.kinds[k] = (r.kinds[k] || 0) + 1;
  }
  function commit(w) { const { r, d } = bump(w.name); r.commits++; d.commits++; }
  function subagent(w) { const { r } = bump(w.name); r.subagents++; }

  // 세션 비용은 트랜스크립트 누계라, 세션 파일마다 지난번에 본 값과의 차이만 더한다.
  // 처음 보는 파일은 서버가 켜진 뒤 시작한 세션(firstAt)이면 0 부터 센다. 그 전 세션(이어 붙인 지난 세션 · 기능을 넣기 전 세션)은
  // 지금 값을 기준으로 삼아 예전 비용을 오늘로 세지 않는다
  const bootAt = Date.now();
  function cost(w, txPath, total, firstAt) {
    if (!txPath || !(total >= 0)) return;
    let prev = s.seen[txPath];
    if (prev == null && firstAt > bootAt) prev = 0;
    if (prev == null) {
      s.seen[txPath] = total;
      const keys = Object.keys(s.seen);
      if (keys.length > SEEN_MAX) for (const k of keys.slice(0, keys.length - SEEN_MAX)) delete s.seen[k];
      save();
      return;
    }
    const delta = total - prev;
    if (delta <= 0) { if (delta < 0) { s.seen[txPath] = total; save(); } return; } // 줄었으면(다시 읽기) 기준만 맞춘다
    s.seen[txPath] = total;
    const { r, d } = bump(w.name);
    r.cost += delta; d.cost += delta;
  }

  // 결정 대기 시간: 상태가 'decision' 에 들어간 시각부터 나올 때까지. 상태를 바꾸는 길이 여럿이라 상태를 보낼 때마다 훑는다
  const decisionSince = new Map(); // 워커 id → 시작 시각
  function watch(workers) {
    const now = Date.now();
    for (const w of workers) {
      const since = decisionSince.get(w.id);
      if (w.status === 'decision') { if (!since) decisionSince.set(w.id, now); continue; }
      if (!since) continue;
      decisionSince.delete(w.id);
      const ms = now - since;
      if (ms < 500 || ms > 6 * 3600_000) continue; // 순간 깜빡임 · 밤새 둔 것은 뺀다
      const { r, d } = bump(w.name);
      r.decisionMs += ms; d.decisionMs += ms;
    }
  }

  function rename(from, to) {
    if (!s.roles[from]) return;
    s.roles[to] = s.roles[to] ? merge(s.roles[to], s.roles[from]) : s.roles[from];
    delete s.roles[from];
    for (const day of Object.values(s.days)) if (day[from]) { day[to] = day[to] ? mergeDay(day[to], day[from]) : day[from]; delete day[from]; }
    save();
  }
  const merge = (a, b) => {
    const out = { ...a };
    for (const k of ['done', 'interrupted', 'failed', 'commits', 'subagents', 'tools', 'cost', 'decisionMs', 'activeDays']) out[k] = (a[k] || 0) + (b[k] || 0);
    out.kinds = { ...a.kinds };
    for (const [k, v] of Object.entries(b.kinds || {})) out.kinds[k] = (out.kinds[k] || 0) + v;
    out.firstAt = Math.min(a.firstAt, b.firstAt); out.lastAt = Math.max(a.lastAt, b.lastAt);
    return out;
  };
  const mergeDay = (a, b) => {
    const out = { ...a };
    for (const k of ['done', 'interrupted', 'failed', 'commits', 'tools', 'cost', 'decisionMs']) out[k] = (a[k] || 0) + (b[k] || 0);
    out.prompts = [...a.prompts, ...b.prompts].sort((x, y) => x.t - y.t).slice(-PROMPTS_PER_DAY);
    return out;
  };

  // 화면용: 딴 배지 · 전체 배지 수
  const badgesOf = (r) => BADGES.filter((b) => b.ok(r)).map(({ id, icon, name, desc }) => ({ id, icon, name, desc }));
  // stats: 화면이 배지마다 진행도(작업 12/20 등)를 그리는 데 쓰는 누적값
  const publicRoles = () => Object.fromEntries(Object.entries(s.roles).map(([n, r]) => [n, {
    badges: badgesOf(r), of: BADGES.length,
    stats: { done: r.done, ends: r.done + r.interrupted + r.failed, commits: r.commits, subagents: r.subagents, activeDays: r.activeDays, cost: r.cost },
  }]));

  // ---------- 하루 요약 카드 ----------
  // 오늘 일한 역할마다: 끝낸 작업 · 커밋 · 비용 · 결정 대기 · 요청 목록 · 지금 딴 배지
  function build(day = kstDay()) {
    const today = s.days[day] || {};
    const roles = Object.entries(today).map(([name, d]) => ({ name, ...d, badges: badgesOf(s.roles[name] || freshRole()) })).sort((a, b) => b.done - a.done || b.prompts.length - a.prompts.length);
    const sum = (k) => roles.reduce((a, r) => a + (r[k] || 0), 0);
    const total = { roles: roles.length, done: sum('done'), interrupted: sum('interrupted'), failed: sum('failed'), commits: sum('commits'), tools: sum('tools'), cost: sum('cost'), decisionMs: sum('decisionMs'), prompts: roles.reduce((a, r) => a + r.prompts.length, 0) };
    const mvp = roles.find((r) => r.done > 0)?.name || null;
    return { date: day, at: Date.now(), seen: false, mvp, total, roles };
  }
  // 오후 5시(KST)가 지났고 오늘 카드가 아직 없으면 만든다. 그 시각에 서버가 꺼져 있었으면 그날 안에 켜질 때 도착
  function tickDaily(force = false) {
    const day = kstDay();
    if (!force && (kstHour() < DAILY_HOUR || daily.cards.some((c) => c.date === day))) return null;
    const c = build(day);
    daily.cards = [...daily.cards.filter((x) => x.date !== day), c].slice(-KEEP_DAYS);
    saveDaily();
    return c;
  }
  function seenDaily(date) {
    const c = daily.cards.find((x) => x.date === date);
    if (!c || c.seen) return false;
    c.seen = true; saveDaily();
    return true;
  }
  const latest = () => daily.cards.at(-1) || null;
  // 상태에는 가벼운 머리말만 — 내용은 /api/daily 로 받는다
  const publicDaily = () => { const c = latest(); return c ? { date: c.date, at: c.at, seen: c.seen, dates: daily.cards.map((x) => x.date) } : null; };
  const getDaily = (date) => (date ? daily.cards.find((x) => x.date === date) : latest()) || null;

  return { prompt, end, tool, commit, subagent, cost, watch, rename, public: publicRoles, tickDaily, seenDaily, publicDaily, getDaily };
}
