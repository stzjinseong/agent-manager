// 관제탑 대시보드 — 서버가 WebSocket 으로 상태 스냅샷을 밀어주고, 터미널은 선택한 워커만 그린다.
// 워커 칩은 id 별로 한 번 만들고 내용만 갱신한다 — 매초 다시 그리면 캐릭터 애니메이션이 리셋된다.
const $ = (s, el = document) => el.querySelector(s);
const STATUS_LABEL = { starting: '부팅 중', idle: '입력 대기', working: '작업 중', decision: '결정 필요', waiting: '백그라운드 대기', done: '완료', checked: '확인됨', interrupted: '중단됨', exited: '종료됨' };
// 표시용 상태: 메인 턴은 끝났지만 백그라운드 서브에이전트가 아직 도는 중이면 'waiting'
// 완료 후 카드를 눌러 본 워커는 '확인됨'(checked) — 브라우저에만 있는 표시 상태(아래 seenDone)
const viewStatus = (w) => {
  if ((w.status === 'done' || w.status === 'idle') && w.profile?.bgRunning) return 'waiting';
  if (w.status === 'done' && isSeenDone(w)) return 'checked';
  return w.status;
};

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

// 매니저 클로드 — 같은 마스코트에 성장 단계별 액세서리 레이어를 겹친다 (왕 테마). 어떤 레이어를 보일지는 CSS 가 .core-dot 의 geN 클래스로 정한다.
//  1 볼터치(+눈 깜빡임) · 2 헤드셋 · 3 망토 · 4 왕관(헤드셋 대신) + 금빛 스파크 · 5 후광 + 별가루
// 바깥 g(.mgr-lean)는 시선 기울기, 안쪽 g(.mgr-act)는 끄덕임·인사 같은 반응 동작용 — 서로 transform 이 겹치지 않게 나눈다
function managerSVG() {
  const R = (x, y, w, h, cls = 'body') => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  return `<svg class="clawd mgr" viewBox="0 0 18 10" shape-rendering="crispEdges"><g class="mgr-lean"><g class="mgr-act">
    <g class="acc acc-cape">${R(0, 5, 18, 4, 'cape')}${R(-1, 8, 3, 2, 'cape')}${R(16, 8, 3, 2, 'cape')}</g>
    ${R(3, 0, 12, 4)}${R(1, 4, 16, 2)}${R(3, 6, 12, 2)}
    <g class="legs-a">${R(4, 8, 1, 2)}${R(6, 8, 1, 2)}${R(11, 8, 1, 2)}${R(13, 8, 1, 2)}</g>
    <g class="legs-b">${R(5, 8, 1, 2)}${R(7, 8, 1, 2)}${R(10, 8, 1, 2)}${R(12, 8, 1, 2)}</g>
    ${R(5, 2, 1, 2, 'eye')}${R(12, 2, 1, 2, 'eye')}
    <g class="acc acc-blush">${R(3, 4, 2, 1, 'blush')}${R(13, 4, 2, 1, 'blush')}</g>
    <g class="acc acc-headset">${R(2, -2, 14, 1, 'band')}${R(2, -1, 1, 3, 'band')}${R(15, -1, 1, 3, 'band')}${R(1, 1, 2, 2, 'cup')}${R(15, 1, 2, 2, 'cup')}</g>
    <g class="acc acc-crown">${R(6, -2, 6, 2, 'gold')}${R(6, -3, 1, 1, 'gold')}${R(8, -3, 2, 1, 'gold')}${R(11, -3, 1, 1, 'gold')}${R(8, -4, 2, 1, 'gold')}</g>
    <g class="acc acc-party">${R(8, -5, 2, 1, 'pt-a')}${R(7, -4, 4, 1, 'pt-b')}${R(6, -3, 6, 1, 'pt-a')}${R(5, -2, 8, 1, 'pt-b')}${R(8, -6, 2, 1, 'pt-c')}</g>
    <g class="acc acc-halo">${R(4, -6, 10, 1, 'halo')}${R(3, -5, 1, 1, 'halo')}${R(14, -5, 1, 1, 'halo')}</g>
    <g class="acc acc-stars">${R(-3, 0, 1, 1, 'star s1')}${R(20, 2, 1, 1, 'star s2')}${R(19, -4, 1, 1, 'star s3')}${R(-2, -4, 1, 1, 'star s4')}</g>
  </g></g></svg>`;
}
$('.core-mark').innerHTML = managerSVG();
// 성장 단계 표시 — geN 클래스는 누적(3단계면 ge1~ge3). 4단계부터는 회로 스파크도 금빛
let mgrStage = 0;
function applyStage(stage) {
  mgrStage = stage;
  const dot = $('.core-dot');
  for (let i = 1; i <= 5; i++) dot.classList.toggle(`ge${i}`, stage >= i);
  $('#floor').classList.toggle('royal', stage >= 4);
}

// ---------- 진화하는 순간 ----------
// 서버 단계가 이 브라우저에서 마지막으로 본 단계보다 높으면, 처리할 승인 요청이 없고 화면을 보고 있을 때만
// 1.2초 빛나며 모습이 바뀌고 별가루가 흩어진다. 그 전까지는 예전 모습을 유지 — 작업 흐름을 끊지 않으려고.
// 본 단계는 테마별로 브라우저에 저장한다(테마가 바뀌어 단계가 0 으로 돌아가면 함께 내린다).
const NEAR_TEXT = { far: '다음 변화까지 아직 멀었음', half: '다음 변화까지 절반쯤', near: '다음 변화까지 조금 남음', max: '최종 단계' };
let evolving = false;
function mgrStageSync() {
  const p = state.progress;
  if (!p) { applyStage(0); return 0; }
  const key = `am.seenStage:${p.theme}`;
  let seen = null;
  try { const v = localStorage.getItem(key); seen = v == null ? null : Number(v); } catch {}
  const remember = (v) => { try { localStorage.setItem(key, String(v)); } catch {} };
  if (seen == null || p.stage < seen) { seen = p.stage; remember(seen); } // 처음 보거나 테마 초기화 — 연출 없이 맞춘다
  if (evolving) return mgrStage;
  if (p.stage > seen) {
    if (state.decisions.length || document.visibilityState !== 'visible') { applyStage(seen); return seen; }
    evolving = true;
    applyStage(seen);
    const dot = $('.core-dot');
    dot.classList.add('evolving');
    setTimeout(() => {
      applyStage(state.progress?.stage ?? p.stage);
      for (let i = 0; i < 14; i++) { // 별가루
        const s = document.createElement('i');
        const a = (Math.PI * 2 * i) / 14 + Math.random() * 0.4, d = 40 + Math.random() * 36;
        s.className = 'mgr-dust';
        s.style.setProperty('--dx', `${Math.cos(a) * d}px`); s.style.setProperty('--dy', `${Math.sin(a) * d * 0.7 - 10}px`);
        s.style.animationDelay = `${Math.random() * 120}ms`;
        s.addEventListener('animationend', () => s.remove());
        dot.appendChild(s);
      }
    }, 600);
    setTimeout(() => {
      dot.classList.remove('evolving');
      evolving = false;
      remember(mgrStage);
      renderStats();
    }, 1200);
    return seen;
  }
  applyStage(p.stage);
  return p.stage;
}

// ---------- 매니저 반응 — 티 나지 않게 살아 있는 느낌. 단계가 오를수록 반응이 늘어난다 ----------
//  0 끄덕임(워커 완료) · 1 반짝(커밋) + 시선(작업 중인 워커 쪽으로 기울기) · 2 졸음(30분 한가함·늦은 밤) + 그날 첫 지시 인사
//  3 콤보(승인 연달아 빨리) · 4 이스터에그(가끔 고깔모자) · 5 별가루(외형)
const ACTIVE = new Set(['working', 'decision']);
let mgrActTimer = null;
function mgrAct(name, ms) {
  const g = $('.mgr-act');
  if (!g) return;
  g.classList.remove('do-nod', 'do-hop', 'do-wave', 'do-yawn');
  void g.getBoundingClientRect(); // 같은 동작을 연달아 다시 재생하게
  g.classList.add(`do-${name}`);
  clearTimeout(mgrActTimer);
  mgrActTimer = setTimeout(() => g.classList.remove(`do-${name}`), ms);
}
const todayKey = () => new Date().toDateString();
function mgrOnState(prev, next) {
  if (!prev?.length) return; // 첫 상태 수신 — 비교할 이전 상태가 없다
  const was = new Map(prev.map((w) => [w.id, w.status]));
  let finished = false, started = false;
  for (const w of next) {
    const p = was.get(w.id);
    if (ACTIVE.has(p) && w.status === 'done') finished = true;
    if (p && !ACTIVE.has(p) && w.status === 'working') started = true;
  }
  if (started && mgrStage >= 2) {
    let day = null; try { day = localStorage.getItem('am.waveDay'); } catch {}
    if (day !== todayKey()) { try { localStorage.setItem('am.waveDay', todayKey()); } catch {} mgrAct('wave', 1300); return; }
  }
  if (finished) mgrAct('nod', 700);
}
function mgrOnFx(msg) {
  if (msg.kind === 'xp') flyXpToManager(msg.id, msg.xp, msg.reason, msg.detail);
  if (msg.kind === 'commit' && mgrStage >= 1) {
    const t = document.createElement('span');
    t.className = 'mgr-twinkle'; t.textContent = '✦';
    t.addEventListener('animationend', () => t.remove());
    $('.core-dot').appendChild(t);
  }
}
let approvals = [];
function mgrOnApprove() {
  if (mgrStage < 3) return;
  const now = Date.now();
  approvals = [...approvals.filter((t) => now - t < 20_000), now];
  if (approvals.length >= 3) { approvals = []; mgrAct('hop', 900); }
}
// 이스터에그: 페이지를 열 때 1% 확률로 그날 하루 고깔모자
try {
  const k = 'am.partyDay';
  if (localStorage.getItem(k) !== todayKey() && Math.random() < 0.01) localStorage.setItem(k, todayKey());
  if (localStorage.getItem(k) === todayKey()) $('.core-dot').classList.add('party-day');
} catch {}
// 매 렌더·30초마다: 시선 기울기, 졸음(모두 30분 넘게 쉬거나 늦은 밤)
function mgrUpdate() {
  const dot = $('.core-dot'), lean = $('.mgr-lean');
  if (!dot || !lean) return;
  dot.classList.toggle('party', mgrStage >= 4 && dot.classList.contains('party-day'));
  let deg = 0;
  if (mgrStage >= 1) {
    const cr = dot.getBoundingClientRect(), cx = cr.left + cr.width / 2;
    const xs = state.workers.filter((w) => ACTIVE.has(w.status)).map((w) => nodeEls.get(w.id)).filter((n) => n?.isConnected)
      .map((n) => { const r = n.getBoundingClientRect(); return r.left + r.width / 2 - cx; });
    if (xs.length) deg = Math.max(-7, Math.min(7, (xs.reduce((a, b) => a + b, 0) / xs.length) / 80));
  }
  lean.style.setProperty('--lean', `${deg.toFixed(1)}deg`);
  const live = state.workers.filter((w) => w.status !== 'exited');
  const busy = live.some((w) => ACTIVE.has(w.status));
  const quietFor = Date.now() - clockSkew - Math.max(0, ...live.map((w) => w.updatedAt || 0));
  const h = new Date().getHours(), night = h >= 23 || h < 6;
  dot.classList.toggle('sleepy', mgrStage >= 2 && !busy && (quietFor > 30 * 60_000 || night));
}
setInterval(() => {
  mgrUpdate();
  // 졸고 있으면 가끔 하품
  if ($('.core-dot').classList.contains('sleepy') && Math.random() < 0.3) mgrAct('yawn', 1600);
}, 30_000);

