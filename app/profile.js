// 세션 프로파일러 — Claude Code 트랜스크립트(.jsonl)를 증분으로 읽어 턴별 토큰·비용을 집계한다.
// 형식은 공식 계약이 아니다(버전마다 바뀔 수 있음). v2.1.284 실측 기준:
//  - assistant 줄: message.id, message.model, message.usage{input_tokens, cache_creation_input_tokens,
//    cache_read_input_tokens, output_tokens, cache_creation{ephemeral_5m/1h_input_tokens}}, content[] 의 tool_use.
//    한 메시지가 스트리밍 블록마다 같은 id 로 여러 줄 기록되므로 id 기준으로 마지막 usage 만 반영한다.
//  - user 줄: content 가 문자열(또는 text 블록)이면 사람이 보낸 질문 = 턴 경계. tool_result 는 턴 내부.
//  - 서브에이전트: <세션파일명>/subagents/agent-*.jsonl, 옆의 .meta.json 의 toolUseId 가
//    메인 트랜스크립트에서 그 서브에이전트를 띄운 tool_use id 다 → 해당 턴에 귀속.
//  - 파일 수정: Edit/Write 결과가 담긴 user 줄의 toolUseResult{ filePath, structuredPatch[{oldStart, oldLines, newStart,
//    newLines, lines['+…'|'-…'|' …']}], userModified }. 새로 만든 파일(Write, type 'create')은 patch 가 비고 content 만 있다.
//    서브에이전트 트랜스크립트에도 같은 모양으로 남는다 → 띄운 메인 턴에 귀속. 셸 명령(Bash)으로 바뀐 파일은
//    트랜스크립트에 내용이 없어 서버가 git 으로 명령 전후를 비교해 p.shellEdits 에 넣는다(shelldiff.js).
import fs from 'node:fs';
import path from 'node:path';
import { priceFor, costOf, windowFor } from './pricing.js';

const MAX_TURNS = 200;
const KEYS = ['input', 'cacheWrite', 'cacheRead', 'output', 'cost'];

export function createProfile(file) {
  return {
    path: file, offset: 0, rest: '', timer: null,
    subDir: path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents'),
    msgs: new Map(), // message.id → { turn, usage }
    toolTurn: new Map(), // tool_use id → turn
    subs: new Map(), // 서브에이전트 파일 → 상태
    toolResults: new Set(), // 결과가 돌아온 tool_use id (포그라운드 서브에이전트 완료 판정)
    doneAgents: new Set(), // 완료 알림(<task-notification>) 또는 SubagentStop 훅으로 끝난 agentId
    // 백그라운드 작업 (Monitor 감시 · run_in_background 명령). 턴이 끝나도 계속 돈다 → '백그라운드 대기' 판정용
    bgTasks: new Map(), // task id → { kind: 'monitor'|'shell', desc, startedAt, expiresAt, done }
    bgCalls: new Map(), // 백그라운드로 시작한 tool_use id → { kind, desc } (결과에서 task id 를 읽기 전까지)
    turns: [], tools: {}, model: null, modelAt: 0, compactions: 0, context: 0, unpriced: false,
    // 시간 측정: 직전 이벤트 시각, 진행 중인 도구 구간, 도구 호출별 시작
    lastTs: 0, seg: null, toolStart: new Map(), toolTime: {},
    // 도구 결과에 담긴 이미지(Read 로 연 그림, MCP 스크린샷 등). 서버가 읽을 때마다 꺼내 파일로 저장하고 비운다
    shots: [],
    // 세션 전체 누적 — turns 는 최근 MAX_TURNS 개만 들고 있어, 합계를 거기서 더하면 긴 세션에서 작게 나왔다
    sess: { ...empty(), thinking: 0, calls: 0, tools: 0 },
    miss: { n: 0, cost: 0, reasons: {} }, // 캐시 재작성(턴이 끝날 때 확정해 센다)
    apiErrors: [], quota: null, // API 오류(429 등)·사용량 한도 — Claude Code 가 '<synthetic>' 응답 줄로 남긴다
    toolErrors: 0, toolErrBy: {}, // 도구 결과 is_error
    compactLog: [], // compact_boundary.compactMetadata
    edits: [], editSeen: new Set(), // Edit/Write 로 고친 파일 이력 (diff 보기) — editOf. editSeen: 같은 결과가 두 번 기록돼도 한 번만
    diffClearedAt: 0, // diff 목록 비우기(🗑) 시각 — 그때까지의 수정은 다시 읽어도 담지 않는다(clearEdits)
    shellEdits: [], // 셸 명령으로 바뀐 파일 (서버가 git 비교로 채운다 — 트랜스크립트엔 없음)
  };
}

