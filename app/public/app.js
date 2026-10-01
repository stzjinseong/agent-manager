// 관제탑 대시보드 — 서버가 WebSocket 으로 상태 스냅샷을 밀어주고, 터미널은 선택한 워커만 그린다.
// 워커 칩은 id 별로 한 번 만들고 내용만 갱신한다 — 매초 다시 그리면 캐릭터 애니메이션이 리셋된다.
const $ = (s, el = document) => el.querySelector(s);
const STATUS_LABEL = { starting: '부팅 중', idle: '입력 대기', working: '작업 중', decision: '결정 필요', waiting: '서브 대기', done: '완료', interrupted: '중단됨', exited: '종료됨' };
// 표시용 상태: 메인 턴은 끝났지만 백그라운드 서브에이전트가 아직 도는 중이면 'waiting'
const viewStatus = (w) => ((w.status === 'done' || w.status === 'idle') && w.profile?.bgRunning ? 'waiting' : w.status);

let state = { workers: [], decisions: [], profiles: [], recentCwds: [], now: Date.now() };
let clockSkew = 0;
let selected = null;
let ws;

// ---------- Claude 캐릭터 (Claude Code 시작 화면의 픽셀 마스코트) ----------
// 터미널 반블록 비율을 따라 픽셀 하나 = 가로 1 × 세로 2
function clawdSVG() {
  const R = (x, y, w, h, cls = 'body') => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  return `<svg class="clawd" viewBox="0 0 18 10" shape-rendering="crispEdges">
    ${R(3, 0, 12, 4)}${R(1, 4, 16, 2)}${R(3, 6, 12, 2)}
    <g class="legs-a">${R(4, 8, 1, 2)}${R(6, 8, 1, 2)}${R(11, 8, 1, 2)}${R(13, 8, 1, 2)}</g>
    <g class="legs-b">${R(5, 8, 1, 2)}${R(7, 8, 1, 2)}${R(10, 8, 1, 2)}${R(12, 8, 1, 2)}</g>
    ${R(5, 2, 1, 2, 'eye')}${R(12, 2, 1, 2, 'eye')}
  </svg>`;
}
document.querySelectorAll('[data-clawd]').forEach((el) => (el.innerHTML = clawdSVG()));

// 브라우저 탭 아이콘 = 같은 픽셀 캐릭터. 결정 대기가 있으면 오른쪽 위에 주황 점
// (서버 재시작 없이 바뀌도록 파일 대신 data URI 로 넣는다)
function faviconSVG(alert) {
  const R = (x, y, w, h, c) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
  const body = '#d97757', eye = '#1a0f0a';
  // 18×10 캐릭터(픽셀 = 가로1×세로2)가 정사각형 폭을 꽉 채우도록 위아래만 여백 (16px 탭에서도 크게 보이게)
  const g = R(3, 0, 12, 4, body) + R(1, 4, 16, 2, body) + R(3, 6, 12, 2, body) +
    [4, 6, 11, 13].map((x) => R(x, 8, 1, 2, body)).join('') + R(5, 2, 1, 2, eye) + R(12, 2, 1, 2, eye);
  const dot = alert ? '<circle cx="15" cy="-1" r="3" fill="#f4b34a" stroke="#0c0d11" stroke-width="0.8"/>' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -4 18 18" shape-rendering="crispEdges">${g}${dot}</svg>`;
}
let faviconAlert = null;
function setFavicon(alert) {
  if (alert === faviconAlert) return;
  faviconAlert = alert;
  $('#favicon').href = 'data:image/svg+xml,' + encodeURIComponent(faviconSVG(alert));
}
setFavicon(false);

// ---------- 터미널 ----------
const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace', // 시스템 고정폭 (style.css --mono 와 같음)
  fontSize: 13, cursorBlink: true, scrollback: 5000,
  allowProposedApi: true, // unicode 버전 전환에 필요
  theme: { background: '#07080a', foreground: '#e6e4de', cursor: '#d97757', selectionBackground: '#d9775744' },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
// 글자 폭 표를 Unicode 11 로 — 기본(Unicode 6)은 🚀 같은 이모지를 1칸으로 세는데 Claude Code 는 2칸으로 그려서
// 이모지 뒤 글자부터 커서 위치가 한 칸씩 어긋나 화면이 꼬였다(실측 재현)
// 애드온 파일을 못 받아도(예: 옛 서버) 화면 전체가 죽지 않게 — 폭 보정만 빠진다
if (window.Unicode11Addon) {
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
} else console.warn('addon-unicode11 없음 — 서버를 재시작하세요 (이모지 폭 보정 꺼짐)');
term.open($('#term'));
term.onData((data) => selected && send({ type: 'input', id: selected, data }));

// ---------- 클립보드 (Windows Terminal 방식) ----------
// Ctrl+C: 선택 영역이 있으면 복사, 없으면 그대로 인터럽트(^C) 전달
// Ctrl+V: xterm 이 ^V 로 보내지 않게 막고 브라우저 기본 붙여넣기에 맡긴다 → xterm 의 paste 처리(bracketed paste)
// Ctrl+Shift+C/V, 맥 ⌘+C/V 도 동일. 우클릭: 선택 있으면 복사, 없으면 붙여넣기
async function copySelection() {
  const text = term.getSelection();
  if (!text) return false;
  try { await navigator.clipboard.writeText(text); } catch {}
  term.clearSelection();
  return true;
}
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  const mod = e.ctrlKey || e.metaKey;
  // e.key 가 아니라 물리 키(e.code)로 판정 — 한글 입력 상태면 Ctrl+V 의 key 가 'ㅍ', Ctrl+C 는 'ㅊ' 로 온다
  if (mod && e.code === 'KeyC' && (term.hasSelection() || e.shiftKey || e.metaKey)) { e.preventDefault(); copySelection(); return false; }
  if (mod && e.code === 'KeyV') return false; // 기본 paste 이벤트로 넘김
  return true;
});
$('#term').addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  if (await copySelection()) return;
  try { const text = await navigator.clipboard.readText(); if (text) term.paste(text); } catch {}
});

let fitTimer;
new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTerm, 60); }).observe($('.term-wrap'));
function fitTerm() {
  if (!selected || $('#detail').hidden) return;
  try { fit.fit(); send({ type: 'resize', id: selected, cols: term.cols, rows: term.rows }); } catch {}
}

// ---------- 통신 ----------
function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => selected && send({ type: 'attach', id: selected });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') {
      state = msg.state; clockSkew = Date.now() - state.now;
      // 주소 #W1 로 열면 해당 워커를 바로 선택
      const h = location.hash.slice(1);
      if (!selected && h && state.workers.some((w) => w.id === h)) { select(h); return; }
      render();
    }
    else if (msg.type === 'pty' && msg.id === selected) term.write(msg.data);
    else if (msg.type === 'scrollback' && msg.id === selected) { term.reset(); term.write(msg.data); }
  };
  ws.onopen = ((orig) => () => { if (serverDown) { location.reload(); return; } orig?.(); })(ws.onopen);
  ws.onclose = () => setTimeout(connect, 1000);
}
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

// ---------- 유틸 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const serverNow = () => Date.now() - clockSkew;
function dur(t) {
  if (!t) return '';
  const s = Math.max(0, Math.round((serverNow() - t) / 1000));
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
  return `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분`;
}
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

// ---------- 렌더 ----------
function render() {
  renderStats();
  renderInbox();
  renderFloor();
  renderCompare();
  renderDetail();
  $('#recent-cwds').innerHTML = state.recentCwds.map((c) => `<option value="${esc(c)}">`).join('');
}

function pendingCount() {
  const withDecision = new Set(state.decisions.map((d) => d.workerId));
  return state.decisions.length + state.workers.filter((w) => w.status === 'decision' && !withDecision.has(w.id)).length;
}