// 브라우저 탭 아이콘 = 매니저와 같은 흰 클로드 캐릭터. 밝은 탭 바에서도 보이도록 어두운 둥근 사각형 바탕을 깐다.
// 결정 대기가 있으면 오른쪽 위에 주황 점 (서버 재시작 없이 바뀌도록 파일 대신 data URI 로 넣는다)
function faviconSVG(alert) {
  const R = (x, y, w, h, c) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
  const body = '#f3f1ec', eye = '#14161c';
  // 18×10 캐릭터(픽셀 = 가로1×세로2)를 22×22 바탕 가운데에
  const g = R(3, 0, 12, 4, body) + R(1, 4, 16, 2, body) + R(3, 6, 12, 2, body) +
    [4, 6, 11, 13].map((x) => R(x, 8, 1, 2, body)).join('') + R(5, 2, 1, 2, eye) + R(12, 2, 1, 2, eye);
  const bg = '<rect x="0" y="0" width="22" height="22" rx="5" fill="#14161c"/>';
  const dot = alert ? '<circle cx="18.5" cy="3.5" r="3.5" fill="#f4b34a" stroke="#14161c" stroke-width="1"/>' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" shape-rendering="crispEdges">${bg}<g transform="translate(2 6)">${g}</g>${dot}</svg>`;
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
  fontSize: 13, cursorBlink: true, scrollback: 12000, // PTY 호스트 기록(10000줄)보다 넉넉히
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
// Enter 는 키 처리기가 정해 둔 대로 바꿔 보낸다(아래 attachCustomKeyEventHandler 참고)
let enterAs = null;
term.onData((data) => {
  if (enterAs && (data === '\r' || data === '\x1b\r')) { data = enterAs; enterAs = null; }
  if (selected) send({ type: 'input', id: selected, data });
});

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
  // Enter 는 줄바꿈, Alt(⌥)·Cmd+Enter 는 제출 — 업무 지시 입력창과 같은 규칙.
  // 줄바꿈은 \n(Ctrl+J)으로 보낸다. 입력창에선 줄바꿈이고 메뉴(권한 확인·선택지)에선 아무 일도 안 해서,
  // 메뉴 확정도 Alt+Enter(\r)로 통일된다. ESC CR 도 줄바꿈이지만 ESC 가 섞여 메뉴에선 위험하다
  // (실측: \n·ESC CR → 입력창 줄바꿈, /model 메뉴 그대로 / \r → 제출·메뉴 확정). 한글 조합 중 Enter 는 조합 확정이라 건드리지 않는다.
  // 직접 보내지 않고 xterm 이 처리하게 둔 뒤 onData 에서 바꾼다 — 이 처리기는 xterm 의 조합 마무리보다 먼저 돌아서,
  // 여기서 바로 보내면 조합 중이던 글자보다 줄바꿈이 먼저 가 글자가 다음 줄로 내려갔다
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    enterAs = e.altKey || e.metaKey ? '\r' : '\n';
    return true;
  }
  const mod = e.ctrlKey || e.metaKey;
  // e.key 가 아니라 물리 키(e.code)로 판정 — 한글 입력 상태면 Ctrl+V 의 key 가 'ㅍ', Ctrl+C 는 'ㅊ' 로 온다
  if (mod && e.code === 'KeyC' && (term.hasSelection() || e.shiftKey || e.metaKey)) { e.preventDefault(); copySelection(); return false; }
  if (mod && e.code === 'KeyV') return false; // 기본 paste 이벤트로 넘김
  return true;
});
// ---------- 이미지 첨부 ----------
// 브라우저는 드롭한 파일의 원래 경로를 알 수 없다 → 서버에 올려 data/uploads 에 저장하고 그 경로를 넣는다.
// Claude Code 는 프롬프트의 이미지 경로를 이미지로 첨부한다(터미널에 파일을 끌어다 놓은 것과 같은 방식)
async function uploadImage(file) {
  const r = await fetch('/api/upload', { method: 'POST', headers: { 'content-type': file.type }, body: file });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j.path;
}
const imageFiles = (dt) => [...(dt?.files || [])].filter((f) => f.type.startsWith('image/'));
function toast(text, ms = 2200) {
  let t = $('#toast');
  if (!t) { t = el('<div id="toast" class="toast"></div>'); document.body.append(t); }
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), ms);
}
// 확인·입력 팝업 — 브라우저 기본 confirm/prompt 대신 화면 가운데 우리 팝업.
// 확인 → true(입력형이면 입력한 글), 취소·Esc·바깥 클릭 → false(입력형이면 null). Enter = 확인(입력형은 Alt/⌘+Enter)
function ask({ title, body = '', ok = '확인', danger = false, input = null }) {
  const back = $('#ask-modal'), inp = $('#ask-input'), okBtn = $('[data-ask="ok"]', back);
  $('#ask-title').textContent = title;
  $('#ask-body').textContent = body;
  $('#ask-body').hidden = !body;
  inp.hidden = input === null;
  inp.value = input ?? '';
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'deny' : 'primary'}`;
  back.classList.toggle('danger', danger);
  back.hidden = false;
  const prevFocus = document.activeElement;
  requestAnimationFrame(() => (input === null ? okBtn : inp).focus());
  return new Promise((resolve) => {
    const done = (yes) => {
      back.hidden = true;
      back.removeEventListener('click', onClick);
      back.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(input === null ? yes : yes ? inp.value.trim() : null);
    };
    const onClick = (e) => {
      const a = e.target.closest('[data-ask]')?.dataset.ask;
      if (a) done(a === 'ok');
      else if (e.target === back) done(false);
    };
    // 캡처 단계에서 처리하고 막는다 — Esc 가 터미널(=Claude 중단)이나 다른 단축키로 새지 않게
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter' && !e.isComposing && (input === null || e.altKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    back.addEventListener('click', onClick);
    back.addEventListener('keydown', onKey, true);
  });
}
async function attachImages(files, insert) {
  for (const f of files) {
    toast(`이미지 첨부 중… ${f.name || '클립보드 이미지'}`, 60_000);
    try { insert(await uploadImage(f)); toast('이미지 첨부됨'); }
    catch (err) { toast(`이미지 첨부 실패: ${err.message}`, 4000); }
  }
}
// 드롭 영역 공통: 이미지가 끌려 오면 테두리 강조
function dropZone(zone, onFiles) {
  zone.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault(); zone.classList.add('dropping');
  });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dropping'); });
  zone.addEventListener('drop', (e) => {
    zone.classList.remove('dropping');
    const files = imageFiles(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    onFiles(files);
  });
}
// 터미널: 경로를 붙여넣기로 보낸다 (Claude 입력칸에 [Image #N] 으로 붙음)
const termInsert = (p) => selected && term.paste(`${p} `);
dropZone($('#term-wrap'), (files) => attachImages(files, termInsert));
// 터미널에서 Ctrl+V 로 클립보드 이미지 붙여넣기 — xterm 보다 먼저 가로챈다(텍스트 붙여넣기는 그대로 둔다)
$('#term').addEventListener('paste', (e) => {
  const files = imageFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault(); e.stopImmediatePropagation();
  attachImages(files, termInsert);
}, true);

$('#term').addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  if (await copySelection()) return;
  try { const text = await navigator.clipboard.readText(); if (text) term.paste(text); } catch {}
});

let fitTimer;
new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTerm, 60); }).observe($('.term-wrap'));
// 터미널 칸 수(가로 글자 수)를 고정하고, 공간이 넓으면 글자를 키워 채운다.
// 칸 수가 줄면 화면 위로 밀려난 기록(스크롤백)은 Claude 가 다시 그릴 수 없어서, 넓을 때 줄 끝까지
// 배경을 칠한 줄(diff 등)이 접히며 배경만 남은 조각 줄이 줄무늬처럼 생겼다(실측: 163→101칸에서 125줄).
// 칸 수를 고정하면 접힐 일이 없다. 높이는 줄 수만 바뀌어 문제없음.
const TERM_COLS = 110;
const FONT_MIN = 11, FONT_MAX = 16;
function fitTerm(now = false) {
  if (!selected || $('#detail').hidden) return;
  try {
    let dims = null;
    // 큰 글자부터 내려가며, 고정 칸 수가 들어가는 가장 큰 글자 크기를 고른다
    for (let fs = FONT_MAX; fs >= FONT_MIN; fs--) {
      if (term.options.fontSize !== fs) term.options.fontSize = fs;
      dims = fit.proposeDimensions();
      if (dims && dims.cols >= TERM_COLS) break;
    }
    if (!dims) return;
    // 아주 좁아 최소 글자로도 안 들어가면 그때만 칸 수를 줄인다
    const cols = Math.min(TERM_COLS, dims.cols), rows = dims.rows;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    syncPtySize(now);
  } catch {}
}

// 화면 크기는 바로 맞추되, 워커 터미널(pty) 크기는 아껴서 바꾼다. 줄 수가 늘 때마다 ConPTY 와 Claude 가
// 화면을 다시 그리면서 이미 스크롤백에 올라간 줄을 한 번 더 써서 입력창이 두 벌 남는다
// (실측: 40→65줄 중복 +14줄, 30→65줄 +21줄. 같은 크기·줄어들 때는 0).
// 그래서 보고 있는 탭만 보내고(탭끼리 크기 다툼 방지), 끌기·애니메이션 중에는 멈췄다가 끝난 크기만 보낸다
let ptyTimer;
function syncPtySize(now = false) {
  clearTimeout(ptyTimer);
  const go = () => {
    if (!selected || $('#detail').hidden) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    send({ type: 'resize', id: selected, cols: term.cols, rows: term.rows });
  };
  if (now) go(); else ptyTimer = setTimeout(go, 250);
}
// 다른 탭·창에서 돌아오면 이 탭 크기로 되돌린다(같은 크기면 서버가 거른다)
addEventListener('focus', () => syncPtySize(true));

// ---------- 통신 ----------
function send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { if (selected) { syncPtySize(true); send({ type: 'attach', id: selected }); } };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') {
      const prevWorkers = state.workers;
      state = msg.state; clockSkew = Date.now() - state.now;
      mgrOnState(prevWorkers, state.workers);
      // 주소 #W1 로 열면 해당 워커를 바로 선택
      const h = location.hash.slice(1);
      if (!selected && h && state.workers.some((w) => w.id === h)) { select(h); return; }
      render();
    }
    else if (msg.type === 'fx') mgrOnFx(msg);
    else if (msg.type === 'pty' && msg.id === selected) term.write(msg.data);
    else if (msg.type === 'scrollback' && msg.id === selected) { term.reset(); term.write(msg.data, () => restoreTermScroll(msg.id)); }
  };
  ws.onopen = ((orig) => () => { if (serverDown) { location.reload(); return; } orig?.(); })(ws.onopen);
  ws.onclose = () => setTimeout(connect, 1000);
}
// 서버 요청. 실패(404·서버 꺼짐·잘못된 응답)를 조용히 삼키지 않고 알림으로 보여 준다 —
// 예전에 옛 서버가 새 API 에 404 를 돌려줬는데 화면엔 아무 일도 없는 것처럼 보였다
async function api(path, body) {
  let r, data;
  try {
    r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    data = await r.json().catch(() => ({}));
  } catch {
    toast('서버에 연결할 수 없습니다', 4000);
    return { error: 'network' };
  }
  if (!r.ok) {
    const msg = data.error || (r.status === 404 ? '서버가 이 기능을 모릅니다 — 서버를 재시작하세요' : `요청 실패 (${r.status})`);
    if (!data.error || r.status >= 500 || r.status === 404) toast(msg, 4000);
    return { ...data, error: msg };
  }
  return data;
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
  renderStale();
  renderInbox();
  renderFloor();
  renderCompare();
  renderDetail();
  mgrUpdate();
  $('#recent-cwds').innerHTML = state.recentCwds.map((c) => `<option value="${esc(c)}">`).join('');
}

function pendingCount() {
  const withDecision = new Set(state.decisions.map((d) => d.workerId));
  return state.decisions.length + state.workers.filter((w) => w.status === 'decision' && !withDecision.has(w.id)).length;
}

function renderStale() {
  $('#stale-bar').hidden = !(state.serverStale || !('serverStale' in state));
}
$('#btn-restart').onclick = () => restartServer();

// 매니저 머리 위 경험치 바: 지금 단계 구간에서 얼마나 찼는지. 진화 연출을 아직 안 본 상태(보이는 단계 < 실제 단계)면
// 새 구간으로 먼저 넘어가 버리지 않게 꽉 찬 채로 둔다 — 연출이 끝나면 새 구간으로 내려간다
function renderXpBar() {
  const p = state.progress, bar = $('#mgr-xpbar');
  if (!bar) return;
  bar.hidden = !p || p.xp == null;
  if (bar.hidden) return;
  const max = p.nextMin == null, pending = mgrStage < p.stage;
  const r = max || pending ? 1 : (p.xp - p.stageMin) / (p.nextMin - p.stageMin);
  bar.classList.toggle('max', max);
  bar.firstElementChild.style.width = `${Math.max(0, Math.min(1, r)) * 100}%`;
  bar.title = max ? `${p.themeName} 최종 단계 · 누적 ${p.xp.toLocaleString()} XP`
    : `${p.themeName} Lv.${p.stage} · ${(p.xp - p.stageMin).toLocaleString()} / ${(p.nextMin - p.stageMin).toLocaleString()} XP (누적 ${p.xp.toLocaleString()})`;
}
function renderStats() {
  renderXpBar();
  const n = (st) => state.workers.filter((w) => viewStatus(w) === st).length;
  const pend = pendingCount();
  $('#stats').innerHTML = [
    ['워커', state.workers.filter((w) => w.status !== 'exited').length, 'var(--idle)'],
    ['작업 중', n('working'), 'var(--working)'],
    ['백그라운드', n('waiting'), 'var(--waiting)'],
    ['결정 대기', pend, 'var(--decision)', pend > 0],
    ['완료', n('done'), 'var(--done)'],
    ['확인됨', n('checked'), 'var(--checked)'],
  ].map(([k, v, c, hot]) => `<span class="stat ${hot ? 'hot' : ''}" style="--c:${c}"><i></i>${k} <b>${v}</b></span>`).join('');
  // 매니저 캐릭터: 작업 중이면 흰 빛 맥동 + 걷기, 결정 대기가 있으면 주황 빛
  const busy = n('working');
  const dot = $('.core-dot');
  dot.classList.toggle('busy', busy > 0);
  dot.classList.toggle('alert', pend > 0);
  const shown = mgrStageSync();
  dot.title = `매니저 · ${busy}명 작업 중${pend ? ` · 결정 대기 ${pend}건` : ''}${state.progress ? ` · ${state.progress.themeName} Lv.${shown} · ${NEAR_TEXT[shown < state.progress.stage ? 'near' : state.progress.near]}` : ''}`;
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
      // 턴은 끝났지만 백그라운드에서 도는 것: 서브에이전트 · Monitor 감시 · 백그라운드 명령
      const p = w.profile, subs = p.subagents.filter((s) => s.running), tasks = p.bgTasks || [];
      const mons = tasks.filter((t) => t.kind === 'monitor'), shells = tasks.filter((t) => t.kind === 'shell');
      const parts = [subs.length && `서브에이전트 ${subs.length}`, mons.length && `감시 ${mons.length}`, shells.length && `명령 ${shells.length}`].filter(Boolean).join(' · ');
      const what = subs.length ? (w.subTool || `${subs[0].type}: ${subs[0].description}`) : (mons[0] || shells[0])?.desc || '';
      return `⏳ 백그라운드 ${parts} · <b>${esc(what)}</b>`;
    }
    case 'done': case 'checked': return esc(w.lastMessage || '완료');
    case 'idle': return w.lastMessage ? esc(w.lastMessage) : '지시를 기다리는 중';
    case 'interrupted': return `⏸ 중단됨 — 처리 중인 작업 없음${w.queue.length ? ` · 대기 지시 ${w.queue.length}건은 보류 (지시를 새로 보내면 재개)` : ''}`;
    case 'starting': return '부팅 중… (처음 여는 폴더면 터미널에서 신뢰 여부를 선택하세요)';
    case 'exited': return '프로세스 종료됨';
  }
  return '';
}

// ---------- 확인 안 한 완료 ----------
// 턴이 끝났는데(서버의 doneAt) 그 뒤로 카드를 눌러 보지 않았으면 초록 빛으로 깜빡인다.
// 확인 기록은 브라우저에 저장 — 키에 시작 시각을 섞어 서버 재설치 등으로 id 가 재사용돼도 섞이지 않게
const SEEN_KEY = 'am.seenDone';
let seenDone = {};
try { seenDone = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}'); } catch {}
const seenKey = (w) => `${w.id}:${w.startedAt}`;
function markSeen(id) {
  const w = state.workers.find((x) => x.id === id);
  if (!w?.doneAt || (seenDone[seenKey(w)] || 0) >= w.doneAt) return;
  seenDone[seenKey(w)] = w.doneAt;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seenDone)); } catch {}
}
function isSeenDone(w) {
  if (!w.doneAt) return false;
  // 지금 그 워커를 보고 있으면 바로 확인 처리
  if (w.id === selected && !$('#detail').hidden && document.visibilityState === 'visible') markSeen(w.id);
  return (seenDone[seenKey(w)] || 0) >= w.doneAt;
}
const isUnseenDone = (w) => viewStatus(w) === 'done' && !!w.doneAt;

// 역할별 캐릭터 색 — 밝기(L 0.76)·채도(C 0.15)를 고정한 OKLCH 라 어떤 색상각이어도 어둡지 않다
const avatarColor = (name) => (state.colors?.[name] != null ? `oklch(0.76 0.15 ${state.colors[name]})` : '');

function updateNode(node, w) {
  node.style.setProperty('--avatar', avatarColor(w.name) || 'var(--accent)');
  // 이름 변경 중(renaming)·드래그 중(dragging) 표시는 사용자 동작이 붙인 것이라 상태 갱신이 지우면 안 된다 —
  // 지우면 바로 아래에서 이름 글자가 입력창을 덮어써, 다른 워커 활동으로 상태가 올 때마다 입력이 닫혔다
  const keep = ['renaming', 'dragging', 'dropping'].filter((c) => node.classList.contains(c)).map((c) => ` ${c}`).join('');
  node.className = `node s-${viewStatus(w)}${w.id === selected ? ' sel' : ''}${isUnseenDone(w) ? ' unseen' : ''}${keep}`;
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
  // 이번(또는 마지막) 턴에 나온 최근 캡처를 무대 왼쪽 아래에 작게. 주소가 같으면 다시 그리지 않는다(깜빡임 방지)
  const shot = (w.shots || []).at(-1);
  const showShot = shot && (!w.turnStartedAt || shot.t >= w.turnStartedAt - 5000) ? shot : null;
  let thumb = $('.card-shot', node);
  if (showShot && thumb?.dataset.shot !== showShot.url) { thumb?.remove(); thumb = el(shotImg(showShot, 'card-shot')); $('.stage', node).append(thumb); }
  if (!showShot && thumb) thumb.remove();
  // 같은 규칙으로 최근 결과물 문서(html·md·pdf·svg)를 무대 오른쪽 아래에 작은 타일로. 누르면 새 탭
  const doc = (w.docs || []).at(-1);
  const showDoc = doc && (!w.turnStartedAt || doc.t >= w.turnStartedAt - 5000) ? doc : null;
  let tile = $('.card-doc', node);
  const docKey = showDoc && `${showDoc.url}@${showDoc.t}`;
  if (showDoc && tile?.dataset.key !== docKey) { tile?.remove(); tile = el(docTile(showDoc)); tile.dataset.key = docKey; $('.stage', node).append(tile); }
  if (!showDoc && tile) tile.remove();
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
  // 종료된 워커는 같은 이름의 대기실 슬롯이 있으면 숨긴다 — 재투입은 슬롯으로 하므로 카드가 겹칠 뿐이다.
  // 저장된 역할이 없는 종료 워커만 남겨, 기록을 보거나 직접 제거할 수 있게 한다.
  const profileNames = new Set(state.profiles.map((p) => p.name));
  const items = [
    ...state.workers.filter((w) => w.status !== 'exited' || !profileNames.has(w.name)).map((w) => ({ key: w.id, name: w.name, w })),
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
  // 지금 관리 중인(세션이 살아 있는) 워커만 — 종료된 워커는 비교에서 뺀다
  const ws_ = state.workers.filter((w) => w.status !== 'exited' && w.profile?.turnCount);
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
  // 작업 중엔 캐릭터가 걷기 애니메이션(bob, translateY 0 ↔ -4px)으로 들썩인다. getBoundingClientRect 는
  // 그 순간의 이동까지 반영해서, 다시 그릴 때마다 출발점이 4px 오르내렸다 → 현재 transform 이동분을 빼고 잰다
  const mark = $('.core-mark'), cr = mark.getBoundingClientRect();
  const m = getComputedStyle(mark).transform, ty = m && m !== 'none' ? new DOMMatrixReadOnly(m).m42 : 0;
  const cx = Math.round(cr.left + cr.width / 2 - fr.left), cy = Math.round(cr.bottom - ty - fr.top + 4);
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
  if (wasHidden) requestAnimationFrame(() => fitTerm());
  const av = $('#detail-avatar');
  if (!av.firstChild) av.innerHTML = clawdSVG();
  av.className = `detail-avatar s-${viewStatus(w)}`;
  av.style.setProperty('--avatar', avatarColor(w.name) || 'var(--accent)');
  $('#term-wrap').style.setProperty('--avatar', avatarColor(w.name) || 'var(--accent)'); // 터미널 테두리 = 워커 색
  $("#detail-name").textContent = w.name; // 상태는 카드 배지·LED 로 보인다
  $('#detail-meta').textContent = [w.id, w.model, w.permissionMode, w.sessionId && `session ${w.sessionId.slice(0, 8)}`, w.pid && `pid ${w.pid}`, w.cwd].filter(Boolean).join(' · ');
  renderMemos(w);
  $('#queue').innerHTML = w.queue.length
    ? `<div class="qh" title="현재 턴이 끝나면 위에서부터 투입">대기 중인 지시 ${w.queue.length}건</div>` +
      w.queue.map((q, i) => `<div class="qi"><span class="n">${i + 1}</span><span class="tx">${esc(q)}</span><button data-unqueue="${i}" title="큐에서 빼기">✕</button></div>`).join('')
    : '';
  const fmt = (t) => new Date(t + clockSkew).toLocaleTimeString('ko-KR', { hour12: false });
  timelineCache = timelineRows(w.log, w.shots, w.docs);
  // CLI 처럼 아래로 갈수록 최신. 맨 아래를 보고 있었거나 워커를 바꿨으면 새 줄을 따라 내려가고,
  // 위로 올려 지난 기록을 보는 중이면 그 자리를 지킨다
  const logEl = $('#log');
  const html = timelineCache.map((r, i) =>
    `<li class="k-${r.kind}" data-i="${i}"${r.kind === 'req' ? ' title="클릭: 터미널에서 이 요청 위치로 이동"' : ''}><time>${fmt(r.t)}</time>${r.tag ? `<span class="tag">${r.tag}</span>` : ''}${esc(r.text)}${r.shot ? shotImg(r.shot, 'tl-shot') : ''}${r.doc ? docCard(r.doc) : ''}${r.kind === 'req' || r.kind === 'queued' ? attachThumbs(r.text) : ''}</li>`).join('');
  if (logEl._html !== html || logEl.dataset.w !== w.id) { // 브라우저가 innerHTML 을 정규화하므로 보낸 글로 비교
    const stick = logEl.dataset.w !== w.id || logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    logEl.dataset.w = w.id;
    logEl.innerHTML = logEl._html = html;
    if (stick) logEl.scrollTop = logEl.scrollHeight;
    pinFor = null; // 줄을 새로 그렸으니 고정 줄도 새 요소 기준으로
    updatePin();
    markGoneSoon();
  }
  renderProfile(w);
}

// 타임라인 정리: 사용자 요청을 한 줄로 모아 강조한다.
//  · 대시보드 지시는 'assign' 과 곧이어 오는 'working: 같은 글' 두 줄로 찍힌다 → 한 줄('요청')
//  · 터미널에서 직접 친 요청은 'working: …' 만 찍힌다 → '요청'
//  · 감시·백그라운드 완료 알림으로 생긴 턴('working: <task-notification>…')은 요청이 아니다 → '알림'
//  · 'queue' 는 대기열에 들어간 지시 → '대기열'
function timelineRows(log, shots = [], docs = []) {
  const rows = [];
  for (const l of log) {
    if (l.kind === 'assign') { rows.push({ t: l.t, kind: 'req', tag: '요청', text: l.text }); continue; }
    if (l.kind === 'queue') { rows.push({ t: l.t, kind: 'queued', tag: '대기열', text: l.text }); continue; }
    const m = l.kind === 'status' && l.text.match(/^working: ([\s\S]*)$/);
    if (m) {
      const text = m[1];
      if (text.startsWith('<task-notification>')) {
        const sum = text.match(/<summary>([^<]*)/)?.[1] || '백그라운드 작업 알림';
        rows.push({ t: l.t, kind: 'bgnote', tag: '🔔 알림', text: sum });
        continue;
      }
      const prev = rows.findLast((r) => r.kind === 'req');
      if (prev && l.t - prev.t < 15_000 && sameReq(prev.text, text)) continue; // 대시보드 지시와 같은 줄
      rows.push({ t: l.t, kind: 'req', tag: '요청', text });
      continue;
    }
    rows.push({ t: l.t, kind: l.kind, text: l.text });
  }
  // 도구 결과 캡처: 그 시각 자리에 썸네일 줄로 끼운다 (로그와 캡처는 같은 시계 — 둘 다 이 PC 의 시각)
  for (const s of shots || []) rows.push({ t: s.t, kind: 'shot', tag: '📷 캡처', text: [s.tool, s.arg].filter(Boolean).join(' · '), shot: s });
  // 워커가 쓴 결과물 문서: 마지막으로 쓴(고친) 시각 자리에 카드 줄로
  for (const d of docs || []) rows.push({ t: d.t, kind: 'doc', tag: '📄 결과물', text: '', doc: d });
  if (shots?.length || docs?.length) rows.sort((a, b) => a.t - b.t); // 안정 정렬이라 같은 시각의 로그 순서는 그대로
  return rows;
}
// 결과물 문서 카드. 미리보기(iframe)는 넣지 않는다 — 타임라인은 줄이 늘 때마다 통째로 다시 그려서 계속 다시 로드된다
const DOC_ICON = { html: '🌐', htm: '🌐', md: '📝', markdown: '📝', pdf: '📕', svg: '🖼️' };
// 워커 카드용 작은 타일 (아이콘 + 확장자). 끌면 링크가 아니라 카드가 끌리게 draggable=false
function docTile(d) {
  const ext = d.name.split('.').pop().toLowerCase();
  return `<a class="card-doc" href="${esc(d.url)}" target="_blank" rel="noopener" draggable="false" title="${esc(d.title ? `${d.title}\n` : '')}${esc(d.name)}&#10;클릭: 새 탭에서 열기">` +
    `<span class="ic">${DOC_ICON[ext] || '📄'}</span><span class="ext">${esc(ext.toUpperCase())}</span></a>`;
}
function docCard(d) {
  const ext = d.name.split('.').pop().toLowerCase();
  // 폴더는 끝쪽 두 단계만 (전체 경로는 마우스를 올리면)
  const parts = d.path.slice(0, -d.name.length - 1).split(/[\\/]/), sep = d.path.includes('\\') ? '\\' : '/';
  const dir = parts.length > 3 ? `…${sep}${parts.slice(-2).join(sep)}` : parts.join(sep);
  return `<a class="tl-doc" href="${esc(d.url)}" target="_blank" rel="noopener" title="${esc(d.path)}&#10;클릭: 새 탭에서 열기">` +
    `<span class="ic">${DOC_ICON[ext] || '📄'}</span><span class="meta">` +
    (d.title ? `<span class="ti">${esc(d.title)}</span>` : '') +
    `<span class="nm">${esc(d.name)}</span><span class="dir">${esc(dir)}</span></span></a>`;
}
// 사람이 지시에 첨부한 이미지: 보낸 글에 들어간 data/uploads 경로를 서버의 /uploads/ 로 바로 보여 준다(따로 저장하지 않음).
// 이미 정리됐거나(7일) 다른 곳의 경로면 서버가 404 → 썸네일을 숨긴다
const UPLOAD_PATH_RE = /[\\/]uploads[\\/]([\w.-]+\.(?:png|jpe?g|gif|webp|bmp))\b/gi;
function attachThumbs(text) {
  const names = [...new Set([...String(text).matchAll(UPLOAD_PATH_RE)].map((m) => m[1]))];
  if (!names.length) return '';
  return `<span class="tl-attach">${names.map((n) => shotImg({ url: `/uploads/${n}` }, 'tl-shot') .replace('<img ', '<img onerror="this.remove()" ')).join('')}</span>`;
}
// ---------- 도구 결과 캡처 보기 ----------
// 썸네일은 data-shot 에 원본 주소를 달아 두고, 어디서 눌러도(타임라인·카드) 같은 크게 보기를 연다
const shotImg = (s, cls) => `<img class="${cls}" src="${esc(s.url)}" data-shot="${esc(s.url)}" alt="캡처" loading="lazy" draggable="false" title="클릭해 크게 보기">`;
// 같은 워커의 캡처끼리 ←/→ 로 넘겨 본다. 몇 번째인지·찍힌 시각과 보관 한도 안내를 아래에 둔다
function openShot(url) {
  const upload = url.startsWith('/uploads/');
  const id = url.split('/')[2];
  const list = upload ? [] : state.workers.find((w) => w.id === id)?.shots || [];
  let i = Math.max(0, list.findIndex((s) => s.url === url));
  const box = el(`<div class="shot-view" title="바깥을 누르거나 Esc 로 닫기">
    <button class="shot-nav prev" title="이전 캡처 (←)">‹</button>
    <figure><img alt="캡처"><figcaption><div class="cap"></div><div class="meta"></div><div class="note"></div></figcaption></figure>
    <button class="shot-nav next" title="다음 캡처 (→)">›</button></div>`);
  const show = () => {
    const s = list[i] || { url, tool: '', arg: '' };
    $('img', box).src = s.url;
    $('.cap', box).textContent = upload ? `사람이 첨부 · data/uploads/${decodeURIComponent(url.slice('/uploads/'.length))}` : [s.tool, s.arg].filter(Boolean).join(' · ');
    $('.meta', box).textContent = list.length ? `${i + 1} / ${list.length}${s.t ? ` · ${new Date(s.t + clockSkew).toLocaleString('ko-KR', { hour12: false })}` : ''}` : '';
    $('.note', box).textContent = upload ? '첨부 원본을 그대로 보여 줍니다 (7일 지나면 정리됨).' : `이미지는 최대 ${state.shotKeep || 50}장까지 관리됩니다.`;
    $('.prev', box).disabled = i <= 0;
    $('.next', box).disabled = i >= list.length - 1;
  };
  const go = (d) => { const n = i + d; if (n >= 0 && n < list.length) { i = n; show(); } };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(1); }
  };
  box.addEventListener('click', (e) => {
    const nav = e.target.closest('.shot-nav');
    if (nav) { go(nav.classList.contains('prev') ? -1 : 1); return; }
    if (e.target.closest('figure')) return; // 그림·설명을 눌러도 닫지 않는다(글자 복사 등)
    close();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  show();
}
// 타임라인 썸네일은 늦게 로드되며 높이가 늘어난다 → 맨 아래를 보던 중이면 바닥을 유지
$('#log').addEventListener('load', (e) => {
  const logEl = e.currentTarget;
  if (e.target.tagName === 'IMG' && logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 160) logEl.scrollTop = logEl.scrollHeight;
}, true);
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-shot]');
  if (!t) return;
  e.stopPropagation(); // 카드 선택·타임라인 요청 이동으로 번지지 않게
  openShot(t.dataset.shot);
}, true);

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
  const sig = p ? `${w.id}|${p.calls}|${p.turnCount}|${p.total.output}|${p.total.cacheRead}|${p.bgRunning}|${p.sub.tokens}|${p.apiErrors?.length}|${p.toolErrors}|${p.cacheMisses}|${Math.round((p.time?.total || 0) / 2000)}|${$('#profile').clientWidth}` : `${w.id}|none`;
  if (sig === profileSig && !force) return;
  profileSig = sig;
  if (!p || !p.turnCount) {
    $('#kpis').innerHTML = '<div class="profile-empty">첫 지시가 끝나면 토큰 사용량이 여기에 쌓입니다.</div>';
    // 이전 워커의 차트·목록·요약이 남지 않게 프로파일 칸을 전부 비운다
    ['#chart-input', '#chart-output', '#chart-tools', '#chart-time', '#chart-tooltime', '#subagents', '#turns-table'].forEach((s) => ($(s).innerHTML = ''));
    $('#profile-model').textContent = '';
    $('#profile-mini').textContent = '';
    return;
  }
  $('#profile-model').textContent = `${p.model || ''} · 컨텍스트 창 ${fmtN(p.window)}`;
  // 접었을 때 제목 옆에 보이는 한 줄 요약
  const tt0 = p.total;
  $('#profile-mini').textContent = `누적 ${fmtN(tt0.input + tt0.cacheWrite + tt0.cacheRead + tt0.output)} · ${fmtUsd(tt0.cost)} · 컨텍스트 ${fmtN(p.context)}${p.cacheHit != null ? ` · 캐시 ${Math.round(p.cacheHit * 100)}%` : ''}`;
  // 접혀 있으면 차트 칸 폭이 0 이라 최소 폭(240px)으로 그려진다 → 그리지 않고, 펼칠 때 다시 그리도록 서명을 비운다
  if ($('#profile').classList.contains('collapsed')) { profileSig = ''; return; }
  const t = p.total;
  const all = t.input + t.cacheWrite + t.cacheRead + t.output;
  const ctx = ctxLevel(p);
  const turns = p.turns;
  $('#kpis').innerHTML = [
    kpi('누적 토큰', fmtN(all), `입력 ${fmtN(all - t.output)} · 출력 ${fmtN(t.output)}${p.thinking ? ` <small title="출력 중 사고(thinking) 토큰 — 출력에 포함">(사고 ${fmtN(p.thinking)})</small>` : ''}`),
    kpi('추정 비용 <small>API 환산</small>', p.unpriced ? `${fmtUsd(t.cost)}+` : fmtUsd(t.cost),
      p.cacheMisses ? `<span class="warn-t" title="원인: ${esc(missReasonsText(p.cacheMissReasons))}">⚠ 캐시 재작성 ${p.cacheMisses}회 · +${fmtUsd(p.cacheMissCost)}</span>` : `턴 평균 ${fmtUsd(t.cost / p.turnCount)}`),
    kpi('현재 컨텍스트', fmtN(p.context),
      `${ctx.level ? `<span class="warn-t">⚠ ${ctx.text}</span>` : `한도의 ${Math.round(ctx.pct * 100)}% · <span title="${esc(compactText(p.compactLog))}">압축 ${p.compactions}회</span>`}`,
      `<div class="gauge"><i class="${ctx.level ? 'warn' : ''}" style="width:${Math.min(100, ctx.pct * 100)}%"></i></div>` + sparkline(turns.map((x) => x.context || 0))),
    kpi('캐시 적중률', p.cacheHit == null ? '—' : `${Math.round(p.cacheHit * 100)}%`, `캐시 읽기 ${fmtN(t.cacheRead)} · 쓰기 ${fmtN(t.cacheWrite)}`),
    kpi('턴 · API 호출', `${p.turnCount} · ${p.calls}`, `질문당 ${(p.calls / p.turnCount).toFixed(1)}회 왕복 · 도구 ${p.tools}회`),
    kpi('응답 시간', fmtMs(p.time.avgTotal), `첫 응답 ${fmtMs(p.time.avgFirst)} · 모델 ${pct(p.time.model, p.time.total)}% · 도구 ${pct(p.time.tool, p.time.total)}%${p.time.approval ? ` · 승인 ${pct(p.time.approval, p.time.total)}%` : ''}`,
      timeBar(p.time)),
    kpi('서브에이전트', p.subagents.length ? `${p.subagents.length}개${p.bgRunning ? ` <small class="sa-run">· ${p.bgRunning}개 진행 중</small>` : ''}` : '—',
      p.subagents.length ? `${fmtN(p.sub.tokens)} · ${fmtUsd(p.sub.cost)} <small>(메인 별도)</small>` : '이 세션에서 사용 안 함'),
    errKpi(p),
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
  if (pct >= 0.8) return { level: 2, pct, text: `한도의 ${Math.round(pct * 100)}% — 곧 자동 압축` };
  if (p.context >= CTX_WARN) return { level: 1, pct, text: `${fmtN(p.context)} — 새 세션 고려` };
  return { level: 0, pct, text: '' };
}

const fmtUsd = (v) => (v == null ? '—' : v < 0.01 ? `$${v.toFixed(3)}` : v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`);