const empty = () => Object.fromEntries(KEYS.map((k) => [k, 0]));

const MAX_EDIT_LINES = 3000; // 아주 큰 파일을 통째로 쓴 경우 메모리·전송량이 커지지 않게 수정 하나의 줄 수를 자른다
// diff 보관 기준: 파일을 고친 최근 요청 KEEP_REQUESTS 개까지, 바뀐 줄을 다 합쳐 MAX_DIFF_LINES 줄까지 — 넘으면 오래된 요청부터 통째로 뺀다
// (가장 최근 요청은 늘 남김). 건수가 아니라 요청 단위라 한 요청의 기록이 중간에 잘리지 않는다. MAX_EDITS 는 줄이 없는 기록(삭제·바이너리)용 안전판
export const KEEP_REQUESTS = 30, MAX_DIFF_LINES = 20_000;
const MAX_EDITS = 2000;

// 도구 결과(toolUseResult) → 수정 이력 한 건. 수정이 아니면 null
function editOf(r, id, tool, turn, ts) {
  if (!r || typeof r !== 'object' || typeof r.filePath !== 'string') return null;
  let hunks;
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) hunks = r.structuredPatch;
  else if (r.type === 'create' && typeof r.content === 'string') {
    const lines = r.content.replace(/\n$/, '').split('\n');
    hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
  } else return null;
  return { id, ts, turn: turn?.n ?? null, tool: tool || null, file: r.filePath, kind: r.type === 'create' ? 'create' : 'edit',
    ...trimHunks(hunks), userModified: Boolean(r.userModified) };
}
// +/− 를 세고, 아주 긴 변경은 앞 MAX_EDIT_LINES 줄만 남긴다 (cut). 셸 명령 비교 결과도 같은 규칙
export function trimHunks(hunks) {
  let add = 0, del = 0, budget = MAX_EDIT_LINES, cut = false;
  hunks = hunks.map((h) => {
    const lines = Array.isArray(h.lines) ? h.lines : [];
    for (const l of lines) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
    const keep = lines.slice(0, Math.max(0, budget));
    if (keep.length < lines.length) cut = true;
    budget -= keep.length;
    return { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: keep };
  }).filter((h) => h.lines.length);
  return { add, del, cut, hunks };
}
function pushEdit(p, ed) {
  if (ed.ts <= p.diffClearedAt) return null;
  p.edits.push(ed);
  // 긴 트랜스크립트를 읽는 동안에도 메모리가 불지 않게 가끔 — 이때는 Edit/Write 만(셸 수정은 아직 안 읽은 턴에 속할 수 있어 다 읽은 뒤에)
  if (p.edits.length % 50 === 0) pruneEdits(p, false);
}
const editLines = (ed) => (ed.hunks || []).reduce((a, h) => a + h.lines.length, 0);
// 보관 기준(KEEP_REQUESTS · MAX_DIFF_LINES · MAX_EDITS)에 맞게 오래된 요청의 수정을 뺀다 — Edit/Write 와 셸 수정을 같은 요청 단위로
export function pruneEdits(p, withShell = true) {
  // 상태를 보낼 때마다 불리므로(profileSummary) 수정·턴 수가 그대로면 건너뛴다
  const key = `${withShell}:${p.edits.length}:${p.shellEdits.length}:${p.turns.length}:${p.turns.at(-1)?.n}`;
  if (p.pruneKey === key) return false;
  p.pruneKey = key;
  const all = withShell ? allEdits(p) : p.edits;
  const lines = new Map(), count = new Map(), order = [];
  for (let i = all.length - 1; i >= 0; i--) {
    const t = all[i].turn ?? null;
    if (!lines.has(t)) { lines.set(t, 0); count.set(t, 0); order.push(t); } // 최근에 고친 요청부터
    lines.set(t, lines.get(t) + editLines(all[i])); count.set(t, count.get(t) + 1);
  }
  const keep = new Set();
  let sumL = 0, sumN = 0;
  for (const t of order) {
    if (keep.size >= KEEP_REQUESTS) break;
    if (keep.size && (sumL + lines.get(t) > MAX_DIFF_LINES || sumN + count.get(t) > MAX_EDITS)) break;
    keep.add(t); sumL += lines.get(t); sumN += count.get(t);
  }
  if (keep.size === order.length) return false;
  const turnOfShell = (ed) => (p.toolTurn.get(ed.toolUseId) || turnAt(p, ed.ts))?.n ?? null;
  p.edits = p.edits.filter((ed) => keep.has(ed.turn ?? null));
  if (withShell) p.shellEdits = p.shellEdits.filter((ed) => keep.has(turnOfShell(ed)));
  return true;
}

