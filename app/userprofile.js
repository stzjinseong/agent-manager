// 사용자 프로파일 — 클로드 키우기로 띄운 워커들의 세션을 모아 '나의 요청 습관·사용 성향'을 집계한다.
// 세션 프로파일(profile.js)은 지금 세션 하나를 메모리에서만 보고 /clear 하면 사라진다 → 여기서는 워커가 쓴 트랜스크립트 경로를
// data/user-profile.json 에 기억해 두고, 리포트를 열 때 바뀐 파일만 다시 읽어 세션별 요약을 갱신한다(요청 글은 분류·예시용 앞부분만).
// 범위: 워커 세션만. 이 PC 의 다른 Claude 세션(터미널에서 직접 연 것)은 넣지 않는다 — 워커가 쓴 경로만 기록하므로
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createProfile, readProfile, profileSummary } from './profile.js';

const VERSION = 3; // 요약 형식이 바뀌면 올린다 — 다른 값이면 모두 다시 읽는다
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
    // aq: 바로 앞 턴이 Claude 의 질문으로 끝났는지(마지막 답 글 끝에 물음표·'할까요' 등) — 짧은 답이 질문에 대한 대답인지 가린다
    // gap: 앞 턴이 끝나고 이 요청을 보내기까지(ms) — 재요청 판단용
    const turns = p.turns.map((t, i) => {
      const prev = p.turns[i - 1];
      return {
        t: t.start, end: t.end, len: t.prompt.length, kind: kindOf(t.prompt), p: t.prompt.slice(0, PROMPT_KEEP),
        cost: +t.cost.toFixed(4), calls: t.calls, tools: t.tools, out: t.output, err: t.toolErrors,
        aq: Boolean(prev?.lastText && ASKED_RE.test(prev.lastText.slice(-160))), gap: prev ? Math.max(0, t.start - prev.end) : null,
      };
    });
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
    const DAY = 86_400_000, now = Date.now();
    const metrics = { 7: metricsOf(sessions, now - 7 * DAY), 30: metricsOf(sessions, now - 30 * DAY), 0: metricsOf(sessions, 0) };
    return { sessions, metrics, tracked: Object.keys(db.sessions).length, since: Math.min(...Object.values(db.sessions).map((s) => s.first || Date.now()), Date.now()) };
  }

  // ---------- AI 코치 리포트 ----------
  // 통계 요약 + 최근 요청 글 샘플을 이 PC 의 Claude CLI(claude -p, 구독 계정)로 보내 성향·개선점을 JSON 으로 받는다.
  // 결과는 data/user-profile-llm.json 에 마지막 한 벌만 둔다. 한 번에 하나만 돈다
  const llmFile = path.join(dataDir, 'user-profile-llm.json');
  let llmRunning = null;
  const lastLlm = () => { try { return JSON.parse(fs.readFileSync(llmFile, 'utf8')); } catch { return null; } };
  function llmInput(days) {
    const since = days ? Date.now() - days * 86_400_000 : 0;
    const { sessions } = report();
    const reqs = [], kinds = {}, hours = new Array(24).fill(0);
    let interrupts = 0, read = 0, inp = 0;
    for (const s of sessions) {
      const ts = s.turns.filter((t) => t.t >= since);
      if (!ts.length) continue;
      interrupts += s.interrupts || 0; read += s.tokens.cacheRead; inp += s.tokens.input + s.tokens.cacheWrite + s.tokens.cacheRead;
      for (const t of ts) {
        if (t.kind === 'auto' || t.kind === 'cmd') continue;
        kinds[t.kind] = (kinds[t.kind] || 0) + 1; hours[new Date(t.t).getHours()]++;
        reqs.push({ t: t.t, role: s.role, kind: t.kind === 'reply' && t.aq ? 'reply←Claude질문' : t.kind, p: t.p.replace(/\s+/g, ' ').trim() });
      }
    }
    reqs.sort((a, b) => a.t - b.t);
    const sample = reqs.slice(-LLM_SAMPLE);
    const stats = { requests: reqs.length, sessions: sessions.filter((s) => s.turns.some((t) => t.t >= since)).length, kinds, interrupts,
      cacheHit: inp ? +(read / inp).toFixed(3) : null, avgLen: reqs.length ? Math.round(reqs.reduce((a, r) => a + r.p.length, 0) / reqs.length) : 0, byHour: hours };
    return { stats, sample, metrics: metricsOf(sessions, since) };
  }
  // 점수는 metricsOf 가 센 값을 그대로 쓰고(모델이 매기지 않음), 강점·개선점은 그 지표 하나를 근거(evidence)로 붙여야 남긴다
  function llmPrompt({ stats, sample, metrics }, lang) {
    const en = lang === 'en';
    const mlines = metrics.list.map((x) => `- ${x.key} ${x.name}: ${x.score ?? '-'}점 (${x.desc}) · 공식: ${x.formula}${x.examples.length ? ` · 낮은 쪽 예: ${x.examples.map((e) => `"${e}"`).join(' / ')}` : ''}`);
    return [
      en ? 'You are a coach who analyzes how a developer uses an AI coding agent (Claude Code).' : '너는 개발자가 AI 코딩 에이전트(Claude Code)를 어떻게 쓰는지 분석하는 코치다.',
      en ? 'You get (1) METRICS already computed by fixed formulas, (2) STATS, (3) a SAMPLE of recent requests (oldest first, [role|kind] prefix, ≤160 chars). "reply←Claude질문" means a short reply that answered Claude\'s question — that is normal, not vague.'
        : '아래에 (1) 정해진 공식으로 이미 센 지표 METRICS, (2) 통계 STATS, (3) 최근 요청 글 샘플 SAMPLE(오래된 것부터, [역할|유형] 머리, 160자까지)이 있다. "reply←Claude질문" 은 Claude 가 물어서 짧게 답한 것이라 정상이다 — 모호한 지시로 보지 마라.',
      en ? 'Rules: do NOT invent scores. Every strength/improvement MUST cite one metric key in "metric" and its numbers in "evidence" (e.g. "done 41% — 112 of 273"). If no metric supports a point, leave it out (fewer items is fine). Quote real sample requests. Do not use tools. Output ONLY one JSON object, no code fence, in English:'
        : '규칙: 점수를 새로 매기지 마라. 강점·개선점마다 근거 지표 key 를 "metric" 에, 그 숫자를 "evidence" 에 반드시 적어라(예: "done 41% — 273건 중 112건"). 지표로 뒷받침되지 않는 일반론은 빼라(항목이 적어도 된다). 샘플의 실제 요청을 인용해라. 도구는 쓰지 말고 JSON 객체 하나만 출력해(코드 펜스 없이, 한국어로):',
      '{"headline":"<≤40자 한 줄 요약>","persona":{"name":"<성향 이름>","desc":"<2문장>"},'
        + '"comments":{"<metric key>":"<그 지표를 샘플로 풀어 쓴 한 문장>"},'
        + '"strengths":[{"title":"","detail":"","metric":"<key>","evidence":"<숫자>"}x1-3],"improvements":[{"title":"","detail":"","metric":"<key>","evidence":"<숫자>"}x1-3],'
        + '"rewrites":[{"before":"<샘플의 실제 요청 그대로>","after":"<더 나은 요청>","why":"<한 문장>"}x2],'
        + '"patterns":["<반복해서 보이는 습관>"x3-5],"next":"<가장 낮은 지표를 올리는, 다음 일주일 동안 해 볼 한 가지>"}',
      en ? 'Kinds: feature=work order, bug=fix, ask=question, ops=commit/build, review=refactor, reply=short reply, etc=other.' : '유형: feature=작업 지시, bug=버그·문제, ask=조사·질문, ops=커밋·빌드, review=리뷰·정리, reply=짧은 답, etc=기타.',
      '', 'METRICS', ...mlines, '', 'STATS ' + JSON.stringify(stats), '', 'SAMPLE',
      ...sample.map((r) => `[${r.role}|${r.kind}] ${r.p}`),
    ].join('\n');
  }
  function llmRun({ days = 30, lang = 'ko', claudeBin }) {
    if (llmRunning) return llmRunning;
    const input = llmInput(days);
    if (!input.sample.length) return Promise.resolve({ error: 'empty' });
    llmRunning = new Promise((resolve) => {
      const env = { ...process.env };
      delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
      const p = spawn(claudeBin, ['-p', '--output-format', 'json', '--model', LLM_MODEL, '--max-turns', '1'], { cwd: os.tmpdir(), env, windowsHide: true });
      let out = '', err = '';
      const kill = setTimeout(() => { try { p.kill(); } catch {} }, 240_000);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => { err += String(e); });
      p.on('close', () => {
        clearTimeout(kill);
        let res = null, rep = null;
        try { res = JSON.parse(out); } catch {}
        const text = String(res?.result || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
        try { rep = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch {}
        if (!rep) return resolve({ error: 'parse', detail: (res?.result || err || out).slice(0, 400) });
        const keys = new Set(input.metrics.list.map((x) => x.key));
        const backed = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => x && keys.has(x.metric) && String(x.evidence || '').trim());
        const dropped = (rep.strengths?.length || 0) + (rep.improvements?.length || 0);
        rep.strengths = backed(rep.strengths); rep.improvements = backed(rep.improvements);
        delete rep.scores;
        const doc = { at: Date.now(), days, n: input.sample.length, total: input.stats.requests, model: Object.keys(res.modelUsage || {})[0] || LLM_MODEL, cost: res.total_cost_usd ?? null,
          dropped: dropped - rep.strengths.length - rep.improvements.length, metrics: input.metrics.list.map(({ examples, ...x }) => x), report: rep };
        try { fs.writeFileSync(llmFile, JSON.stringify(doc)); } catch {}
        resolve(doc);
      });
      p.stdin.end(llmPrompt(input, lang));
    }).finally(() => { llmRunning = null; });
    return llmRunning;
  }
  return { note, report, lastLlm, llmRun, llmBusy: () => Boolean(llmRunning), llmCount: (days) => Math.min(LLM_SAMPLE, llmInput(days).stats.requests) };
}
const ASKED_RE = /\?\s*$|\?\s*[\n)]|까요\s*[?.]?\s*$|할까요|될까요|드릴까요|진행할까|하시겠|원하시면|알려\s?주세요|골라\s?주세요|정해\s?주세요|should I|shall I|do you want|would you like|let me know/i;