// 캐시 재작성 원인: API 가 붙여 준 진단(diagnostics.cache_miss_reason)이 있으면 그 값, 없으면 공백 시간으로 추정
const MISS_REASON = {
  previous_message_not_found: '앞 대화의 캐시를 못 찾음 (만료·다른 서버)',
  tools_changed: '도구 목록이 바뀜 (MCP 연결·해제 등)',
  system_changed: '시스템 프롬프트가 바뀜',
  expired: '캐시 만료 추정 (공백이 TTL 초과)',
  unknown: '원인 미상 (프롬프트·도구 변경 추정)',
};
const missReason = (k) => MISS_REASON[k] || k;
const missReasonsText = (r) => Object.entries(r || {}).map(([k, n]) => `${missReason(k)} ${n}회`).join(' · ') || '—';
function compactText(log) {
  if (!log?.length) return '자동 압축 기록 없음';
  return log.map((c) => `${new Date(c.ts + clockSkew).toLocaleString('ko-KR', { hour12: false })} ${c.trigger === 'manual' ? '수동' : '자동'} 압축 ${fmtN(c.pre)} → ${fmtN(c.post)}${c.ms ? ` (${fmtMs(c.ms)})` : ''}`).join('\n');
}
// 오류 KPI: API 오류(429 레이트리밋 등)·사용량 한도·도구 실패. 없으면 '—'
function errKpi(p) {
  const api = p.apiErrors || [], q = p.quota, limited = q && q.status === 'rejected' && q.resetsAt && q.resetsAt * 1000 > serverNow();
  const n = api.length + (p.toolErrors || 0);
  const last = api.at(-1);
  const apiT = api.length ? `API 오류 ${api.length}건${last?.status ? ` (최근 ${last.status})` : ''}` : '';
  const toolT = p.toolErrors ? `도구 실패 ${p.toolErrors}건${p.toolErrTop?.length ? ` · ${p.toolErrTop.map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}` : '';
  const sub = [apiT, toolT].filter(Boolean).join(' · ') || '이 세션에서 오류 없음';
  const tip = api.map((x) => `${new Date(x.ts + clockSkew).toLocaleTimeString('ko-KR', { hour12: false })} ${x.status ?? ''} ${x.text}`).join('\n');
  return kpi('오류', n ? `${n}건` : '—',
    `${limited ? `<span class="warn-t">⚠ 사용량 한도(${esc(q.rateLimitType || '')}) · ${new Date(q.resetsAt * 1000 + clockSkew).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })} 해제</span> · ` : ''}<span title="${esc(tip)}">${esc(sub)}</span>`);
}
function missText(m) {
  const gap = m.gap != null ? ` · 공백 ${fmtMs(m.gap)}` : '';
  if (m.reason) return `캐시 재작성 — ${missReason(m.reason)}${gap} (API 진단)`;
  return m.expired ? `캐시 만료 추정${gap} (TTL ${m.ttl >= 3600_000 ? '1시간' : '5분'})` : `캐시 재작성${gap} (프롬프트·도구 변경 추정)`;
}

function turnNotes(x) {
  const notes = [];
  if (x.cacheMiss) notes.push(`<span class="warn-t" title="${esc(missText(x.cacheMiss))}">⚠ ${x.cacheMiss.expired ? '캐시 만료' : '캐시 재작성'} ${fmtN(x.cacheMiss.tokens)}${x.cacheMiss.extra != null ? ` +${fmtUsd(x.cacheMiss.extra)}` : ''}</span>`);
  if (x.sub) notes.push(`<span title="이 턴에서 띄운 서브에이전트">🤖 ${x.sub.n}개 ${fmtN(x.sub.tokens)} · ${fmtUsd(x.sub.cost)}</span>`);
  if (x.toolErrors) notes.push(`<span class="warn-t" title="도구 결과가 오류(is_error)로 돌아온 횟수">✕ 도구 실패 ${x.toolErrors}</span>`);
  return notes.join(' ');
}

function renderSubagents(p) {
  $('#subagents').innerHTML = p.subagents.length
    ? p.subagents.map((s) => `<div class="sa">
        <div class="sa-top"><b>${s.running ? '<i class="sa-live"></i>' : ''}${esc(s.type)}</b><span>${s.running ? '<em class="sa-run">진행 중</em> · ' : ''}${s.background ? '백그라운드 · ' : ''}${s.turn ? `턴 #${s.turn}` : ''}</span></div>
        <div class="sa-desc" title="${esc(s.description)}">${esc(s.description || '—')}</div>
        <div class="sa-meta">${s.model ? `${esc(String(s.model).replace(/^claude-/, ''))} · ` : ''}${fmtN(s.tokens)} 토큰 · ${fmtUsd(s.cost)} · API ${s.calls}회${s.start && s.end ? ` · ${fmtMs(s.end - s.start)}` : ''}</div>
      </div>`).join('')
    : '<div class="profile-empty">서브에이전트(Explore 등)를 쓰면 메인 세션과 따로 집계됩니다.</div>';
  // 돌고 있는 백그라운드 작업(감시·명령): 경과 시간은 1초마다 갱신(tick), 만료 시각이 있으면 함께
  if (p.bgTasks?.length) $('#subagents').insertAdjacentHTML('beforeend', p.bgTasks.map((b) => `<div class="sa">
      <div class="sa-top"><b><i class="sa-live"></i>${b.kind === 'monitor' ? '감시' : '백그라운드 명령'}</b><span><em class="sa-run">진행 중</em> · <em data-since="${b.startedAt}"></em></span></div>
      <div class="sa-desc" title="${esc(b.desc)}">${esc(b.desc || '—')}</div>
      <div class="sa-meta">${b.expiresAt ? `만료 ${new Date(b.expiresAt + clockSkew).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })}` : '만료 없음'}${b.id ? ` · ${esc(b.id)}` : ''}</div>
    </div>`).join(''));
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
    how: 'API 응답마다 서버가 보고한 usage 값(트랜스크립트에 저장됨)을 메시지 ID 기준으로 중복 제거해 세션 처음부터 합산. 서브에이전트는 제외(별도 칸). 괄호 안 사고 토큰은 출력 중 thinking 몫(출력에 포함).',
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
    use: '150k를 넘으면 매 턴 읽는 비용이 커지는 구간 → 새 세션이나 /compact 고려. 컨텍스트 한도(창)의 80%면 곧 자동 압축되며 앞 내용이 요약된다. 추이선이 계단처럼 뛰면 큰 파일·출력이 들어온 턴.',
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
  '오류': {
    what: 'API 오류(429 레이트리밋·과부하 등)와 도구 실패(도구 결과가 오류로 돌아온 경우) 횟수. 사용량 한도에 걸려 있으면 풀리는 시각.',
    how: 'API 오류는 Claude Code 가 남기는 오류 응답 줄(isApiErrorMessage·apiErrorStatus), 한도는 그 줄의 quotaLimits, 도구 실패는 tool_result 의 is_error. 오류 응답은 실제 API 호출이 아니라 호출 수·토큰에서 뺀다.',
    use: '도구 실패가 한 도구에 몰리면 명령·경로 문제. 429 가 잦으면 동시에 돌리는 워커 수를 줄일 때. 마우스를 올리면 최근 API 오류 내용.',
    trust: '높음 — 기록된 실측값. 다만 기록 형식은 공식 계약이 아니라 버전에 따라 빠질 수 있음.',
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

// ---------- 워커를 오가도 터미널 스크롤 위치 유지 ----------
// 워커를 바꾸면 터미널을 지우고 서버 스냅샷을 다시 그려 늘 맨 아래가 된다. 떠날 때 보던 맨 윗줄(번호·글자)을 기억했다가
// 돌아와 스냅샷을 다 그린 뒤 그 줄로 되돌린다. 기록 상한으로 앞줄이 잘려 번호가 밀렸을 수 있어 같은 글자의 줄을
// 기억한 번호 가까이에서 찾고, 없으면 번호로 간다. 맨 아래를 보고 있었으면 기억하지 않는다(새 출력을 따라감)
const termScroll = new Map(); // worker id → { line, text }
let restoreFor = null;
const lineText = (i) => term.buffer.active.getLine(i)?.translateToString(true) ?? '';
function saveTermScroll(id) {
  const b = term.buffer.active;
  if (b.viewportY >= b.baseY) { termScroll.delete(id); return; }
  termScroll.set(id, { line: b.viewportY, text: lineText(b.viewportY) });
}
function restoreTermScroll(id) {
  if (restoreFor !== id) return; // 고른 직후 첫 스냅샷에만 — 재연결 등으로 다시 오는 스냅샷은 건드리지 않는다
  restoreFor = null;
  const saved = termScroll.get(id);
  if (!saved) return;
  const b = term.buffer.active;
  let at = -1;
  if (saved.text.trim()) {
    for (let d = 0; d <= b.length && at < 0; d++) {
      if (lineText(saved.line - d) === saved.text) at = saved.line - d;
      else if (d && lineText(saved.line + d) === saved.text) at = saved.line + d;
      if (saved.line - d < 0 && saved.line + d >= b.length) break;
    }
  }
  term.scrollToLine(Math.max(0, Math.min(b.baseY, at >= 0 ? at : saved.line)));
}
function select(id) {
  markSeen(id); // 카드를 눌렀으면 완료 확인
  // 이미 열려 있는 워커를 다시 누르면 아무것도 하지 않는다 — 터미널을 다시 그리지 않고,
  // 포커스도 옮기지 않는다(옮기면 더블클릭으로 연 이름 입력창의 포커스를 빼앗아 바로 닫혀 버림)
  if (id === selected && !$('#detail').hidden) return;
  if (selected && !$('#detail').hidden) saveTermScroll(selected);
  selected = id;
  restoreFor = id;
  render();
  term.reset();
  // 크기를 먼저 맞춘 뒤 기록을 받는다 — 기록이 예전 크기로 만들어지지 않게
  requestAnimationFrame(() => {
    fitTerm(true);
    send({ type: 'attach', id });
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
  requestAnimationFrame(() => { n.classList.add('dragging'); trashEl.classList.add('show'); }); // 드래그 이미지가 찍힌 뒤 흐리게
});
nodesEl.addEventListener('dragover', (e) => {
  if (memoDrag) return memoDragOver(e);
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
nodesEl.addEventListener('drop', (e) => { e.preventDefault(); if (memoDrag) memoDrop(e); });
nodesEl.addEventListener('dragleave', (e) => {
  const n = e.target.closest?.('.node');
  if (n && !n.contains(e.relatedTarget)) n.classList.remove('dropping');
});
nodesEl.addEventListener('dragend', () => {
  trashEl.classList.remove('show', 'over');
  if (!dragEl) return;
  dragEl.classList.remove('dragging');
  dragEl = null;
  const order = [...nodesEl.querySelectorAll('.node')].map((n) => n.dataset.name).filter(Boolean);
  state.order = order; // 서버 응답 전 깜빡임 방지
  api('/api/order', { order });
  requestAnimationFrame(drawTraces);
});

// ---------- 휴지통: 칩을 끌기 시작하면 아래에 뜨고, 놓으면 제거 ----------
// 워커 칩은 상세의 '제거'와 같고(실행 중이면 세션 종료), 대기실 칩은 저장된 역할 삭제와 같다. 둘 다 확인을 받는다
const trashEl = $('#trash');
trashEl.addEventListener('dragover', (e) => { if (!dragEl) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; trashEl.classList.add('over'); });
trashEl.addEventListener('dragleave', (e) => { if (!trashEl.contains(e.relatedTarget)) trashEl.classList.remove('over'); });
trashEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  const n = dragEl;
  if (!n) return;
  if (n.classList.contains('socket')) {
    const name = n.dataset.profile;
    if (name && await ask({ title: '저장된 역할 삭제', body: `"${name}" 역할을 목록에서 지울까요?`, ok: '삭제', danger: true })) api('/api/profiles/delete', { name });
    return;
  }
  const w = state.workers.find((x) => x.id === n.dataset.id);
  if (!w) return;
  const running = w.status !== 'exited';
  if (!(await ask({ title: `"${w.name}" 워커를 제거할까요?`, body: running ? '목록에서 지웁니다. 실행 중인 Claude 세션도 종료됩니다.' : '목록에서 지웁니다.', ok: '제거', danger: true }))) return;
  await api(`/api/workers/${w.id}/remove`);
  if (selected === w.id) { selected = null; render(); }
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
    if (r.error) { nm.textContent = old; toast(r.error, 3500); }
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
  if (!node || e.target.closest('.card-doc')) return; // 문서 타일은 새 탭만 열고 카드는 선택하지 않음
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (node.classList.contains('socket')) {
    const p = state.profiles.find((x) => x.name === node.dataset.profile);
    if (!p) return;
    if (act === 'launch') { const { id } = await api('/api/workers', p); select(id); }
    if (act === 'forget' && await ask({ title: '저장된 역할 삭제', body: `"${p.name}" 역할을 목록에서 지울까요?`, ok: '삭제', danger: true })) api('/api/profiles/delete', { name: p.name });
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
    message = await ask({ title: '거부 사유', body: 'Claude 에게 그대로 전달됩니다.', ok: '거부', danger: true, input: '' });
    if (message === null) return;
    act = 'deny';
  }
  btn.closest('.decision').style.opacity = .5;
  if (act === 'allow') mgrOnApprove();
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
// 업무 지시·나중에 할 작업 입력칸: 쓴 줄 수만큼 높이가 늘고 줄어든다(최소 3줄 = rows,
// 옆 패널 높이의 40% 까지 늘고 그 뒤로는 칸 안에서 스크롤 — 타임라인 자리를 남긴다). 코드로 값을 바꾼 뒤에도 불러 준다
const GROW_MAX = 0.4;
function autoGrow(ta) {
  if (!ta.matches('.task-form textarea, .memo-form textarea')) return;
  ta.style.height = 'auto';
  const sideH = $('.side').clientHeight || innerHeight;
  const max = Math.max(ta.offsetHeight, Math.round(Math.min(sideH, innerHeight) * GROW_MAX));
  const h = ta.scrollHeight + ta.offsetHeight - ta.clientHeight; // + 테두리
  ta.style.height = `${Math.min(h, max)}px`;
  ta.style.overflowY = h > max ? 'auto' : 'hidden';
}
for (const ta of document.querySelectorAll('.task-form textarea, .memo-form textarea')) ta.addEventListener('input', () => autoGrow(ta));
// 업무 지시 칸: 이미지 드롭·붙여넣기 → 커서 위치에 경로 삽입
function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
  const before = ta.value.slice(0, s), pad = before && !/\s$/.test(before) ? ' ' : '';
  ta.value = `${before}${pad}${text} ${ta.value.slice(e)}`;
  ta.selectionStart = ta.selectionEnd = before.length + pad.length + text.length + 1;
  autoGrow(ta);
  ta.focus();
}
// 이미지 드롭·Ctrl+V 붙여넣기 → 커서 위치에 경로 삽입 (업무 지시 · 나중에 할 작업 공통)
function acceptImages(ta) {
  dropZone(ta, (files) => attachImages(files, (p) => insertAtCursor(ta, p)));
  ta.addEventListener('paste', (e) => {
    const files = imageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    attachImages(files, (p) => insertAtCursor(ta, p));
  });
}
acceptImages(taskForm.text);
acceptImages($('#memo-form').text);
taskForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = taskForm.text.value.trim();
  if (!text || !selected) return;
  taskForm.text.value = '';
  autoGrow(taskForm.text);
  taskForm.text.focus();
  flyToWorker(selected, taskForm.text, 'task');
  await api(`/api/workers/${selected}/task`, { text });
};
// 입력 칸 공통 키: Enter = 줄바꿈(기본 동작), Alt+Enter / 맥 ⌘+Enter = 제출(폼 submit).
// 업무 지시·메모가 같은 함수를 써서 키 동작이 어긋나지 않게 한다. 한글 조합 중 입력은 무시해야 마지막 글자가 잘리지 않는다
function submitOnModEnter(form) {
  form.text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.altKey || e.metaKey) && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
}
submitOnModEnter(taskForm);
// ---------- 메모 (역할별, 자동 실행 안 됨) ----------
let memoSig = '';
function renderMemos(w) {
  const list = state.memos?.[w.name] || [];
  const sig = `${w.id}|${w.name}|${list.map((m) => `${m.id}:${m.text}`).join('|')}`; // 글도 넣어야 수정이 반영된다
  if (sig === memoSig) return; // 상태 갱신마다 다시 그리면 버튼 클릭이 끊긴다
  if ($('#memos li.editing') && sig.startsWith(`${w.id}|`)) return; // 수정 중엔 다시 그리지 않는다 — 끝나면 다음 갱신에 반영
  memoSig = sig;
  const fmt = (t) => new Date(t + clockSkew).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  $('#memos').innerHTML = list.length
    ? `<li class="mh">${list.length}건</li>` + list.map((m) => `<li data-id="${m.id}" draggable="true" title="워커 카드에 끌어다 놓으면 그 워커의 나중에 할 작업으로 옮겨집니다"><span class="mt">${esc(m.text)}</span>
        <span class="ma"><time>${fmt(m.createdAt)}</time><button class="btn mini ghost" data-memo="edit" title="내용 수정">수정</button><button class="btn mini primary" data-memo="send" title="업무 지시로 보내기 (작업 중이면 대기열)" aria-label="업무 지시로 보내기">▶</button><button class="btn mini ghost" data-memo="remove" title="삭제">✕</button></span></li>`).join('')
    : '<li class="empty-memo">나중에 할 작업이 없습니다</li>';
}
// 수정: 본문 자리에 입력칸을 띄운다. Alt(⌘)+Enter 저장 · Esc 취소 — 추가 칸과 같은 키
function editMemo(li, w) {
  if (li.classList.contains('editing')) return;
  const id = li.dataset.id, old = (state.memos?.[w.name] || []).find((m) => m.id === id)?.text ?? $('.mt', li).textContent;
  li.classList.add('editing');
  li.draggable = false; // 입력칸에서 글자를 끌어 선택할 수 있게
  const ta = el('<textarea class="memo-edit" rows="3"></textarea>');
  ta.value = old;
  const bar = el('<span class="ma"><span class="hint">Alt(⌘)+Enter 저장 · Esc 취소</span><button class="btn mini primary" data-edit="save">저장</button><button class="btn mini ghost" data-edit="cancel">취소</button></span>');
  const keep = [...li.children];
  keep.forEach((c) => (c.hidden = true));
  li.append(ta, bar);
  acceptImages(ta);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  const done = () => { ta.remove(); bar.remove(); keep.forEach((c) => (c.hidden = false)); li.classList.remove('editing'); li.draggable = true; memoSig = ''; renderMemos(w); };
  const save = async () => {
    const text = ta.value.trim();
    if (text === old.trim()) return done();
    if (!text) { toast('내용이 비었습니다 — 지우려면 ✕', 2400); return; }
    li.classList.add('busy');
    const r = await api('/api/memos', { role: w.name, op: 'edit', id, text });
    li.classList.remove('busy');
    if (r.error) { toast(r.error, 3000); return; }
    const m = (state.memos?.[w.name] || []).find((x) => x.id === id);
    if (m) m.text = text; // 서버 상태가 오기 전에 바로 보이게
    done();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.altKey || e.metaKey) && !e.isComposing) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]')?.dataset.edit;
    e.stopPropagation();
    if (b === 'save') save();
    if (b === 'cancel') done();
  });
}
const memoForm = $('#memo-form');
submitOnModEnter(memoForm); // 업무 지시 칸과 같은 키: Enter 줄바꿈, Alt/⌘+Enter 추가
memoForm.onsubmit = (e) => {
  e.preventDefault();
  const text = memoForm.text.value.trim();
  const w = state.workers.find((x) => x.id === selected);
  if (!text || !w) return;
  memoForm.text.value = '';
  autoGrow(memoForm.text);
  memoForm.text.focus();
  flyToWorker(w.id, memoForm.text, 'memo');
  api('/api/memos', { role: w.name, op: 'add', text });
};

// ---------- 지시·메모 추가 연출: 워커 색 작은 쪽지가 입력 칸에서 그 워커 카드의 캐릭터로 날아간다 ----------
// 직선으로 날아가며 꼬리(트레일)를 남기고, 도착하면 캐릭터가 통 튀고 무대가 워커 색으로 번쩍인다. 순수 연출이라 실패해도 무시
function flyToWorker(id, fromEl, kind) {
  const w = state.workers.find((x) => x.id === id), target = nodeEls.get(id)?.querySelector('.avatar');
  if (!w || !target || !fromEl) return;
  const color = avatarColor(w.name) || 'var(--accent)';
  flyNote(fromEl, target, color, `fly-note ${kind}`, () => {
    const nd = nodeEls.get(id);
    if (!nd?.isConnected) return;
    const stage = nd.querySelector('.stage');
    stage.style.setProperty('--fc', color);
    stage.classList.remove('got'); void stage.offsetWidth; stage.classList.add('got');
    setTimeout(() => stage.classList.remove('got'), 900);
  });
}
// 작업 완료 → 경험치: 반대 방향으로, 워커 카드의 캐릭터에서 금빛 구슬이 매니저 클로드로 날아가 '+N XP' 가 떠오른다
// reason: 'clear'(/clear) · 'cache'(턴 캐시 적중률, detail = %) · 없음(작업 완료). 잃은 경험치는 날아가지 않고 매니저 위에 빨갛게
const XP_REASON = { clear: () => ' · /clear', cache: (d) => ` · 캐시 ${d}%` };
function flyXpToManager(id, xp, reason, detail) {
  const from = nodeEls.get(id)?.querySelector('.avatar'), dot = $('.core-dot');
  if (!dot) return;
  const label = XP_REASON[reason]?.(detail) || '';
  const show = () => {
    // 경험치 바는 평소 흐리게 두고, 바뀌는 순간부터 잠깐 또렷하게 (연달아 바뀌면 그만큼 연장)
    dot.classList.add('xp-show');
    clearTimeout(flyXpToManager.t);
    flyXpToManager.t = setTimeout(() => dot.classList.remove('xp-show'), 2200);
    const t = document.createElement('span');
    t.className = `mgr-xp${xp < 0 ? ' loss' : ''}`; t.textContent = `${xp < 0 ? '−' : '+'}${Math.abs(xp)} XP${label}`;
    t.addEventListener('animationend', () => t.remove());
    dot.appendChild(t);
  };
  if (xp < 0 || !from?.isConnected) { show(); return; }
  flyNote(from, dot, 'var(--gold)', 'fly-note xp', () => {
    dot.classList.remove('xp-got'); void dot.offsetWidth; dot.classList.add('xp-got');
    setTimeout(() => dot.classList.remove('xp-got'), 700);
    show();
  });
}
// 공통 비행: 직선으로 날아가며 꼬리(트레일)를 남기고, 도착하면 onArrive. 순수 연출이라 실패해도 무시
function flyNote(fromEl, toEl, color, cls, onArrive) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  const x0 = a.left + a.width / 2, y0 = a.top + a.height / 2, x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
  const dx = x1 - x0, dy = y1 - y0, dist = Math.hypot(dx, dy);
  const el = document.createElement('div');
  el.className = cls;
  el.style.setProperty('--fc', color);
  el.style.left = `${x0}px`; el.style.top = `${y0}px`;
  document.body.appendChild(el);
  const dur = Math.min(700, 360 + dist * 0.28), t0 = performance.now();
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2); // easeInOutCubic
  let lastX = x0, lastY = y0;
  const frame = (now) => {
    const t = Math.min(1, (now - t0) / dur), e = ease(t);
    const x = x0 + dx * e, y = y0 + dy * e;
    const sc = t < 0.15 ? 0.6 + (t / 0.15) * 0.5 : 1.1 - (t - 0.15) * 0.8;
    el.style.transform = `translate(${dx * e}px, ${dy * e}px) scale(${sc})`;
    el.style.opacity = t < 0.1 ? t / 0.1 : 1;
    // 꼬리: 지난 프레임 위치에서 지금 위치까지 4px 간격으로 점을 떨군다 — 빠른 구간에서도 끊기지 않게
    const seg = Math.hypot(x - lastX, y - lastY), n = Math.max(1, Math.floor(seg / 4));
    for (let i = 1; i <= n && t > 0.03; i++) {
      const d = document.createElement('i');
      d.className = 'fly-trail';
      d.style.setProperty('--fc', color);
      d.style.left = `${lastX + ((x - lastX) * i) / n}px`; d.style.top = `${lastY + ((y - lastY) * i) / n}px`;
      d.addEventListener('animationend', () => d.remove());
      document.body.appendChild(d);
    }
    lastX = x; lastY = y;
    if (t < 1) return requestAnimationFrame(frame);
    el.remove();
    onArrive?.();
  };
  requestAnimationFrame(frame);
}
$('#memos').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-memo]')?.dataset.memo;
  const li = e.target.closest('li[data-id]');
  const w = state.workers.find((x) => x.id === selected);
  if (!act || !li || !w) return;
  if (act === 'edit') return editMemo(li, w);
  if (act === 'remove' && !(await ask({ title: '이 작업을 지울까요?', body: li.querySelector('.mt')?.textContent.slice(0, 120) || '', ok: '지우기', danger: true }))) return;
  li.classList.add('busy');
  if (act === 'send') flyToWorker(w.id, li, 'task');
  const r = await api('/api/memos', { role: w.name, op: act, id: li.dataset.id, workerId: w.id });
  if (r.error) { li.classList.remove('busy'); toast(r.error, 3000); } // 성공은 날아가는 쪽지로 알린다
});

// ---------- 메모 → 다른 워커 카드로 끌어 옮기기 ----------
// 카드 순서 변경 드래그(dragEl)와 섞이지 않게 따로 표시한다. dragover 중엔 dataTransfer 를 읽을 수 없어 변수로 들고 다닌다
let memoDrag = null;
const memoTarget = (e) => {
  const n = e.target.closest?.('.node');
  return n && n.dataset.name && n.dataset.name !== memoDrag.role ? n : null;
};
$('#memos').addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('li[data-id]');
  const w = state.workers.find((x) => x.id === selected);
  if (!li || !w || e.target.closest('button')) { e.preventDefault(); return; }
  memoDrag = { role: w.name, id: li.dataset.id, li };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/x-am-memo', li.dataset.id);
  requestAnimationFrame(() => li.classList.add('dragging'));
});
$('#memos').addEventListener('dragend', () => {
  memoDrag?.li.classList.remove('dragging');
  memoDrag = null;
  nodesEl.querySelectorAll('.node.dropping').forEach((n) => n.classList.remove('dropping'));
});
function memoDragOver(e) {
  const n = memoTarget(e);
  if (!n) return; // 같은 역할 카드나 빈 곳에는 놓을 수 없다
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!n.classList.contains('dropping')) {
    nodesEl.querySelectorAll('.node.dropping').forEach((x) => x.classList.remove('dropping'));
    n.classList.add('dropping');
  }
}
async function memoDrop(e) {
  const n = memoTarget(e), d = memoDrag;
  if (!n) return;
  n.classList.remove('dropping');
  d.li.classList.add('busy');
  const r = await api('/api/memos', { role: d.role, op: 'move', id: d.id, to: n.dataset.name });
  if (r.error) { d.li.classList.remove('busy'); toast(r.error, 3000); }
  else toast(`'${n.dataset.name}' 의 나중에 할 작업으로 옮겼습니다`);
}

$('#queue').addEventListener('click', (e) => {
  const i = e.target.closest('[data-unqueue]')?.dataset.unqueue;
  if (i != null && selected) api(`/api/workers/${selected}/unqueue`, { index: Number(i) });
});

// ---------- 서버 재시작 ----------
// 서버가 실행기를 '기다렸다 띄우기'로 남기고 내려간다 → 돌아오면 화면이 스스로 새로고침(ws.onopen 의 serverDown 처리)
async function restartServer() {
  const r = await api('/api/restart');
  if (r.error) return; // 옛 서버(이 API 없음)는 api() 가 알림을 띄운다 → ⏻ 서버만 종료 후 Launch 실행
  serverDown = true;
  $('#down-detail').textContent = '서버를 다시 켜는 중입니다… 워커는 그대로 실행 중입니다.';
  $('#down-screen').hidden = false;
}

// ---------- 서버 종료 ----------
let serverDown = false;
$('#btn-power').onclick = () => { $('#power-modal').hidden = false; };
$('#power-modal').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-power]')?.dataset.power;
  if (!act && e.target !== $('#power-modal')) return;
  $('#power-modal').hidden = true;
  if (!act || act === 'cancel') return;
  if (act === 'restart') return restartServer();
  try { await api('/api/shutdown', { workers: act === 'all' }); } catch {}
  serverDown = true;
  $('#down-detail').textContent = act === 'all' ? '모든 워커도 함께 종료했습니다.' : '워커는 백그라운드에서 계속 실행 중입니다 — 서버를 다시 켜면 그대로 다시 붙습니다.';
  $('#down-screen').hidden = false;
});

$('#btn-interrupt').onclick = () => selected && api(`/api/workers/${selected}/interrupt`);

// 터미널 크게 보기: 브라우저 전체화면 API 는 Esc 로 빠져나가는데 Esc 는 Claude 중단 키라 겹친다 → 창 전체를 덮는 오버레이로
// ---------- 타임라인 요청 → 터미널 해당 위치로 ----------
// Claude Code 는 요청을 '> 요청 내용' 으로 대화에 다시 찍는다. 터미널 기록(스크롤백)에서 그 줄을 찾아 스크롤한다.
// 같은 문구가 여러 번이면 뒤에서부터 순서를 맞춘다 — 오래된 기록이 지워져도(clear 등) 최근 요청은 맞게 찾도록.
// 못 찾으면(기록이 지워졌거나 범위를 벗어남) 옮기지 않는다.
let timelineCache = [];
const normText = (s) => String(s).replace(/\s+/g, ' ').trim();
// 첨부 이미지: 보낸 글에는 파일 경로가, 터미널에는 Claude 가 바꾼 '[Image #N]' 이 찍힌다 → 양쪽 다 지우고 비교
const IMG_RE = /\[Image #\d+\]|"[^"]*\.(?:png|jpe?g|gif|webp|bmp)"|(?:[A-Za-z]:)?[\\/]\S*\.(?:png|jpe?g|gif|webp|bmp)\b/gi;
const stripImg = (s) => normText(String(s).replace(IMG_RE, ' '));
// 비교는 공백을 모두 뺀 글자끼리 — Claude 는 요청을 화면 폭에 맞춰 직접 줄을 끊고(들여쓰기 2칸) 원래 줄바꿈도 그대로 찍어서,
// 줄이 어디서 끊겼는지와 상관없이 같은 요청이면 같게 나오도록
// 터미널은 `코드` 의 백틱을 빼고 그리고, 붙여넣기 감싸개 태그(<pasted_content …>)는 보이지 않으므로 양쪽에서 지운다
const compact = (s) => stripImg(String(s).replace(/<\/?pasted_content[^>]*>/g, ' ')).replace(/[\s`]+/g, '');
// 대시보드 지시 로그와 훅이 받은 프롬프트 로그가 같은 요청인지. 첨부 이미지는 한쪽이 파일 경로, 한쪽이 '[Image #N]' 이라
// 글자 그대로는 달라서 같은 지시가 두 줄로 찍혔다 → compact 로 비교. 둘 다 서버에서 300자로 잘리는데 훅 쪽은 앞에
// 'working: ' 이 붙어 9자 먼저 끊기므로, 긴 지시도 맞도록 짧은 쪽이 긴 쪽의 앞부분이면 같은 요청으로 본다
function sameReq(a, b) {
  const x = compact(a), y = compact(b);
  if (!x || !y) return x === y; // 이미지만 보낸 지시끼리만 — 빈 글이 아무 요청에나 붙지 않게
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y);
}
const PROMPT_RE = /^\s?[>›❯]\s?/, CONT_RE = /^ {2}\S/; // 요청 첫 줄 / Claude 가 들여써 이어 찍은 줄
// 터미널 기록을 한 번 훑어 요청 블록(줄 번호 + 앞 40글자)과 턴 요약 줄(줄 번호 + 시각)을 모은다.
// 기록이 1만 줄이라 타임라인 줄마다 훑으면 무겁다 → 기록이 바뀐 뒤 처음 물을 때만 다시 훑는다
const KEY_LEN = 40;
let termScan = null;
term.onWriteParsed(() => { termScan = null; });
function scanTerm() {
  if (termScan) return termScan;
  const b = term.buffer.active, prompts = [], dones = [];
  const row = (j) => b.getLine(j)?.translateToString(true) ?? '';
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (!line || line.isWrapped) continue;
    const first = row(i);
    const dm = DONE_RE.exec(first);
    if (dm) { dones.push({ line: i, min: doneMinutes(dm) }); continue; }
    if (!PROMPT_RE.test(first)) continue;
    // 요청 블록: 프롬프트 줄 + 뒤따르는 줄들 — 자동 줄바꿈(isWrapped), 들여쓴 이어지는 줄, 그 사이 빈 줄.
    // 들여쓰지 않은 줄(● 응답 등)이 나오면 끝. KEY_LEN 만큼 모이면 더 읽지 않는다
    let acc = compact(first.replace(PROMPT_RE, ''));
    for (let j = i + 1; j < b.length && acc.length < KEY_LEN; j++) {
      const l = b.getLine(j), t = row(j);
      if (l.isWrapped || CONT_RE.test(t)) { acc += compact(t); continue; }
      if (!t.trim() && CONT_RE.test(row(j + 1))) continue; // 요청 안의 빈 줄
      break;
    }
    prompts.push({ line: i, acc });
  }
  return (termScan = { prompts, dones });
}
function findPromptLine(text, fromEnd) {
  const key = compact(text).slice(0, KEY_LEN);
  if (key.length < 2) return -1;
  const hits = scanTerm().prompts.filter((p) => p.acc.startsWith(key)).map((p) => p.line);
  return hits.length > fromEnd ? hits[hits.length - 1 - fromEnd] : -1;
}
// 턴 요약 줄 "✻ Brewed for 2m 2s · done 오후 4:15"(로케일에 따라 4:15 PM) 중 그 시각(분 단위) 이전의 마지막 것
const DONE_RE = /^✻ .*\bdone\s+(오전|오후|AM|PM)?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i;
function doneMinutes(m) {
  const pm = /오후|PM/i.test(m[1] || m[4] || ''), am = /오전|AM/i.test(m[1] || m[4] || '');
  let h = Number(m[2]) % 12;
  if (pm) h += 12; else if (!am) h = Number(m[2]);
  return h * 60 + Number(m[3]);
}
// 요약 줄엔 날짜가 없어 시각만으로는 어제·오늘을 못 가른다. 예전엔 '그 시각 이전의 마지막 요약 줄'을 골라,
// 기록에서 밀려난 어제 요청이 오늘 아침 줄로 엉뚱하게 이동했다 → 요청 직전 NEAR_MIN 분 안에 끝난 턴만 인정한다
// (원래 목적: 앞 턴이 끝나는 바로 그 순간 투입돼 '❯ 요청' 줄이 안 남은 경우)
const NEAR_MIN = 3;
function findTurnEndBefore(t) {
  const d = new Date(t), want = d.getHours() * 60 + d.getMinutes();
  let best = -1;
  for (const x of scanTerm().dones) if ((want - x.min + 1440) % 1440 <= NEAR_MIN) best = x.line;
  return best;
}
// 타임라인의 요청 줄 중 터미널 기록에서 이미 밀려나 이동할 수 없는 것은 흐리게 — 누르기 전에 알 수 있게
function laterSame(i) {
  const row = timelineCache[i];
  return timelineCache.slice(i + 1).filter((r) => r.kind === 'req' && normText(r.text) === normText(row.text)).length;
}
function markGoneReqs() {
  if (!selected || $('#detail').hidden) return;
  for (const li of $('#log').querySelectorAll('li.k-req')) {
    const i = Number(li.dataset.i), row = timelineCache[i];
    if (!row) continue;
    const gone = findPromptLine(row.text, laterSame(i)) < 0 && findTurnEndBefore(row.t + clockSkew) < 0;
    li.classList.toggle('gone', gone);
    li.title = gone ? '터미널 기록에서 밀려난 요청이라 위치로 이동할 수 없습니다' : '클릭: 터미널에서 이 요청 위치로 이동';
  }
}
let goneTimer = null;
const markGoneSoon = () => { clearTimeout(goneTimer); goneTimer = setTimeout(markGoneReqs, 400); };
term.onWriteParsed(markGoneSoon);
// ---------- 타임라인 상단 고정 요청 ----------
// 위로 스크롤돼 안 보이게 된 요청 줄 가운데 가장 아래(최근) 것을 타임라인 위에 붙여 보여 준다.
// 지금 보고 있는 기록이 어떤 요청의 결과인지 알 수 있고, 누르면 그 줄을 누른 것과 같다(터미널에서 그 위치로).
// 덮어 씌우는 방식이라 목록 레이아웃·스크롤 위치는 바뀌지 않는다
const pinEl = $('#tl-pin');
let pinFor = null;
function updatePin() {
  const logEl = $('#log');
  const top = logEl.getBoundingClientRect().top;
  let hit = null;
  for (const li of logEl.querySelectorAll('li.k-req')) {
    if (li.getBoundingClientRect().bottom <= top + 2) hit = li; else break;
  }
  if (!hit) { pinEl.hidden = true; pinFor = null; return; }
  // offsetTop 은 정수로 반올림돼 소수 위치일 때 위로 1px 남짓 틈이 생겨 뒤가 비쳤다 → 실제 위치에서 2px 더 올린다
  // (숨겨진 동안엔 offsetParent 가 null 이라 부모 .timeline 을 직접 기준으로)
  const lr = logEl.getBoundingClientRect(), tr = pinEl.parentElement.getBoundingClientRect();
  pinEl.style.top = `${lr.top - tr.top - 2}px`;
  // 오른쪽은 목록의 스크롤바 앞에서 멈춘다(스크롤바를 가리지 않게) — clientWidth 는 스크롤바를 뺀 폭
  pinEl.style.right = `${tr.right - (lr.left + logEl.clientLeft + logEl.clientWidth)}px`;
  if (pinFor !== hit || pinEl.hidden) {
    pinFor = hit;
    const row = timelineCache[Number(hit.dataset.i)];
    pinEl.innerHTML = `<time>${esc(hit.querySelector('time')?.textContent || '')}</time><span class="tag">요청</span><span class="tx">${esc(row?.text || '')}</span>`;
  }
  pinEl.classList.toggle('gone', hit.classList.contains('gone'));
  pinEl.hidden = false;
}
$('#log').addEventListener('scroll', updatePin, { passive: true });
new ResizeObserver(() => updatePin()).observe($('#log'));
// 누르면 타임라인도 그 요청 줄이 맨 위에 오게 스크롤하고, 터미널은 그 요청 위치로
pinEl.addEventListener('click', () => {
  const li = pinFor;
  if (!li?.isConnected) return;
  const logEl = $('#log');
  logEl.scrollTo({ top: logEl.scrollTop + li.getBoundingClientRect().top - logEl.getBoundingClientRect().top, behavior: 'smooth' });
  li.click();
});