function usageOf(m, p) {
  const u = m.usage;
  const write = u.cache_creation_input_tokens || 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const usage = {
    input: u.input_tokens || 0, cacheWrite: write, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0,
    w1h, w5: Math.max(0, write - w1h),
    thinking: u.output_tokens_details?.thinking_tokens || 0, // 출력 중 사고(thinking) 토큰 — 출력에 포함된 값
  };
  const price = priceFor(m.model);
  if (!price && m.model && m.model !== '<synthetic>') p.unpriced = true;
  usage.cost = costOf(usage, price);
  return usage;
}

function promptText(e) {
  if (e.isMeta || e.isSidechain) return null;
  const c = e.message?.content;
  // 사람이 이미지를 붙인 지시는 [text, image] 블록으로 온다 — 글만 모으고, 글 없이 이미지뿐이면 '(이미지)'
  let text = typeof c === 'string' ? c
    : Array.isArray(c) && c.length && c.every((b) => b.type === 'text' || b.type === 'image')
      ? (c.some((b) => b.type === 'text') ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '(이미지)') : null;
  if (text == null) return null;
  if (/^<(local-command-stdout|local-command-stderr|command-message|system-reminder)/.test(text)) return null;
  // 백그라운드 작업 완료 알림도 모델 턴을 일으키므로 턴으로 세되, 사람 질문과 구분되게 표시
  if (text.startsWith('<task-notification>')) {
    const sum = text.match(/<summary>([^<]*)<\/summary>/);
    return `🔔 ${sum ? sum[1] : '백그라운드 작업 알림'}`;
  }
  const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) { const args = text.match(/<command-args>([^<]*)<\/command-args>/); text = `${cmd[1]} ${args?.[1] || ''}`.trim(); }
  return text.trim() || null;
}

// 캐시 재작성: 이전 턴이 있는데 첫 호출이 캐시를 거의 못 읽고 크게 새로 썼다. 원인은 API 가 진단을 붙여 주면
// 그 값(diagnostics.cache_miss_reason.type)을, 없으면 공백 시간으로 만료를 추정한다. 단가는 그 턴의 모델 기준
function missOf(t) {
  const f = t.first;
  if (!t.hasPrev || !f || f.cacheWrite < 10_000 || f.cacheWrite <= f.cacheRead) return null;
  const ttl = f.w1h > 0 ? 3600_000 : 300_000;
  const price = priceFor(t.model);
  // 같은 토큰을 읽었으면 냈을 값과의 차이
  const extra = price ? (f.cacheWrite * price.input * (f.w1h > 0 ? 2 : 1.25) - f.cacheWrite * price.read) / 1e6 : null;
  return { tokens: f.cacheWrite, gap: t.gap, ttl, expired: t.gap != null && t.gap > ttl, extra, reason: t.missReason || null };
}
const missKey = (m) => m.reason || (m.expired ? 'expired' : 'unknown');
function countMiss(p, t) {
  if (t.missCounted) return;
  t.missCounted = true;
  const m = missOf(t);
  if (!m) return;
  p.miss.n++; p.miss.cost += m.extra || 0;
  p.miss.reasons[missKey(m)] = (p.miss.reasons[missKey(m)] || 0) + 1;
}

function newTurn(p, text, ts) {
  closeSeg(p);
  const last = p.turns.at(-1);
  if (last) countMiss(p, last); // 앞 턴은 이제 바뀌지 않는다 → 캐시 재작성 확정
  const t = { n: (last?.n || 0) + 1, prompt: text.slice(0, 200), start: ts, end: ts, calls: 0, tools: 0, firstId: null, first: null,
    firstAt: null, modelMs: 0, toolWallMs: 0, toolPer: {}, ...empty(), thinking: 0, toolErrors: 0, model: null,
    hasPrev: Boolean(last), gap: last ? ts - last.end : null, missReason: null, missCounted: false };
  p.turns.push(t);
  if (p.turns.length > MAX_TURNS) p.turns.shift();
  return t;
}

// 도구 구간(모델이 도구를 부른 순간 → 마지막 도구 결과)을 닫아 턴의 도구 시간에 더한다.
// 병렬 도구는 겹치므로 개별 합이 아니라 이 벽시계 구간으로 잰다.
function closeSeg(p) {
  if (!p.seg) return;
  // 도구는 tool_use 블록이 써지자마자 실행되므로 모델 생성과 겹친다 — 겹친 부분은 모델 시간으로 두고 그 뒤만 도구 시간
  p.seg.turn.toolWallMs += Math.max(0, p.seg.end - Math.max(p.seg.start, p.seg.modelEnd));
  p.seg = null;
}