function renderStats() {
  const n = (st) => state.workers.filter((w) => viewStatus(w) === st).length;
  const pend = pendingCount();
  $('#stats').innerHTML = [
    ['워커', state.workers.filter((w) => w.status !== 'exited').length, 'var(--idle)'],
    ['작업 중', n('working'), 'var(--working)'],
    ['서브 대기', n('waiting'), 'var(--waiting)'],
    ['결정 대기', pend, 'var(--decision)', pend > 0],
    ['완료', n('done'), 'var(--done)'],
  ].map(([k, v, c, hot]) => `<span class="stat ${hot ? 'hot' : ''}" style="--c:${c}"><i></i>${k} <b>${v}</b></span>`).join('');
  // 매니저 캐릭터: 작업 중 인원 숫자 배지. 작업 중이면 흰 빛 맥동 + 걷기, 결정 대기가 있으면 주황 빛
  const busy = n('working');
  $('#core-count').textContent = busy;
  const dot = $('.core-dot');
  dot.classList.toggle('busy', busy > 0);
  dot.classList.toggle('alert', pend > 0);
  dot.title = `매니저 · ${busy}명 작업 중${pend ? ` · 결정 대기 ${pend}건` : ''}`;
  document.title = pend ? `(${pend}) 클로드 키우기` : '클로드 키우기';
  setFavicon(pend > 0);
}

// 결정함 — 결정 목록이 바뀔 때만 다시 만든다 (버튼 클릭 중에 DOM 이 바뀌지 않게)
let inboxSig = '';
function renderInbox() {
  const sig = state.decisions.map((d) => d.id).join(',');
  if (sig === inboxSig) return;
  inboxSig = sig;
  const byId = Object.fromEntries(state.workers.map((w) => [w.id, w]));
  $('#inbox').innerHTML = state.decisions.map((d) => `
    <div class="decision" data-id="${d.id}">
      <div class="d-icon">!</div>
      <div class="what">
        <div class="t"><b>${esc(byId[d.workerId]?.name || d.workerId)}</b> 가 <b>${esc(d.tool)}</b> 권한을 요청합니다<span class="age" data-since="${d.createdAt}"></span></div>
        <code>${esc(detailOf(d))}</code>
      </div>
      <div class="acts">
        <button class="btn allow" data-act="allow">허용</button>
        <button class="btn deny" data-act="deny">거부</button>
        <button class="btn" data-act="deny-msg">거부 + 사유</button>
        <button class="btn ghost" data-act="pass" title="대시보드 결정을 포기하고 터미널 프롬프트로 넘김">터미널에서</button>
      </div>
    </div>`).join('');
  tick();
}

function detailOf(d) {
  const i = d.input || {};
  if (i.command) return i.command;
  if (i.file_path && (i.old_string || i.new_string)) return `${i.file_path}\n- ${String(i.old_string || '').slice(0, 300)}\n+ ${String(i.new_string || '').slice(0, 300)}`;
  if (i.file_path) return i.file_path;
  return JSON.stringify(i).slice(0, 600);
}

// ---------- 회로 기판 ----------
const nodeEls = new Map(); // key(workerId | 'P:'+profileName) → element

function nodeTemplate() {
  return el(`
    <div class="node">
      <div class="node-head"><span class="led"></span><span class="nid"></span><span class="nname" title="더블클릭해 이름 변경 · 칩을 끌어 순서 변경"></span><span class="pill"></span></div>
      <div class="stage"><div class="avatar">${clawdSVG()}</div><div class="fx"><span></span><span></span><span></span><span class="mark"></span></div></div>
      <div class="bubble"></div>
      <div class="quest"><div class="quest-top"><span>할 일</span><b class="qn"></b></div><div class="qbar"><i></i></div></div>
      <div class="meta"></div>
      <div class="path"></div>
    </div>`);
}

function socketTemplate() {
  return el(`
    <div class="node socket">
      <div class="node-head"><span class="nid">SLOT</span><span class="nname" title="더블클릭해 이름 변경 · 칩을 끌어 순서 변경"></span><span class="pill">대기실</span></div>
      <div class="stage"><div class="avatar">${clawdSVG()}</div></div>
      <div class="path"></div>
      <div class="socket-acts"><button class="btn primary" data-act="launch">▶ 투입</button><button class="btn ghost" data-act="forget" title="저장된 역할 삭제">✕</button></div>
    </div>`);
}

function bubbleOf(w) {
  const pend = state.decisions.find((d) => d.workerId === w.id);
  switch (viewStatus(w)) {
    case 'working': return w.currentTool ? `⚙ <b>${esc(w.currentTool)}</b>` : `💭 ${esc(w.lastPrompt)}`;
    case 'decision': return pend ? `🔐 <b>${esc(pend.summary)}</b>` : `❓ ${esc(w.notice || '응답이 필요합니다 — 터미널을 확인하세요')}`;
    case 'waiting': {
      const run = w.profile.subagents.filter((s) => s.running);
      return `🤖 서브에이전트 ${run.length}개 진행 중 · <b>${esc(w.subTool || `${run[0].type}: ${run[0].description}`)}</b>`;
    }
    case 'done': return esc(w.lastMessage || '완료');
    case 'idle': return w.lastMessage ? esc(w.lastMessage) : '지시를 기다리는 중';
    case 'interrupted': return `⏸ 중단됨 — 처리 중인 작업 없음${w.queue.length ? ` · 대기 지시 ${w.queue.length}건은 보류 (지시를 새로 보내면 재개)` : ''}`;
    case 'starting': return '부팅 중… (처음 여는 폴더면 터미널에서 신뢰 여부를 선택하세요)';
    case 'exited': return '프로세스 종료됨';
  }
  return '';
}

function updateNode(node, w) {
  node.className = `node s-${viewStatus(w)}${w.id === selected ? ' sel' : ''}`;
  node.dataset.id = w.id;
  $('.nid', node).textContent = w.id;
  if (!node.classList.contains('renaming')) $('.nname', node).textContent = w.name;
  $('.pill', node).textContent = STATUS_LABEL[viewStatus(w)];
  const b = bubbleOf(w);
  if ($('.bubble', node).innerHTML !== b) $('.bubble', node).innerHTML = b;
  const todos = w.todos || [];
  const doneN = todos.filter((t) => t.status === 'completed').length;
  const active = todos.find((t) => t.status === 'in_progress');
  $('.qn', node).textContent = todos.length ? `${doneN}/${todos.length}${active ? ` · ${active.activeForm || active.content}` : ''}` : '—';
  $('.qbar i', node).style.width = todos.length ? `${(doneN / todos.length) * 100}%` : '0%';
  const running = w.status === 'working' || w.status === 'decision';
  $('.meta', node).innerHTML =
    `<span title="${running ? '이번 턴 경과' : '마지막 갱신'}">⏱ <em data-since="${running ? w.turnStartedAt : w.updatedAt}"></em></span>` +
    `<span title="도구 사용 횟수">⚙ ${w.toolCount}</span>` +
    (w.queue.length ? `<span class="q" title="대기 중인 지시">📥 ${w.queue.length}</span>` : '') +
    (w.profile?.turnCount ? `<span title="추정 비용 (API 환산)">$ ${fmtUsd(w.profile.total.cost).slice(1)}</span>` : '');
  const ctx = w.profile ? ctxLevel(w.profile) : { level: 0 };
  node.classList.toggle('ctx-warn', ctx.level > 0);
  let badge = $('.ctx-badge', node);
  if (ctx.level && !badge) { badge = el('<div class="ctx-badge"></div>'); $('.stage', node).append(badge); }
  if (badge) { badge.hidden = !ctx.level; badge.textContent = ctx.level ? `⚠ ctx ${fmtN(w.profile.context)}` : ''; badge.title = ctx.text || ''; }
  $('.path', node).textContent = w.cwd;
  $('.path', node).title = w.cwd;
}