$('#log').addEventListener('click', (e) => {
  const li = e.target.closest('li.k-req');
  if (!li) return;
  const i = Number(li.dataset.i), row = timelineCache[i];
  if (!row) return;
  // 이 요청 뒤에 같은 문구 요청이 몇 번 더 있었나 = 터미널에서 끝에서 몇 번째인가
  let line = findPromptLine(row.text, laterSame(i));
  if (line < 0) {
    // 앞 턴이 끝나는 바로 그 순간 투입된 요청은 Claude 가 '❯ 요청' 줄을 남기지 않는 경우가 있다 →
    // 그 시각 직전에 끝난 턴의 요약 줄(✻ … · done 오후 4:15)로 대신 이동
    line = findTurnEndBefore(row.t + clockSkew);
    if (line < 0) { toast('터미널 기록에서 밀려난 요청입니다 (오래됐거나 clear·재부팅으로 지워짐)', 3200); return; }
    toast('요청 줄이 터미널에 남지 않아 그 무렵(직전 턴 종료) 위치로 이동했습니다', 2800);
  }
  term.scrollToLine(Math.max(0, line - 2));
  term.selectLines(line, line); // 잠깐 강조
  clearTimeout(findPromptLine.t);
  findPromptLine.t = setTimeout(() => term.clearSelection(), 1600);
});