function apply(p, e, line) {
  // 완료 알림은 user 메시지·대기열(queue-operation)·첨부(queued_command) 어디로든 기록될 수 있어 원문 줄에서 찾는다
  if (line.includes('<task-notification>')) {
    for (const m of line.matchAll(/<task-id>([^<]+)<\/task-id>/g)) p.doneAgents.add(m[1].trim());
    // 백그라운드 작업은 <status> 가 붙은 알림이 와야 끝난 것 — Monitor 의 중간 "Monitor event" 알림엔 status 가 없다
    for (const blk of line.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const id = blk[1].match(/<task-id>([^<]+)<\/task-id>/)?.[1]?.trim();
      if (id && /<status>[^<]+<\/status>/.test(blk[1]) && p.bgTasks.has(id)) p.bgTasks.get(id).done = true;
    }
  }
  const ts = Date.parse(e.timestamp) || Date.now();
  if (e.type === 'system' && /compact/i.test(e.subtype || '')) {
    p.compactions++;
    const cm = e.compactMetadata;
    if (cm) { p.compactLog.push({ ts, trigger: cm.trigger || null, pre: cm.preTokens ?? null, post: cm.postTokens ?? null, ms: cm.durationMs ?? null }); if (p.compactLog.length > 20) p.compactLog.shift(); }
    return;
  }
  if (e.type === 'user') {
    const c = e.message?.content;
    if (Array.isArray(c)) for (const b of c) {
      if (b.type !== 'tool_result' || !b.tool_use_id) continue;
      p.toolResults.add(b.tool_use_id);
      if (!b.is_error && !p.editSeen.has(b.tool_use_id)) {
        const st = p.toolStart.get(b.tool_use_id);
        const ed = editOf(e.toolUseResult, b.tool_use_id, st?.name, st?.turn || p.toolTurn.get(b.tool_use_id), ts);
        if (ed) { p.editSeen.add(b.tool_use_id); pushEdit(p, ed); }
      }
      // 이미지 블록: { type:'image', source:{ type:'base64', media_type, data } } — 실측 Read 134건 모두 이 모양
      if (Array.isArray(b.content)) b.content.forEach((x, i) => {
        if (x?.type !== 'image' || x.source?.type !== 'base64' || !x.source.data) return;
        const st = p.toolStart.get(b.tool_use_id);
        p.shots.push({ key: `${b.tool_use_id}-${i}`, ts, tool: st?.name || null, arg: st?.arg || null, media: x.source.media_type, data: x.source.data });
        if (p.shots.length > 60) p.shots.shift(); // 처음부터 다시 읽을 때 base64 가 메모리에 쌓이지 않게 (서버가 최근 50장만 남기므로 그보다 조금 넉넉히)
      });
      // 백그라운드로 시작한 호출의 결과에서 task id 를 읽어 등록
      const bc = p.bgCalls.get(b.tool_use_id);
      if (bc) {
        p.bgCalls.delete(b.tool_use_id);
        const txt = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('') : String(b.content || '');
        const id = txt.match(/background with ID: (\w+)/)?.[1] || txt.match(/Monitor started \(task (\w+)/)?.[1];
        const min = Number(txt.match(/expires in (\d+)\s*m/)?.[1]);
        if (id) p.bgTasks.set(id, { kind: bc.kind, desc: bc.desc, startedAt: ts, expiresAt: min ? ts + min * 60_000 : null, done: false });
      }
      const s = p.toolStart.get(b.tool_use_id);
      if (b.is_error) {
        p.toolErrors++;
        const nm = s?.name || '?';
        p.toolErrBy[nm] = (p.toolErrBy[nm] || 0) + 1;
        if (s) s.turn.toolErrors++;
      }
      if (s) {
        const ms = Math.max(0, ts - s.ts);
        s.turn.toolPer[s.name] = (s.turn.toolPer[s.name] || 0) + ms;
        const tt = p.toolTime[s.name] || (p.toolTime[s.name] = { n: 0, ms: 0, max: 0 });
        tt.n++; tt.ms += ms; tt.max = Math.max(tt.max, ms);
        p.toolStart.delete(b.tool_use_id);
      }
      if (p.seg) p.seg.end = Math.max(p.seg.end, ts);
    }
    p.lastTs = ts;
    p.lastKind = 'user';
    // 사용자 중단(Esc)은 Stop 훅이 오지 않고 이 문구의 user 메시지로만 남는다 — 턴이 아니라 중단 시각으로 기록
    const first = typeof c === 'string' ? c : Array.isArray(c) && c[0]?.type === 'text' ? c[0].text : '';
    if (first.startsWith('[Request interrupted by user')) { p.interruptedAt = ts; return; }
    if (e.isCompactSummary) return; // 압축 뒤 이어 붙는 요약 글 — 사람이 보낸 질문이 아니라 턴으로 세지 않는다
    const text = promptText(e);
    if (text) newTurn(p, text, ts);
    return;
  }
  if (e.type === 'assistant' && e.quotaLimits) p.quota = { ...e.quotaLimits, ts };
  // API 오류(429 레이트리밋 등)는 '<synthetic>' 응답으로 남는다 — 실제 API 호출이 아니므로 호출·토큰에 넣지 않고 따로 모은다
  if (e.type === 'assistant' && e.isApiErrorMessage) {
    const txt = (e.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 200);
    p.apiErrors.push({ ts, status: e.apiErrorStatus ?? null, text: txt });
    if (p.apiErrors.length > 10) p.apiErrors.shift();
    return;
  }
  if (e.type !== 'assistant' || !e.message?.usage || e.isSidechain) return;

  const m = e.message, usage = usageOf(m, p);
  const turn = p.turns.at(-1) || newTurn(p, '(기록 시작 전)', ts);
  const prev = p.msgs.get(m.id);
  const target = prev?.turn || turn;
  if (!prev) { if (!target.calls) target.firstId = m.id; target.calls++; p.sess.calls++; }
  const why = m.diagnostics?.cache_miss_reason?.type;
  if (why && target.firstId === m.id) target.missReason = why;
  // 모델 시간: 새 응답이면 요청을 보낸 시점(직전 이벤트)부터, 같은 응답의 다음 줄이면 이전 줄부터 (스트리밍)
  if (!prev) { closeSeg(p); target.modelMs += Math.max(0, ts - Math.max(p.lastTs, target.start)); }
  else target.modelMs += Math.max(0, ts - prev.end);
  // 프롬프트 캐시 수명: 호출마다(읽기도) 다시 TTL 만큼 늘어난다 — 시작은 요청을 보낸 시점(직전 이벤트)으로 보수적으로.
  // TTL 은 캐시를 쓸 때 기록된 종류(1시간/5분)로 알고, 읽기만 한 호출은 직전에 알던 값을 그대로 쓴다
  if (!prev) p.cacheAt = p.lastTs || ts;
  // 한 호출에 두 종류가 섞이면 짧은 쪽(5분)이 먼저 만료되므로 그쪽을 따른다
  if (usage.w5 > 0) p.cacheTtl = 300_000; else if (usage.w1h > 0) p.cacheTtl = 3600_000;
  if (p.seg && p.seg.msgId === m.id) p.seg.modelEnd = ts;
  target.firstAt ??= ts;
  for (const k of [...KEYS, 'thinking']) { const d = usage[k] - (prev?.usage[k] || 0); target[k] += d; p.sess[k] += d; }
  if (target.firstId === m.id) target.first = { cacheWrite: usage.cacheWrite, cacheRead: usage.cacheRead, w1h: usage.w1h };
  p.msgs.set(m.id, { turn: target, usage, end: ts });
  p.lastTs = ts;
  p.lastKind = 'assistant';
  p.lastStop = m.stop_reason || null; // 'end_turn' 이면 응답이 정상으로 끝난 것 (스트리밍 중간 줄은 null)
  p.lastText = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n') || p.lastText;
  target.end = ts;
  if (m.model && m.model !== '<synthetic>') { p.model = m.model; p.modelAt = ts; target.model = m.model; }
  p.context = usage.input + usage.cacheWrite + usage.cacheRead;
  target.context = p.context;
  for (const b of m.content || []) {
    if (b.type !== 'tool_use' || p.toolTurn.has(b.id)) continue;
    p.toolTurn.set(b.id, target);
    target.tools++; p.sess.tools++;
    const name = b.name?.startsWith('mcp__') ? `MCP · ${b.name.split('__')[1]}` : b.name;
    const inp = b.input || {};
    p.toolStart.set(b.id, { name, ts, turn: target, arg: String(inp.file_path || inp.url || inp.description || '').slice(0, 200) || null });
    if (b.name === 'Monitor' || inp.run_in_background) {
      p.bgCalls.set(b.id, { kind: b.name === 'Monitor' ? 'monitor' : 'shell', desc: String(inp.description || inp.command || b.name).slice(0, 120) });
    }
    // 백그라운드 작업을 직접 멈춘 경우 (TaskStop / KillShell)
    const stopId = (b.name === 'TaskStop' || b.name === 'KillShell' || b.name === 'KillBash') && (inp.task_id || inp.shell_id || inp.id);
    if (stopId && p.bgTasks.has(stopId)) p.bgTasks.get(stopId).done = true;
    if (!p.seg) p.seg = { start: ts, end: ts, turn: target, msgId: m.id, modelEnd: ts };
    p.tools[name] = (p.tools[name] || 0) + 1;
  }
}

// 파일 끝에 새로 붙은 줄만 읽는다
function readLines(state, file, onEntry) {
  let size;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size < state.offset) return 'reset';
  if (size === state.offset) return false;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - state.offset);
  fs.readSync(fd, buf, 0, buf.length, state.offset);
  fs.closeSync(fd);
  state.offset = size;
  const lines = (state.rest + buf.toString('utf8')).split('\n');
  state.rest = lines.pop(); // 아직 다 안 쓰인 마지막 줄
  for (const line of lines) {
    if (!line.trim()) continue;
    try { onEntry(JSON.parse(line), line); } catch {}
  }
  return true;
}