function renderFloor() {
  const nodes = $('#nodes');
  const liveNames = new Set(state.workers.filter((w) => w.status !== 'exited').map((w) => w.name));
  const items = [
    ...state.workers.map((w) => ({ key: w.id, name: w.name, w })),
    ...state.profiles.filter((p) => !liveNames.has(p.name)).map((p) => ({ key: `P:${p.name}`, name: p.name, p })),
  ];
  // 저장된 순서(역할 이름) 우선, 없는 항목은 원래 순서대로 뒤에 (stable sort)
  const rank = (name) => { const i = (state.order || []).indexOf(name); return i < 0 ? Infinity : i; };
  items.sort((a, b) => rank(a.name) - rank(b.name));
  // 워커마다 가로 차선을 하나씩 쓰므로, 많아지면 코어와 칩 사이 간격을 넓혀 차선 간격을 확보
  $('.core').style.marginBottom = `${Math.max(44, 28 + items.length * 7)}px`;
  const keep = new Set(items.map((i) => i.key));
  for (const [k, n] of nodeEls) if (!keep.has(k)) { n.remove(); nodeEls.delete(k); }

  let prev = null;
  for (const it of items) {
    let n = nodeEls.get(it.key);
    if (!n) { n = it.w ? nodeTemplate() : socketTemplate(); n.draggable = true; nodeEls.set(it.key, n); }
    n.dataset.name = it.name;
    if (it.w) updateNode(n, it.w);
    else {
      n.dataset.profile = it.p.name;
      if (!n.classList.contains('renaming')) $('.nname', n).textContent = it.p.name;
      $('.path', n).textContent = it.p.cwd;
      $('.path', n).title = it.p.cwd;
    }
    // 순서 유지 (이미 제자리면 옮기지 않아 애니메이션이 끊기지 않음). 드래그 중엔 사용자가 옮긴 자리를 존중
    if (!dragEl) {
      const want = prev ? prev.nextSibling : nodes.firstChild;
      if (want !== n) nodes.insertBefore(n, want);
    }
    prev = n;
  }
  let empty = $('.empty', nodes);
  if (!items.length && !empty) nodes.append(el('<div class="empty">아직 워커가 없습니다. 오른쪽 위 <b>+ 워커</b>로 첫 Claude 를 투입하세요.</div>'));
  if (items.length && empty) empty.remove();
  tick();
  requestAnimationFrame(drawTraces);
}