// ---------- 세션 프로파일 접기/펼치기 (브라우저에 기억) ----------
const PROFILE_KEY = 'am.profileCollapsed';
function setProfileCollapsed(on) {
  $('#profile').classList.toggle('collapsed', on);
  $('#profile-toggle').setAttribute('aria-expanded', String(!on));
  // 펼치는 순간 실제 폭으로 차트를 다시 그린다
  if (!on) { const w = state.workers.find((x) => x.id === selected); if (w) requestAnimationFrame(() => renderProfile(w, true)); }
  try { on ? localStorage.setItem(PROFILE_KEY, '1') : localStorage.removeItem(PROFILE_KEY); } catch {}
}
try { if (localStorage.getItem(PROFILE_KEY)) setProfileCollapsed(true); } catch {}
$('#profile-toggle').addEventListener('click', () => setProfileCollapsed(!$('#profile').classList.contains('collapsed')));
$('#profile-toggle').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#profile-toggle').click(); } });

// ---------- 워커 비교 접기/펼치기 (브라우저에 기억) ----------
const COMPARE_KEY = 'am.compareCollapsed';
function setCompareCollapsed(on) {
  $('#compare').classList.toggle('collapsed', on);
  $('#compare-toggle').setAttribute('aria-expanded', String(!on));
  try { on ? localStorage.setItem(COMPARE_KEY, '1') : localStorage.removeItem(COMPARE_KEY); } catch {}
}
try { if (localStorage.getItem(COMPARE_KEY)) setCompareCollapsed(true); } catch {}
$('#compare-toggle').addEventListener('click', () => setCompareCollapsed(!$('#compare').classList.contains('collapsed')));
$('#compare-toggle').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#compare-toggle').click(); } });

