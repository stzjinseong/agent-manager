// ---------- 매니저 클로드 성장 ----------
// 워커가 작업(턴) 하나를 하는 동안 일어난 일을 그 작업의 '주머니(pot)'에 쌓아 두고,
// 작업이 정상 완료(Stop)되는 순간 주머니를 매니저에게 지급한다. 중단된 작업의 주머니는 버린다.
// 화면에는 단계(stage)와 대략적인 진척만 보내고 XP 숫자는 숨긴다 — 모습이 바뀌는 걸로만 알아채게.
import fs from 'node:fs';
import path from 'node:path';

// 테마가 바뀌면(코드 업데이트로 받은 경우 포함) 단계를 0 으로 되돌리고 새로 키운다
export const THEME = { id: 'king', name: '왕' };

// 단계 문턱(누적 XP). 하루 평균 1,000~1,500 XP 기준 약 4일 · 2주 · 5주 · 3개월 · 7개월
export const STAGES = [0, 5_000, 15_000, 40_000, 100_000, 250_000];

const XP = {
  task: 10,     // 도구를 1회 이상 쓴 작업 완료
  chat: 2,      // 도구 없이 답만 한 작업 완료
  commit: 5,    // 작업 중 git commit 성공
  subagent: 5,  // 작업 중 서브에이전트 완료
};
const CONC_STEP = 0.25, CONC_MAX = 0.75; // 동시 작업 보너스: 다른 워커 1명 평균당 +25%, 최대 +75%
const STREAK_STEP = 0.1, STREAK_MAX = 0.5; // 연속 사용일 보너스: 하루당 +10%, 최대 +50%
const SAMPLE_MS = 5_000;

const fresh = () => ({ theme: THEME.id, xp: 0, stage: 0, streak: 0, lastDay: null, counts: { tasks: 0, commits: 0, subagents: 0 }, startedAt: Date.now() });
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const stageOf = (xp) => STAGES.reduce((s, min, i) => (xp >= min ? i : s), 0);

export function createProgress(dataDir, { onStageUp } = {}) {
  const file = path.join(dataDir, 'progress.json');
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { p = null; }
  if (!p || p.theme !== THEME.id) p = fresh(); // 처음이거나 테마가 바뀌었으면 0단계부터

  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(p, null, 2)); } catch {} }, 500);
  };
  save();

  const isActive = (w) => w.status === 'working' || w.status === 'decision';

  return {
    // 작업 시작 — 이미 주머니가 있으면(같은 턴 안의 추가 입력) 이어서 쌓는다
    open(w) { if (!w.pot) w.pot = { tools: 0, commits: 0, subagents: 0, samples: 0, others: 0, startedAt: Date.now() }; },
    tool(w) { if (w.pot) w.pot.tools++; },
    commit(w) { if (w.pot) w.pot.commits++; },
    subagent(w) { if (w.pot) w.pot.subagents++; },
    drop(w) { w.pot = null; },

    // 5초마다: 작업 중인 워커마다 "지금 같이 일하는 다른 워커 수"를 표본으로 쌓는다
    sample(workers) {
      const list = [...workers];
      const active = list.filter(isActive).length;
      for (const w of list) if (w.pot && isActive(w)) { w.pot.samples++; w.pot.others += active - 1; }
    },

    // 작업 완료 → 주머니 지급
    payout(w) {
      const pot = w.pot;
      w.pot = null;
      if (!pot) return 0;
      const base = (pot.tools > 0 ? XP.task : XP.chat) + pot.commits * XP.commit + pot.subagents * XP.subagent;
      const avgOthers = pot.samples ? pot.others / pot.samples : 0;
      const conc = 1 + Math.min(CONC_MAX, avgOthers * CONC_STEP);
      const now = Date.now(), today = dayOf(now), yesterday = dayOf(now - 86_400_000);
      if (p.lastDay !== today) { p.streak = p.lastDay === yesterday ? p.streak + 1 : 1; p.lastDay = today; }
      const streak = 1 + Math.min(STREAK_MAX, (p.streak - 1) * STREAK_STEP);
      const gained = Math.round(base * conc * streak);
      p.xp += gained;
      p.counts.tasks++; p.counts.commits += pot.commits; p.counts.subagents += pot.subagents;
      const before = p.stage;
      p.stage = stageOf(p.xp);
      save();
      if (p.stage > before) onStageUp?.(p.stage);
      return gained;
    },

    // 화면용: 숫자 대신 단계와 대략적인 진척(far / half / near / max)
    public() {
      const next = STAGES[p.stage + 1];
      let near = 'max';
      if (next != null) {
        const r = (p.xp - STAGES[p.stage]) / (next - STAGES[p.stage]);
        near = r < 0.34 ? 'far' : r < 0.8 ? 'half' : 'near';
      }
      // xp·stageMin·nextMin: 매니저 머리 위 경험치 바용 (지금 단계 구간 안에서 얼마나 찼는지)
      return { theme: THEME.id, themeName: THEME.name, stage: p.stage, maxStage: STAGES.length - 1, near, xp: p.xp, stageMin: STAGES[p.stage], nextMin: next ?? null };
    },
    SAMPLE_MS,
  };
}

// git commit 이 실제로 커밋을 만들었는지 — 명령에 git commit 이 있고 실패·변경 없음 흔적이 없을 때
export function isCommit(ev) {
  if (ev.tool_name !== 'Bash') return false;
  const cmd = String(ev.tool_input?.command || '');
  if (!/\bgit\b(?:\s+-C\s+\S+|\s+-c\s+\S+)*\s+commit\b/.test(cmd)) return false;
  const r = ev.tool_response || {};
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.interrupted || /nothing to commit|no changes added|fatal:|error:/i.test(out)) return false;
  return true;
}