function readSubagents(p) {
  let files;
  try { files = fs.readdirSync(p.subDir).filter((f) => f.endsWith('.jsonl')); } catch { return false; }
  let changed = false;
  for (const f of files) {
    const full = path.join(p.subDir, f);
    let s = p.subs.get(f);
    if (!s) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(full.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
      const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      s = { agentId, offset: 0, rest: '', meta, msgs: new Map(), model: null, calls: 0, start: null, end: null, tools: new Map(), ...empty() };
      p.subs.set(f, s);
    }
    const r = readLines(s, full, (e) => {
      const ts = Date.parse(e.timestamp) || null;
      if (ts) { s.start ??= ts; s.end = ts; }
      // 서브에이전트가 Edit/Write 로 고친 파일 — 그 서브에이전트를 띄운 메인 턴의 수정으로 (시간이 없으면 그 시각의 턴)
      if (e.type === 'assistant') for (const b of e.message?.content || []) if (b.type === 'tool_use') s.tools.set(b.id, b.name);
      if (e.type === 'user' && Array.isArray(e.message?.content)) for (const b of e.message.content) {
        if (b.type !== 'tool_result' || !b.tool_use_id || b.is_error || p.editSeen.has(b.tool_use_id)) continue;
        const turn = p.toolTurn.get(s.meta.toolUseId) || turnAt(p, ts);
        const ed = editOf(e.toolUseResult, b.tool_use_id, s.tools.get(b.tool_use_id), turn, ts || Date.now());
        if (ed) { ed.agent = s.meta.agentType || 'subagent'; p.editSeen.add(b.tool_use_id); pushEdit(p, ed); }
      }
      if (e.type !== 'assistant' || !e.message?.usage) return;
      const usage = usageOf(e.message, p), prev = s.msgs.get(e.message.id);
      if (!prev) s.calls++;
      for (const k of KEYS) s[k] += usage[k] - (prev?.[k] || 0);
      s.msgs.set(e.message.id, usage);
      s.model = e.message.model || s.model;
    });
    if (r) changed = true;
  }
  return changed;
}