// ---------- 터미널 높이 조절 (CLI 아래 가로선을 위아래로 끌기) ----------
// 높이는 #detail 의 --term-h 로 정하고 브라우저에 기억한다. 크기가 바뀌면 기존 ResizeObserver 가 fit + pty resize 를 한다
const TERM_H_KEY = 'am.termH';
const clampTermH = (h) => Math.round(Math.max(240, Math.min(innerHeight * 0.9, h)));
function setTermH(h) {
  if (h == null) $('#detail').style.removeProperty('--term-h');
  else $('#detail').style.setProperty('--term-h', `${clampTermH(h)}px`);
}
try { const saved = Number(localStorage.getItem(TERM_H_KEY)); if (saved) setTermH(saved); } catch {}
const resizer = $('#term-resizer');
resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizer.setPointerCapture(e.pointerId);
  const startY = e.clientY, startH = $('#term-wrap').getBoundingClientRect().height;
  resizer.classList.add('dragging'); document.body.classList.add('resizing-term');
  const move = (ev) => setTermH(startH + (ev.clientY - startY));
  const up = () => {
    resizer.removeEventListener('pointermove', move);
    resizer.classList.remove('dragging'); document.body.classList.remove('resizing-term');
    try { localStorage.setItem(TERM_H_KEY, String(Math.round($('#term-wrap').getBoundingClientRect().height))); } catch {}
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up, { once: true });
  resizer.addEventListener('pointercancel', up, { once: true });
});
resizer.addEventListener('dblclick', () => { setTermH(null); try { localStorage.removeItem(TERM_H_KEY); } catch {} });