// 작업 중인 선: MANAGER → 워커 방향으로 Claude 코랄 전류가 흐른다.
// 짧은 전류 두 줄기(pathLength=100 으로 정규화한 dash 이동) + 선을 따라 달리는 불꽃 머리(animateMotion)
const ELECTRIC_DEFS = `<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
  <feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
function electric(d) {
  const spark = (delay) => `<circle class="spark" r="3" filter="url(#glow)"><animateMotion dur="1.6s" begin="${delay}s" repeatCount="indefinite" path="${d}"/></circle>`;
  return `<path class="bolt" pathLength="100" d="${d}" filter="url(#glow)"/>` +
    `<path class="bolt b2" pathLength="100" d="${d}" filter="url(#glow)"/>` +
    spark(0) + spark(-0.8);
}

// 워커 비교 — 누적 토큰은 워커 간 최대값 기준, 컨텍스트는 각자의 창 기준
function renderCompare() {
  const ws_ = state.workers.filter((w) => w.profile?.turnCount);
  $('#compare').hidden = ws_.length < 1;
  if (!ws_.length) return;
  const tok = (w) => { const t = w.profile.total; return t.input + t.cacheWrite + t.cacheRead + t.output; };
  const max = Math.max(...ws_.map(tok), 1);
  $('#cmp').innerHTML = '<div class="cmp-h"><span>워커</span><span>누적 토큰</span><span class="r">추정 비용</span><span class="r">캐시 적중</span><span>컨텍스트</span></div>' +
    ws_.map((w) => {
      const p = w.profile, ctx = ctxLevel(p);
      return `<div class="cmp-row s-${viewStatus(w)}${w.id === selected ? ' sel' : ''}" data-id="${w.id}">
        <span class="cmp-name"><span class="led"></span>${esc(w.name)}</span>
        <span class="cmp-bar"><span class="b"><i style="width:${(tok(w) / max) * 100}%"></i></span><b>${fmtN(tok(w))}</b></span>
        <span class="r">${fmtUsd(p.total.cost)}${p.sub.cost ? `<small> +🤖${fmtUsd(p.sub.cost)}</small>` : ''}</span>
        <span class="r">${p.cacheHit == null ? '—' : Math.round(p.cacheHit * 100) + '%'}${p.cacheMisses ? ` <span class="warn-t" title="캐시 재작성 턴">⚠${p.cacheMisses}</span>` : ''}</span>
        <span class="cmp-bar ctx"><span class="b"><i class="${ctx.level ? 'warn' : ''}" style="width:${Math.min(100, ctx.pct * 100)}%"></i></span><b class="${ctx.level ? 'warn-t' : ''}">${fmtN(p.context)} / ${fmtN(p.window)}</b></span>
      </div>`;
    }).join('');
}
$('#cmp').addEventListener('click', (e) => { const r = e.target.closest('.cmp-row'); if (r) select(r.dataset.id); });

// 코어 → 각 칩으로 회로선. 첫 줄은 곧장 내려가고, 아랫줄은 칩 왼쪽 골목으로 돌아 들어간다.
let traceSig = '';
function drawTraces() {
  const floor = $('#floor');
  const fr = floor.getBoundingClientRect();
  // 매니저 = 흰 클로드 캐릭터. 선은 캐릭터 아래 가장자리에서 출발한다
  const cr = $('.core-mark').getBoundingClientRect();
  const cx = Math.round(cr.left + cr.width / 2 - fr.left), cy = Math.round(cr.bottom - fr.top + 4);
  // 칩 위치는 레이아웃 좌표(offsetTop/Left)로 잰다. getBoundingClientRect 는 호버·선택 시 떠오르는
  // translateY(-2px) 까지 반영해서, 같은 줄인데도 "첫 줄"이 아니라고 판정돼 선이 왼쪽 골목으로 우회했었다.
  const nr = $('#nodes').getBoundingClientRect();
  const list = [...nodeEls.values()].filter((n) => n.isConnected).map((n) => {
    const w = state.workers.find((x) => x.id === n.dataset.id);
    return {
      x: Math.round(nr.left - fr.left + n.offsetLeft), y: Math.round(nr.top - fr.top + n.offsetTop),
      w: n.offsetWidth, h: n.offsetHeight, st: w ? viewStatus(w) : 'socket',
    };
  });
  const sig = `${cx},${cy}|` + list.map((o) => `${o.x},${o.y},${o.w},${o.st}`).join('|');
  if (sig === traceSig) return;
  traceSig = sig;
  if (!list.length) { $('#traces').innerHTML = ''; return; }
  const firstTop = Math.min(...list.map((o) => o.y));
  // 워커마다 전용 차선 — 선끼리 겹치지 않게 한다.
  //  · 출발점: 매니저 캐릭터 아래 가장자리에 목표 x 순서대로 펼쳐 둔다
  //  · 가로 차선: 코어에서 먼 워커일수록 코어에 가까운(위쪽) 차선 → 괄호처럼 포개져 서로 교차하지 않는다
  //  · 첫 줄은 칩 위로, 아랫줄은 칩 왼쪽 골목으로(같은 골목을 쓰면 세로 차선을 4px 씩 비켜 둔다)
  const gutterUse = new Map();
  const targets = list.map((o) => {
    if (o.y === firstTop) return { ...o, tx: o.x + Math.round(o.w / 2), first: true };
    const k = gutterUse.get(o.x) || 0; gutterUse.set(o.x, k + 1);
    return { ...o, tx: o.x - 7 - k * 4, first: false };
  }).sort((a, b) => a.tx - b.tx);
  const n = targets.length;
  const span = Math.min(cr.width - 16, Math.max(0, (n - 1) * 14));
  targets.forEach((t, i) => {
    t.ax = Math.round(cx - span / 2 + (n > 1 ? (span * i) / (n - 1) : span / 2));
    t.ay = cy;
  });
  const laneTop = cy + 10, laneBottom = firstTop - 16;
  const step = n > 1 ? Math.max(3, Math.min(10, (laneBottom - laneTop) / (n - 1))) : 0;
  [...targets].sort((a, b) => Math.abs(b.tx - cx) - Math.abs(a.tx - cx)).forEach((t, rank) => { t.ly = Math.round(laneTop + rank * step); });
  const routes = targets.map((t) => {
    const pts = t.first
      ? [[t.ax, t.ay], [t.ax, t.ly], [t.tx, t.ly], [t.tx, t.y - 7]]
      : [[t.ax, t.ay], [t.ax, t.ly], [t.tx, t.ly], [t.tx, t.y + 46], [t.x - 1, t.y + 46]];
    return { ...t, pts, d: roundedPath(pts, 8) };
  });
  const svg = routes.map((o) => {
    const cls = o.st === 'socket' ? 't-socket' : `t-${o.st}`;
    const end = o.pts.at(-1);
    return `<g class="${cls}"><path class="base" d="${o.d}"/><path class="flow" d="${o.d}"/>${o.st === 'working' ? electric(o.d) : ''}` +
      `<circle class="pad" cx="${o.ax}" cy="${o.ay}" r="2"/><circle class="pad" cx="${end[0]}" cy="${end[1]}" r="3.5"/></g>`;
  }).join('');
  $('#traces').innerHTML = ELECTRIC_DEFS + svg;
}

// 직교 꺾은선을 모서리만 둥글린 경로로 (반지름은 인접 구간 길이의 절반을 넘지 않게)
function roundedPath(pts, r) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const rr = Math.min(r, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const ux = Math.sign(x - px), uy = Math.sign(y - py), vx = Math.sign(nx - x), vy = Math.sign(ny - y);
    d += ` L${x - ux * rr} ${y - uy * rr} Q${x} ${y} ${x + vx * rr} ${y + vy * rr}`;
  }
  const last = pts.at(-1);
  return d + ` L${last[0]} ${last[1]}`;
}

new ResizeObserver(() => requestAnimationFrame(drawTraces)).observe($('#floor'));

// ---------- 상세 ----------
function renderDetail() {
  const w = state.workers.find((x) => x.id === selected);
  const wasHidden = $('#detail').hidden;
  $('#detail').hidden = !w;
  if (!w) return;
  if (wasHidden) requestAnimationFrame(fitTerm);
  const av = $('#detail-avatar');
  if (!av.firstChild) av.innerHTML = clawdSVG();
  av.className = `detail-avatar s-${viewStatus(w)}`;
  $("#detail-name").textContent = `${w.name} · ${STATUS_LABEL[viewStatus(w)]}`;
  $('#detail-meta').textContent = [w.id, w.model, w.permissionMode, w.sessionId && `session ${w.sessionId.slice(0, 8)}`, w.pid && `pid ${w.pid}`, w.cwd].filter(Boolean).join(' · ');
  $('#queue').innerHTML = w.queue.length
    ? `<div class="qh">대기 중인 지시 ${w.queue.length}건 — 현재 턴이 끝나면 위에서부터 투입</div>` +
      w.queue.map((q, i) => `<div class="qi"><span class="n">${i + 1}</span><span class="tx">${esc(q)}</span><button data-unqueue="${i}" title="큐에서 빼기">✕</button></div>`).join('')
    : '';
  const fmt = (t) => new Date(t + clockSkew).toLocaleTimeString('ko-KR', { hour12: false });
  $('#log').innerHTML = w.log.slice().reverse().map((l) => `<li class="k-${l.kind}"><time>${fmt(l.t)}</time>${esc(l.text)}</li>`).join('');
  renderProfile(w);
}

// ---------- 세션 프로파일 ----------
const SERIES = [ // 쌓는 순서 = 아래 → 위
  { key: 'cacheRead', label: '캐시 읽기', color: 'var(--s-read)' },
  { key: 'cacheWrite', label: '캐시 쓰기', color: 'var(--s-write)' },
  { key: 'input', label: '신규 입력', color: 'var(--s-new)' },
];
// 시간 차트 색: dataviz 기준 팔레트 dark 5·4·1번 (검증 통과 — 면 #1b1e26, CVD all-pairs ΔE ≥ 13.2). 기타는 중립 회색
const TSERIES = [
  { key: 'model', label: '모델 응답', color: 'var(--t-model)' },
  { key: 'tool', label: '도구 실행', color: 'var(--t-tool)' },
  { key: 'approval', label: '승인 대기', color: 'var(--t-wait)' },
  { key: 'other', label: '기타', color: 'var(--t-other)' },
];
const timeOf = (t, k) => (t.time?.[k] || 0) / 1000; // 초 단위로 그린다
const fmtSec = (v) => (v < 60 ? `${Math.round(v)}초` : `${Math.floor(v / 60)}분${Math.round(v % 60) ? ` ${Math.round(v % 60)}초` : ''}`);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const fmtN = (n) => {
  if (n == null) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
};
const fmtMs = (ms) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
};
const turnInput = (t) => t.input + t.cacheWrite + t.cacheRead;

let profileSig = '';
let profileTurns = [];
function renderProfile(w, force) {
  const p = w.profile;
  const sig = p ? `${w.id}|${p.calls}|${p.turnCount}|${p.total.output}|${p.total.cacheRead}|${p.bgRunning}|${p.sub.tokens}|${Math.round((p.time?.total || 0) / 2000)}|${$('#profile').clientWidth}` : `${w.id}|none`;
  if (sig === profileSig && !force) return;
  profileSig = sig;
  if (!p || !p.turnCount) {
    $('#kpis').innerHTML = '<div class="profile-empty">첫 지시가 끝나면 토큰 사용량이 여기에 쌓입니다.</div>';
    ['#chart-input', '#chart-output', '#chart-tools', '#turns-table'].forEach((s) => ($(s).innerHTML = ''));
    $('#profile-model').textContent = '';
    return;
  }
  $('#profile-model').textContent = `${p.model || ''} · 컨텍스트 창 ${fmtN(p.window)}`;
  const t = p.total;
  const all = t.input + t.cacheWrite + t.cacheRead + t.output;
  const ctx = ctxLevel(p);
  const turns = p.turns;
  $('#kpis').innerHTML = [
    kpi('누적 토큰', fmtN(all), `입력 ${fmtN(all - t.output)} · 출력 ${fmtN(t.output)}`),
    kpi('추정 비용 <small>API 환산</small>', p.unpriced ? `${fmtUsd(t.cost)}+` : fmtUsd(t.cost),
      p.cacheMisses ? `<span class="warn-t">⚠ 캐시 재작성 ${p.cacheMisses}회 · +${fmtUsd(p.cacheMissCost)}</span>` : `턴 평균 ${fmtUsd(t.cost / p.turnCount)}`),
    kpi('현재 컨텍스트', fmtN(p.context),
      `${ctx.level ? `<span class="warn-t">⚠ ${ctx.text}</span>` : `창의 ${Math.round(ctx.pct * 100)}% · 압축 ${p.compactions}회`}`,
      `<div class="gauge"><i class="${ctx.level ? 'warn' : ''}" style="width:${Math.min(100, ctx.pct * 100)}%"></i></div>` + sparkline(turns.map((x) => x.context || 0))),
    kpi('캐시 적중률', p.cacheHit == null ? '—' : `${Math.round(p.cacheHit * 100)}%`, `캐시 읽기 ${fmtN(t.cacheRead)} · 쓰기 ${fmtN(t.cacheWrite)}`),
    kpi('턴 · API 호출', `${p.turnCount} · ${p.calls}`, `질문당 ${(p.calls / p.turnCount).toFixed(1)}회 왕복 · 도구 ${p.tools}회`),
    kpi('응답 시간', fmtMs(p.time.avgTotal), `첫 응답 ${fmtMs(p.time.avgFirst)} · 모델 ${pct(p.time.model, p.time.total)}% · 도구 ${pct(p.time.tool, p.time.total)}%${p.time.approval ? ` · 승인 ${pct(p.time.approval, p.time.total)}%` : ''}`,
      timeBar(p.time)),
    kpi('서브에이전트', p.subagents.length ? `${p.subagents.length}개${p.bgRunning ? ` <small class="sa-run">· ${p.bgRunning}개 진행 중</small>` : ''}` : '—',
      p.subagents.length ? `${fmtN(p.sub.tokens)} · ${fmtUsd(p.sub.cost)} <small>(메인 별도)</small>` : '이 세션에서 사용 안 함'),
  ].join('');
  renderSubagents(p);

  profileTurns = turns.slice(-20);
  drawStacked($('#chart-input'), profileTurns);
  drawBars($('#chart-output'), profileTurns);
  drawStacked($('#chart-time'), profileTurns, TSERIES, timeOf, 150, fmtSec);
  const maxMs = Math.max(1, ...p.toolTime.map((x) => x.ms));
  $('#chart-tooltime').innerHTML = p.toolTime.length
    ? p.toolTime.map((x) => `<div class="hbar wide" title="${esc(x.name)} — ${x.n}회 · 총 ${fmtMs(x.ms)} · 평균 ${fmtMs(x.ms / x.n)} · 최대 ${fmtMs(x.max)}"><span class="n">${esc(x.name)}</span><span class="b"><i style="width:${(x.ms / maxMs) * 100}%;background:var(--t-tool)"></i></span><span class="c">${fmtMs(x.ms)}</span><span class="d">${x.n}회 · 평균 ${fmtMs(x.ms / x.n)} · 최대 ${fmtMs(x.max)}</span></div>`).join('')
    : '<div class="profile-empty">도구 실행 기록 없음</div>';
  const maxTool = Math.max(1, ...p.toolTop.map((x) => x[1]));
  $('#chart-tools').innerHTML = p.toolTop.length
    ? p.toolTop.map(([n, c]) => `<div class="hbar"><span class="n" title="${esc(n)}">${esc(n)}</span><span class="b"><i style="width:${(c / maxTool) * 100}%"></i></span><span class="c">${c}</span></div>`).join('')
    : '<div class="profile-empty">도구 사용 없음</div>';

  const fmtT = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' });
  const live = w.status === 'working' || w.status === 'decision';
  $('#turns-table').innerHTML =
    '<thead><tr><th>#</th><th>시각</th><th>질문</th><th class="r">첫 응답</th><th class="r">소요</th><th class="r">API</th><th class="r">도구</th><th class="r">입력</th><th class="r">캐시 적중</th><th class="r">출력</th><th class="r">비용</th><th>비고</th></tr></thead><tbody>' +
    turns.slice(-8).reverse().map((x, i) => {
      const inp = turnInput(x);
      return `<tr class="${live && i === 0 ? 'live' : ''}"><td>${x.n}</td><td>${fmtT(x.start)}</td><td class="p" title="${esc(x.prompt)}">${esc(x.prompt)}</td>` +
        `<td class="r">${fmtMs(x.time.first)}</td><td class="r" title="모델 ${fmtMs(x.time.model)} · 도구 ${fmtMs(x.time.tool)}${x.time.approval ? ` · 승인 대기 ${fmtMs(x.time.approval)}` : ''}">${fmtMs(x.time.total)}</td><td class="r">${x.calls}</td><td class="r">${x.tools}</td>` +
        `<td class="r">${fmtN(inp)}</td><td class="r">${inp ? Math.round((x.cacheRead / inp) * 100) + '%' : '—'}</td><td class="r">${fmtN(x.output)}</td>` +
        `<td class="r">${fmtUsd(x.cost)}</td><td class="note">${turnNotes(x)}</td></tr>`;
    }).join('') + '</tbody>';
}

const CTX_WARN = 150_000; // 이 이상이면 매 턴 캐시 읽기 비용이 커지는 구간 — 새 세션 고려
function ctxLevel(p) {
  const pct = p.context / (p.window || 200_000);
  if (pct >= 0.8) return { level: 2, pct, text: `창의 ${Math.round(pct * 100)}% — 곧 자동 압축` };
  if (p.context >= CTX_WARN) return { level: 1, pct, text: `${fmtN(p.context)} — 새 세션 고려` };
  return { level: 0, pct, text: '' };
}

const fmtUsd = (v) => (v == null ? '—' : v < 0.01 ? `$${v.toFixed(3)}` : v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);

function missText(m) {
  const gap = m.gap != null ? ` · 공백 ${fmtMs(m.gap)}` : '';
  return m.expired ? `캐시 만료 추정${gap} (TTL ${m.ttl >= 3600_000 ? '1시간' : '5분'})` : `캐시 재작성${gap} (프롬프트·도구 변경 추정)`;
}

function turnNotes(x) {
  const notes = [];
  if (x.cacheMiss) notes.push(`<span class="warn-t" title="${esc(missText(x.cacheMiss))}">⚠ ${x.cacheMiss.expired ? '캐시 만료' : '캐시 재작성'} ${fmtN(x.cacheMiss.tokens)}${x.cacheMiss.extra != null ? ` +${fmtUsd(x.cacheMiss.extra)}` : ''}</span>`);
  if (x.sub) notes.push(`<span title="이 턴에서 띄운 서브에이전트">🤖 ${x.sub.n}개 ${fmtN(x.sub.tokens)} · ${fmtUsd(x.sub.cost)}</span>`);
  return notes.join(' ');
}

function renderSubagents(p) {
  $('#subagents').innerHTML = p.subagents.length
    ? p.subagents.map((s) => `<div class="sa">
        <div class="sa-top"><b>${s.running ? '<i class="sa-live"></i>' : ''}${esc(s.type)}</b><span>${s.running ? '<em class="sa-run">진행 중</em> · ' : ''}${s.background ? '백그라운드 · ' : ''}${s.turn ? `턴 #${s.turn}` : ''}</span></div>
        <div class="sa-desc" title="${esc(s.description)}">${esc(s.description || '—')}</div>
        <div class="sa-meta">${fmtN(s.tokens)} 토큰 · ${fmtUsd(s.cost)} · API ${s.calls}회${s.start && s.end ? ` · ${fmtMs(s.end - s.start)}` : ''}</div>
      </div>`).join('')
    : '<div class="profile-empty">서브에이전트(Explore 등)를 쓰면 메인 세션과 따로 집계됩니다.</div>';
}

function timeBar(tm) {
  if (!tm.total) return '';
  return '<div class="tbar">' + TSERIES.filter((x) => tm[x.key] > 0)
    .map((x) => `<i style="width:${(tm[x.key] / tm.total) * 100}%;background:${x.color}"></i>`).join('') + '</div>';
}

function kpi(k, v, s, extra = '') {
  const key = k.split(' <')[0];
  return `<div class="kpi"${INFO[key] ? ` data-info="${key}"` : ''}><div class="k">${k}${INFO[key] ? ' <i class="info">ⓘ</i>' : ''}</div>${v ? `<div class="v">${v}</div>` : ''}<div class="s">${s}</div>${extra}</div>`;
}

// ---------- 항목 설명 툴팁: 의미 · 근거 · 활용 · 신뢰도 ----------
const INFO = {
  '누적 토큰': {
    what: '이 세션이 모델과 주고받은 토큰 총합. 입력(신규 + 캐시 쓰기 + 캐시 읽기) + 출력.',
    how: 'API 응답마다 서버가 보고한 usage 값(트랜스크립트에 저장됨)을 메시지 ID 기준으로 중복 제거해 합산. 서브에이전트는 제외(별도 칸).',
    use: '대부분이 캐시 읽기인 게 정상 — 매 턴 대화 전체를 다시 읽기 때문. 그래서 대화가 길어질수록 턴당 토큰이 계속 커진다. 증가 속도가 가팔라지면 세션을 나눌 때.',
    trust: '높음 — 추정이 아닌 API 실측값. 단 Claude Code 내부 호출(제목 생성 등)이 기록되지 않으면 약간 적게 나올 수 있음.',
  },
  '추정 비용': {
    what: 'API 단가로 환산한 이 세션의 비용. 구독(Pro/Max/Team) 사용이면 실제 청구액이 아니라 "API였다면 얼마"인 비교용 값.',
    how: '토큰 × 모델 단가(공식 모델표, 2026-09-25 기준). 캐시 쓰기는 5분 TTL ×1.25, 1시간 TTL ×2 (기록된 TTL 구분 사용), 캐시 읽기는 모델별 캐시 단가.',
    use: '턴 평균과 비교해 유독 비싼 턴(=무거운 작업)을 찾는다. ⚠ 캐시 재작성 비용은 공백을 줄이거나 세션 중 설정 변경을 피하면 아낄 수 있던 돈.',
    trust: '추정치 — 웹 검색 요금, fast 모드 할증 등은 미포함. 단가 표가 바뀌면 갱신 필요.',
  },
  '현재 컨텍스트': {
    what: '마지막 요청에 실린 프롬프트 크기 = 다음 턴이 최소한 다시 읽어야 하는 양.',
    how: '마지막 API 호출의 입력 합계(신규 + 캐시 쓰기 + 캐시 읽기). 창 크기·%는 모델표 기준(Haiku 200k, Opus·Sonnet 5세대 1M). 아래 선은 턴별 컨텍스트 추이.',
    use: '150k를 넘으면 매 턴 읽는 비용이 커지는 구간 → 새 세션이나 /compact 고려. 창의 80%면 곧 자동 압축되며 앞 내용이 요약된다. 추이선이 계단처럼 뛰면 큰 파일·출력이 들어온 턴.',
    trust: '크기는 높음(상태줄 Context 표시와 일치 확인). %는 중간 — Claude Code가 실제로 더 작은 창을 쓰면 낮게 보임.',
  },
  '캐시 적중률': {
    what: '입력 중 캐시에서 읽은 비율. 캐시 읽기는 일반 입력보다 훨씬 싸다(대부분 1/10, Opus 5.5는 1/20).',
    how: '캐시 읽기 ÷ (신규 입력 + 캐시 쓰기 + 캐시 읽기), 세션 누적.',
    use: '90% 이상이 정상. 낮아지면 ① 공백 뒤 캐시 만료 ② 세션 중 모델·설정 변경 ③ CLAUDE.md·도구 목록 변경을 의심. 턴별 차트의 ⚠ 표시와 함께 보면 어느 턴이 원인인지 보인다.',
    trust: '높음 — 실측 토큰으로 계산.',
  },
  '턴 · API 호출': {
    what: '사용자 질문(턴) 수와 실제 모델 호출 수. 호출 ÷ 턴 = 한 질문을 처리하려고 모델과 몇 번 왕복했는지.',
    how: '사람이 보낸 메시지를 턴 경계로 셈(🔔 백그라운드 완료 알림도 턴). 응답 메시지 ID 개수가 API 호출 수.',
    use: '질문당 왕복이 많을수록 도구를 오가며 일한 것. 호출이 많은 턴은 도구 왕복이 많은 것 — 매 호출마다 컨텍스트 전체를 다시 읽으므로 비용·시간이 같이 커진다. 독립 조회를 한 번에 묶으면(병렬) 호출 수가 준다.',
    trust: '높음.',
  },
  '응답 시간': {
    what: '질문 하나를 처리하는 데 걸린 평균 시간(질문 → 마지막 응답)과 첫 응답까지의 평균 대기. 막대는 세션 전체 시간이 어디에 쓰였는지 비율.',
    how: '트랜스크립트 각 기록의 시각으로 계산. 모델 응답 = 요청을 보낸 시점(직전 기록)부터 응답의 마지막 줄까지 — 네트워크·대기열 지연 포함. 도구 실행 = 모델 생성이 끝난 뒤부터 마지막 도구 결과까지(병렬 도구는 겹친 시간을 한 번만). 도구는 호출 블록이 써지자마자 실행되므로 생성과 겹친 부분은 모델 시간으로 센다. 승인 대기 = 결정함에서 허용·거부할 때까지.',
    use: '모델 비중이 크면 생각·생성이 긴 것 → 지시를 좁히거나 effort 를 낮춰 볼 여지. 도구 비중이 크면 빌드·테스트·검색 같은 실행이 병목. 첫 응답이 길면 컨텍스트가 크거나 생각이 깊은 것. 승인 대기가 크면 권한 허용 목록을 늘리면 빨라진다.',
    trust: '중간 — 기록 시각 기반 근사. 터미널에서 직접 승인한 대기 시간은 도구 실행에 섞인다(결정함 경유만 분리).',
  },
  '턴별 소요 시간': {
    what: '턴마다 걸린 시간을 모델 응답 / 도구 실행 / 승인 대기 / 기타로 나눈 막대.',
    how: '응답 시간 카드와 같은 방식으로 턴별 계산. 막대에 마우스를 올리면 첫 응답 시간과 도구별 시간까지 표시.',
    use: '유독 긴 턴을 찾고 원인이 생각(모델)인지 실행(도구)인지 승인 대기인지 바로 구분. 같은 종류의 지시인데 점점 느려지면 컨텍스트가 커진 탓일 수 있다.',
    trust: '중간 — 기록 시각 기반 근사.',
  },
  '도구별 소요 시간': {
    what: '도구 종류별 총 실행 시간, 호출 횟수, 평균, 최대.',
    how: '도구 호출 기록 시각 → 그 결과 기록 시각. 병렬로 돈 도구는 각자 시간을 따로 더하므로 합계가 실제 경과보다 클 수 있다. 메인 세션만(서브에이전트 제외).',
    use: '느린 도구를 찾는다 — Bash 가 길면 빌드·테스트·대기 명령, Agent 가 길면 서브에이전트 작업, MCP 가 길면 외부 서버 응답. 최대값이 튀면 한 번의 긴 명령이 원인.',
    trust: '높음 — 호출과 결과의 기록 시각 차이. 터미널 승인 대기는 포함될 수 있음.',
  },
  '서브에이전트': {
    what: '이 세션이 띄운 서브에이전트(Explore 등) 수와 토큰·비용. 메인 세션 수치와 따로 집계.',
    how: '세션 폴더의 subagents/agent-*.jsonl 실측 usage. meta.json 의 연결 정보로 어느 턴에서 띄웠는지 귀속. 진행 중 여부는 완료 알림·SubagentStop 훅으로 판단.',
    use: '조사를 서브에이전트에 맡기면 읽은 원문이 메인 컨텍스트에 쌓이지 않는다. 현재 컨텍스트 추이와 같이 보면 위임 효과(메인이 덜 커졌는지)를 확인할 수 있다.',
    trust: '토큰·비용은 높음. 진행 중 여부는 추론.',
  },
  '턴별 입력 토큰': {
    what: '턴마다 모델에 들어간 입력의 구성. 파랑 = 캐시 읽기, 초록 = 캐시 쓰기, 주황 = 캐시 안 된 신규 입력.',
    how: '그 턴의 모든 API 호출 입력을 합산. 막대에 마우스를 올리면 턴별 상세.',
    use: '파랑이 대부분이면 정상. 초록이 크면 캐시를 새로 쓴 턴(첫 턴·만료·변경), ⚠ 는 재작성이 의심되는 턴. 막대 높이가 점점 커지는 건 컨텍스트가 자라기 때문.',
    trust: '높음 — 실측. ⚠ 판정만 추론(첫 호출이 1만 토큰 이상 새로 쓰고 읽은 양보다 많을 때).',
  },
  '턴별 출력 토큰': {
    what: '턴마다 모델이 생성한 토큰(내부 사고 토큰 포함).',
    how: '그 턴의 API 호출 output_tokens 합계.',
    use: '출력 단가는 입력의 5배. 출력이 큰 턴은 긴 코드 작성·장문 응답. 같은 일을 하는데 유독 크면 지시를 더 구체적으로 줄 여지.',
    trust: '높음 — 실측.',
  },
  '도구 사용': {
    what: '메인 세션이 호출한 도구별 횟수(Bash, Read, Edit, MCP 등).',
    how: '응답 안의 tool_use 블록 수. 서브에이전트의 도구 사용은 제외.',
    use: 'Bash·Read가 압도적이면 탐색 위주 세션. 탐색이 많다면 서브에이전트 위임 후보. Edit 비중으로 실제 수정량을 가늠.',
    trust: '높음.',
  },
  '서브에이전트 목록': {
    what: '띄운 서브에이전트 하나하나: 종류, 맡긴 일, 토큰·비용, API 호출 수, 걸린 시간.',
    how: 'subagents 폴더의 개별 트랜스크립트 + meta.json. ● 진행 중 = 아직 완료 신호가 없음.',
    use: '비싼 서브에이전트가 무엇을 했는지 확인. 결과 대비 비용이 크면 다음엔 더 좁게 지시하거나 저렴한 모델로.',
    trust: '토큰 높음, 진행 상태는 추론.',
  },
  '최근 턴': {
    what: '최근 8턴의 질문·첫 응답·소요(마우스를 올리면 모델/도구 구성)·호출·도구·입력·캐시 적중·출력·비용과 비고(⚠ 캐시 재작성, 🤖 서브에이전트).',
    how: '위 차트와 같은 데이터를 표로. 소요 = 질문 시각 → 마지막 응답 시각.',
    use: '비용이 튄 턴을 질문 내용과 함께 확인. 캐시 적중이 낮은 턴의 공백 시간을 보면 만료 여부를 알 수 있다.',
    trust: '높음(소요 시간만 근사).',
  },
  '워커 비교': {
    what: '워커별 누적 토큰·추정 비용(🤖 = 서브에이전트 별도)·캐시 적중률·컨텍스트/창.',
    how: '각 워커 세션 프로파일의 요약값. 누적 토큰 막대는 워커 중 최댓값 기준 비율.',
    use: '어느 역할이 토큰을 많이 쓰는지, 어느 세션의 컨텍스트가 불어나 새 세션이 필요한지 한눈에.',
    trust: '각 항목의 신뢰도를 따름(토큰 실측, 비용 추정).',
  },
};

function showInfo(el) {
  const i = INFO[el.dataset.info];
  if (!i) return;
  const tip = $('#tip');
  tip.classList.add('info-tip');
  tip.innerHTML = `<div class="tt">${esc(el.dataset.info)}</div>` +
    [['의미', i.what], ['근거', i.how], ['활용', i.use], ['신뢰도', i.trust]]
      .map(([h, t]) => `<div class="ib"><b>${h}</b><span>${esc(t)}</span></div>`).join('');
  tip.hidden = false;
  // 마우스를 따라다니지 않고 대상 아래에 고정 (읽는 동안 흔들리지 않게)
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const below = r.bottom + 8 + t.height < innerHeight;
  tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - t.width - 8))}px`;
  tip.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - t.height - 8)}px`;
}
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-info]');
  if (el && !el.contains(e.relatedTarget)) showInfo(el);
});
document.addEventListener('mouseout', (e) => {
  const el = e.target.closest('[data-info]');
  if (el && !el.contains(e.relatedTarget)) { $('#tip').hidden = true; $('#tip').classList.remove('info-tip'); }
});

function sparkline(vals) {
  if (vals.length < 2) return '<svg class="spark"></svg>';
  const W = 100, H = 22, max = Math.max(...vals, 1);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - 2 - (v / max) * (H - 4)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--text-2)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// 보기 좋은 축 최대값 (1·2·5 × 10^n)
function niceMax(v) {
  if (v <= 0) return 1;
  const e = 10 ** Math.floor(Math.log10(v)), f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
}

// 위쪽만 둥근 막대 (기준선 쪽은 각지게)
function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

function chartFrame(el, H, max, axis = fmtN) {
  const W = Math.max(240, el.clientWidth), L = 44, B = 18, T = 6;
  const ph = H - B - T, pw = W - L - 4;
  const grid = [0, 0.5, 1].map((f) => {
    const y = T + ph - f * ph;
    return `<line class="gl" x1="${L}" x2="${W - 4}" y1="${y}" y2="${y}"/><text class="al" x="${L - 6}" y="${y + 3.5}" text-anchor="end">${axis(max * f)}</text>`;
  }).join('');
  return { W, L, B, T, ph, pw, grid };
}

// series 를 아래→위로 쌓는 막대. get(t, key) 로 값을 꺼내고 axis 로 눈금을 표시한다
function drawStacked(el, turns, series = SERIES, get = (t, k) => t[k], H = 170, axis = fmtN) {
  const totalOf = (t) => series.reduce((a, s) => a + (get(t, s.key) || 0), 0);
  const max = niceMax(Math.max(...turns.map(totalOf), 1));
  const f = chartFrame(el, H, max, axis);
  const slot = f.pw / 20, bw = Math.min(28, slot * 0.62);
  const cols = turns.map((t, i) => {
    const x = f.L + slot * i + (slot - bw) / 2;
    let y = f.T + f.ph, segs = '';
    const visible = series.filter((s) => get(t, s.key) > 0);
    visible.forEach((s, j) => {
      const h = (get(t, s.key) / max) * f.ph;
      const gap = j < visible.length - 1 ? 2 : 0; // 세그먼트 사이 2px 면 간격
      const hh = Math.max(0, h - gap);
      y -= h;
      if (hh >= 0.5) segs += j === visible.length - 1 ? `<path d="${topRounded(x, y, bw, hh, 4)}" fill="${s.color}"/>` : `<rect x="${x}" y="${y + gap}" width="${bw}" height="${hh}" fill="${s.color}"/>`;
    });
    const miss = series === SERIES && t.cacheMiss ? `<text class="miss" x="${x + bw / 2}" y="${Math.max(f.T + 9, y - 5)}" text-anchor="middle">⚠</text>` : '';
    return `<g class="col" data-i="${i}">${segs}${miss}<text class="al" x="${x + bw / 2}" y="${H - 4}" text-anchor="middle">${t.n}</text><rect x="${f.L + slot * i}" y="${f.T}" width="${slot}" height="${f.ph + f.B}" fill="transparent"/></g>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${H}" height="${H}">${f.grid}${cols}</svg>`;
}