// ---------- 요청 습관 지표 — 정해진 공식으로 센다(돌릴 때마다 같은 값). AI 코치는 이 숫자를 근거로만 말한다 ----------
const M_RE = {
  // 대상이 보이는 요청: 파일·확장자, 백틱 코드, 경로, 번호(#12·숫자), 식별자(camelCase·snake_case)
  target: /[\w-]+\.(?:js|mjs|ts|tsx|cs|json|md|py|html|css|txt|png|jpg|mp4|yaml|yml|xml|unity|prefab|asset)\b|`[^`]+`|[\\/][\w.-]+[\\/]|#\d+|\d|\b[a-z]+[A-Z]\w*|\b\w+_\w+/,
  // 맥락을 붙인 요청: 이유·상황·비교·예시·첨부(이미지·붙여넣기)
  context: /왜냐|때문|해서|하니까|인데|는데|지만|었는데|더니|\[Image #|pasted|로그|오류 메시지|에러 메시지|스크린샷|화면에|예:|예를 들|처럼|같이|현재|지금은|원래|기존|because|since|currently|e\.g\./i,
  // 완료 기준을 적은 요청: 검증·확인·재현·결과 형태
  done: /검증|확인해|확인까지|테스트|재현|영상|스크린샷|캡처|까지\s|되도록|되게|기준|결과|보고해|표로|빌드해|돌려\s?봐|verify|test|until|so that/i,
  // 고쳐 달라는 재요청: 앞 작업 결과가 안 맞을 때 나오는 말
  rework: /다시|아직|여전히|안\s?돼|안\s?되|안됨|그대로|또\s|왜 안|틀렸|아니야|아니라|잘못|안 바뀌|안 나와|안 떠|안 보여|이상해|still|again|not working|wrong/i,
};
const WORK = new Set(['feature', 'bug', 'ask', 'ops', 'review', 'etc']);
export function metricsOf(sessions, since = 0) {
  const all = [], ordered = [];
  let interrupts = 0;
  for (const s of sessions) {
    const ts = s.turns.filter((t) => t.t >= since && t.kind !== 'auto' && t.kind !== 'cmd');
    if (!ts.length) continue;
    interrupts += s.interrupts || 0;
    for (const t of ts) all.push({ ...t, role: s.role });
    ordered.push(ts);
  }
  const work = all.filter((t) => WORK.has(t.kind)), orders = all.filter((t) => t.kind === 'feature' || t.kind === 'bug');
  const ex = (arr) => arr.slice(-3).map((t) => t.p.replace(/\s+/g, ' ').slice(0, 90));
  const ratio = (n, d) => (d ? n / d : null);
  const clearN = work.filter((t) => t.len >= 15 || M_RE.target.test(t.p)), unclear = work.filter((t) => !(t.len >= 15 || M_RE.target.test(t.p)));
  const ctxPool = work.filter((t) => t.kind !== 'ops'), ctxN = ctxPool.filter((t) => t.len >= 80 || M_RE.context.test(t.p));
  const doneN = orders.filter((t) => M_RE.done.test(t.p)), noDone = orders.filter((t) => !M_RE.done.test(t.p));
  // 재요청: 앞 턴이 끝나고 30분 안에, 앞 결과를 고쳐 달라는 말로 시작한 요청(질문형 조사는 뺌)
  const rework = all.filter((t) => t.gap != null && t.gap < 30 * 60_000 && t.kind !== 'ask' && M_RE.rework.test(t.p.slice(0, 40))); // 앞 40자 — 새 요청 중간의 '안 되어 있으면' 같은 말은 빼려고
  const replies = all.filter((t) => t.kind === 'reply'), replyToQ = replies.filter((t) => t.aq), bareReply = replies.filter((t) => !t.aq);
  const m = (key, name, num, den, desc, formula, examples = []) => {
    const r = ratio(num, den);
    return { key, name, score: r == null ? null : Math.round(r * 100), num, den, desc, formula, examples };
  };
  const rw = ratio(rework.length, orders.length);
  return {
    requests: all.length, work: work.length, orders: orders.length, interrupts, replies: replies.length, replyToQ: replyToQ.length,
    list: [
      m('clarity', '명확성', clearN.length, work.length, `작업 요청 ${work.length}건 중 ${clearN.length}건이 대상이 분명함`, '15자 이상이거나 파일·코드·경로·번호를 담은 작업 요청 비율', ex(unclear)),
      m('context', '맥락 제공', ctxN.length, ctxPool.length, `요청 ${ctxPool.length}건 중 ${ctxN.length}건에 이유·상황·첨부를 붙임`, '80자 이상이거나 이유·상황·예시·이미지·붙여넣기를 담은 요청 비율(커밋·빌드 제외)', ex(ctxPool.filter((t) => !(t.len >= 80 || M_RE.context.test(t.p))))),
      m('done', '완료 기준', doneN.length, orders.length, `작업 지시·버그 ${orders.length}건 중 ${doneN.length}건에 검증·결과 형태를 적음`, '작업 지시·버그 요청 중 검증·확인·재현·결과 형태를 적은 비율', ex(noDone)),
      { ...m('firstpass', '한 번에 끝냄', Math.max(0, orders.length - rework.length), orders.length, `작업 지시·버그 ${orders.length}건 뒤 고쳐 달라는 재요청 ${rework.length}건(${rw == null ? '-' : Math.round(rw * 100)}%)`, '1 − (앞 작업 30분 안에 다시·아직·안 돼 등으로 시작한 재요청 ÷ 작업 지시·버그)', ex(rework)), rework: rework.length },
      m('flow', '한 번에 맡기기', all.length - bareReply.length, all.length, `요청 ${all.length}건 중 질문 없이 보낸 '응·진행해' 같은 짧은 답 ${bareReply.length}건(Claude 질문에 답한 ${replyToQ.length}건은 제외)`, '1 − (Claude 가 묻지 않았는데 보낸 짧은 답 ÷ 전체 요청)', ex(bareReply)),
    ],
  };
}
const LLM_SAMPLE = 120; // 보내는 요청 글 수(최근 것부터)
const LLM_MODEL = 'sonnet'; // 분석용 — 구독 사용량을 덜 쓰는 모델