// ---------- 옆 패널 영역 높이 조절 (업무 지시 · 나중에 할 작업 · 타임라인 사이 가로선 끌기) ----------
// 끈 영역(가로선 위쪽)에 높이를 주고, 남는 자리는 타임라인이 갖는다. 영역마다 브라우저에 기억 · 더블클릭: 기본(내용 크기)
const SIDE_LOG_MIN = 80; // 타임라인이 최소한 남길 높이
function setSecH(sec, h) {
  if (h == null) { sec.classList.remove('sized'); sec.style.removeProperty('--sec-h'); return; }
  sec.classList.add('sized');
  sec.style.setProperty('--sec-h', `${Math.round(h)}px`);
}
// 제목과 입력칸까지는 항상 보이게 — 그 아래 목록(대기열·메모)만 줄어든다
const secMinH = (sec) => sec.querySelector('form').getBoundingClientRect().bottom - sec.getBoundingClientRect().top;
for (const handle of document.querySelectorAll('.side-resizer')) {
  const sec = $('#' + handle.dataset.sec), key = `am.secH.${handle.dataset.sec}`;
  try { const saved = Number(localStorage.getItem(key)); if (saved) setSecH(sec, saved); } catch {}
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY, startH = sec.getBoundingClientRect().height;
    const minH = secMinH(sec), maxH = Math.max(startH, startH + $('.timeline').getBoundingClientRect().height - SIDE_LOG_MIN);
    handle.classList.add('dragging'); document.body.classList.add('resizing-term');
    const move = (ev) => setSecH(sec, Math.max(minH, Math.min(maxH, startH + (ev.clientY - startY))));
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.classList.remove('dragging'); document.body.classList.remove('resizing-term');
      try { if (sec.classList.contains('sized')) localStorage.setItem(key, String(Math.round(sec.getBoundingClientRect().height))); } catch {}
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });
  handle.addEventListener('dblclick', () => { setSecH(sec, null); try { localStorage.removeItem(key); } catch {} });
}