function drawBars(el, turns) {
  const H = 90, max = niceMax(Math.max(...turns.map((t) => t.output), 1));
  const f = chartFrame(el, H, max);
  const slot = f.pw / 20, bw = Math.min(28, slot * 0.62);
  const cols = turns.map((t, i) => {
    const x = f.L + slot * i + (slot - bw) / 2, h = (t.output / max) * f.ph;
    return `<g class="col" data-i="${i}">${h >= 0.5 ? `<path d="${topRounded(x, f.T + f.ph - h, bw, h, 4)}" fill="var(--s-out)"/>` : ''}<text class="al" x="${x + bw / 2}" y="${H - 4}" text-anchor="middle">${t.n}</text><rect x="${f.L + slot * i}" y="${f.T}" width="${slot}" height="${f.ph + f.B}" fill="transparent"/></g>`;
  }).join('');
  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${H}" height="${H}">${f.grid}${cols}</svg>`;
}

// 두 차트 공통 호버: 같은 턴을 양쪽에서 함께 강조하고 툴팁 하나로 보여준다
function onChartHover(e) {
  const col = e.target.closest('.col');
  const charts = [$('#chart-input'), $('#chart-output'), $('#chart-time')];
  if (!col) { charts.forEach((c) => c.classList.remove('hovering')); $('#tip').hidden = true; return; }
  const i = Number(col.dataset.i), t = profileTurns[i];
  if (!t) return;
  charts.forEach((c) => {
    c.classList.add('hovering');
    c.querySelectorAll('.col').forEach((g) => g.classList.toggle('on', Number(g.dataset.i) === i));
  });
  const inp = turnInput(t);
  const tip = $('#tip');
  tip.classList.remove("info-tip");
  tip.innerHTML = `<div class="tt">#${t.n} ${esc(t.prompt)}</div>` +
    SERIES.slice().reverse().map((s) => `<div class="row"><span><i style="background:${s.color}"></i>${s.label}</span><b>${fmtN(t[s.key])}</b></div>`).join('') +
    `<div class="row"><span><i style="background:var(--s-out)"></i>출력</span><b>${fmtN(t.output)}</b></div><hr>` +
    `<div class="row"><span>캐시 적중</span><b>${inp ? Math.round((t.cacheRead / inp) * 100) : 0}%</b></div>` +
    `<hr><div class="row"><span>소요 (첫 응답)</span><b>${fmtMs(t.time.total)} (${fmtMs(t.time.first)})</b></div>` +
    TSERIES.filter((x) => t.time[x.key]).map((x) => `<div class="row"><span><i style="background:${x.color}"></i>${x.label}</span><b>${fmtMs(t.time[x.key])}</b></div>`).join('') +
    (t.toolPer.length ? `<div class="row sub"><span>도구별</span><b>${t.toolPer.map(([k, v]) => `${esc(k)} ${fmtMs(v)}`).join(' · ')}</b></div>` : '') +
    `<div class="row"><span>API · 도구 호출</span><b>${t.calls} · ${t.tools}</b></div>` +
    `<div class="row"><span>추정 비용</span><b>${fmtUsd(t.cost)}</b></div>` +
    (t.sub ? `<div class="row"><span>🤖 서브에이전트 ${t.sub.n}개</span><b>${fmtN(t.sub.tokens)} · ${fmtUsd(t.sub.cost)}</b></div>` : '') +
    (t.cacheMiss ? `<hr><div class="warn-t">⚠ ${esc(missText(t.cacheMiss))}<br>재작성 ${fmtN(t.cacheMiss.tokens)} 토큰${t.cacheMiss.extra != null ? ` · 읽었으면 ${fmtUsd(t.cacheMiss.extra)} 절약` : ''}</div>` : '');
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.min(e.clientY + 14, innerHeight - r.height - 8)}px`;
}
['#chart-input', '#chart-output', '#chart-time'].forEach((s) => {
  $(s).addEventListener('mousemove', onChartHover);
  $(s).addEventListener('mouseleave', onChartHover);
});
new ResizeObserver(() => {
  const w = state.workers.find((x) => x.id === selected);
  if (w) renderProfile(w);
}).observe($('#profile'));

function select(id) {
  // 이미 열려 있는 워커를 다시 누르면 아무것도 하지 않는다 — 터미널을 다시 그리지 않고,
  // 포커스도 옮기지 않는다(옮기면 더블클릭으로 연 이름 입력창의 포커스를 빼앗아 바로 닫혀 버림)
  if (id === selected && !$('#detail').hidden) return;
  selected = id;
  render();
  term.reset();
  send({ type: 'attach', id });
  requestAnimationFrame(() => {
    fitTerm();
    if (!document.querySelector('input.rename')) $('#task-form').text.focus();
  });
}

// 매초: 경과 시간 텍스트만 갱신
function tick() {
  document.querySelectorAll('[data-since]').forEach((n) => {
    const t = Number(n.dataset.since);
    n.textContent = t ? (n.classList.contains('age') ? ` · ${dur(t)} 전` : dur(t)) : '';
  });
}
setInterval(tick, 1000);

// ---------- 이벤트 ----------
// ---------- 칩 드래그 앤 드롭 순서 변경 ----------
// 끌고 다니는 동안 DOM 에서 바로 자리를 바꿔 미리 보여주고(회로선도 따라감), 놓는 순간 이름 순서를 저장한다
let dragEl = null;
const nodesEl = $('#nodes');
nodesEl.addEventListener('dragstart', (e) => {
  const n = e.target.closest?.('.node');
  if (!n || e.target.closest('button')) { e.preventDefault(); return; }
  dragEl = n;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', n.dataset.name || '');
  requestAnimationFrame(() => n.classList.add('dragging')); // 드래그 이미지가 찍힌 뒤 흐리게
});
nodesEl.addEventListener('dragover', (e) => {
  if (!dragEl) return;
  e.preventDefault();
  const over = e.target.closest('.node');
  if (!over || over === dragEl) return;
  const r = over.getBoundingClientRect();
  // 같은 줄이면 좌우 절반, 줄이 다르면 위아래 절반으로 앞/뒤 판정
  const sameRow = Math.abs(r.top - dragEl.getBoundingClientRect().top) < r.height / 2;
  const after = sameRow ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
  const ref = after ? over.nextSibling : over;
  if (ref !== dragEl && dragEl.nextSibling !== ref) {
    nodesEl.insertBefore(dragEl, ref);
    requestAnimationFrame(drawTraces);
  }
});
nodesEl.addEventListener('drop', (e) => e.preventDefault());
nodesEl.addEventListener('dragend', () => {
  if (!dragEl) return;
  dragEl.classList.remove('dragging');
  dragEl = null;
  const order = [...nodesEl.querySelectorAll('.node')].map((n) => n.dataset.name).filter(Boolean);
  state.order = order; // 서버 응답 전 깜빡임 방지
  api('/api/order', { order });
  requestAnimationFrame(drawTraces);
});

// ---------- 역할 이름 변경: 칩의 이름을 더블클릭 → Enter 저장 / Esc 취소 ----------
nodesEl.addEventListener('dblclick', (e) => {
  const nm = e.target.closest('.nname');
  if (nm) startRename(nm.closest('.node'), nm);
});

function startRename(node, nm) {
  if (node.classList.contains('renaming')) return;
  const old = node.dataset.name;
  node.classList.add('renaming');
  node.draggable = false; // 입력창 안에서 드래그로 글자 선택이 되게
  const inp = el('<input class="rename" maxlength="40" spellcheck="false">');
  inp.value = old;
  nm.textContent = '';
  nm.append(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const to = inp.value.trim();
    node.classList.remove('renaming');
    node.draggable = true;
    nm.textContent = save && to ? to : old;
    if (!save || !to || to === old) return;
    const url = node.classList.contains('socket') ? '/api/profiles/rename' : `/api/workers/${node.dataset.id}/rename`;
    const r = await api(url, { from: old, name: to });
    if (r.error) { nm.textContent = old; alert(r.error); }
  };
  inp.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (ev) => ev.stopPropagation()); // 입력 중 클릭이 칩 선택으로 번지지 않게
}

$('#nodes').addEventListener('click', async (e) => {
  const node = e.target.closest('.node');
  if (!node) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (node.classList.contains('socket')) {
    const p = state.profiles.find((x) => x.name === node.dataset.profile);
    if (!p) return;
    if (act === 'launch') { const { id } = await api('/api/workers', p); select(id); }
    if (act === 'forget' && confirm(`저장된 역할 "${p.name}" 을 삭제할까요?`)) api('/api/profiles/delete', { name: p.name });
    return;
  }
  select(node.dataset.id);
});

$('#inbox').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('.decision').dataset.id;
  let act = btn.dataset.act, message;
  if (act === 'deny-msg') {
    message = prompt('거부 사유 (Claude 에게 전달됩니다)');
    if (message === null) return;
    act = 'deny';
  }
  btn.closest('.decision').style.opacity = .5;
  await api(`/api/decisions/${id}`, { behavior: act, message });
});

const newForm = $('#new-form');
$('#btn-new').onclick = () => {
  $('#new-panel').hidden = !$('#new-panel').hidden;
  if (!$('#new-panel').hidden) {
    if (!newForm.cwd.value && state.recentCwds[0]) newForm.cwd.value = state.recentCwds[0];
    newForm.name.focus();
  }
};
$('#btn-cancel').onclick = () => { $('#new-panel').hidden = true; };
$('#btn-pick').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '…';
  try {
    const { path } = await api('/api/pick-folder', { start: newForm.cwd.value || state.recentCwds[0] || '' });
    if (path) newForm.cwd.value = path;
  } finally { btn.disabled = false; btn.textContent = '📁'; }
};
newForm.onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, cwd: f.cwd.value, args: f.args.value, permissionMode: f.permissionMode.value, save: f.save.checked };
  const { id } = await api('/api/workers', body);
  f.name.value = ''; f.args.value = '';
  $('#new-panel').hidden = true;
  select(id);
};

const taskForm = $('#task-form');
taskForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = taskForm.text.value.trim();
  if (!text || !selected) return;
  taskForm.text.value = '';
  taskForm.text.focus();
  await api(`/api/workers/${selected}/task`, { text });
};
// Enter = 줄바꿈(기본 동작), Alt+Enter / 맥 ⌘+Enter = 전송. 한글 조합 중 입력은 무시해야 마지막 글자가 잘리지 않는다
taskForm.text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.altKey || e.metaKey) && !e.isComposing) { e.preventDefault(); taskForm.requestSubmit(); }
});
$('#queue').addEventListener('click', (e) => {
  const i = e.target.closest('[data-unqueue]')?.dataset.unqueue;
  if (i != null && selected) api(`/api/workers/${selected}/unqueue`, { index: Number(i) });
});

// ---------- 서버 종료 ----------
let serverDown = false;
$('#btn-power').onclick = () => { $('#power-modal').hidden = false; };
$('#power-modal').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-power]')?.dataset.power;
  if (!act && e.target !== $('#power-modal')) return;
  $('#power-modal').hidden = true;
  if (!act || act === 'cancel') return;
  try { await api('/api/shutdown', { workers: act === 'all' }); } catch {}
  serverDown = true;
  $('#down-detail').textContent = act === 'all' ? '모든 워커도 함께 종료했습니다.' : '워커는 백그라운드에서 계속 실행 중입니다 — 서버를 다시 켜면 그대로 다시 붙습니다.';
  $('#down-screen').hidden = false;
});

$('#btn-interrupt').onclick = () => selected && api(`/api/workers/${selected}/interrupt`);

// 터미널 크게 보기: 브라우저 전체화면 API 는 Esc 로 빠져나가는데 Esc 는 Claude 중단 키라 겹친다 → 창 전체를 덮는 오버레이로
function setTermFull(on) {
  $('#term-wrap').classList.toggle('full', on);
  document.body.classList.toggle('term-full', on);
  $('#btn-full').textContent = on ? '⛶ 원래대로' : '⛶ 크게';
  const w = state.workers.find((x) => x.id === selected);
  $('#term-title').textContent = w ? `${w.name} · ${STATUS_LABEL[viewStatus(w)]}` : '';
  requestAnimationFrame(() => { fitTerm(); term.focus(); });
}
$('#btn-full').onclick = () => setTermFull(!$('#term-wrap').classList.contains('full'));
$('#btn-full-exit').onclick = () => setTermFull(false);
$('#btn-remove').onclick = async () => {
  if (!selected || !confirm('워커를 목록에서 제거할까요? (실행 중이면 종료됩니다)')) return;
  await api(`/api/workers/${selected}/remove`);
  selected = null; render();
};
$('#btn-close').onclick = () => { selected = null; render(); };

connect();