function isRunning(p, s) {
  if (p.doneAgents.has(s.agentId)) return false;
  // 포그라운드는 도구 결과가 돌아오면 끝. 백그라운드는 즉시 "launched" 결과가 오므로 완료 알림만 믿는다
  if (s.meta.requestShape !== 'background' && s.meta.toolUseId && p.toolResults.has(s.meta.toolUseId)) return false;
  return true;
}

// 돌고 있는 백그라운드 작업(감시·명령). Monitor 는 만료 시각이 지나면 끝난 것으로 본다
function runningTasks(p) {
  const now = Date.now();
  return [...p.bgTasks.entries()].filter(([, t]) => !t.done && !(t.expiresAt && now > t.expiresAt)).map(([id, t]) => ({ id, ...t }));
}

// 서버가 '계속 읽기'를 판단할 때 쓰는 개수 — 서브에이전트 + 백그라운드 작업
export function runningSubagents(p) {
  let n = runningTasks(p).length;
  for (const s of p.subs.values()) if (isRunning(p, s)) n++;
  return n;
}

// 변화가 있으면 true
export function readProfile(p) {
  let r = readLines(p, p.path, (e, line) => apply(p, e, line));
  // 트랜스크립트가 줄었으면 처음부터 다시 읽는다 — 셸 수정은 트랜스크립트에 없는 서버 기록이라 그대로 둔다(비우면 다음 정리 때 디스크 파일까지 지워졌다)
  if (r === 'reset') { const { shellEdits: shell, diffClearedAt } = p; Object.assign(p, createProfile(p.path)); Object.assign(p, { shellEdits: shell, diffClearedAt }); r = readLines(p, p.path, (e, line) => apply(p, e, line)); }
  const s = readSubagents(p);
  return Boolean(r || s);
}