// 크게/원래대로 전환은 FLIP 애니메이션: 바뀌기 전 위치·크기(First)와 바뀐 뒤(Last)를 재서, 원래 자리에서
// 목표 자리로 늘어나고 줄어드는 것처럼 보이게 한다. 늘어나는 동안 글자가 찌그러져 보이지 않게 터미널 내용은
// 잠깐 감췄다가, 크기를 맞춘(fit) 뒤 서서히 보여 준다.
let termAnim = null;
function setTermFull(on) {
  const wrap = $('#term-wrap'), inner = $('#term');
  const first = wrap.getBoundingClientRect();
  wrap.classList.toggle('full', on);
  document.body.classList.toggle('term-full', on);
  $('#btn-full').textContent = on ? '⛶ 원래대로' : '⛶ 크게';
  const w = state.workers.find((x) => x.id === selected);
  $('#term-title').textContent = w ? w.name : '';
  const done = () => { fitTerm(); term.focus(); inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' }); inner.style.opacity = ''; };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { requestAnimationFrame(done); return; }
  const last = wrap.getBoundingClientRect();
  termAnim?.cancel();
  inner.style.opacity = '0';
  termAnim = wrap.animate([
    { transformOrigin: '0 0', transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})` },
    { transformOrigin: '0 0', transform: 'none' },
  ], { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  termAnim.onfinish = () => { termAnim = null; done(); };
  // 옆 패널: 넓은 화면의 크게 보기에선 오른쪽에 따로 붙는다(style.css) → 터미널이 커지는 동안 오른쪽에서 밀려 들어오고,
  // 원래대로 돌아갈 땐 제자리에서 살짝 떠오르며 나타난다. 좁은 화면은 크게 보기에 옆 패널이 없다(터미널만)
  if (matchMedia('(min-width: 1101px)').matches) {
    // 움직임과 페이드를 따로 돌린다 — 같은 감속 곡선에 묶으면 투명도가 처음 0.1초에 거의 다 차서 페이드가 안 보였다
    sideAnim?.forEach((a) => a.cancel());
    const side = $('.side');
    sideAnim = [
      side.animate(on ? [{ transform: 'translateX(48px)' }, { transform: 'none' }] : [{ transform: 'translateY(8px)' }, { transform: 'none' }],
        { duration: on ? 320 : 240, delay: on ? 60 : 80, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'backwards' }),
      side.animate([{ opacity: 0 }, { opacity: 1 }], { duration: on ? 480 : 360, delay: on ? 60 : 80, easing: 'ease-in-out', fill: 'backwards' }),
    ];
  }
}
let sideAnim = null;
$('#btn-full').onclick = () => setTermFull(!$('#term-wrap').classList.contains('full'));
$('#btn-full-exit').onclick = () => setTermFull(false);
$('#btn-remove').onclick = async () => {
  if (!selected || !(await ask({ title: '워커를 제거할까요?', body: '목록에서 지웁니다. 실행 중이면 Claude 세션도 종료됩니다.', ok: '제거', danger: true }))) return;
  await api(`/api/workers/${selected}/remove`);
  selected = null; render();
};
$('#btn-close').onclick = () => { if (selected) saveTermScroll(selected); selected = null; render(); };

connect();

// 다른 탭에 있다가 돌아오면, 열어 둔 워커의 완료를 확인 처리하도록 다시 그린다
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
