// 사용자 프로파일 — 클로드 키우기로 띄운 워커들의 세션을 모아 '나의 요청 습관·사용 성향'을 집계한다.
// 세션 프로파일(profile.js)은 지금 세션 하나를 메모리에서만 보고 /clear 하면 사라진다 → 여기서는 워커가 쓴 트랜스크립트 경로를
// data/user-profile.json 에 기억해 두고, 리포트를 열 때 바뀐 파일만 다시 읽어 세션별 요약을 갱신한다(요청 글은 분류·예시용 앞부분만).
// 범위: 워커 세션만. 이 PC 의 다른 Claude 세션(터미널에서 직접 연 것)은 넣지 않는다 — 워커가 쓴 경로만 기록하므로
import fs from 'node:fs';
import path from 'node:path';
import { createProfile, readProfile, profileSummary } from './profile.js';

const VERSION = 2; // 요약 형식이 바뀌면 올린다 — 다른 값이면 모두 다시 읽는다
const PROMPT_KEEP = 160;

// 요청 유형 — 키워드 규칙(한·영). 앞에 있는 규칙이 우선: 운영(커밋·빌드) → 버그 → 리뷰·정리 → 기능 → 조사·질문
export const KINDS = [
  ['ops', /커밋|푸시|push|commit|릴리즈|release|배포|deploy|빌드|build|머지|merge|브랜치|branch|태그|\btag\b|재시작|restart/i],
  ['bug', /버그|오류|에러|안\s?돼|안\s?되|안됨|안\s?나와|안\s?떠|고쳐|문제|깨져|깨지|실패|이상해|꼬여|꼬이|멈춰|\bbug|error|fix|crash|exception|fail|broken/i],
  ['review', /리뷰|검토|정리해|리팩|개선|최적화|다듬|review|refactor|clean\s?up|optimi[sz]e|tidy/i],
  ['feature', /추가|만들어|구현|넣어|기능|생성|붙여|바꿔|변경|수정해|지원|해\s?줘|해\s?주세요|하게|보이게|되게|맞춰|필요할|될\s?듯|할\s?듯|좋겠|좋을|않을까|해야|되어야|돼야|하는\s?게|너무|\badd\b|implement|create|feature|build\s|make\s|support|change/i],
  ['ask', /조사|확인|알려|설명|왜|어떻게|분석|찾아|뭐야|무엇|어디|가능|\?|investigate|explain|why|how|what|where|check|look into/i],
];
// 사람이 쓴 요청이 아닌 것: 백그라운드 작업·서브에이전트·감시 알림(🔔 — promptText 가 <task-notification> 을 바꾼 것)은 'auto',
// 슬래시 명령(/clear 등)은 'cmd'. 규칙에 안 걸린 짧은 글(응 · 네 해줘 · 그냥 유지할게)은 앞 대화에 대한 답 'reply'
export function kindOf(text) {
  const t = text.trim();
  if (t.startsWith('🔔')) return 'auto';
  if (/^\/[\w:-]+/.test(t)) return 'cmd';
  if (t.length <= 25 && /^(응|네|넵|예|ㅇㅇ|좋아|그래|오케이|ok\b|yes\b|그럼|그냥|아니)/i.test(t)) return 'reply';
  for (const [k, re] of KINDS) if (re.test(t)) return k;
  return t.length <= 20 ? 'reply' : 'etc';
}

export function createUserProfile(dataDir) {
  const file = path.join(dataDir, 'user-profile.json');
  let db = { version: VERSION, sessions: {} };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j.sessions === 'object') db = { version: VERSION, sessions: j.sessions };
    if (j.version !== VERSION) for (const s of Object.values(db.sessions)) delete s.sum; // 형식이 바뀌면 요약만 버리고 다시 읽는다
  } catch {}
  let saveT = null;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(db)); } catch {} }, 1000); };

  // 워커가 이 트랜스크립트를 쓰기 시작함 — 역할 이름·작업 폴더와 함께 기억(같은 경로면 최신 정보로)
  function note(tx, w) {
    if (!tx || typeof tx !== 'string') return;
    const s = db.sessions[tx];
    if (s && s.role === w.name && s.cwd === w.cwd) return;
    db.sessions[tx] = { ...(s || {}), role: w.name || s?.role || '?', cwd: w.cwd || s?.cwd || '', first: s?.first || Date.now() };
    save();
  }

  // 트랜스크립트 하나를 처음부터 읽어 요약 — 턴은 전부(세션 프로파일은 최근 200개만 들고 있음)
  function summarize(tx) {
    const p = createProfile(tx);
    p.maxTurns = Infinity;
    readProfile(p);
    const s = profileSummary(p);
    const turns = p.turns.map((t) => ({
      t: t.start, end: t.end, len: t.prompt.length, kind: kindOf(t.prompt), p: t.prompt.slice(0, PROMPT_KEEP),
      cost: +t.cost.toFixed(4), calls: t.calls, tools: t.tools, out: t.output, err: t.toolErrors,
    }));
    p.shots = []; // 이미지(base64)는 쓰지 않는다
    return {
      model: s.model, models: modelsOf(p), turns, cost: s.total.cost, tokens: { input: s.total.input, cacheWrite: s.total.cacheWrite, cacheRead: s.total.cacheRead, output: s.total.output },
      cacheHit: s.cacheHit, compactions: s.compactions, cacheMisses: s.cacheMisses, interrupts: p.interrupts || 0,
      tools: { ...p.tools }, toolErrors: s.toolErrors, edits: { files: s.edits.files, add: s.edits.add, del: s.edits.del },
      subagents: p.subs.size, subCost: s.sub.cost, thinking: s.thinking,
      time: { model: s.time.model, tool: s.time.tool, approval: s.time.approval, total: s.time.total },
    };
  }
  // 모델별 요청 수 — 턴마다 마지막으로 답한 모델
  function modelsOf(p) {
    const m = {};
    for (const t of p.turns) if (t.model) m[t.model] = (m[t.model] || 0) + 1;
    return m;
  }

  // 리포트용 — 바뀐 세션만 다시 읽는다. 없어진 파일은 마지막 요약을 그대로 쓴다(Claude 가 오래된 기록을 지워도 통계는 남게)
  function report() {
    let changed = false;
    for (const [tx, s] of Object.entries(db.sessions)) {
      let st;
      try { st = fs.statSync(tx); } catch { continue; }
      if (s.sum && s.size === st.size && s.mtime === st.mtimeMs) continue;
      try { s.sum = summarize(tx); s.size = st.size; s.mtime = st.mtimeMs; changed = true; } catch {}
    }
    if (changed) save();
    const sessions = Object.entries(db.sessions).filter(([, s]) => s.sum)
      .map(([tx, s]) => ({ id: path.basename(tx, '.jsonl'), role: s.role, cwd: s.cwd, first: s.first, ...s.sum }));
    return { sessions, tracked: Object.keys(db.sessions).length, since: Math.min(...Object.values(db.sessions).map((s) => s.first || Date.now()), Date.now()) };
  }
  return { note, report };
}