// 그 시각에 진행 중이던 턴 (턴 시작이 그 시각 이전인 마지막 턴)
function turnAt(p, ts) {
  if (!ts) return p.turns.at(-1) || null;
  for (let i = p.turns.length - 1; i >= 0; i--) if (p.turns[i].start <= ts) return p.turns[i];
  return null;
}
// diff 목록 비우기 — 지금까지의 수정(Edit/Write·셸)을 버리고, 트랜스크립트를 다시 읽어도(서버 재시작) 그 시각 전 것은 담지 않는다
export function clearEdits(p, at = Date.now()) {
  p.diffClearedAt = at;
  p.edits = [];
  p.shellEdits = [];
  p.pruneKey = null;
}
// Edit/Write(메인·서브에이전트) + 셸 명령 수정을 시간순으로. 셸 수정의 턴은 그 Bash 호출의 턴(서브에이전트 Bash 면 그 시각의 턴)
function allEdits(p) {
  const shell = p.shellEdits.filter((ed) => ed.ts > p.diffClearedAt).map((ed) => ({ ...ed, turn: (p.toolTurn.get(ed.toolUseId) || turnAt(p, ed.ts))?.n ?? null }));
  return shell.length ? [...p.edits, ...shell].sort((a, b) => a.ts - b.ts) : p.edits;
}

// diff 보기: 파일별로 묶은 수정 이력(최근에 고친 파일이 위)과, 파일을 고친 요청 목록(최근 요청이 위)
export function editLog(p) {
  pruneEdits(p);
  const files = new Map(), reqs = new Map();
  for (const ed of allEdits(p)) {
    const f = files.get(ed.file) || { file: ed.file, add: 0, del: 0, last: 0, created: false, edits: [] };
    f.add += ed.add; f.del += ed.del; f.last = Math.max(f.last, ed.ts);
    if (ed.kind === 'create') f.created = true;
    f.edits.push(ed);
    files.set(ed.file, f);
    const r = reqs.get(ed.turn) || { turn: ed.turn, files: new Set(), add: 0, del: 0, last: 0 };
    r.files.add(ed.file); r.add += ed.add; r.del += ed.del; r.last = Math.max(r.last, ed.ts);
    reqs.set(ed.turn, r);
  }
  // 요청 글은 들고 있는 최근 턴(MAX_TURNS)에서 찾는다 — 그보다 오래된 요청은 번호만
  const turnOf = new Map(p.turns.map((t) => [t.n, t]));
  const requests = [...reqs.values()].map((r) => ({ ...r, files: r.files.size, prompt: turnOf.get(r.turn)?.prompt ?? null, start: turnOf.get(r.turn)?.start ?? null }))
    .sort((a, b) => (b.turn ?? -1) - (a.turn ?? -1));
  return { files: [...files.values()].sort((a, b) => b.last - a.last), requests };
}

// waits: 관제탑 결정함을 거친 권한 승인 대기 [{ toolUseId, ms }] — 트랜스크립트에는 없는 정보라 서버가 넘겨준다
export function profileSummary(p, waits = []) {
  const approvalByTurn = new Map();
  for (const w of waits) {
    // PermissionRequest 훅에 tool_use_id 가 없을 수 있어(실측) 시각으로 귀속: 요청 시점에 진행 중이던 턴
    let turn = w.toolUseId && p.toolTurn.get(w.toolUseId);
    if (!turn) for (const t of p.turns) if (t.start <= w.start) turn = t;
    if (turn) approvalByTurn.set(turn, (approvalByTurn.get(turn) || 0) + w.ms);
  }
  // 아직 닫히지 않은 도구 구간(도구 실행 중)도 현재까지 반영
  const openSeg = (t) => (p.seg && p.seg.turn === t ? Math.max(0, p.seg.end - Math.max(p.seg.start, p.seg.modelEnd)) : 0);
  const timing = (t) => {
    const end = Math.max(t.end, p.seg?.turn === t ? p.seg.end : 0);
    const total = Math.max(0, end - t.start);
    const approval = approvalByTurn.get(t) || 0;
    const toolWall = t.toolWallMs + openSeg(t);
    const tool = Math.max(0, toolWall - approval);
    const model = Math.min(t.modelMs, total);
    return { total, first: t.firstAt ? t.firstAt - t.start : null, model, tool, approval, other: Math.max(0, total - model - toolWall) };
  };
  // 합계는 세션 전체(p.sess). 평균 턴 시간은 들고 있는 최근 턴 기준
  const total = Object.fromEntries(KEYS.map((k) => [k, p.sess[k]]));
  const { calls, tools } = p.sess;
  let durSum = 0, durN = 0;
  for (const t of p.turns) if (t.calls && t.end > t.start) { durSum += t.end - t.start; durN++; }
  // 캐시 재작성: 끝난 턴은 세어 둔 값, 진행 중인 마지막 턴은 지금 상태로 더한다
  const lastT = p.turns.at(-1), lastMiss = lastT && !lastT.missCounted ? missOf(lastT) : null;
  const missReasons = { ...p.miss.reasons };
  if (lastMiss) missReasons[missKey(lastMiss)] = (missReasons[missKey(lastMiss)] || 0) + 1;
  // 서브에이전트 → 턴 귀속
  const subByTurn = new Map();
  const subagents = [...p.subs.values()].map((s) => {
    const turn = p.toolTurn.get(s.meta.toolUseId);
    const tokens = s.input + s.cacheWrite + s.cacheRead + s.output;
    if (turn) { const a = subByTurn.get(turn) || { tokens: 0, cost: 0, n: 0 }; a.tokens += tokens; a.cost += s.cost; a.n++; subByTurn.set(turn, a); }
    return { type: s.meta.agentType || 'subagent', description: s.meta.description || '', turn: turn?.n ?? null, model: s.model,
      running: isRunning(p, s), background: s.meta.requestShape === 'background', calls: s.calls, tokens, cost: s.cost, input: s.input, cacheWrite: s.cacheWrite, cacheRead: s.cacheRead, output: s.output, start: s.start, end: s.end };
  }).sort((a, b) => (b.running - a.running) || (b.start || 0) - (a.start || 0));
  const sub = subagents.reduce((a, s) => ({ tokens: a.tokens + s.tokens, cost: a.cost + s.cost }), { tokens: 0, cost: 0 });

  const inputAll = total.input + total.cacheWrite + total.cacheRead;
  const turns = p.turns.slice(-30).map((t) => {
    const gap = t.gap ?? null, cacheMiss = missOf(t);
    const sa = subByTurn.get(t);
    return {
      n: t.n, prompt: t.prompt, start: t.start, end: t.end, calls: t.calls, tools: t.tools,
      input: t.input, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, output: t.output, cost: t.cost, context: t.context,
      thinking: t.thinking, toolErrors: t.toolErrors,
      gap, cacheMiss, sub: sa || null,
      time: timing(t),
      toolPer: Object.entries(t.toolPer).sort((a, b) => b[1] - a[1]).slice(0, 4),
    };
  });
  return {
    model: p.model,
    window: windowFor(p.model),
    total, calls, tools,
    turnCount: p.turns.length,
    context: p.context,
    cacheHit: inputAll ? total.cacheRead / inputAll : null,
    cache: p.cacheAt && p.cacheTtl ? { at: p.cacheAt, ttl: p.cacheTtl } : null, // 메인 대화 캐시가 살아 있는 기한(at + ttl)
    avgTurnMs: durN ? durSum / durN : null,
    compactions: p.compactions,
    unpriced: p.unpriced,
    cacheMisses: p.miss.n + (lastMiss ? 1 : 0),
    cacheMissCost: p.miss.cost + (lastMiss?.extra || 0),
    cacheMissReasons: missReasons,
    thinking: p.sess.thinking,
    apiErrors: p.apiErrors.slice(-5),
    quota: p.quota,
    toolErrors: p.toolErrors,
    toolErrTop: Object.entries(p.toolErrBy).sort((a, b) => b[1] - a[1]).slice(0, 5),
    compactLog: p.compactLog.slice(-5),
    edits: (() => {
      pruneEdits(p);
      const all = allEdits(p);
      return { n: all.length, files: new Set(all.map((x) => x.file)).size,
        add: all.reduce((a, x) => a + x.add, 0), del: all.reduce((a, x) => a + x.del, 0), last: all.at(-1)?.ts || 0 };
    })(),
    sub, subagents: subagents.slice(0, 12),
    bgTasks: runningTasks(p).map(({ id, kind, desc, startedAt, expiresAt }) => ({ id, kind, desc, startedAt, expiresAt })),
    bgRunning: subagents.filter((s) => s.running).length + runningTasks(p).length,
    toolTop: Object.entries(p.tools).sort((a, b) => b[1] - a[1]).slice(0, 8),
    toolTime: Object.entries(p.toolTime).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.ms - a.ms).slice(0, 8),
    time: (() => {
      const all = p.turns.map(timing);
      const sum = (k) => all.reduce((a, x) => a + (x[k] || 0), 0);
      const firsts = all.filter((x) => x.first != null);
      return {
        total: sum('total'), model: sum('model'), tool: sum('tool'), approval: sum('approval'), other: sum('other'),
        avgFirst: firsts.length ? firsts.reduce((a, x) => a + x.first, 0) / firsts.length : null,
        avgTotal: all.length ? sum('total') / all.length : null,
      };
    })(),
    turns,
  };
}
