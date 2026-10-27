// 관제탑 대시보드 — 서버가 WebSocket 으로 상태 스냅샷을 밀어주고, 터미널은 선택한 워커만 그린다.
// 워커 칩은 id 별로 한 번 만들고 내용만 갱신한다 — 매초 다시 그리면 캐릭터 애니메이션이 리셋된다.
const $ = (s, el = document) => el.querySelector(s);
applyI18n(); // 정적 문구를 지금 언어로 (i18n.js) — 다 바꿨으니 가려 둔 화면을 보인다
document.documentElement.classList.remove('i18n-pending');
// 값은 한국어 원문 — 화면에 쓸 땐 statusLabel() 로 지금 언어로
const statusLabel = (st) => _t(STATUS_LABEL[st]);
const STATUS_LABEL = { starting: '부팅 중', idle: '입력 대기', working: '작업 중', decision: '결정 필요', waiting: '백그라운드 대기', done: '완료', checked: '확인됨', interrupted: '중단됨', exited: '종료됨' };
// 표시용 상태: 메인 턴은 끝났지만 백그라운드 서브에이전트가 아직 도는 중이면 'waiting'
// 완료 후 카드를 눌러 본 워커는 '확인됨'(checked) — 브라우저에만 있는 표시 상태(아래 seenDone)
const viewStatus = (w) => {
  if ((w.status === 'done' || w.status === 'idle') && w.profile?.bgRunning) return 'waiting';
  if (w.status === 'done' && isSeenDone(w)) return 'checked';
  return w.status;
};

let state = { workers: [], decisions: [], profiles: [], recentCwds: [], now: Date.now() };
let gotState = false; // 서버 상태를 한 번이라도 받았는지 — 그 전의 빈 state 로 안내를 그리면 새로고침 때 잠깐 보였다 사라진다
let clockSkew = 0;
let selected = null;
let ws;
// 터치 기기(휴대폰·태블릿): 마우스 없이 손가락으로만 다루는 화면 — 끌기 대신 길게 누르기 메뉴, 전송 버튼, 터미널 보조 키 등(아래 '모바일').
// 마우스도 있는 기기(터치 노트북·트랙패드 iPad)는 hover 가 있어 데스크톱 방식 그대로
const TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
document.documentElement.classList.toggle('touch', TOUCH);
// 휴대폰 폭: 상세 머리줄이 두 줄(이름 · 버튼)이 되고 미터는 그 아래 한 줄(style.css) — 미터 자리를 재지 않는다(placeMeters)
const NARROW = matchMedia('(max-width: 640px)');

// ---------- 캐릭터 — 그림은 characters.js 의 컨셉이 그린다(clawdSVG · managerSVG · faviconSVG) ----------
// data-clawd 값이 'head' 면 머리만(작은 자리) · 'logo' / 'logo-full' 은 앱의 얼굴 자리(올린 캐릭터면 워커 그림 대신 매니저 기본 그림)
document.querySelectorAll('[data-clawd]').forEach((el) => (el.innerHTML = clawdSVG(el.dataset.clawd || 'full')));
$('.core-mark').innerHTML = managerSVG(0);
// 성장 단계 표시 — geN 클래스는 누적(3단계면 ge1~ge3). 4단계부터는 회로 스파크도 금빛
let mgrStage = 0;
function applyStage(stage) {
  const c = curChar(), redraw = c.stageKey && c.stageKey(stage) !== c.stageKey(mgrStage);
  mgrStage = stage;
  if (redraw) $('.core-mark').innerHTML = managerSVG(stage); // 올린 캐릭터: 단계마다 그림이 다르면 바꿔 그린다
  const dot = $('.core-dot');
  for (let i = 1; i <= 5; i++) dot.classList.toggle(`ge${i}`, stage >= i);
  $('#floor').classList.toggle('royal', stage >= 4);
  syncBrandMgr(redraw);
}
// 최소화 중 헤더 로고(.brand-mark.mgr-on)도 매니저 그림·단계 모습으로 — 펼치면 원래 로고(워커 머리 그림)로 돌아간다
function syncBrandMgr(redraw = false) {
  const mark = $('.brand-mark'), on = mark.classList.contains('mgr-on'), svg = mark.querySelector('svg.clawd');
  const isMgr = svg?.classList.contains('mgr');
  if (svg && (on !== isMgr || (on && redraw))) svg.outerHTML = on ? managerSVG(mgrStage) : clawdSVG('logo');
  for (let i = 1; i <= 5; i++) mark.classList.toggle(`ge${i}`, on && mgrStage >= i);
  mark.classList.toggle('party', on && $('.core-dot').classList.contains('party'));
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
  const g = $('.core-mark .mgr-act');
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
  // CLI 에 직접 친 요청 — 업무 지시처럼 쪽지가 날아간다. 출발점은 그 워커의 터미널 커서 자리(xterm 입력 칸이 커서를 따라간다)
  if (msg.kind === 'cli-send' && msg.id === selected && !$('#detail').hidden) {
    const from = $('#term-wrap .xterm-helper-textarea') || $('#term-wrap');
    flyToWorker(msg.id, from, 'task');
  }
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
// ---------- 매니저 산책 ----------
// 작업 중인 워커가 없으면 매니저가 화면 속 패널 · 카드 윗면을 담장 삼아 걸어 다니고, 다른 윗면으로 폴짝 뛰어 옮겨 간다(플랫폼 게임처럼).
// 작업이 생기면 제자리로 뛰어 돌아온다. 서 있는 위치는 '어느 요소의 윗면 · 왼쪽에서 몇 px' 로 기억해, 스크롤해도 그 담장 위에 그대로 있다.
// 자리(.core)는 그대로 두고 .core-dot 을 CSS translate 로만 옮긴다 — transform 을 쓰는 xp-got 연출과 겹치지 않고,
// 매니저에 붙은 xp 바 · 반짝이 · 먼지도 함께 따라온다. 회로 선은 제자리 기준(drawTraces 가 이동분을 뺀다).
// 졸 때(sleepy) · 최소화 · 움직임 줄이기일 때는 나가지 않고, 떠 있는 동안은 클릭을 막지 않게 pointer-events 를 끈다
const ROAM_WALK = 60; // 담장 위를 걷는 속도 px/초
const ROAM_LEDGES = '#floor, #nodes .node, .att-tab-in, #detail, #term-wrap, .side-sec';
const roam = { on: false, raf: 0, timer: 0, last: 0, mode: 'idle', until: 0, el: null, ox: 0, tx: 0, jump: null, tele: false };
const roamAt = (dot) => { const t = getComputedStyle(dot).translate; if (!t || t === 'none') return [0, 0]; const [x, y = '0'] = t.split(' '); return [parseFloat(x) || 0, parseFloat(y) || 0]; };
// 발 위치(가운데 아래) 기준으로 다룬다. 제자리 발 위치 = 지금 위치 - 이동분
function roamHomeFeet(dot) {
  const [cx, cy] = roamAt(dot), r = dot.getBoundingClientRect();
  return { x: r.left - cx + r.width / 2, y: r.top - cy + r.height };
}
function roamPut(dot, x, y) {
  const h = roamHomeFeet(dot);
  dot.style.translate = `${Math.round(x - h.x)}px ${Math.round(y - h.y)}px`;
}
function roamFeet(dot) { const r = dot.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom }; }
// 올라설 수 있는 윗면: 보이고, 매니저가 설 만큼 넓고, 윗면이 화면 안(상단바 아래, 머리가 가리지 않게 여유)에 있는 것
function roamLedges(dot) {
  const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 59) + 60;
  const w = dot.getBoundingClientRect().width;
  return [...document.querySelectorAll(ROAM_LEDGES)].filter((el) => {
    if (el.closest('[hidden]') || !el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    return r.width >= w + 20 && r.top >= top && r.top <= innerHeight - 30;
  });
}
const roamOn = (el, ox) => { const r = el.getBoundingClientRect(); return { x: r.left + ox, y: r.top }; };
function roamJumpTo(dot, el, ox) { // el 이 없으면 제자리로
  const from = roamFeet(dot), to = el ? roamOn(el, ox) : roamHomeFeet(dot);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  roam.jump = { from, el, ox, t0: performance.now(), dur: Math.max(450, Math.min(1100, 380 + dist * .9)), peak: 40 + Math.min(90, dist * .12) };
  roam.mode = 'jump';
  if (Math.abs(to.x - from.x) > 4) dot.classList.toggle('face-l', to.x < from.x);
  dot.classList.remove('walking');
  dot.classList.add('jumping');
}
function roamPick(dot) {
  const ls = roamLedges(dot).filter((el) => el !== roam.el);
  if (!ls.length) return null;
  const f = roamFeet(dot);
  // 가까운 윗면일수록 자주 — 화면을 가로질러 순간이동하듯 뛰지 않게
  const ws = ls.map((el) => { const r = el.getBoundingClientRect(); const d = Math.hypot(Math.max(r.left - f.x, 0, f.x - r.right), r.top - f.y); return 1 / (1 + d / 220) ** 2; });
  let k = Math.random() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < ls.length; i++) if ((k -= ws[i]) <= 0) return ls[i];
  return ls.at(-1);
}
function roamRandOx(dot, el) { const w = dot.getBoundingClientRect().width, r = el.getBoundingClientRect(); return w / 2 + 6 + Math.random() * Math.max(0, r.width - w - 12); }
function roamFrame(now) {
  const dot = $('.core-dot');
  if (!dot) return;
  roam.raf = requestAnimationFrame(roamFrame);
  const dt = Math.min(.05, (now - (roam.last || now)) / 1000);
  roam.last = now;
  if (roam.mode === 'jump') {
    const j = roam.jump, p = Math.min(1, (now - j.t0) / j.dur);
    // 목적지는 매 프레임 다시 잰다 — 뛰는 사이 스크롤 · 레이아웃이 바뀌어도 그 윗면에 내려앉게
    const to = j.el ? roamOn(j.el, j.ox) : roamHomeFeet(dot);
    roamPut(dot, j.from.x + (to.x - j.from.x) * p, j.from.y + (to.y - j.from.y) * p - 4 * j.peak * p * (1 - p));
    if (p < 1) return;
    dot.classList.remove('jumping');
    dot.classList.add('land');
    setTimeout(() => dot.classList.remove('land'), 260);
    if (!j.el) { roamStop(dot); return; }
    roam.el = j.el; roam.ox = j.ox;
    roam.mode = 'idle'; roam.until = now + 600 + Math.random() * 1500;
    return;
  }
  const el = roam.el;
  // 서 있던 윗면이 사라지거나 화면 밖으로 나가면 다른 곳으로 뛴다(없으면 제자리로)
  if (!el || !el.isConnected || !roamLedges(dot).includes(el)) {
    const next = roamPick(dot);
    if (next) roamJumpTo(dot, next, roamRandOx(dot, next));
    else { roam.on = false; roamTeleport(dot); } // 설 곳이 없으면 제자리로 순간이동 — 다음 렌더에서 다시 나간다
    return;
  }
  const r = el.getBoundingClientRect(), w = dot.getBoundingClientRect().width;
  roam.ox = Math.max(w / 2, Math.min(r.width - w / 2, roam.ox)); // 패널 폭이 줄어도 끝에 걸쳐 떨어지지 않게
  if (roam.mode === 'walk') {
    const d = roam.tx - roam.ox, step = ROAM_WALK * dt;
    if (Math.abs(d) <= step) { roam.ox = roam.tx; roam.mode = 'idle'; roam.until = now + 1200 + Math.random() * 3500; dot.classList.remove('walking'); }
    else roam.ox += Math.sign(d) * step;
  } else if (now >= roam.until) {
    // 쉬었으면 다음 행동: 이 담장 위를 걷거나(60%) 다른 윗면으로 뛴다(40%)
    const next = Math.random() < .4 && roamPick(dot);
    if (next) { roamJumpTo(dot, next, roamRandOx(dot, next)); return; }
    roam.tx = roamRandOx(dot, el);
    roam.mode = 'walk';
    dot.classList.toggle('face-l', roam.tx < roam.ox);
    dot.classList.add('walking');
  }
  const p = roamOn(el, roam.ox);
  roamPut(dot, p.x, p.y);
}
// 제자리로는 순간이동: 그 자리에서 가늘게 늘어나며 사라지고(빛 고리 · 반짝이) 제자리에서 같은 연출로 나타난다.
// 크기 연출은 CSS scale 개별 속성(WAAPI)이라 xp-got 의 transform · 걷기 bob 과 겹치지 않는다
function roamBurst(x, y) {
  const ring = el('<i class="mgr-tp-ring"></i>');
  ring.style.left = `${x}px`; ring.style.top = `${y}px`;
  document.body.append(ring);
  ring.animate([{ scale: .2, opacity: .9 }, { scale: 1.6, opacity: 0 }], { duration: 420, easing: 'ease-out' }).finished.then(() => ring.remove());
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.random() * .4, d = 26 + Math.random() * 22;
    const sp = el('<i class="mgr-tp-spark"></i>');
    sp.style.left = `${x}px`; sp.style.top = `${y}px`;
    document.body.append(sp);
    sp.animate([{ translate: '0 0', opacity: 1, scale: 1 }, { translate: `${Math.cos(a) * d}px ${Math.sin(a) * d}px`, opacity: 0, scale: .3 }],
      { duration: 380 + Math.random() * 160, easing: 'cubic-bezier(.2,.7,.3,1)' }).finished.then(() => sp.remove());
  }
}
async function roamTeleport(dot) {
  if (roam.tele) return;
  roam.tele = true;
  cancelAnimationFrame(roam.raf);
  roam.raf = 0; roam.mode = 'idle'; roam.el = null; roam.last = 0;
  dot.classList.remove('walking', 'jumping', 'land');
  const mid = () => { const r = $('.core-mark', dot).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  roamBurst(...mid());
  await dot.animate([{ scale: '1 1', opacity: 1 }, { scale: '.15 1.7', opacity: 0 }], { duration: 230, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
  dot.style.translate = '';
  dot.classList.remove('face-l');
  drawTraces();
  roamBurst(...mid());
  const a = dot.animate([{ scale: '.15 1.7', opacity: 0 }, { scale: '1.15 .88', opacity: 1, offset: .65 }, { scale: '1 1', opacity: 1 }], { duration: 320, easing: 'ease-out' });
  dot.getAnimations().filter((x) => x !== a && x.effect?.target === dot && x.playState === 'finished').forEach((x) => x.cancel()); // 사라질 때 남긴 fill 정리
  await a.finished.catch(() => {});
  dot.classList.remove('roam');
  roam.tele = false;
}
function roamStop(dot) { // 점프로 제자리에 닿았을 때(예비) — 연출 없이 정리
  cancelAnimationFrame(roam.raf);
  roam.raf = 0; roam.mode = 'idle'; roam.el = null; roam.last = 0;
  dot.classList.remove('walking', 'jumping', 'roam', 'face-l');
  dot.style.translate = '';
  drawTraces();
}
// 매니저가 산책을 나가면 제자리에 그림자(같은 모양의 어두운 실루엣 + 바닥 그림자)를 남긴다 — 자리가 비어 보이지 않게.
// 나갈 때마다 지금 모습(단계 · 꾸밈)을 본떠 다시 만든다. 보이고 숨는 것은 .core-dot.roam 을 따르는 CSS
function roamGhost(dot) {
  let g = $('.mgr-ghost');
  if (!g) { g = el('<span class="mgr-ghost" aria-hidden="true"></span>'); dot.before(g); }
  g.innerHTML = $('.core-mark', dot)?.innerHTML || '';
}
function roamSync(stay) {
  const dot = $('.core-dot');
  if (!dot) return;
  stay = stay || dot.classList.contains('sleepy') || $('#floor').hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!stay) {
    if (roam.on || roam.tele) return; // 순간이동 중이면 끝난 뒤 다음 렌더에서 다시 나간다
    roam.on = true;
    clearTimeout(roam.timer);
    // 잠깐 쉬었다가 제자리에서 가까운 윗면으로 첫 점프. 탭이 안 보이면 rAF 가 멈춰 그 자리에서 기다린다
    roam.timer = setTimeout(() => {
      if (!roam.on) return;
      const next = roamPick(dot);
      if (!next) { roam.on = false; return; }
      roamGhost(dot);
      dot.classList.add('roam');
      roamJumpTo(dot, next, roamRandOx(dot, next));
      roam.last = 0;
      roam.raf = requestAnimationFrame(roamFrame);
    }, 1500 + Math.random() * 2500);
    return;
  }
  if (!roam.on) return;
  roam.on = false;
  clearTimeout(roam.timer);
  if (roam.raf) roamTeleport(dot); // 제자리로 순간이동
}

// 매 렌더·30초마다: 시선 기울기, 졸음(모두 30분 넘게 쉬거나 늦은 밤)
function mgrUpdate() {
  const dot = $('.core-dot'), lean = $('.core-mark .mgr-lean');
  if (!dot || !lean) return;
  dot.classList.toggle('party', mgrStage >= 4 && dot.classList.contains('party-day'));
  $('.brand-mark').classList.toggle('party', dot.classList.contains('party') && $('.brand-mark').classList.contains('mgr-on'));
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

// 브라우저 탭 아이콘 = 지금 캐릭터 (서버 재시작 없이 바뀌도록 파일 대신 data URI 로 넣는다). 결정 대기가 있으면 주황 점
let faviconAlert = null;
function setFavicon(alert, force) {
  if (alert === faviconAlert && !force) return;
  faviconAlert = alert;
  $('#favicon').href = 'data:image/svg+xml,' + encodeURIComponent(faviconSVG(alert));
}
setFavicon(false);

// ---------- 터미널 ----------
// 터미널 색: 다크는 검정 바탕, 라이트는 업무 지시 입력칸과 같은 바탕(--bg #f4f3ef)에 먹색 글자.
// 워커 CLI 는 다크 테마 색(흰 글자 등)으로 그리지만 아래 minimumContrastRatio 가 밝은 바탕에 맞게 글자색을 어둡게 보정한다.
// 기본 16색(ANSI)은 밝은 바탕에서 읽히게 진한 쪽으로
// 사용자 테마 목록(프로젝트 themes/ 폴더, 서버 /api/themes) — 터미널 색에도 쓰여 여기서 먼저 꺼낸다. 첫 화면용으로 브라우저에 기억(am.themes)
let userThemes = [], themeDir = '';
try { userThemes = JSON.parse(localStorage.getItem('am.themes') || '[]'); } catch {}
const curTheme = () => userThemes.find((t) => t.id === document.documentElement.dataset.skin);
// 터미널 색: 기본 다크/라이트 값에 지금 테마의 theme.json terminal.dark/light 를 덮어쓴다.
// CLI 색 구성표(꾸미기 → 글꼴 · CLI 색)를 골랐으면 그 색이 앞선다 — 다크/라이트·테마와 상관없이 이 PC 에선 그 색
function termTheme(light) {
  const sc = termScheme();
  if (sc) return { ...baseTermTheme(sc.dark === false), ...schemeTheme(sc) };
  const t = curTheme()?.terminal?.[light ? 'light' : 'dark'];
  return t ? { ...baseTermTheme(light), ...t } : baseTermTheme(light);
}
// ---------- CLI 색 구성표 (Windows Terminal 형식) ----------
// 고른 구성표를 통째로 브라우저에 기억(am.term.scheme) — 서버·다른 PC 없이도 그대로 쓴다. 목록은 Windows Terminal 기본 구성표 +
// 서버 PC 의 Windows Terminal settings.json 에 있는 것(/api/term-schemes). 키 이름은 WT 그대로(purple · cursorColor) → schemeTheme 이 xterm 이름으로
const WT_SCHEMES = [
  { name: 'Campbell', background: '#0C0C0C', foreground: '#CCCCCC', cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF', black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', purple: '#881798', cyan: '#3A96DD', white: '#CCCCCC', brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightPurple: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2' },
  { name: 'Campbell Powershell', background: '#012456', foreground: '#CCCCCC', cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF', black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', purple: '#881798', cyan: '#3A96DD', white: '#CCCCCC', brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightPurple: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2' },
  { name: 'Vintage', background: '#000000', foreground: '#C0C0C0', cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF', black: '#000000', red: '#800000', green: '#008000', yellow: '#808000', blue: '#000080', purple: '#800080', cyan: '#008080', white: '#C0C0C0', brightBlack: '#808080', brightRed: '#FF0000', brightGreen: '#00FF00', brightYellow: '#FFFF00', brightBlue: '#0000FF', brightPurple: '#FF00FF', brightCyan: '#00FFFF', brightWhite: '#FFFFFF' },
  { name: 'One Half Dark', background: '#282C34', foreground: '#DCDFE4', cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF', black: '#282C34', red: '#E06C75', green: '#98C379', yellow: '#E5C07B', blue: '#61AFEF', purple: '#C678DD', cyan: '#56B6C2', white: '#DCDFE4', brightBlack: '#5A6374', brightRed: '#E06C75', brightGreen: '#98C379', brightYellow: '#E5C07B', brightBlue: '#61AFEF', brightPurple: '#C678DD', brightCyan: '#56B6C2', brightWhite: '#DCDFE4' },
  { name: 'One Half Light', background: '#FAFAFA', foreground: '#383A42', cursorColor: '#4F525D', selectionBackground: '#4F525D', black: '#383A42', red: '#E45649', green: '#50A14F', yellow: '#C18301', blue: '#0184BC', purple: '#A626A4', cyan: '#0997B3', white: '#FAFAFA', brightBlack: '#4F525D', brightRed: '#DF6C75', brightGreen: '#98C379', brightYellow: '#E4C07A', brightBlue: '#61AFEF', brightPurple: '#C577DD', brightCyan: '#56B5C1', brightWhite: '#FFFFFF' },
  { name: 'Solarized Dark', background: '#002B36', foreground: '#839496', cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF', black: '#002B36', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2', purple: '#D33682', cyan: '#2AA198', white: '#EEE8D5', brightBlack: '#073642', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83', brightBlue: '#839496', brightPurple: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3' },
  { name: 'Solarized Light', background: '#FDF6E3', foreground: '#657B83', cursorColor: '#002B36', selectionBackground: '#073642', black: '#002B36', red: '#DC322F', green: '#859900', yellow: '#B58900', blue: '#268BD2', purple: '#D33682', cyan: '#2AA198', white: '#EEE8D5', brightBlack: '#073642', brightRed: '#CB4B16', brightGreen: '#586E75', brightYellow: '#657B83', brightBlue: '#839496', brightPurple: '#6C71C4', brightCyan: '#93A1A1', brightWhite: '#FDF6E3' },
  { name: 'Tango Dark', background: '#000000', foreground: '#D3D7CF', cursorColor: '#FFFFFF', selectionBackground: '#FFFFFF', black: '#000000', red: '#CC0000', green: '#4E9A06', yellow: '#C4A000', blue: '#3465A4', purple: '#75507B', cyan: '#06989A', white: '#D3D7CF', brightBlack: '#555753', brightRed: '#EF2929', brightGreen: '#8AE234', brightYellow: '#FCE94F', brightBlue: '#729FCF', brightPurple: '#AD7FA8', brightCyan: '#34E2E2', brightWhite: '#EEEEEC' },
  { name: 'Tango Light', background: '#FFFFFF', foreground: '#555753', cursorColor: '#000000', selectionBackground: '#555753', black: '#000000', red: '#CC0000', green: '#4E9A06', yellow: '#C4A000', blue: '#3465A4', purple: '#75507B', cyan: '#06989A', white: '#D3D7CF', brightBlack: '#555753', brightRed: '#EF2929', brightGreen: '#8AE234', brightYellow: '#FCE94F', brightBlue: '#729FCF', brightPurple: '#AD7FA8', brightCyan: '#34E2E2', brightWhite: '#EEEEEC' },
  { name: 'Dark+', background: '#1E1E1E', foreground: '#CCCCCC', cursorColor: '#808080', selectionBackground: '#FFFFFF', black: '#000000', red: '#CD3131', green: '#0DBC79', yellow: '#E5E510', blue: '#2472C8', purple: '#BC3FBC', cyan: '#11A8CD', white: '#E5E5E5', brightBlack: '#666666', brightRed: '#F14C4C', brightGreen: '#23D18B', brightYellow: '#F5F543', brightBlue: '#3B8EEA', brightPurple: '#D670D6', brightCyan: '#29B8DB', brightWhite: '#E5E5E5' },
];
const SCHEME_KEY = 'am.term.scheme';
const hexOk = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
// 밝은 바탕인지(구성표의 dark 표시) — 스크롤바·확장 색(diff 줄 등)을 라이트/다크 어느 쪽 값으로 둘지
const isDarkBg = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return 0.299 * r + 0.587 * g + 0.114 * b < 140; };
function termScheme() {
  try { const s = JSON.parse(localStorage.getItem(SCHEME_KEY) || 'null'); return s && hexOk(s.background) ? { ...s, dark: isDarkBg(s.background) } : null; } catch { return null; }
}
function schemeTheme(s) {
  const t = { background: s.background, foreground: hexOk(s.foreground) ? s.foreground : undefined, cursorAccent: s.background };
  if (hexOk(s.cursorColor)) t.cursor = s.cursorColor;
  // WT 의 선택색은 불투명 색에 앱이 투명도를 입힌다 — xterm 은 색 그대로 칠하므로 같은 느낌이 나게 반투명(25%)으로
  if (hexOk(s.selectionBackground)) t.selectionBackground = s.selectionBackground + '40';
  for (const k of ['black', 'red', 'green', 'yellow', 'blue', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightCyan', 'brightWhite']) if (hexOk(s[k])) t[k] = s[k];
  if (hexOk(s.purple)) t.magenta = s.purple; if (hexOk(s.brightPurple)) t.brightMagenta = s.brightPurple;
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  return t;
}
// 터미널 둘레(.term-wrap 여백 등 --term-bg)도 구성표 바탕색으로.
// 채팅 보기·위 막대는 구성표가 아니라 화면 테마를 따른다(--chat-bg) — 라이트 화면에 어두운 구성표면 글자는 어둡고 바탕도 어두워졌다.
// 그래서 구성표를 덮기 전의 테마 값을 먼저 읽어 둔다. 라이트·다크 전환과 사용자 테마를 불러온 뒤에도 다시 부른다
function applyScheme() {
  const root = document.documentElement, sc = termScheme();
  root.style.removeProperty('--term-bg');
  root.style.setProperty('--chat-bg', getComputedStyle(root).getPropertyValue('--term-bg').trim() || '#07080a');
  if (sc) root.style.setProperty('--term-bg', sc.background);
}
// Claude Code 는 예전엔 이 터미널에 256색 번호로 색을 찍었다(2.1.29x 부터 diff·요청 줄은 24비트 — 아래 recolorTerm 이 같은 번호의 색으로 바꾼다). 그중 몇 번호를 이 화면에서만 다른 색으로 —
//  · diff: 22 추가 줄 배경 · 28 추가 단어 · 52 삭제 줄 · 88 삭제 단어 · 77 '+' 글자 · 167 '-' 글자. 기본은 원색에 가까워 너무 진하다 → 차분한 초록/빨강
//  · 237: 지난 요청(❯ 요청 글) 줄 배경 — 회색 대신 타임라인 요청 행처럼 강조색(--accent)을 배경에 섞은 연한 색(라이트 11% · 다크는 바탕이 더 어두워 15%)
//  · 231(흰 글자): 요청 줄 글자색. 라이트에선 대비 보정만으로는 회색으로 남아서 기본 글자색(검정)으로
// 이 번호들은 diff·요청 줄 말고는 거의 쓰이지 않는다. 글자 대비는 minimumContrastRatio 가 맞춘다
// diff 색은 라이트·다크 같은 한 벌 — GitHub 풍 연한 초록/분홍 줄에 진한 단어 강조(diff 화면 --dl-* 과 같은 값). 다크에서도 줄은 밝아서
// 그 위 흰 글자는 minimumContrastRatio 가 어둡게 맞춘다
const TERM_DIFF = { 22: '#e9ffed', 28: '#addeb2', 52: '#fdeeef', 88: '#f2bac4', 77: '#1a7f37', 167: '#cf222e' };
const TERM_256 = {
  dark: { ...TERM_DIFF, 237: '#271916' },
  light: { ...TERM_DIFF, 237: '#efe3dc', 231: '#1b1d23' },
};
// Claude Code 2.1.29x 부터 diff·요청 줄 배경을 256색 번호가 아니라 24비트 RGB 로 찍는다(실측 2026-10-12, 2.1.296: 버퍼 배경 팔레트 0칸,
// RGB #001b29·#003047·#3d0100·#5c0200·#373737) → 위 번호 매핑이 안 먹어 예전 색 그대로였다. 들어오는 출력에서 알려진 값만 같은 번호의 색으로 바꿔 쓴다.
// 값은 Claude 테마별 — dark-daltonized(라이트 계열 사용자의 워커 테마, server.js workerTheme)는 실측, dark 는 Claude 기본 다크 값
const RGB_REMAP = {
  '0;27;41': 22, '0;48;71': 28, '61;1;0': 52, '92;2;0': 88, // dark-daltonized: 추가 줄·단어 / 삭제 줄·단어
  '34;92;43': 22, '56;166;96': 28, '122;41;54': 52, '179;89;107': 88, // dark
  '55;55;55': 237, // 지난 요청 줄
};
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(';');
function recolorTerm(data) {
  if (!data.includes('48;2;')) return data;
  const map = TERM_256[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];
  return data.replace(/(?<=\x1b\[(?:[\d;]*;)?)48;2;(\d{1,3});(\d{1,3});(\d{1,3})(?=[;m])/g, (m, rr, g, b) => {
    const n = RGB_REMAP[`${rr};${g};${b}`];
    return n != null && map[n] ? `48;2;${hexRgb(map[n])}` : m;
  });
}
const extAnsi = (map) => { const a = []; for (const [n, c] of Object.entries(map)) a[n - 16] = c; return a; }; // 16번부터, 빈 칸은 기본색
function baseTermTheme(light) {
  // 스크롤바는 회색 둥근 막대(모양은 style.css #term .slider). xterm 기본값(글자색 20%)은 라이트에서 거의 안 보여서 조금 진하게,
  // 올리면·끄는 중엔 더 진하게
  if (!light) return { background: '#07080a', foreground: '#e6e4de', cursor: '#d97757', selectionBackground: '#d9775744',
    scrollbarSliderBackground: '#e6e4de40', scrollbarSliderHoverBackground: '#e6e4de66', scrollbarSliderActiveBackground: '#e6e4de85', extendedAnsi: extAnsi(TERM_256.dark) };
  return {
    background: '#fcfbf7', foreground: '#2b231c', cursor: '#c8623f', cursorAccent: '#fcfbf7', selectionBackground: '#c8623f33',
    scrollbarSliderBackground: '#1b1d234d', scrollbarSliderHoverBackground: '#1b1d2373', scrollbarSliderActiveBackground: '#1b1d2394',
    black: '#1b1d23', red: '#c4342b', green: '#2f7d3a', yellow: '#946200', blue: '#2a5fc0', magenta: '#9b3aa8', cyan: '#1a7f8e', white: '#5c606b',
    brightBlack: '#6b6f7a', brightRed: '#d9473d', brightGreen: '#3a9147', brightYellow: '#a87000', brightBlue: '#3a72d6', brightMagenta: '#ae4cbb', brightCyan: '#22909f', brightWhite: '#3d4049',
    extendedAnsi: extAnsi(TERM_256.light),
  };
}
applyScheme();
const term = new Terminal({
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, "Cascadia Mono", Consolas, monospace', // 시스템 고정폭 (style.css --mono 와 같음)
  fontSize: 13, cursorBlink: true, scrollback: 12000, // PTY 호스트 기록(10000줄)보다 넉넉히
  allowProposedApi: true, // unicode 버전 전환에 필요
  theme: termTheme(document.documentElement.dataset.theme === 'light'),
  // 배경과 대비가 모자란 글자색은 자동으로 밝혀 그린다. 라이트 테마로 뜬 워커는 질문 창 문구 등을 순수 검정(rgb 0,0,0)으로
  // 그려 이 검정 배경에서 드래그해야만 보였다(실측). 새 워커는 서버가 다크 테마로 띄우지만, 이미 떠 있는 워커도 바로 보이게
  minimumContrastRatio: 4.5,
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
// 시작 중(신뢰 확인 같은 선택창 없이)엔 터미널 입력을 막는다 — 가림막(#term-boot)과 같은 조건
const termLocked = () => { const w = selected && state.workers.find((x) => x.id === selected); return Boolean(w && w.status === 'starting' && !w.bootOpen); };
// 선택한 입력칸 글 위에 글자를 치면(덮어쓰기) 선택한 글을 먼저 지운다 — 지우는 동안(커서를 옮기며 몇 번 왕복) 친 글자는
// 붙잡아 두었다가 다 지운 뒤 보낸다. 안 그러면 지우는 도중의 커서 자리에 끼어들었다
let replaceJob = null;
const heldInput = [];
// 터미널 기록 받기: 워커를 바꿀 때 최근 TERM_SNAP_LINES 줄만 받아 빨리 그리고(server trimScrollback), 맨 위까지 올리면 전부 받는다.
// 채팅 보기 중이면 터미널이 안 보이므로 기록은 CLI 로 돌아올 때 받는다(pending)
const TERM_SNAP_LINES = 1500;
let termSnap = { id: null, partial: false, loadingFull: false, fromBottom: 0, pending: false };
// 채팅 보기면 지금 화면 높이만큼만 받는다(수십 줄) — CLI 가 메뉴 · 선택창을 띄웠는지 알아야 해서(cliPeek). 긴 기록은 CLI 로 돌아올 때(pending)
function attachMsg(id) {
  termSnap = { id, partial: false, loadingFull: false, fromBottom: 0, pending: chatOpen };
  return { type: 'attach', id, snap: true, lines: chatOpen ? term.rows + 20 : TERM_SNAP_LINES };
}
// 최근 줄만 받은 터미널을 맨 위까지 올리면 나머지 기록을 받는다 — 다 받으면 보던 줄이 그대로 맨 위에 오게(scrollback 처리)
term.onScroll((y) => {
  if (y !== 0 || !termSnap.partial || termSnap.loadingFull || termSnap.id !== selected) return;
  termSnap.loadingFull = true;
  termSnap.fromBottom = term.buffer.active.baseY - y;
  send({ type: 'snapshot', id: selected, full: true });
});
function loadTermSnapIfPending() {
  if (!termSnap.pending || termSnap.id !== selected) return;
  termSnap.pending = false;
  send({ type: 'snapshot', id: selected, lines: TERM_SNAP_LINES });
}
// ---------- 채팅 보기에서 CLI 엿보기 ----------
// Claude Code 는 채팅에 없는 화면(되감기 · /model 같은 메뉴, 권한 선택창, 폴더 신뢰 확인 …)을 띄우면 평소 입력창(가로선 사이 ❯ 줄)을
// 감춘다. 채팅 보기에선 그게 안 보여 멈춘 줄도 몰랐다(실측: Esc 두 번에 Rewind 메뉴가 떠 다음 지시가 '보내는 중'에 갇힘).
// 화면 맨 아래에 입력창이 없으면 채팅 아래쪽을 걷어 실제 터미널을 보여 주고 키를 그쪽으로 — 입력창이 돌아오면 다시 닫는다
function cliScreenBlocked() {
  const b = term.buffer.active;
  if (b.type === 'alternate') return false; // 전체 화면 모드 워커는 화면 모양이 달라 보지 않는다
  const rows = [];
  for (let i = b.baseY; i < b.baseY + term.rows; i++) rows.push(b.getLine(i)?.translateToString(true) || '');
  let last = rows.length - 1;
  while (last >= 0 && !rows[last].trim()) last--;
  if (last < 0) return false; // 아직 화면을 못 받음
  peekLast = last;
  const rule = rows.map((t, i) => (/^\s*─{20,}/.test(t) ? i : -1)).filter((i) => i >= 0);
  for (let k = rule.length - 1; k > 0; k--) {
    if (last - rule[k] > 8) break; // 입력창 아래엔 상태줄 · 안내 몇 줄뿐
    if (rule[k] - rule[k - 1] >= 2 && /^\s*[❯›>]/.test(rows[rule[k - 1] + 1])) return false;
  }
  return true;
}
let peekOn = false, peekHidden = false, peekTimer = null, peekSince = 0, peekLast = 0;
// 화면이 아직 짧으면(막 띄운 워커 등) 메뉴가 터미널 위쪽에 그려져 채팅 칸에 가린다 → 마지막 글 줄이 드러난 칸 맨 아래에 오게 터미널을 내린다
function peekShift() {
  const el = $('#term');
  if (!peekOn) { el.style.transform = ''; return; }
  const cell = ($('#term .xterm-screen')?.clientHeight || 0) / term.rows;
  el.style.transform = cell ? `translateY(${Math.max(0, term.rows - 1 - peekLast) * cell}px)` : '';
}
function cliPeekCheck() {
  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => {
    const w = state.workers.find((x) => x.id === selected);
    const want = Boolean(chatOpen && w && termSnap.id === selected && !['starting', 'exited'].includes(w.status) && !$('#detail').hidden && cliScreenBlocked());
    if (!want) { peekSince = 0; peekHidden = false; $('#cv-peek').hidden = true; return setCliPeek(false); }
    if (!peekSince) peekSince = Date.now();
    if (Date.now() - peekSince < 500) return cliPeekCheck(); // 다시 그리는 중의 잠깐 빈 화면은 넘긴다
    $('#cv-peek').hidden = false; // 접어 둬도 막대는 남겨 '기다리는 중'을 알린다
    setCliPeek(!peekHidden);
    peekShift();
  }, 120);
}
// 채팅 칸을 위로 줄여 아래에 깔린 실제 터미널(맨 아래 줄들 — 메뉴가 뜨는 자리)을 드러낸다. 터미널 크기는 그대로(pty 크기를 바꾸지 않게)
function setCliPeek(on) {
  if (on === peekOn) return;
  peekOn = on;
  $('#term-wrap').classList.toggle('cli-peek', on);
  $('#cv-peek').classList.toggle('open', on);
  $('[data-peek]', $('#cv-peek')).textContent = _t(on ? '접기' : '펼치기');
  peekShift();
  if (on) { term.scrollToBottom(); if (!(document.activeElement === chatForm.text && chatForm.text.value)) term.focus(); }
  else if (chatOpen && document.activeElement?.closest?.('#term')) chatForm.text.focus();
}
$('#cv-peek').addEventListener('click', (e) => {
  if (!e.target.closest('[data-peek]')) return;
  peekHidden = peekOn;
  setCliPeek(!peekOn);
});
term.onWriteParsed(cliPeekCheck);
function sendInput(data) {
  if (replaceJob) { heldInput.push(data); return; }
  if (selected) send({ type: 'input', id: selected, data });
}
function typeOver() {
  if (replaceJob || cutting || !term.hasSelection() || termLocked()) return;
  const job = cutSelection(true); // 입력칸 밖 선택이면 false — 그때는 xterm 이 선택만 풀고 글자는 그대로 간다
  if (!job) return;
  replaceJob = job.finally(() => { replaceJob = null; const d = heldInput.splice(0).join(''); if (d) sendInput(d); });
}
term.onData((data) => {
  if (enterAs && (data === '\r' || data === '\x1b\r')) { data = enterAs; enterAs = null; }
  if (termLocked()) return;
  sendInput(data);
});
// ---------- Safari: 조합 이벤트 없이 들어오는 한글 ----------
// Safari 는 가끔 터미널 입력칸에서 조합 이벤트(compositionstart…)를 전혀 보내지 않고, 첫 자모는 insertText 로 넣은 뒤
// 마지막 글자를 insertReplacementText 로 갈아끼우며 조합한다(ㅈ → 지 → 진). xterm 은 insertText 만(그것도 키 상태에 따라)
// 보내고 갈아끼우기는 무시해서 CLI 엔 자모만 들어갔다(실측 Safari 18.6, 키·입력 이벤트 기록).
// 그 경우만 직접 처리한다: 입력칸의 바뀌기 전·후를 비교해 바뀐 글자 수만큼 DEL, 새 글자를 보낸다(ㅈ→지 = DEL + 지).
// xterm 보다 먼저 받도록 바깥 요소(#term)의 캡처 단계에서 듣고, 처리한 이벤트는 xterm 에 넘기지 않는다
const IS_SAFARI = /safari/i.test(navigator.userAgent) && !/chrome|chromium|crios|fxios|android/i.test(navigator.userAgent);
const HANGUL_RE = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;
let imeComposing = false, imeCompEndAt = 0, imeBefore = '', imeRunStart = 0;
const IME_MOD_KEYS = ['Shift', 'CapsLock', 'Meta', 'OS', 'Control', 'Alt'];
if (IS_SAFARI && term.textarea) {
  const ta = term.textarea, box = $('#term');
  ta.addEventListener('compositionstart', () => { imeComposing = true; });
  ta.addEventListener('compositionend', () => { imeComposing = false; imeCompEndAt = Date.now(); });
  // 한글이 아닌 키(Backspace·Enter·방향키 등)를 누르면 거기서부터 새로 센다 — 갈아끼우기가 그 앞 글자까지 지우지 않게.
  // 보조키만 누른 것은 뺀다: 쌍자음·ㅒ·ㅖ 는 Shift 를 누르고 치는데, Shift 를 누르는 순간 새로 세면 '해'+ㅆ 의
  // 갈아끼우기(해→했)가 센 자리보다 앞 글자라 무시돼 '해'로 남았다
  ta.addEventListener('keydown', (e) => { if (e.keyCode !== 229 && !IME_MOD_KEYS.includes(e.key)) imeRunStart = ta.value.length; }, true);
  const plain = (e) => !imeComposing && !e.isComposing && Date.now() - imeCompEndAt > 100;
  const ours = (e) => plain(e) && (e.inputType === 'insertReplacementText' || (e.inputType === 'insertText' && HANGUL_RE.test(e.data || '')));
  box.addEventListener('beforeinput', (e) => { if (e.target === ta && ours(e)) imeBefore = ta.value; }, true);
  box.addEventListener('input', (e) => {
    if (e.target !== ta || !ours(e)) return;
    e.stopPropagation(); // xterm 이 insertText 를 한 번 더 보내지 않게
    const before = imeBefore, after = ta.value;
    let p = 0;
    while (p < before.length && p < after.length && before[p] === after[p]) p++;
    p = Math.max(p, Math.min(imeRunStart, before.length, after.length));
    const data = '\x7f'.repeat(before.length - p) + after.slice(p);
    imeBefore = after;
    if (!data || termLocked()) return;
    sendInput(data);
  }, true);
}

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
// ---------- 잘라내기 (Ctrl/⌘+X) ----------
// xterm 화면엔 CLI 가 그린 글자만 있고 입력 내용은 Claude 안에 있다 → 선택을 복사한 뒤 키로 지운다:
// 커서를 선택 한쪽 끝으로 옮기고, 반대쪽 끝까지 가며 몇 번 눌렀는지 세서, 그만큼 Delete(끝→시작) 또는 Backspace(시작→끝).
// 화면에서 글자 수를 셀 수 없어 커서를 보며 옮긴다(실측 v2.1.296): 입력칸은 단어 단위로 접히고 접힌 자리의 공백은 안 보인다
// (줄 끝 → 다음 줄 첫 칸이 두 번), 단어 중간에서 접히면 줄 끝 칸에는 커서가 가지 않는다(한 번), 줄바꿈도 두 번. ←/→ 는 한 글자씩
// 줄을 넘어 움직이고 커서는 진짜 터미널 커서다. 입력칸이 아니거나(메뉴·! 셸) Vim 모드·붙여넣기 묶음([Pasted text #1])이면 복사만 한다
const CUT_INDENT = 2; // '❯ ' · 이어지는 줄 들여쓰기
let cutting = false;
function cutBox() {
  const b = term.buffer.active, rows = [];
  for (let i = b.baseY; i < b.length; i++) rows.push(i);
  const str = (y) => b.getLine(y)?.translateToString(true) || '';
  const rule = rows.filter((y) => /^\s*─{20,}/.test(str(y)));
  for (let k = rule.length - 1; k > 0; k--) {
    const top = rule[k - 1], bottom = rule[k];
    if (bottom - top < 2) continue;
    const first = str(top + 1), at = first.search(/[❯›>]/);
    if (at < 0 || first.slice(0, at).trim()) return null;
    const below = rows.filter((y) => y > bottom).map(str).join('\n');
    if (/-- (INSERT|NORMAL|VISUAL)/.test(below)) return null;
    return { top, bottom, start: at + CUT_INDENT, cur: { y: b.baseY + b.cursorY, x: b.cursorX } };
  }
  return null;
}
// 줄 y 의 글자 끝 칸(마지막 글자 다음 칸)
function cutRowEnd(y) {
  const l = term.buffer.active.getLine(y);
  let end = 0;
  for (let x = 0; l && x < l.length; x++) { const c = l.getCell(x); if (c && c.getChars().trim()) end = x + Math.max(1, c.getWidth()); }
  return end;
}
// a 부터 b 까지(같은 줄) 글자 수 — 두 칸 글자(한글)는 한 글자
function cutChars(y, a, b) {
  const l = term.buffer.active.getLine(y);
  let n = 0;
  for (let x = a; l && x < b; x++) if (l.getCell(x)?.getWidth()) n++;
  return n;
}
// 화면이 다시 그려질 때까지(조용해진 뒤 40ms, 길어야 400ms)
function cutSettle() {
  return new Promise((done) => {
    let quiet, sub;
    const end = () => { clearTimeout(quiet); clearTimeout(cap); sub?.dispose(); done(); };
    const cap = setTimeout(end, 400);
    sub = term.onWriteParsed(() => { clearTimeout(quiet); quiet = setTimeout(end, 40); });
  });
}
// 잘라낼 글 — 화면 그대로(getSelection)면 접힌 자리마다 줄바꿈·들여쓰기가 끼므로 입력 글로 되돌린다.
// 접힌 자리: 줄이 끝 칸(cols-2)까지 찼으면 단어 중간에서 접힘(이어 붙임), 다음 줄 첫 단어가 이 줄에 안 들어가면 공백에서 접힘,
// 들어가는데 내려갔으면 줄바꿈
function cutText(s, e, start) {
  const b = term.buffer.active, limit = term.cols - 2;
  const slice = (y, a, z) => { const l = b.getLine(y); let t = ''; for (let x = a; l && x < z; x++) { const c = l.getCell(x); if (c?.getWidth()) t += c.getChars() || ' '; } return t; };
  let out = '';
  for (let y = s.y; y <= e.y; y++) {
    const end = cutRowEnd(y);
    out += slice(y, y === s.y ? s.x : start, y === e.y ? e.x : end);
    if (y === e.y) break;
    const next = b.getLine(y + 1);
    let w = 0; // 다음 줄 첫 단어의 칸 수
    while (next && start + w < next.length && next.getCell(start + w)?.getChars().trim()) w += next.getCell(start + w).getWidth() || 1;
    out += end >= limit ? '' : end > start && end + 1 + w > limit ? ' ' : '\n';
  }
  return out;
}
// 키를 많이 한 번에 보내면 CLI 가 나눠 처리해 중간 화면에서 조용해질 수 있다 → 한 번 더 기다린다
async function cutKeys(data) { send({ type: 'input', id: selected, data }); await cutSettle(); if (data.length > 60) await cutSettle(); return cutBox(); }
// del: Backspace/Delete 로 지우기 — 클립보드에 넣지 않는다. 입력칸 글을 지울 수 없는 선택이면 false 를 돌려줘
// 키를 원래대로 CLI 에 보내게 한다(잘라내기는 그때 복사만 하고 true). 확인은 첫 await 전에 끝나 키 처리기가 바로 정한다
function cutSelection(del = false) {
  const sel = term.getSelectionPosition(), text = term.getSelection();
  if (!sel || !text) return false;
  const id = selected;
  // 클립보드는 키 이벤트 안에서(첫 await 전에) 쓴다 — Safari 는 사용자 동작 중에만 허용
  const copyOnly = (why) => { if (del) return false; copySelection(); toast(_t(why)); return true; };
  let box = cutBox();
  if (cutting || !box || termLocked() || !id) return copyOnly('입력칸 밖이라 복사만 했어요');
  // 선택을 입력칸 글자 범위로 줄인다 — 줄 앞 '❯ '·들여쓰기와 줄 끝 빈칸은 빼고, 두 칸 글자의 오른쪽 반에 걸치면 그 글자까지
  let s = { y: sel.start.y, x: Math.max(sel.start.x, box.start) }, e = { y: sel.end.y, x: sel.end.x };
  if (s.x >= cutRowEnd(s.y) && s.y < e.y) s = { y: s.y + 1, x: box.start };
  e.x = Math.min(e.x, Math.max(cutRowEnd(e.y), box.start));
  if (s.y <= box.top || e.y >= box.bottom || (s.y === e.y && s.x >= e.x)) return copyOnly('입력칸 밖이라 복사만 했어요');
  if (!term.buffer.active.getLine(s.y)?.getCell(s.x)?.getWidth()) s.x--;
  if (term.buffer.active.getLine(e.y)?.getCell(e.x)?.getWidth() === 0) e.x++;
  for (let y = s.y; y <= e.y; y++) {
    const line = term.buffer.active.getLine(y)?.translateToString(true) || '';
    if (/\[(Pasted text|Image) #\d+/.test(line)) return copyOnly('붙여넣은 묶음이 있는 줄은 복사만 했어요');
  }
  if (box.cur.y <= box.top || box.cur.y >= box.bottom) return copyOnly('입력칸 밖이라 복사만 했어요');
  if (!del) try { navigator.clipboard.writeText(cutText(s, e, box.start)).catch(() => {}); } catch {}
  term.clearSelection();
  cutting = true;
  return (async () => { try {
    // 입력칸 맨 위 가로선 기준 상대 줄로 다룬다 — 도중에 위쪽 출력이 늘어 화면이 밀려도 맞도록
    const rel = (p, bx) => ({ y: p.y - bx.top, x: p.x });
    const key = (p) => p.y * 10000 + p.x;
    const top0 = box.top, S = rel(s, box), E = rel(e, box);
    const at = (bx, p) => bx && bx.cur.y - bx.top === p.y && bx.cur.x === p.x;
    let cur = rel(box.cur, box), guard = 400;
    const rowEnd = (y) => Math.max(cutRowEnd(y + top0), box.start); // 빈 줄이면 들여쓰기 칸
    const between = (a, b) => { let n = 0; for (let y = a.y; y <= b.y; y++) n += cutChars(y + top0, y === a.y ? a.x : box.start, y === b.y ? b.x : rowEnd(y)); return n; };
    // 줄 끝 칸에 커서가 못 가는 자리(단어 중간 접힘)는 다음 줄 첫 칸이 같은 자리
    const reached = (p) => at(box, p) || (p.x === rowEnd(p.y) && at(box, { y: p.y + 1, x: box.start }));
    // 1) 목표 자리로: 보이는 글자 수만큼 한 번에(접힌 자리를 0 으로 쳐 넘치지 않게), 나머지는 한 칸씩
    const moveTo = async (T) => {
      const fwd0 = key(cur) < key(T), k = fwd0 ? between(cur, T) : between(T, cur);
      if (k) { box = await cutKeys((fwd0 ? '\x1b[C' : '\x1b[D').repeat(k)); if (!box) throw 0; cur = rel(box.cur, box); }
      while (!reached(T)) {
        if (!guard--) throw 0;
        const fwd = key(cur) < key(T);
        box = await cutKeys(fwd ? '\x1b[C' : '\x1b[D');
        if (!box) throw 0;
        const next = rel(box.cur, box);
        if (key(next) === key(cur) || (!reached(T) && (fwd ? key(next) > key(T) : key(next) < key(T)))) throw 0; // 못 가거나 지나침
        cur = next;
      }
      cur = rel(box.cur, box);
    };
    // 2) 선택 반대쪽 끝까지 한 방향으로 가며 누른 수를 센다(= 지울 글자 수). 줄마다 그 줄 글자만큼 한 번에, 줄을 넘는 한 칸은 따로 —
    // 접힌 공백·줄바꿈이면 그 한 칸이 숨은 글자, 단어 중간 접힘이면 옆 줄 글자 하나
    let n = 0;
    if (key(cur) >= key(E)) {
      // 커서가 선택 뒤(보통 맨 끝): 끝 → 시작으로 ← 하며 세고, 그 자리에서 Delete. 커서가 선택 너머로 갔다 오지 않는다
      await moveTo(E);
      while (!at(box, S)) {
        if (!guard--) throw 0;
        const to = cur.y === S.y ? S.x : box.start, m = cutChars(cur.y + top0, to, cur.x);
        if (m) { box = await cutKeys('\x1b[D'.repeat(m)); n += m; if (!at(box, { y: cur.y, x: to })) throw 0; }
        if (cur.y === S.y) break;
        box = await cutKeys('\x1b[D'); n++;
        if (!box || box.cur.y - box.top !== cur.y - 1) throw 0;
        cur = rel(box.cur, box);
      }
      if (!n) throw 0;
      send({ type: 'input', id, data: '\x1b[3~'.repeat(n) });
    } else {
      // 커서가 선택 앞이나 안: 시작 → 끝으로 → 하며 세고, Backspace
      await moveTo(S);
      for (let y = S.y; y <= E.y; y++) {
        const from = y === S.y ? S.x : box.start, last = y === E.y;
        const to = last ? E.x : rowEnd(y), m = cutChars(y + top0, from, to);
        if (m) { box = await cutKeys('\x1b[C'.repeat(m)); n += m; if (!box) throw 0; }
        const nextRow = { y: y + 1, x: box.start };
        if (last) { if (!reached({ y, x: to })) throw 0; break; }
        if (at(box, nextRow)) continue; // 단어 중간에서 접힘 — 이미 다음 줄
        if (!at(box, { y, x: to })) throw 0;
        box = await cutKeys('\x1b[C'); n++;
        if (!at(box, nextRow)) throw 0;
      }
      if (!n) throw 0;
      send({ type: 'input', id, data: '\x7f'.repeat(n) });
    }
  } catch {
    toast(_t(del ? '커서를 옮기지 못해 지우지 못했어요' : '커서를 옮기지 못해 복사만 했어요'));
  } finally { cutting = false; } })(); // 지우기가 끝나면 풀리는 약속 — 덮어쓰기(typeOver)가 기다린다
}
// ---------- 전체 선택 (Ctrl/⌘+A) ----------
// 입력칸에 쓴 글을 화면에서 선택한다 — 그대로 Ctrl+C 복사 · Ctrl+X 잘라내기로 이어진다.
// 입력칸이 아니거나(메뉴·Vim 모드) 비어 있으면(흐린 안내 글만) false → ^A 를 그대로 CLI 로(줄 처음으로)
function selectInput() {
  const box = cutBox();
  if (!box) return false;
  const b = term.buffer.active;
  let first = -1, last = -1;
  for (let y = box.top + 1; y < box.bottom; y++) {
    const l = b.getLine(y);
    for (let x = box.start; l && x < l.length; x++) {
      const c = l.getCell(x);
      if (c?.getChars().trim() && !c.isDim()) { if (first < 0) first = y; last = y; break; }
    }
  }
  if (first < 0) return false;
  const end = cutRowEnd(last);
  term.select(box.start, first, (last - first) * term.cols + end - box.start);
  return true;
}
// 한글 조합 중 Ctrl+A: 바로 선택하면 곧이어 조합 글자가 확정·전송되고, xterm 은 입력이 들어오면 선택을 지운다(onUserInput)
// → 두 번 눌러야 됐다. 조합이 끝나고 CLI 가 그 글자를 다시 그린 뒤 선택한다
async function selectInputAfterIme() {
  for (let t = 0; imeComposing && t < 50; t++) await new Promise((r) => setTimeout(r, 10));
  await cutSettle();
  selectInput();
}
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  // Enter 는 헤더 ⌨ 의 키 세트대로(enterAction) — 업무 지시 입력창과 같은 규칙. 세트 1: Enter 줄바꿈 · Alt(⌥)·Cmd+Enter 제출,
  // 세트 2: Enter 제출 · Shift/Ctrl+Enter 줄바꿈 · Cmd(Alt)+Enter 는 아무 일도 안 함.
  // 줄바꿈은 \n(Ctrl+J)으로 보낸다. 입력창에선 줄바꿈이고 메뉴(권한 확인·선택지)에선 아무 일도 안 해서,
  // 메뉴 확정도 Alt+Enter(\r)로 통일된다. ESC CR 도 줄바꿈이지만 ESC 가 섞여 메뉴에선 위험하다
  // (실측: \n·ESC CR → 입력창 줄바꿈, /model 메뉴 그대로 / \r → 제출·메뉴 확정). 한글 조합 중 Enter 는 조합 확정이라 건드리지 않는다.
  // 직접 보내지 않고 xterm 이 처리하게 둔 뒤 onData 에서 바꾼다 — 이 처리기는 xterm 의 조합 마무리보다 먼저 돌아서,
  // 여기서 바로 보내면 조합 중이던 글자보다 줄바꿈이 먼저 가 글자가 다음 줄로 내려갔다
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
    const act = enterAction(e);
    if (!act) return false;
    enterAs = act === 'send' ? '\r' : '\n';
    return true;
  }
  // 한글 조합 중 보조키(⌘ 등)만 누른 것은 xterm 에 넘기지 않는다. xterm 은 Shift·Ctrl·Alt 만 보조키로 알고 ⌘(Meta)는 몰라서
  // 거기서 조합을 끝난 것으로 보내 버리는데, 입력기는 조합을 계속해 다음 키에 글자가 바뀌면(이→잉) xterm 이 입력칸에 쌓인
  // 글 전체를 다시 보냈다(실측 Safari: '입력입력ㅇ…김잉' 이 통째로 들어감). 조합은 입력기가 끝낼 때(compositionend) 보낸다
  if ((e.isComposing || imeComposing) && IME_MOD_KEYS.includes(e.key)) return false;
  // Safari 의 조합 이벤트 없는 한글은 위 입력 처리기가 보낸다 — xterm 의 229 키 처리(입력칸 비교 전송)까지 돌면 두 번 간다
  if (IS_SAFARI && e.keyCode === 229 && !e.isComposing && !imeComposing) return false;
  const mod = e.ctrlKey || e.metaKey;
  // e.key 가 아니라 물리 키(e.code)로 판정 — 한글 입력 상태면 Ctrl+V 의 key 가 'ㅍ', Ctrl+C 는 'ㅊ' 로 온다
  if (mod && e.code === 'KeyC' && (term.hasSelection() || e.shiftKey || e.metaKey)) { e.preventDefault(); copySelection(); return false; }
  if (mod && e.code === 'KeyV') { typeOver(); return false; } // 기본 paste 이벤트로 넘김 — 선택한 입력칸 글이 있으면 그 자리에 붙여넣기
  // Ctrl/⌘+X: 선택이 있으면 잘라내기(입력칸 밖이면 복사만), 없으면 그대로 CLI 로
  if (mod && e.code === 'KeyX' && term.hasSelection()) { e.preventDefault(); cutSelection(); return false; }
  // Backspace/Delete: 입력칸 글을 선택해 두었으면(Ctrl+A 등) 그 글을 지운다 — 클립보드는 그대로.
  // 입력칸 밖 선택이면 선택만 풀고 키는 원래대로 CLI 로(한 글자 지우기)
  // 글자 키(한글 조합 시작 포함): 선택한 입력칸 글을 지우고 그 자리에 — 키는 그대로 xterm 이 처리하고 보낼 글자는 지울 때까지 붙잡는다
  if (!mod && !e.altKey && (e.key.length === 1 || e.keyCode === 229 || e.key === 'Process') && term.hasSelection()) typeOver();
  if (!mod && !e.altKey && (e.key === 'Backspace' || e.key === 'Delete') && term.hasSelection() && !e.isComposing && !imeComposing) {
    if (cutSelection(true)) { e.preventDefault(); return false; }
    term.clearSelection();
  }
  if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyA') {
    if (e.isComposing || imeComposing || e.keyCode === 229 || Date.now() - imeCompEndAt < 500) { e.preventDefault(); selectInputAfterIme(); return false; }
    if (selectInput()) { e.preventDefault(); return false; }
  }
  return true;
});
// ---------- 파일 첨부 ----------
// 브라우저는 드롭한 파일의 원래 경로를 알 수 없다 → 서버에 올려 data/uploads 에 저장하고 그 경로를 넣는다.
// Claude Code 는 프롬프트의 이미지 경로를 이미지로 첨부하고(터미널에 파일을 끌어다 놓은 것과 같은 방식),
// 그 밖의 파일(html·pdf·txt 등)은 경로 글자로 받아 필요하면 Read 로 읽는다
async function uploadFile(file) {
  const r = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || '') },
    body: file,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(srvText(j.error) || r.status);
  return j.path;
}
const droppedFiles = (dt) => [...(dt?.files || [])];
const isImage = (f) => f.type.startsWith('image/');
function toast(text, ms = 2200) {
  let t = $('#toast');
  if (!t) { t = el('<div id="toast" class="toast"></div>'); document.body.append(t); }
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), ms);
}
// 확인·입력 팝업 — 브라우저 기본 confirm/prompt 대신 화면 가운데 우리 팝업.
// 확인 → true(입력형이면 입력한 글), 취소·Esc·바깥 클릭 → false(입력형이면 null). Enter = 확인(입력형은 Alt/⌘+Enter)
function ask({ title, body = '', ok = _t('확인'), danger = false, input = null }) {
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
      // 입력 칸이 있으면 그 칸의 Enter 처리(onEnterKey, 키 세트대로)가 확인 버튼을 누른다
      else if (e.key === 'Enter' && !e.isComposing && input === null) { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    back.addEventListener('click', onClick);
    back.addEventListener('keydown', onKey, true);
  });
}
async function attachFiles(files, insert) {
  for (const f of files) {
    const img = isImage(f);
    toast(_t(img ? '이미지 첨부 중… {name}' : '파일 첨부 중… {name}', { name: f.name || _t(img ? '클립보드 이미지' : '클립보드 파일') }), 60_000);
    try { insert(await uploadFile(f)); toast(_t(img ? '이미지 첨부됨' : '파일 첨부됨')); }
    catch (err) { toast(_t(img ? '이미지 첨부 실패: {msg}' : '파일 첨부 실패: {msg}', { msg: err.message }), 4000); }
  }
}
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
// 타임라인 썸네일(캡처·결과물·첨부)을 끌 때 싣는 화면 주소. 놓으면 서버가 이 PC 의 파일 경로로 바꿔 경로만 넣는다(다시 올리지 않음)
const THUMB_TYPE = 'application/x-am-file';
const hasThumb = (e) => [...(e.dataTransfer?.types || [])].includes(THUMB_TYPE);
// 드롭 영역 공통: 파일(OS)이나 타임라인 썸네일이 끌려 오면 테두리 강조. onPath: 썸네일을 놓았을 때 받은 경로
function dropZone(zone, onFiles, onPath) {
  const ok = (e) => hasFiles(e) || (onPath && hasThumb(e));
  zone.addEventListener('dragover', (e) => {
    if (!ok(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; zone.classList.add('dropping');
  });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dropping'); });
  zone.addEventListener('drop', async (e) => {
    zone.classList.remove('dropping');
    if (!ok(e)) return;
    e.preventDefault();
    if (hasThumb(e)) {
      const r = await api('/api/file-path', { url: e.dataTransfer.getData(THUMB_TYPE) });
      if (r.path) { onPath(r.path); toast(_t('파일 첨부됨')); }
      return;
    }
    const files = droppedFiles(e.dataTransfer);
    if (files.length) onFiles(files);
  });
}
// 타임라인 썸네일 끌기 시작 — 썸네일은 카드 끌기와 겹치지 않게 draggable=false 로 그려지므로, 누르는 순간 이 칸에서만 끌 수 있게 바꾼다
const THUMB_SEL = '.tl-shot, .tl-doc, .att-img, .att-file, .att-vid';
const thumbUrl = (t) => t.dataset.shot || t.dataset.video || t.getAttribute('href') || t.getAttribute('src') || '';
$('#log').addEventListener('mousedown', (e) => { const t = e.target.closest(THUMB_SEL); if (t) t.draggable = true; }, true);
$('#log').addEventListener('dragstart', (e) => {
  const t = e.target.closest?.(THUMB_SEL);
  if (!t || !thumbUrl(t)) return;
  e.dataTransfer.setData(THUMB_TYPE, thumbUrl(t));
  e.dataTransfer.effectAllowed = 'copy';
  document.body.classList.add('thumb-drag');
});
$('#log').addEventListener('dragend', () => document.body.classList.remove('thumb-drag'));
// 드롭 영역 밖에 파일을 놓으면 브라우저가 그 파일을 열어 화면이 바뀌어 버린다(html 등) → 막고 '놓을 수 없음' 표시
document.addEventListener('dragover', (e) => { if (hasFiles(e) && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
document.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });
// 터미널: 경로를 붙여넣기로 보낸다 (이미지는 Claude 입력칸에 [Image #N] 으로 붙고, 그 밖의 파일은 경로 그대로)
const termInsert = (p) => selected && term.paste(`${p} `);
dropZone($('#term-wrap'), (files) => attachFiles(files, termInsert), termInsert);
// 터미널에서 Ctrl+V 로 클립보드 파일 붙여넣기 — xterm 보다 먼저 가로챈다(텍스트 붙여넣기는 그대로 둔다)
$('#term').addEventListener('paste', (e) => {
  const files = droppedFiles(e.clipboardData);
  if (!files.length) return;
  e.preventDefault(); e.stopImmediatePropagation();
  attachFiles(files, termInsert);
}, true);

$('#term').addEventListener('contextmenu', async (e) => {
  e.preventDefault();
  if (await copySelection()) return;
  try { const text = await navigator.clipboard.readText(); if (text) term.paste(text); } catch {}
});

let fitTimer;
new ResizeObserver(() => { clearTimeout(fitTimer); fitTimer = setTimeout(fitTerm, 60); }).observe($('.term-wrap'));
// 미터(컨텍스트·5시간·주간) 자리: 보통 화면에선 오른쪽 끝 = 터미널 오른쪽 가장자리, 높이 = 역할 이름 줄.
// 터미널 폭은 옆 패널 넓히기·창 크기에 따라 바뀌어 잴 때마다 맞춘다(크게 보기에선 닫기 버튼 왼쪽 — CSS 만으로)
let termAnim = null, revealTimer = 0; // 크게 보기 전환 애니메이션(setTermFull)
function placeMeters() {
  const head = $('.detail-head'), wrap = $('#term-wrap'), name = $('#detail-name'), box = $('#meters');
  if (NARROW.matches) { box.classList.remove('y1', 'y2', 'y3'); return; }
  if (!head || wrap.classList.contains('full') || $('#detail').hidden) return;
  // 크게 보기에서 돌아오는 동안엔 터미널 상자가 transform 으로 줄어드는 중이라 getBoundingClientRect 가 움직이는 값을 준다 —
  // 그 값으로 맞추면 미터가 오른쪽으로 튀었다가 끝나고 돌아왔다. 애니메이션이 끝나면(setTermFull 의 done) 다시 맞춘다
  if (termAnim) return;
  const h = head.getBoundingClientRect(), t = wrap.getBoundingClientRect(), n = name.getBoundingClientRect();
  if (!t.width) return;
  // 좁은 화면에서 옆 패널이 터미널 아래로 내려가면 터미널이 전체 폭이라 오른쪽 버튼과 겹친다 → 버튼 왼쪽까지만
  // 기준은 버튼 묶음의 맨 왼쪽(diff) — 영어처럼 버튼 글자가 길면 diff 가 터미널 오른쪽 끝보다 왼쪽까지 온다
  const btn = $('#btn-diff').getBoundingClientRect();
  const right = Math.min(t.right, btn.left - 14);
  box.style.setProperty('--mt-right', `${Math.max(0, h.right - right)}px`);
  box.style.setProperty('--mt-top', `${n.top - h.top}px`);
  box.style.setProperty('--mt-h', `${n.height}px`);
  // 좁으면 이름을 덮지 않게 단계적으로 양보: 남은 시간(↻) → 라벨 → 미터 전체 (크게 보기의 컨테이너 규칙과 같은 순서)
  const rg = document.createRange();
  rg.selectNodeContents(name);
  const room = right - rg.getBoundingClientRect().right - 16;
  box.classList.remove('y1', 'y2', 'y3');
  for (const c of ['y1', 'y2', 'y3']) {
    if (box.scrollWidth <= room) break;
    box.classList.add(c);
  }
}
new ResizeObserver(() => requestAnimationFrame(placeMeters)).observe($('#term-wrap'));
new ResizeObserver(() => requestAnimationFrame(placeMeters)).observe($('.detail-head'));
// 터미널 칸 수(가로 글자 수)를 고정하고, 공간이 넓으면 글자를 키워 채운다.
// 칸 수가 줄면 화면 위로 밀려난 기록(스크롤백)은 Claude 가 다시 그릴 수 없어서, 넓을 때 줄 끝까지
// 배경을 칠한 줄(diff 등)이 접히며 배경만 남은 조각 줄이 줄무늬처럼 생겼다(실측: 163→101칸에서 125줄).
// 칸 수를 고정하면 접힐 일이 없다. 높이는 줄 수만 바뀌어 문제없음.
const TERM_COLS = 110;
const FONT_MIN = 11, FONT_MAX = 16;
function fitTerm(now = false) {
  if (!selected || $('#detail').hidden) return;
  if (TOUCH) return fitTermTouch();
  try {
    const box = $('#term');
    box.style.width = '';
    // 고정 칸 수가 들어가는 가장 큰 글자 크기. 예전엔 큰 글자부터 하나씩 바꿔 가며 쟀는데, 글자 크기를 바꿀 때마다
    // 터미널 전체를 다시 그려(실측 1회 ~175ms, CPU 4배 느림) 최대 6번이면 워커 선택·크게 보기가 1초 넘게 멈췄다.
    // 칸 너비는 글자 크기에 비례하므로 지금 크기로 한 번 재서 맞는 크기를 계산해 한 번만 바꾸고, 넘치면 한 단계만 더 줄인다
    let dims = fit.proposeDimensions();
    if (!dims) return;
    const cur = term.options.fontSize;
    const want = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.floor((cur * dims.cols) / TERM_COLS)));
    if (want !== cur) { term.options.fontSize = want; dims = fit.proposeDimensions(); }
    if (dims && dims.cols < TERM_COLS && want > FONT_MIN) { term.options.fontSize = want - 1; dims = fit.proposeDimensions(); }
    // 최소 글자로도 안 들어갈 만큼 좁아도 칸 수는 줄이지 않는다 — 터미널을 넓히고 옆으로 밀어 본다(터치 기기와 같은 방식).
    // 칸 수가 바뀌면 Claude 는 보이는 화면만 새 폭으로 다시 그리고 스크롤백은 그대로라, 그 경계에 걸린 표가 두 폭으로
    // 섞여 세로선이 어긋났다(실측 — 되돌려도 남는다). 칸 폭 반올림 때문에 한두 번 더 잰다
    for (let i = 0; i < 4 && dims && dims.cols < TERM_COLS; i++) {
      box.style.width = `${Math.ceil(box.clientWidth * (TERM_COLS + 1) / dims.cols)}px`;
      dims = fit.proposeDimensions();
    }
    if (!dims) return;
    $('#term-wrap').classList.toggle('zoomed', box.style.width !== '');
    const cols = TERM_COLS, rows = dims.rows;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    syncPtySize(now);
  } catch {}
}
// 터치 기기: 워커 터미널(pty) 크기는 건드리지 않는다. 휴대폰 폭(40여 칸)으로 바꾸면 Claude 가 그 폭으로 다시 그려
// PC 로 돌아와도 이미 찍힌 출력이 좁게 접힌 채 남는다 — 그래서 PC 와 같은 110칸으로 받고 화면 쪽에서 맞춘다.
// 확대(기본): 읽기 좋은 크기로 그리고 터미널을 옆으로 밀어 본다 · 맞춤: 110칸이 화면 폭에 다 들어가는 글자 크기(전체 모양 보기). term-keys 🔍 로 전환
const TOUCH_ZOOM_KEY = 'am.termZoom', TOUCH_FONT = { fit: 4, zoom: 11 };
let termZoom = true;
let ptyCols = TERM_COLS; // 워커 터미널(pty)의 지금 칸 수 — 서버가 기록(scrollback)과 크기 변경(ptysize)에 실어 보낸다. 옛 서버면 PC 기본값
try { termZoom = localStorage.getItem(TOUCH_ZOOM_KEY) !== '0'; } catch {}
function fitTermTouch() {
  try {
    const box = $('#term');
    box.style.width = '';
    let dims = fit.proposeDimensions();
    if (!dims) return;
    const cur = term.options.fontSize;
    // 맞춤은 0.5px 단위 — 정수로만 줄이면 휴대폰 폭에선 한 단계 차이로 오른쪽이 크게 빈다
    const want = termZoom ? TOUCH_FONT.zoom : Math.max(TOUCH_FONT.fit, Math.min(FONT_MAX, Math.floor((cur * dims.cols * 2) / ptyCols) / 2));
    if (want !== cur) { term.options.fontSize = want; dims = fit.proposeDimensions(); }
    // 칸이 모자라면 상자를 그만큼 넓힌다(밖은 .term-stage 가 가로 스크롤). 칸 폭 반올림 때문에 한두 번 더 잰다
    for (let i = 0; i < 4 && dims && dims.cols < ptyCols; i++) {
      box.style.width = `${Math.ceil(box.clientWidth * (ptyCols + 1) / dims.cols)}px`;
      dims = fit.proposeDimensions();
    }
    if (!dims) return;
    if (term.cols !== ptyCols || term.rows !== dims.rows) term.resize(ptyCols, dims.rows);
    $('#term-wrap').classList.toggle('zoomed', box.style.width !== '');
  } catch {}
}

// 화면 크기는 바로 맞추되, 워커 터미널(pty) 크기는 아껴서 바꾼다. 줄 수가 늘 때마다 ConPTY 와 Claude 가
// 화면을 다시 그리면서 이미 스크롤백에 올라간 줄을 한 번 더 써서 입력창이 두 벌 남는다
// (실측: 40→65줄 중복 +14줄, 30→65줄 +21줄. 같은 크기·줄어들 때는 0).
// 그래서 보고 있는 탭만 보내고(탭끼리 크기 다툼 방지), 끌기·애니메이션 중에는 멈췄다가 끝난 크기만 보낸다
let ptyTimer;
function syncPtySize(now = false) {
  clearTimeout(ptyTimer);
  if (TOUCH) return; // 터치 기기는 pty 크기를 바꾸지 않는다(fitTermTouch)
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
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); // https 로 열었으면 wss 여야 브라우저가 막지 않는다
  ws.onopen = () => { if (selected) { syncPtySize(true); send(attachMsg(selected)); } chatViewSent = ''; sendChatView(); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'state') {
      const prevWorkers = state.workers;
      state = msg.state; gotState = true; clockSkew = Date.now() - state.now;
      mgrOnState(prevWorkers, state.workers);
      // 주소 #W1 로 열면 해당 워커를 바로 선택
      const h = location.hash.slice(1);
      if (!selected && h && state.workers.some((w) => w.id === h)) { select(h); return; }
      render();
    }
    else if (msg.type === 'fx') mgrOnFx(msg);
    else if (msg.type === 'pty' && msg.id === selected) term.write(recolorTerm(msg.data));
    else if (msg.type === 'ptysize' && msg.id === selected && TOUCH) { ptyCols = msg.cols; fitTerm(); } // PC 에서 터미널 폭이 바뀌면 따라간다
    else if (msg.type === 'scrollback' && msg.id === selected) {
      if (TOUCH) { ptyCols = msg.cols || TERM_COLS; fitTerm(); } // 기록은 pty 폭으로 만들어졌다 — 그 폭으로 받아야 줄이 어긋나지 않는다
      const more = termSnap.loadingFull ? termSnap.fromBottom : null; // 맨 위로 올려 전부 불러온 것 — 보던 줄을 그대로 맨 위에
      termSnap = { id: msg.id, partial: Boolean(msg.partial), loadingFull: false, fromBottom: 0, pending: termSnap.id === msg.id && termSnap.pending };
      term.reset();
      term.write(recolorTerm(msg.data), () => (more == null ? restoreTermScroll(msg.id) : term.scrollToLine(Math.max(0, term.buffer.active.baseY - more))));
    }
    else if (msg.type === 'clearScrollback' && msg.id === selected) term.write('\x1b[3J'); // /clear — 이전 대화 기록만 지움
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
    toast(_t('서버에 연결할 수 없습니다'), 4000);
    return { error: 'network' };
  }
  if (!r.ok) {
    const msg = srvText(data.error) || (r.status === 404 ? _t('서버가 이 기능을 모릅니다 — 서버를 재시작하세요') : _t('요청 실패 ({status})', { status: r.status }));
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
  if (s < 60) return _t('{s}초', { s });
  if (s < 3600) return _t('{m}분 {s}초', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') });
  return _t('{h}시간 {m}분', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
}
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
// 새 기능 점: 새로 생긴 버튼에 처음 누를 때까지 업데이트 버튼과 같은 주황 점을 띄운다. 누른 기능 키는 이 브라우저에 기억(localStorage).
// 새 기능을 넣을 때 newDot(버튼, '키') 한 줄 — 키는 기능마다 한 번 정하면 바꾸지 않는다(바꾸면 다시 뜬다)
const NEW_SEEN_KEY = 'am.newSeen';
const newSeen = (() => { try { return new Set(JSON.parse(localStorage.getItem(NEW_SEEN_KEY) || '[]')); } catch { return new Set(); } })();
function newDot(btn, key) {
  if (!btn || newSeen.has(key)) return;
  const dot = el('<i class="upd-dot new-dot" aria-hidden="true"></i>');
  btn.append(dot);
  btn.addEventListener('click', () => {
    newSeen.add(key);
    try { localStorage.setItem(NEW_SEEN_KEY, JSON.stringify([...newSeen])); } catch {}
    dot.remove();
  }, { once: true, capture: true });
}

// ---------- 렌더 ----------
// 서버는 상세 패널을 연 워커만 타임라인 · 프로필 전부를 싣고 나머지는 가볍게(lite) 보낸다(server.js workerView).
// 막 고른 워커는 서버가 전부를 보내 줄 때까지 잠깐 lite 로 남는다 — 그동안은 지난번에 받은 전체 값을 이어 쓰고, 없으면 빈 타임라인으로.
// 프로필은 null 로 비우지 않고 lite 값을 그대로 둔다 — 비우면 카드의 대기(bgRunning) 상태 · 비용 · ctx 배지가 사라졌다 돌아와 카드가 깜빡였다
let fullOf = null; // { id, log, past, atts, profile } — 마지막으로 받은 연 워커의 전체 값
function fillSelected() {
  const w = selected && state.workers.find((x) => x.id === selected);
  if (!w) return;
  if (!w.lite) { fullOf = { id: w.id, log: w.log, past: w.past, atts: w.atts, profile: w.profile }; return; }
  const f = fullOf?.id === w.id ? fullOf : { log: [], past: [], atts: [], profile: w.profile };
  Object.assign(w, { log: f.log, past: f.past, atts: f.atts, profile: f.profile, lite: false });
}
function render() {
  fillSelected();
  renderStats();
  renderStale();
  renderUpd();
  window.renderDaily?.(); // 하루 요약 카드 도착 띠 · 우편함 버튼 (growth.js)
  window.renderSchedules?.(); // 예약 실행 버튼 · 상세 패널의 이 역할 예약 (schedule.js)
  window.renderDirectives?.(); // 작업 지시 버튼 · 상세 패널의 이 워커 지시 칩 (directives.js)
  window.renderStash?.(); // 알림 보관함 버튼 · 끝난 알림 정리 (stash.js)
  renderInbox();
  renderFloor();
  renderDock();
  renderDetail();
  renderHint();
  mgrUpdate();
}

function pendingCount() {
  const withDecision = new Set(state.decisions.map((d) => d.workerId));
  return state.decisions.length + state.workers.filter((w) => w.status === 'decision' && !withDecision.has(w.id)).length;
}

function renderStale() {
  const stale = $('#stale-bar');
  // 보관함에 넣어 둔 동안은 숨긴다 (stash.js)
  stale.hidden = !(state.serverStale || !('serverStale' in state)) || Boolean(window.isStashed?.('stale'));
}
// 상단 알림 띠 묶음(#top-stack): 헤더 바로 아래에 겹쳐서. 띠가 새로 뜨거나 사라지면 다른 띠는 자리를 밀거나 당기며 미끄러지고(FLIP),
// 새 띠는 위에서 내려오며 나타난다 — 띠를 숨기고 보이는 곳이 여럿이라(renderStale · growth.js renderDaily) hidden 속성 변화를 지켜본다
const topStack = $('#top-stack');
const stackTops = new Map(); // 띠 → 지난번 offsetTop
function renderTopStack() {
  topStack.style.top = `${Math.round($('.topbar').getBoundingClientRect().bottom) + 12}px`;
  for (const bar of topStack.children) {
    if (bar.hidden) { stackTops.delete(bar); continue; }
    const now = bar.offsetTop, before = stackTops.get(bar);
    stackTops.set(bar, now);
    if (before == null) bar.animate([{ opacity: 0, transform: 'translateY(-12px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.3, 1.4, .5, 1)' });
    else if (before !== now) bar.animate([{ transform: `translateY(${before - now}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2, .9, .3, 1)' });
  }
}
new MutationObserver(renderTopStack).observe(topStack, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden'] });
addEventListener('resize', renderTopStack);
renderTopStack();
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
  bar.title = max ? _t('최종 단계 · 누적 {xp} XP', { xp: p.xp.toLocaleString() })
    : `Lv.${p.stage} · ${(p.xp - p.stageMin).toLocaleString()} / ${(p.nextMin - p.stageMin).toLocaleString()} XP (${_t('누적 {xp}', { xp: p.xp.toLocaleString() })})`;
}
function renderStats() {
  renderXpBar();
  renderUsage();
  const n = (st) => state.workers.filter((w) => viewStatus(w) === st).length;
  const pend = pendingCount();
  const html = [
    ['all', '워커', state.workers.filter((w) => w.status !== 'exited').length, 'var(--idle)'],
    ['working', '작업 중', n('working'), 'var(--working)'],
    ['waiting', '백그라운드', n('waiting'), 'var(--waiting)'],
    ['decision', '결정 대기', pend, 'var(--decision)', pend > 0],
    ['done', '완료', n('done'), 'var(--done)'],
    ['checked', '확인됨', n('checked'), 'var(--checked)'],
  ].map(([st, k, v, c, hot]) => `<span class="stat ${hot ? 'hot' : ''}${v ? ' tap' : ''}" style="--c:${c}" data-st="${st}"${v ? ` role="button" title="${_t('누르면 해당 워커 카드가 꿈틀거립니다')}"` : ''}><i></i>${_t(k)} <b>${v}</b></span>`).join('');
  if ($('#stats')._html !== html) $('#stats').innerHTML = $('#stats')._html = html;
  // 매니저 캐릭터: 작업 중이면 흰 빛 맥동 + 걷기, 결정 대기가 있으면 주황 빛
  const busy = n('working');
  const dot = $('.core-dot');
  dot.classList.toggle('busy', busy > 0);
  dot.classList.toggle('alert', pend > 0);
  roamSync(busy > 0);
  const shown = mgrStageSync();
  dot.title = `${_t('매니저 · {busy}명 작업 중', { busy })}${pend ? _t(' · 결정 대기 {n}건', { n: pend }) : ''}${state.progress ? ` · Lv.${shown} · ${_t(NEAR_TEXT[shown < state.progress.stage ? 'near' : state.progress.near])}` : ''}`;
  document.title = pend ? `(${pend}) ${_t('클로드 키우기')}` : _t('클로드 키우기');
  setFavicon(pend > 0);
}

// 상단 상태 버튼: 누르면 그 상태의 워커 카드(최소화 칩 포함)를 꿈틀거리게 — 어느 카드인지 바로 찾게.
// 카드 className 은 렌더마다 통째로 바뀌므로(updateNode) 클래스 대신 Web Animations 로 흔든다
const statWorkers = (st) => {
  if (st === 'all') return state.workers.filter((w) => w.status !== 'exited');
  if (st === 'decision') { const ids = new Set(state.decisions.map((d) => d.workerId)); return state.workers.filter((w) => w.status === 'decision' || ids.has(w.id)); }
  return state.workers.filter((w) => viewStatus(w) === st);
};
function wiggle(elx) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  elx.getAnimations().filter((a) => a.id === 'wiggle').forEach((a) => a.cancel());
  const frames = reduce
    ? [{ filter: 'brightness(1)' }, { filter: 'brightness(1.6)' }, { filter: 'brightness(1)' }]
    : [{ rotate: '0deg' }, { rotate: '-3deg', scale: '1.03' }, { rotate: '3deg' }, { rotate: '-2.5deg' }, { rotate: '2deg' }, { rotate: '-1deg' }, { rotate: '0deg', scale: '1' }];
  elx.animate(frames, { duration: reduce ? 500 : 650, easing: 'ease-in-out', composite: 'add', id: 'wiggle' });
}
$('#stats').addEventListener('click', (e) => {
  const b = e.target.closest('.stat.tap');
  if (!b) return;
  const els = statWorkers(b.dataset.st).flatMap((w) => [...document.querySelectorAll(`.node[data-id="${CSS.escape(w.id)}"], .dchip[data-id="${CSS.escape(w.id)}"]`)])
    .filter((x) => x.offsetParent); // 접혀 숨은 쪽(바닥 · 칩 줄)은 빼고 보이는 것만
  if (!els.length) return;
  const vh = innerHeight;
  if (!els.some((x) => { const r = x.getBoundingClientRect(); return r.bottom > 0 && r.top < vh; })) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  els.forEach(wiggle);
});

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
        <div class="t">${_t('<b>{name}</b> 가 <b>{tool}</b> 권한을 요청합니다', { name: esc(byId[d.workerId]?.name || d.workerId), tool: esc(d.tool) })}<span class="age" data-since="${d.createdAt}"></span></div>
        <code>${esc(detailOf(d))}</code>
      </div>
      <div class="acts">
        <button class="btn allow" data-act="allow">${_t('허용')}</button>
        <button class="btn deny" data-act="deny">${_t('거부')}</button>
        <button class="btn" data-act="deny-msg">${_t('거부 + 사유')}</button>
        <button class="btn ghost" data-act="pass" title="${_t('대시보드 결정을 포기하고 터미널 프롬프트로 넘김')}">${_t('터미널에서')}</button>
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

// 카드 경로는 앞쪽을 줄이려고 오른쪽→왼쪽(rtl)으로 그린다 — 그러면 맨 앞 '/' 가 끝으로 튀어 보여, 왼쪽→오른쪽 표시(LRM)를 앞에 붙인다
const ltrPath = (p) => (p ? `\u200E${p}` : '');

function nodeTemplate() {
  return el(`
    <div class="node">
      <div class="node-head"><span class="led"></span><span class="repo-sw" hidden></span><span class="nid"></span><span class="nname" title="${_t('더블클릭해 이름 변경 · 칩을 끌어 순서 변경')}"></span><span class="pill"></span><button class="node-more" data-act="more" aria-label="${_t('메뉴')}">⋯</button></div>
      <div class="stage"><div class="avatar">${clawdSVG()}</div><div class="fx"><span></span><span></span><span></span><span class="mark"></span></div></div>
      <div class="meta"></div>
      <div class="path-row"><span class="branch" hidden></span><div class="path"></div></div>
    </div>`);
}

// 서버 시각 t 가 지금으로부터 얼마 전인지 짧게 (방금 · 5분 전 · 3시간 전 · 2일 전)
function fmtAgo(t) {
  const m = Math.max(0, Math.floor((Date.now() - (t + clockSkew)) / 60000));
  return m < 1 ? _t('방금') : m < 60 ? _t('{m}분 전', { m }) : m < 1440 ? _t('{h}시간 전', { h: Math.floor(m / 60) }) : _t('{d}일 전', { d: Math.floor(m / 1440) });
}
function socketTemplate() {
  return el(`
    <div class="node socket">
      <div class="node-head"><span class="repo-sw" hidden></span><span class="nid">SLOT</span><span class="nname" title="${_t('더블클릭해 이름 변경 · 칩을 끌어 순서 변경')}"></span><span class="pill">${_t('대기실')}</span><button class="node-more" data-act="more" aria-label="${_t('메뉴')}">⋯</button></div>
      <div class="stage"><div class="avatar">${clawdSVG()}</div></div>
      <div class="path"></div>
      <div class="socket-acts"><button class="btn primary" data-act="launch">${_t('▶ 투입')}</button><button class="btn ghost" data-act="forget" title="${_t('저장된 역할 삭제')}">✕</button></div>
    </div>`);
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
// 보고 있는(선택한) 워커가 끝나도 바로 확인 처리하지 않는다 — 끝난 걸 놓치지 않게 빛이 돌고, 그 워커에 손을 대면(아래 ackSeen) 확인
function isSeenDone(w) {
  if (!w.doneAt) return false;
  return (seenDone[seenKey(w)] || 0) >= w.doneAt;
}
const isUnseenDone = (w) => viewStatus(w) === 'done' && !!w.doneAt;
// 선택해서 터미널을 띄워 둔 워커는 카드·칩 대신 터미널 테두리에 빛이 돈다 — 보고 있는 화면에서 알아채게 (상세 화면은 선택한 워커가 있으면 늘 열려 있다)
const unseenOnCard = (w) => isUnseenDone(w) && w.id !== selected;
// 선택한 워커의 상세 화면(터미널·업무 지시·메모 등)이나 그 카드·칩을 누르거나 그 안에서 키를 치면 완료 확인
function ackSeen(e) {
  if (!selected || $('#detail').hidden) return;
  if (!e.target.closest?.(`#detail, .node[data-id="${selected}"], .dchip[data-id="${selected}"]`)) return;
  const w = state.workers.find((x) => x.id === selected);
  if (!w || !isUnseenDone(w)) return;
  markSeen(w.id);
  render();
}
document.addEventListener('pointerdown', ackSeen, true);
document.addEventListener('keydown', ackSeen, true);

// 역할별 캐릭터 색 — 서버가 역할마다 정해 둔 색상각(0~360, 서로 멀게)을 고른 파스텔 팔레트의 가장 가까운 색으로 바꾼다.
// 예전엔 밝기·채도를 고정한 OKLCH 를 색상각 그대로 써서 색상에 따라 탁하거나 형광처럼 튀었다(연두·청록 등) →
// '클로드 놀이터' 테마 그림의 부드러운 톤(머티리얼 300~400 계열)으로 통일. 저장된 색상각은 그대로라 역할 색이 바뀌어도 순서는 유지
const AVATAR_PALETTE = ['#ff8a65', '#ffb74d', '#ffd54f', '#aed581', '#7ccf8a', '#4db6ac', '#4dd0e1', '#64b5f6', '#7986cb', '#b39ddb', '#f48fb1', '#e57373'];
// sRGB → OKLCH 색상각(도) — 팔레트 색을 색상각 순으로 세워 가장 가까운 것을 찾으려고
function okHue(hex) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16)));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return (Math.atan2(B, A) * 180 / Math.PI + 360) % 360;
}
const AVATAR_HUES = AVATAR_PALETTE.map(okHue);
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
// 역할마다 아직 다른 역할이 안 쓴 팔레트 색 중 색상각이 가장 가까운 것 — 같은 색이 두 역할에 겹치지 않게(먼저 생긴 역할부터).
// 팔레트(12색)보다 역할이 많으면 그때부터는 가장 가까운 색을 함께 쓴다. 역할 색 목록이 바뀔 때만 다시 계산
let avatarMap = { key: '', map: {} };
const avatarColor = (name) => {
  const colors = state.colors || {};
  if (colors[name] == null) return '';
  // 지금 쓰는 역할(떠 있는 워커 · 대기실에 저장된 역할)이 먼저 색을 받는다 — 지난 역할 기록이 좋은 색을 차지하지 않게
  const live = new Set([...(state.workers || []).map((w) => w.name), ...(state.profiles || []).map((p) => p.name)]);
  const key = JSON.stringify(colors) + [...live].join('|');
  if (avatarMap.key !== key) {
    const map = {}, used = new Set();
    const names = Object.keys(colors).sort((a, b) => live.has(b) - live.has(a));
    for (const n of names) {
      const h = colors[n];
      const order = AVATAR_HUES.map((x, i) => i).sort((a, b) => hueGap(AVATAR_HUES[a], h) - hueGap(AVATAR_HUES[b], h));
      const pick = order.find((i) => !used.has(i)) ?? order[0];
      used.add(pick); map[n] = AVATAR_PALETTE[pick];
    }
    avatarMap = { key, map };
  }
  return avatarMap.map[name];
};

function updateNode(node, w) {
  node.style.setProperty('--avatar', avatarColor(w.name) || 'var(--accent)');
  // 이름 변경 중(renaming)·드래그 중(dragging) 표시는 사용자 동작이 붙인 것이라 상태 갱신이 지우면 안 된다 —
  // 지우면 바로 아래에서 이름 글자가 입력창을 덮어써, 다른 워커 활동으로 상태가 올 때마다 입력이 닫혔다
  const keep = ['renaming', 'dragging', 'dropping'].filter((c) => node.classList.contains(c)).map((c) => ` ${c}`).join('');
  node.className = `node s-${viewStatus(w)}${w.id === selected ? ' sel' : ''}${unseenOnCard(w) ? ' unseen' : ''}${keep}`;
  node.title = w.id === selected ? _t('다시 누르면 닫기') : '';
  node.dataset.id = w.id;
  $('.nid', node).textContent = w.id;
  if (!node.classList.contains('renaming')) $('.nname', node).textContent = w.name;
  $('.pill', node).textContent = statusLabel(viewStatus(w));
  const running = w.status === 'working' || w.status === 'decision';
  $('.meta', node).innerHTML =
    (window.roleLevelChip?.(w.name) || '') + // 역할 레벨 (growth.js) — 누르면 성장 기록
    `<span title="${_t(running ? '이번 턴 경과' : '마지막 갱신')}">⏱ <em data-since="${running ? w.turnStartedAt : w.updatedAt}"></em></span>` +
    `<span title="${_t('도구 사용 횟수')}">⚙ ${w.toolCount}</span>` +
    (w.queue.length ? `<span class="q" title="${_t(w.dispatchAt ? '곧 다음 지시 투입' : '대기 중인 지시')}">${w.dispatchAt ? '⏳' : ''}📥 ${w.queue.length}</span>` : '') +
    (w.profile?.turnCount ? `<span title="${_t('추정 비용 (API 환산)')}">$ ${fmtUsd(w.profile.total.cost).slice(1)}</span>` : '');
  // 이번(또는 마지막) 턴에 나온 최근 캡처를 무대 왼쪽 아래에 작게. 주소가 같으면 다시 그리지 않는다(깜빡임 방지)
  const { shot: showShot, doc: showDoc } = recentMedia(w);
  let thumb = $('.card-shot', node);
  if (showShot && thumb?.dataset.shot !== showShot.url) { thumb?.remove(); thumb = el(shotImg(showShot, 'card-shot')); $('.stage', node).append(thumb); }
  if (!showShot && thumb) thumb.remove();
  // 같은 규칙으로 최근 결과물 문서(html·md·pdf·svg·txt·csv·json 등)를 무대 오른쪽 아래에 작은 타일로. 누르면 새 탭
  let tile = $('.card-doc', node);
  const docKey = showDoc && `${showDoc.url}@${showDoc.t}`;
  if (showDoc && tile?.dataset.key !== docKey) { tile?.remove(); tile = el(docTile(showDoc)); tile.dataset.key = docKey; $('.stage', node).append(tile); }
  if (!showDoc && tile) tile.remove();
  const ctx = w.profile ? ctxLevel(w.profile) : { level: 0 };
  node.classList.toggle('ctx-warn', ctx.level > 0);
  let badge = $('.ctx-badge', node);
  if (ctx.level && !badge) { badge = el('<div class="ctx-badge"></div>'); $('.stage', node).append(badge); }
  if (badge) { badge.hidden = !ctx.level; badge.textContent = ctx.level ? `⚠ ctx ${fmtN(w.profile.context)}` : ''; badge.title = ctx.text || ''; }
  $('.path', node).textContent = ltrPath(w.cwd);
  $('.path', node).title = w.cwd;
  setBranch($('.branch', node), w.branch);
}
// 작업 폴더의 git 브랜치(서버가 .git/HEAD 를 읽음) — 브랜치가 아니면(분리된 HEAD) 커밋 앞자리. 저장소가 아니면 숨김
const BRANCH_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.6-2.3 3.1-5.4 4.2"/></svg>';
const branchTitle = (b) => _t(b.detached ? '브랜치 없음(분리된 HEAD) — 커밋 {name}' : 'git 브랜치: {name}', { name: b.name });
function setBranch(elx, b) {
  if (!elx) return;
  elx.hidden = !b;
  if (!b) return;
  const key = `${b.name}|${b.detached}|${LANG}`;
  if (elx.dataset.key === key) return;
  elx.dataset.key = key;
  elx.classList.toggle('detached', b.detached);
  elx.innerHTML = `${BRANCH_SVG}<span>${esc(b.name)}</span>`;
  elx.title = branchTitle(b);
}

// 워커 추가 + 아이콘 — 글자 '+' 는 글꼴마다 기준선이 달라 동그라미 가운데에 맞지 않았다
const PLUS_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
// 카드를 작업 폴더(repo)별로 묶는다 — 워커가 여러 repo 에 섞이면 순서만으로는 어느 repo 워커인지 안 보였다.
// 폴더가 둘 이상일 때만 묶고, 묶음마다 머리줄(이름 · 개수)
const repoKey = (cwd) => (cwd || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
// 머리줄 이름: 폴더 끝 이름이 같은 clone 이 여럿(Merge·Merge-bundle 의 anipang-next-client)이라 다른 묶음과 겹치지 않을 때까지 뒤에서부터 마디를 늘린다.
// 같은 이름이 연달아 겹친 폴더(Merge-sub\anipang-next-client\anipang-next-client)는 한 마디로 친다 — 안 그러면
// 'anipang-next-client/anipang-next-client' 로 끝나 정작 구분되는 Merge-sub 가 빠졌다.
// 셋 이상 마디가 필요하면 가운데는 … 로 줄여 '구분되는 마디/…/끝 이름'만 보인다(전체 경로는 머리줄 title)
function repoLabels(cwds) {
  const segs = new Map(cwds.map((c) => [repoKey(c), (c || '').replace(/[\\/]+$/, '').split(/[\\/]/)
    .filter((s, i, a) => !i || s.toLowerCase() !== a[i - 1].toLowerCase())]));
  const tail = (k, n) => segs.get(k).slice(-n).join('/').toLowerCase();
  const out = new Map();
  for (const k of segs.keys()) {
    const s = segs.get(k);
    let n = 1;
    while (n < s.length && [...segs.keys()].some((o) => o !== k && tail(o, n) === tail(k, n))) n++;
    out.set(k, (n > 2 ? `${s.at(-n)}/…/${s.at(-1)}` : s.slice(-n).join('/')) || _t('폴더 없음'));
  }
  return out;
}
const repoHeadEls = new Map();
// 묶음 보기 켜고 끄기 — 저장한 순서 그대로 보는 게 편한 사람도 있어 고를 수 있게(이 브라우저에만, 기본은 묶음)
const REPO_GROUP_KEY = 'am.repoGroup';
const repoGroupOn = () => { try { return localStorage.getItem(REPO_GROUP_KEY) !== '0'; } catch { return true; } };
// repo 색: 묶음 머리줄·카드 머리·최소화 칩의 네모 표시. 폴더 키 가나다순으로 정해 묶음 순서를 바꿔도 색은 그대로.
// 상태색(초록·호박·빨강·보라 백그라운드 대기)과 겹치지 않는 파랑·자홍·청록·올리브 — 넷을 넘으면 돌아 쓴다
const REPO_COLORS = 4;
// 카드 머리·칩의 네모 — 묶였을 때만 보이고, 칩에는 카드에 붙은 색(--repo)을 그대로 옮긴다
function setRepoSwatch(box, color, label) {
  const sw = $('.repo-sw', box);
  if (!sw) return;
  sw.hidden = !color;
  if (color) { box.style.setProperty('--repo', color); sw.title = label; } else box.style.removeProperty('--repo');
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
  // repo 묶음: 묶음 순서는 그 묶음의 첫 카드 자리(저장된 순서), 묶음 안은 저장된 순서 그대로
  for (const it of items) { it.cwd = it.w ? it.w.cwd : it.p.cwd; it.repo = repoKey(it.cwd); }
  const repos = [...new Set(items.map((i) => i.repo))];
  const grouped = repoGroupOn() && repos.length > 1;
  // 보기 버튼은 폴더가 둘 이상일 때만 — 하나뿐이면 묶을 게 없다
  const gb = $('#btn-floor-group');
  gb.hidden = repos.length < 2;
  gb.setAttribute('aria-pressed', String(repoGroupOn()));
  gb.textContent = _t(repoGroupOn() ? '▦ repo별 묶음' : '☰ 저장 순서');
  gb.title = _t(repoGroupOn() ? '지금: 작업 폴더(repo)별로 묶어 보기 · 누르면 저장한 순서 그대로' : '지금: 저장한 순서 그대로 · 누르면 작업 폴더(repo)별로 묶어 보기');
  if (grouped) items.sort((a, b) => repos.indexOf(a.repo) - repos.indexOf(b.repo));
  const labels = grouped ? repoLabels(repos.map((r) => items.find((i) => i.repo === r).cwd)) : new Map();
  for (const [k, h] of repoHeadEls) if (!labels.has(k)) { h.remove(); repoHeadEls.delete(k); }
  const colorOf = new Map([...labels.keys()].sort().map((k, i) => [k, `var(--repo-${i % REPO_COLORS})`]));
  // 워커마다 가로 차선을 하나씩 쓰므로, 많아지면 코어와 칩 사이 간격을 넓혀 차선 간격을 확보
  $('.core').style.marginBottom = `${Math.max(44, 28 + items.length * 7)}px`;
  const keep = new Set(items.map((i) => i.key));
  for (const [k, n] of nodeEls) if (!keep.has(k)) { n.remove(); nodeEls.delete(k); }

  let prev = null, prevRepo = null;
  const place = (x) => {
    // 순서 유지 (이미 제자리면 옮기지 않아 애니메이션이 끊기지 않음). 드래그 중엔 사용자가 옮긴 자리를 존중
    if (!dragEl) {
      const want = prev ? prev.nextSibling : nodes.firstChild;
      if (want !== x) nodes.insertBefore(x, want);
    }
    prev = x;
  };
  for (const it of items) {
    if (grouped && it.repo !== prevRepo) {
      let h = repoHeadEls.get(it.repo);
      if (!h) {
        h = el(`<div class="repo-head"><span class="repo-sw"></span><b></b><span class="rh-n"></span></div>`);
        h.dataset.repo = it.repo;
        repoHeadEls.set(it.repo, h);
      }
      const mine = items.filter((i) => i.repo === it.repo);
      $('b', h).textContent = labels.get(it.repo);
      $('.rh-n', h).textContent = mine.length;
      h.style.setProperty('--repo', colorOf.get(it.repo));
      h.title = it.cwd || '';
      place(h);
      prevRepo = it.repo;
    }
    let n = nodeEls.get(it.key);
    if (!n) { n = it.w ? nodeTemplate() : socketTemplate(); n.draggable = true; nodeEls.set(it.key, n); }
    n.dataset.name = it.name;
    n.dataset.repo = grouped ? it.repo : ''; // 끌기 제한(같은 묶음 안에서만)은 묶었을 때만
    setRepoSwatch(n, colorOf.get(it.repo), labels.get(it.repo));
    if (it.w) updateNode(n, it.w);
    else {
      n.dataset.profile = it.p.name;
      if (!n.classList.contains('renaming')) $('.nname', n).textContent = it.p.name;
      $('.path', n).textContent = ltrPath(it.p.cwd);
      $('.path', n).title = it.p.cwd;
      // ▶ 투입: 이 역할의 마지막 세션이 남아 있으면 이어서(--resume). Shift+클릭이면 새 세션
      const at = state.resumable?.[it.p.name], lb = $('[data-act="launch"]', n);
      lb.title = at ? _t('마지막 세션({t})을 이어서 시작 · Shift+클릭: 새 세션으로', { t: fmtAgo(at) }) : _t('새 세션으로 시작');
    }
    place(n);
  }
  let empty = $('.empty', nodes);
  if (!items.length && !empty) nodes.append(empty = el(`<div class="empty">${_t('아직 워커가 없습니다. <b>+ 워커 추가</b>로 첫 Claude 를 투입하세요.')}</div>`));
  if (items.length && empty) empty.remove();
  // 맨 끝(마지막 워커 다음 자리)에 '워커 추가' 카드 — .node 가 아니라 순서·회로선·끌기에 끼지 않는다
  let add = $('.node-add', nodes);
  if (!add) add = el(`<button type="button" class="node-add" data-new><span class="na-plus" aria-hidden="true">${PLUS_SVG}</span><b></b><small></small></button>`);
  $('b', add).textContent = _t('워커 추가');
  $('small', add).textContent = _t('역할 이름과 작업 폴더를 정해 투입');
  add.classList.toggle('on', !$('#new-panel').hidden);
  if (nodes.lastElementChild !== add) nodes.append(add);
  layoutRepoGroups();
  tick();
  requestAnimationFrame(drawTraces);
}

// 묶음 배치: 묶음마다 카드 수만큼만 칸을 쓰고, 줄에 남는 칸에 다음 묶음을 옆으로 붙인다(선반 쌓기).
// 카드 1~2장짜리 묶음이 줄마다 하나씩 쌓여 세로로 너무 길어졌다. 카드는 한 그리드(#nodes)의 자식 그대로 두고
// 칸만 지정해서 끌기·회로선·최소화 칩은 그대로 쓴다. 자리는 DOM 순서(머리줄 → 그 묶음 카드)로 매번 다시 계산 —
// 끄는 도중 옮긴 자리, 창 폭이 바뀌어 달라진 열 수도 그대로 반영된다
function layoutRepoGroups() {
  const nodes = $('#nodes'), kids = [...nodes.children], add = $('.node-add', nodes);
  // 열 수는 폭으로 직접 센다(.nodes 의 repeat(auto-fill, minmax(236px, 1fr)) 와 같은 계산). gridTemplateColumns 개수로 세면
  // 지정한 칸이 열 수를 넘었을 때 브라우저가 붙인 암묵 열까지 세어져, 한 번 넘친 배치가 그대로 굳어 기판 밖으로 나갔다
  const gap = parseFloat(getComputedStyle(nodes).columnGap) || 0;
  const cols = Math.max(1, Math.floor((nodes.clientWidth + gap) / (236 + gap)));
  // '워커 추가' 카드는 남는 칸이 있을 때만 — 칸이 꽉 찬 줄 다음에 카드 하나 때문에 한 줄을 통째로 더 쓰게 되면
  // 카드 대신 오른쪽 위 도구 줄의 작은 '+ 워커 추가' 버튼을 띄운다
  const showAdd = (fits) => {
    if (add) add.hidden = !fits;
    $('#btn-floor-add').hidden = fits;
  };
  if (!kids.some((k) => k.classList.contains('repo-head'))) {
    for (const k of kids) k.style.gridRow = k.style.gridColumn = '';
    const n = kids.filter((k) => k.classList.contains('node')).length;
    showAdd(n === 0 || n % cols !== 0);
    return;
  }
  const groups = [];
  for (const k of kids) {
    if (k.classList.contains('repo-head')) groups.push({ head: k, cards: [] });
    else if (k.classList.contains('node') && groups.length) groups.at(-1).cards.push(k);
  }
  // 선반 채우기: 묶음은 들어갈 자리가 있는 가장 앞 선반에 넣는다(first-fit) — 앞 선반의 남는 칸을 비워 두지 않게.
  // 카드가 열 수보다 많은 묶음은 선반 하나를 혼자 쓰고 여러 줄로 내려간다
  const shelves = [];
  for (const g of groups) {
    g.shown = g.cards.length;
    g.w = Math.max(1, Math.min(g.shown, cols));
    let sh = shelves.find((x) => x.used + g.w <= cols);
    if (!sh) shelves.push(sh = { used: 0, deep: 0, groups: [] });
    g.col = sh.used + 1;
    sh.used += g.w;
    sh.deep = Math.max(sh.deep, Math.ceil(g.shown / cols));
    sh.groups.push(g);
  }
  let row = 1;
  for (const sh of shelves) {
    sh.row = row;
    for (const g of sh.groups) {
      g.head.style.gridRow = String(row);
      g.head.style.gridColumn = `${g.col} / span ${g.w}`;
      g.cards.forEach((c, i) => {
        c.style.gridRow = String(row + 1 + Math.floor(i / cols));
        c.style.gridColumn = String(g.col + (i % cols));
      });
    }
    row += 1 + Math.max(1, sh.deep);
  }
  // '워커 추가' 카드: 칸이 남는 첫 선반의 카드 줄 끝. 남는 칸이 없으면 카드 대신 도구 줄 버튼
  const sh = shelves.find((x) => x.used < cols && x.deep <= 1);
  showAdd(!!sh);
  if (add && sh) {
    add.style.gridRow = String(sh.row + 1);
    add.style.gridColumn = String(sh.used + 1);
  }
}

// ---------- 최소화한 회로 기판 (헤더 아래 한 줄) ----------
// 칩은 회로 기판과 같은 항목·순서(대기실 슬롯도 — 흐린 점선 칩에 ▶ 동그라미 버튼). id 별로 한 번 만들고 내용만 갱신 — 캐릭터 애니메이션이 리셋되지 않게.
// 칩도 끌어서 순서를 바꾼다 — 놓으면 회로 기판과 같은 순서(state.order)로 저장된다
const dockEls = new Map();
let dockDrag = null; // 끌고 있는 칩 (아래 '최소화한 칩 끌어서 순서 바꾸기')
function renderDock() {
  // 최소화 중엔 헤더 로고가 매니저 역할 — 작업 중이면 걷고, 결정 대기면 주황 빛, 경험치 구슬도 여기로 (따로 두면 같은 캐릭터가 둘)
  const min = !$('#dock').hidden, mgr = $('.brand-mark'), core = $('.core-dot');
  mgr.classList.toggle('mgr-on', min);
  mgr.classList.toggle('busy', min && core.classList.contains('busy'));
  mgr.classList.toggle('alert', min && core.classList.contains('alert'));
  if (min) mgr.title = core.title; else mgr.removeAttribute('title');
  syncBrandMgr();
  if (!min) return;
  const list = $('#dock-list');
  // 순서는 화면의 카드 순서 그대로 — nodeEls(Map)는 카드를 처음 만든 순서라 끌어 옮긴 순서와 다르다.
  // 키: 워커는 id, 대기실 슬롯은 'P:역할 이름'(nodeEls 와 같은 키)
  const keys = [...$('#nodes').querySelectorAll('.node')].map((n) => (n.classList.contains('socket') ? `P:${n.dataset.profile}` : n.dataset.id))
    .filter((k) => k && nodeEls.get(k));
  for (const [id, c] of dockEls) if (!keys.includes(id)) { c.parentElement.remove(); dockEls.delete(id); }
  let prev = null;
  for (const id of keys) {
    if (id.startsWith('P:')) { prev = renderDockSocket(list, id, prev); continue; }
    const w = state.workers.find((x) => x.id === id);
    if (!w) continue;
    let c = dockEls.get(id);
    // 칩(버튼) 아래에 그 워커의 최근 캡처·문서 썸네일 — 버튼 안에는 링크를 둘 수 없어 칩과 썸네일을 한 칸(.dslot)으로 묶는다
    if (!c) {
      const slot = el(`<div class="dslot"><button class="dchip" draggable="true"><span class="led"></span><span class="repo-sw" hidden></span><span class="avatar">${clawdSVG('head')}</span><span class="dname"></span><span class="dst"></span></button><div class="dthumbs"></div></div>`);
      c = slot.firstChild; dockEls.set(id, c);
    }
    const media = recentMedia(w), thumbs = c.nextElementSibling;
    const mkey = `${media.shot?.url || ''}|${media.doc ? `${media.doc.url}@${media.doc.t}` : ''}`;
    if (thumbs.dataset.key !== mkey) {
      thumbs.dataset.key = mkey;
      thumbs.innerHTML = (media.shot ? shotImg(media.shot, 'dock-shot') : '') + (media.doc ? docTile(media.doc, 'dock-doc') : '');
    }
    const st = viewStatus(w);
    c.className = `dchip s-${st}${w.id === selected ? ' sel' : ''}${unseenOnCard(w) ? ' unseen' : ''}${c.classList.contains('dropping') ? ' dropping' : ''}${c === dockDrag ? ' dragging' : ''}`;
    c.dataset.id = id;
    c.dataset.name = w.name;
    c.style.setProperty('--avatar', avatarColor(w.name) || 'var(--accent)');
    const card = nodeEls.get(id);
    setRepoSwatch(c, card?.style.getPropertyValue('--repo'), $('.repo-sw', card)?.title || '');
    $('.dname', c).textContent = w.name;
    $('.dst', c).textContent = statusLabel(st);
    c.title = _t(w.id === selected ? '{name} · {status} — 다시 누르면 닫기' : '{name} · {status} — 클릭해서 열기', { name: w.name, status: statusLabel(st) });
    // 끄는 중엔 사용자가 옮긴 자리를 존중
    const slot = c.parentElement;
    if (!dockDrag) {
      const want = prev ? prev.nextSibling : list.firstChild;
      if (want !== slot) list.insertBefore(slot, want);
    }
    prev = slot;
  }
  let empty = $('.dock-empty', list);
  if (!dockEls.size && !empty) list.append(el(`<span class="dock-empty">${_t('워커 없음')}</span>`));
  if (dockEls.size && empty) empty.remove();
  // 칩 줄 끝에도 워커 추가(회로 기판의 '워커 추가' 카드와 같은 동작)
  let add = $('.dadd', list);
  if (!add) add = el(`<button type="button" class="dadd" data-new aria-haspopup="dialog">${PLUS_SVG}</button>`);
  add.title = add.ariaLabel = _t('워커 추가');
  add.classList.toggle('on', !$('#new-panel').hidden);
  if (list.lastElementChild !== add) list.append(add);
  dockFade();
}
// 칩 줄 양 끝 흐림: 화면 밖으로 넘친 칩이 있는 쪽만 흐리게 — 스크롤바를 숨겨서(style.css) 옆으로 밀 수 있는지 알 길이 없었다
function dockFade() {
  const d = $('#dock-list');
  d.classList.toggle('fade-l', d.scrollLeft > 2);
  d.classList.toggle('fade-r', d.scrollLeft + d.clientWidth < d.scrollWidth - 2);
}
$('#dock-list').addEventListener('scroll', dockFade, { passive: true });
addEventListener('resize', dockFade);
// 대기실 슬롯 칩: 흐린 점선 칩에 ▶ 투입 버튼. 버튼을 안에 두려고 칩을 <div> 로 만든다
function renderDockSocket(list, key, prev) {
  const p = state.profiles.find((x) => `P:${x.name}` === key);
  let c = dockEls.get(key);
  if (!p) return prev;
  if (!c) {
    const slot = el(`<div class="dslot"><div class="dchip socket" draggable="true"><span class="repo-sw" hidden></span><span class="avatar">${clawdSVG('head')}</span><span class="dname"></span><span class="dst">${_t('대기실')}</span><button class="btn primary dlaunch" data-act="launch" aria-label="${_t('투입')}"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.8v6.4L8.4 5z"/></svg></button></div></div>`);
    c = slot.firstChild; dockEls.set(key, c);
  }
  c.dataset.name = c.dataset.profile = p.name;
  const card = nodeEls.get(key);
  setRepoSwatch(c, card?.style.getPropertyValue('--repo'), $('.repo-sw', card)?.title || '');
  c.classList.toggle('dragging', c === dockDrag);
  $('.dname', c).textContent = p.name;
  const at = state.resumable?.[p.name];
  $('.dlaunch', c).title = _t('투입') + ' · ' + (at ? _t('마지막 세션({t})을 이어서 시작 · Shift+클릭: 새 세션으로', { t: fmtAgo(at) }) : _t('새 세션으로 시작'));
  const slot = c.parentElement;
  if (!dockDrag) {
    const want = prev ? prev.nextSibling : list.firstChild;
    if (want !== slot) list.insertBefore(slot, want);
  }
  return slot;
}
// 칩 ▶ 투입 — 회로 기판의 대기실 카드와 같다(마지막 세션 이어서, Shift+클릭이면 새 세션)
async function launchProfile(name, fresh) {
  const p = state.profiles.find((x) => x.name === name);
  if (!p) return;
  const r = await api('/api/workers', { ...p, resume: !fresh });
  if (!r.id) return;
  select(r.id);
  if (r.resumed) toast(_t('지난 세션을 이어서 시작했어요 — 새로 시작하려면 Shift+클릭'), 3500);
}
$('#dock-list').addEventListener('click', (e) => {
  const c = e.target.closest('.dchip');
  if (!c) return;
  if (c.classList.contains('socket')) { if (e.target.closest('[data-act="launch"]')) launchProfile(c.dataset.profile, e.shiftKey); return; }
  if (c.dataset.id === selected && !$('#detail').hidden) closeDetail(); // 열린 워커의 칩을 다시 누르면 닫기
  else select(c.dataset.id);
});

const FLOOR_MIN_KEY = 'am.floorMin';
function setFloorMin(on) {
  $('#floor').hidden = on;
  $('#dock').hidden = !on;
  try { on ? localStorage.setItem(FLOOR_MIN_KEY, '1') : localStorage.removeItem(FLOOR_MIN_KEY); } catch {}
  renderDock();
  renderHint();
  if (!on) requestAnimationFrame(() => { traceSig = ''; drawTraces(); mgrUpdate(); });
  scheduleSelLink();
}
$('#btn-floor-min').addEventListener('click', () => setFloorMin(true));
$('#btn-floor-group').addEventListener('click', () => {
  try { localStorage.setItem(REPO_GROUP_KEY, repoGroupOn() ? '0' : '1'); } catch {}
  render();
});
$('#btn-dock-expand').addEventListener('click', () => setFloorMin(false));
// 헤더 높이만큼 아래에 붙인다 (헤더가 줄바꿈되면 높이가 바뀜)
new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`)).observe($('.topbar'));

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


// 코어 → 각 칩으로 회로선. 매니저 아래에서 칩 위쪽 가운데로 S 곡선.
let traceSig = '';
function drawTraces() {
  scheduleSelLink();
  const floor = $('#floor');
  const fr = floor.getBoundingClientRect();
  // 매니저 = 흰 클로드 캐릭터. 선은 캐릭터 아래 가장자리에서 출발한다
  // 작업 중엔 캐릭터가 걷기 애니메이션(bob, translateY 0 ↔ -4px)으로 들썩인다. getBoundingClientRect 는
  // 그 순간의 이동까지 반영해서, 다시 그릴 때마다 출발점이 4px 오르내렸다 → 현재 transform 이동분을 빼고 잰다
  const mark = $('.core-mark'), cr = mark.getBoundingClientRect();
  const m = getComputedStyle(mark).transform, ty = m && m !== 'none' ? new DOMMatrixReadOnly(m).m42 : 0;
  const [rx, ry] = roamAt($('.core-dot')); // 산책 중이면 그 이동분도 빼서 선은 제자리에서 출발
  const cx = Math.round(cr.left - rx + cr.width / 2 - fr.left), cy = Math.round(cr.bottom - ty - ry - fr.top + 4);
  // 칩 위치는 레이아웃 좌표(offsetTop/Left)로 잰다. getBoundingClientRect 는 호버·선택 시 떠오르는
  // translateY(-2px) 까지 반영해서, 떠오를 때마다 선 끝이 흔들리고 다시 그려졌다.
  const nr = $('#nodes').getBoundingClientRect();
  const list = [...nodeEls.values()].filter((n) => n.isConnected && n.offsetParent).map((n) => {
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
  // 워커마다 매니저 캐릭터 아래 가장자리에 출발점을 목표 x 순서대로 펼쳐 두고, 칩 위쪽 가운데로 S 곡선.
  // 회로선은 카드·묶음 머리줄 위에 그린다(.traces z-index) — 묶음을 나란히 놓은 뒤로 아랫줄 카드로 가는 선이 윗줄 카드 뒤로 숨어 어느 카드로 가는지 끊겨 보였다
  const targets = list.map((o) => ({ ...o, tx: o.x + Math.round(o.w / 2) })).sort((a, b) => a.tx - b.tx || a.y - b.y);
  const n = targets.length;
  const span = Math.min(cr.width - 16, Math.max(0, (n - 1) * 14));
  targets.forEach((t, i) => {
    t.ax = Math.round(cx - span / 2 + (n > 1 ? (span * i) / (n - 1) : span / 2));
    t.ay = cy;
  });
  const routes = targets.map((t) => {
    const ey = t.y - 7, k = Math.max(20, Math.round((ey - t.ay) / 2));
    return { ...t, pts: [[t.ax, t.ay], [t.tx, ey]], d: `M${t.ax} ${t.ay} C${t.ax} ${t.ay + k} ${t.tx} ${ey - k} ${t.tx} ${ey}` };
  });
  const svg = routes.map((o) => {
    const cls = o.st === 'socket' ? 't-socket' : `t-${o.st}`;
    const end = o.pts.at(-1);
    return `<g class="${cls}"><path class="base" d="${o.d}"/><path class="flow" d="${o.d}"/>${o.st === 'working' ? electric(o.d) : ''}` +
      `<circle class="pad" cx="${o.ax}" cy="${o.ay}" r="2"/><circle class="pad" cx="${end[0]}" cy="${end[1]}" r="3.5"/></g>`;
  }).join('');
  $('#traces').innerHTML = ELECTRIC_DEFS + svg;
}

// 폭이 바뀌면 그리드 열 수가 달라져 묶음 배치(layoutRepoGroups)도 다시 계산
new ResizeObserver(() => requestAnimationFrame(() => { layoutRepoGroups(); drawTraces(); })).observe($('#floor'));

// 선택한 워커 카드 → 아래 상세 패널(CLI 가 든 카드) 위쪽 가운데로 워커 색 연결선 — 어느 카드의 터미널을 보고 있는지 한눈에.
// 카드 영역(#floor)과 상세 패널은 따로 놓인 형제라 #traces 에 못 그리고, 페이지 좌표의 오버레이(body 아래 #sel-link)에 그린다.
// 반투명 곡선으로 다른 UI 위를 그대로 가로지른다. 최소화 중엔 칩에서 출발. 크게 보기·카드 끄는 중엔 숨김
const selLink = document.body.appendChild(Object.assign(document.createElementNS('http://www.w3.org/2000/svg', 'svg'), { id: 'sel-link' }));
selLink.setAttribute('class', 'sel-link');
selLink.setAttribute('aria-hidden', 'true');
var selLinkRaf = 0, selLinkSig = ''; // var: 이 줄보다 먼저 도는 초기화(setFloorMin·renderDetail)에서도 부를 수 있게
function scheduleSelLink() { if (!selLinkRaf) selLinkRaf = requestAnimationFrame(() => { selLinkRaf = 0; drawSelLink(); drawDockTraces(); }); }
// 최소화 중엔 헤더 로고가 매니저다 — 바닥의 회로선(drawTraces)처럼 매니저에서 칩 줄의 워커 칩으로 선을 잇는다(선마다 다른 높이의 차선).
// 헤더 · 칩 줄은 붙박이(sticky)라 화면 좌표로 그리는 고정 SVG 하나(#dock-traces, 헤더 위)에 그린다.
// 칩 줄이 가로로 굴러 줄 밖으로 밀린 칩은 뺀다. 선 모양 · 상태 색은 바닥 회로선과 같은 .traces 규칙
const dockTraces = el('<svg class="traces dock-traces" id="dock-traces" aria-hidden="true"></svg>');
document.body.append(dockTraces);
let dockTraceSig = '';
function drawDockTraces() {
  const mark = $('.brand-mark');
  // 아무 워커도 움직이지 않으면(작업 중 · 백그라운드 · 결정 대기 없음) 선을 그리지 않는다 — 헤더 아래가 늘 선으로 덮여 있지 않게
  const busy = state.workers.some((w) => ['working', 'waiting', 'decision'].includes(viewStatus(w))) || state.decisions.length > 0;
  const on = busy && $('#floor').hidden && mark?.classList.contains('mgr-on') && !document.body.classList.contains('term-full');
  const lr = on && $('#dock-list').getBoundingClientRect();
  const chips = on ? [...document.querySelectorAll('#dock-list .dchip')].map((c) => {
    const r = c.getBoundingClientRect(), w = state.workers.find((x) => x.id === c.dataset.id);
    return { tx: Math.round(r.left + r.width / 2), ty: Math.round(r.top) - 1, st: c.classList.contains('socket') ? 'socket' : w ? viewStatus(w) : 'socket' };
  }).filter((o) => o.tx >= lr.left + 6 && o.tx <= lr.right - 6) : [];
  const mr = on && mark.getBoundingClientRect();
  const sig = chips.length ? `${Math.round(mr.left)},${Math.round(mr.bottom)}|` + chips.map((o) => `${o.tx},${o.ty},${o.st}`).join('|') : '';
  if (sig === dockTraceSig) return;
  dockTraceSig = sig;
  if (!sig) { dockTraces.innerHTML = ''; return; }
  // 선마다 곡선으로 그으면 좁은 띠(약 29px)에서 긴 가로선이 같은 높이로 겹쳐 읽기 어려웠다 → 선마다 자기 차선(높이)을 준다.
  // 로고 아래에서 내려와 자기 차선을 따라 가로로 가다 칩 위로 꺾여 내려간다. 서로 건너지 않게,
  // 먼 칩일수록 출발점은 오른쪽 · 차선은 위(로고 쪽), 가까운 칩일수록 출발점은 왼쪽 · 차선은 아래(칩 쪽)
  chips.sort((a, b) => a.tx - b.tx);
  const n = chips.length, cx = mr.left + mr.width / 2, ay = Math.round(mr.bottom) + 1;
  const top = Math.min(...chips.map((o) => o.ty)), lo = ay + 4, hi = top - 4;
  const gap = n > 1 ? Math.min(5, (hi - lo) / (n - 1)) : 0, span = Math.min(mr.width - 6, (n - 1) * 5);
  dockTraces.innerHTML = chips.map((o, i) => {
    const ax = Math.round(cx - span / 2 + (n > 1 ? (span * i) / (n - 1) : span / 2));
    const ly = Math.round(n > 1 ? hi - (hi - lo - gap * (n - 1)) / 2 - gap * i : (lo + hi) / 2); // i 가 클수록(먼 칩) 위 차선
    // 꺾이는 두 모서리는 둥글게(반지름 최대 5px — 차선 · 세로 길이가 짧으면 그만큼 줄인다)
    const sx = Math.sign(o.tx - ax) || 1, r = Math.max(0, Math.min(5, ly - ay, o.ty - ly, Math.abs(o.tx - ax) / 2));
    const d = `M${ax} ${ay} V${ly - r} Q${ax} ${ly} ${ax + sx * r} ${ly} H${o.tx - sx * r} Q${o.tx} ${ly} ${o.tx} ${ly + r} V${o.ty}`;
    return `<g class="${o.st === 'socket' ? 't-socket' : `t-${o.st}`}"><path class="base" d="${d}"/><path class="flow" d="${d}"/><circle class="pad" cx="${o.tx}" cy="${o.ty}" r="2.5"/></g>`;
  }).join('');
}
function drawSelLink() {
  const detail = $('#detail'), min = $('#floor').hidden;
  // 최소화 중엔 칩 줄(#dock — 헤더 아래 붙박이)의 선택 칩에서 출발
  const from = selected && (min ? $(`#dock-list .dchip[data-id="${selected}"]`) : $(`#nodes .node[data-id="${selected}"]`));
  const pts = from && !detail.hidden && !document.body.classList.contains('term-full') && (min ? dockLinkPoints(from) : cardLinkPoints(from));
  if (!pts) {
    if (selLinkSig) { selLink.innerHTML = ''; selLinkSig = ''; }
    return;
  }
  const color = from.style.getPropertyValue('--avatar');
  const sig = `${color}|${pts.join(';')}`;
  if (sig === selLinkSig) return;
  selLinkSig = sig;
  if (color) selLink.style.setProperty('--avatar', color); else selLink.style.removeProperty('--avatar');
  selLink.classList.toggle('on-dock', min);
  // 위아래로 늘어진 S 곡선 (다른 UI 를 피하지 않고 가로지름)
  const [start, end] = pts, k = Math.max(24, Math.abs(end[1] - start[1]) / 2);
  const d = `M${start[0]} ${start[1]} C${start[0]} ${start[1] + k} ${end[0]} ${end[1] - k} ${end[0]} ${end[1]}`;
  selLink.innerHTML = `<path class="base" d="${d}"/><path class="flow" d="${d}"/><circle cx="${start[0]}" cy="${start[1]}" r="3"/><circle cx="${end[0]}" cy="${end[1]}" r="3"/>`;
}
// 상세 패널(CLI 가 든 카드) 위쪽 가장자리 가운데 (페이지 좌표). top 은 패널 위 가장자리(화면 좌표)
function linkTarget() {
  const dr = $('#detail').getBoundingClientRect();
  return { x: Math.round(dr.left + dr.width / 2 + scrollX), y: Math.round(dr.top + scrollY), top: dr.top, l: dr.left + scrollX, r: dr.right + scrollX };
}
function cardLinkPoints(card) {
  const t = linkTarget();
  // 선택 카드는 translateY(-2px) 로 떠 있다(호버도) — 이동분을 빼고 레이아웃 자리로 잰다(회로선과 같은 이유)
  const m = getComputedStyle(card).transform, ty = m && m !== 'none' ? new DOMMatrixReadOnly(m).m42 : 0;
  const cr = card.getBoundingClientRect();
  return [[Math.round(cr.left + cr.width / 2 + scrollX), Math.round(cr.bottom - ty + scrollY + 12)], [t.x, t.y]]; // 선택 표시 막대(::after, 아래 9px) 밑에서
}
// 칩 줄은 페이지를 굴려도 헤더 아래 붙어 있다 — 선택 칩 아래 가장자리에서 출발(칩 줄 위로 그리게 .on-dock).
// 칩이 줄 밖으로 밀려 안 보이거나, 패널을 올려 칩 줄 밑으로 들어갔으면 숨김
function dockLinkPoints(chip) {
  const cr = chip.getBoundingClientRect(), lr = $('#dock-list').getBoundingClientRect(), dk = $('#dock').getBoundingClientRect(), t = linkTarget();
  const cx = cr.left + cr.width / 2;
  if (cx < lr.left || cx > lr.right || t.top < dk.bottom + 14) return null;
  // 도착점은 패널 위 가장자리 가운데가 아니라 출발점에서 가운데 쪽으로 1cm(≈38px)만 비켜난 곳 — 칩 줄과 패널이 붙어 있어
  // 가운데까지 비스듬히 가로지르면 선이 길게 눕는다. 가운데가 1cm 보다 가까우면 가운데.
  // 칩이 패널 폭 밖(패널이 좁아 한쪽에 있을 때)이면 가까운 쪽 모서리에서 1cm 안쪽 — 출발점 기준이면 패널 밖 허공에서 끝났다
  const x = cx + scrollX, from = Math.min(Math.max(x, t.l), t.r), ex = from + Math.sign(t.x - from) * Math.min(38, Math.abs(t.x - from));
  return [[Math.round(x), Math.round(cr.bottom + scrollY)], [Math.round(ex), t.y]]; // 칩 아래 가장자리에 맞닿게
}
for (const sel of ['#floor', '#detail', '#hint']) { const n = $(sel); if (n) new ResizeObserver(scheduleSelLink).observe(n); }
new ResizeObserver(scheduleSelLink).observe(document.body);
window.addEventListener('resize', scheduleSelLink);
// 최소화 중엔 칩 줄이 붙박이라 페이지를 굴리면 선이 따라가야 한다(펼친 상태는 둘 다 페이지와 함께 움직여 그대로)
window.addEventListener('scroll', () => { if ($('#floor').hidden) scheduleSelLink(); }, { passive: true });
$('#dock-list').addEventListener('scroll', scheduleSelLink, { passive: true });

// ---------- 빈 자리 안내 ----------
// 워커를 열지 않았으면 아래가 비어 보인다 — 살아 있는 워커가 없으면 만들기를, 있으면 카드 누르기를 권한다.
// 그림 애니메이션이 매번 처음부터 시작하지 않게 종류가 바뀔 때만 다시 그린다
const CURSOR_SVG = '<svg class="hint-cursor" viewBox="0 0 12 18" shape-rendering="crispEdges"><path d="M1 1 L1 15 L4.5 11.5 L7 17 L9 16 L6.5 10.5 L11 10.5 Z"/></svg>';
function renderHint() {
  const box = $('#hint');
  box.hidden = !gotState || !$('#detail').hidden; // 상태가 오기 전엔 워커가 있는지 몰라 그리지 않는다
  if (box.hidden) return;
  const live = state.workers.some((w) => w.status !== 'exited');
  const min = !$('#dock').hidden, kind = live ? 'click' : 'create';
  if (box.dataset.kind === `${kind}|${min}`) return;
  box.dataset.kind = `${kind}|${min}`;
  box.innerHTML = kind === 'create'
    ? `<div class="hint-art create"><span class="hint-slot"><span class="avatar">${clawdSVG()}</span></span><span class="hint-plus">+</span></div>
       <h2>${_t('워커를 생성해보세요!')}</h2>
       <p>${state.profiles.length ? _t('대기실 카드의 <b>▶ 투입</b>이나 ') : ''}${_t('<b>+ 워커 추가</b>로 첫 Claude 를 투입하면 여기서 터미널·Tasks·타임라인을 볼 수 있어요.')}</p>
       <button class="btn primary" data-hint="new">${_t('+ 워커 추가')}</button>`
    : `<div class="hint-art click"><span class="avatar">${clawdSVG()}</span><span class="hint-ring"></span>${CURSOR_SVG}</div>
       <h2>${_t('워커를 클릭해보세요!')}</h2>
       <p>${_t(min ? '위의 워커 칩을 누르면 여기에 그 워커의 터미널·Tasks·타임라인이 열려요.' : '위의 워커 카드를 누르면 여기에 그 워커의 터미널·Tasks·타임라인이 열려요.')}</p>`;
}
$('#hint').addEventListener('click', (e) => { if (e.target.closest('[data-hint="new"]')) toggleNewPanel(); });

// ---------- 상세 ----------
// 대기열 머리줄 — 투입 대기 남은 초·자동 투입 꺼짐
// 대기열 ↩ 되돌리기·✕ 빼기 아이콘 — 메모 카드의 수정·보내기와 같은 버튼 모양(.memo-ic)
const UNDO_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const QH_SEND = () => ` <button data-resume title="${_t('맨 위 지시를 지금 투입')}">${_t('▶ 1번 보내기')}</button>`;
function queueHead(w) {
  const n = w.queue.length, idle = !['working', 'decision'].includes(w.status);
  if (w.dispatchAt) return `<div class="qh held soon" title="${_t('보내지 않으려면 위의 자동 투입 체크를 해제하세요')}">${_t('{s}초 뒤 1번 투입 · 대기 {n}건', { n, s: `<span class="cd" data-at="${w.dispatchAt}"></span>` })}</div>`;
  if (state.manualQueue?.[w.name]) return `<div class="qh held" title="${_t('자동 투입이 꺼져 있어 ▶ 를 눌러야 한 건씩 투입됩니다')}">${_t('자동 투입 꺼짐 · 대기 {n}건', { n })}${idle ? QH_SEND() : ''}</div>`;
  return `<div class="qh held calm" title="${_t('현재 턴이 끝나면 위에서부터 투입')}">${_t('대기 중인 지시 {n}건', { n })}</div>`;
}
// 투입 대기 남은 초 — 상태가 안 바뀌어도 매초 줄어들게(새로 그린 직후에도 비지 않게 renderDetail 끝에서도 부른다)
function tickQueueCountdown() {
  for (const c of document.querySelectorAll('#queue .cd')) c.textContent = Math.max(0, Math.ceil((Number(c.dataset.at) + clockSkew - Date.now()) / 1000));
}
setInterval(tickQueueCountdown, 250);
function renderDetail() {
  const w = state.workers.find((x) => x.id === selected);
  const wasHidden = $('#detail').hidden;
  $('#detail').hidden = !w;
  if (!w) $('#att-tab').hidden = true;
  scheduleSelLink();
  $('#term-wrap').classList.toggle('unseen', Boolean(w && isUnseenDone(w))); // 확인 안 한 완료 빛 — 카드 대신 여기(unseenOnCard)
  $('#term-boot').hidden = !termLocked();
  // 종료된 워커는 PTY 호스트에 화면이 없어 빈 터미널에 커서만 보였다 — 종료 안내로 덮고, 중단 버튼은 감춘다
  $('#term-gone').hidden = !(w && w.status === 'exited');
  $('#btn-interrupt').hidden = Boolean(w && w.status === 'exited');
  if (!w) return;
  if (wasHidden) requestAnimationFrame(() => { fitTerm(); placeMeters(); });
  else if ($('#detail-name').textContent !== w.name) requestAnimationFrame(placeMeters); // 다른 워커로 바꾸면 이름 폭이 달라진다
  $('#term-wrap').style.setProperty('--avatar', avatarColor(w.name) || 'var(--accent)'); // 터미널 테두리 = 워커 색
  $("#detail-name").textContent = w.name; // 상태는 카드 배지·LED 로 보인다
  // 경로는 막대가 좁아 빼고 툴팁으로 — 브랜치까지만 줄에
  const metaHtml = [w.id, w.model, w.permissionMode, w.sessionId && `session ${w.sessionId.slice(0, 8)}`, w.pid && `pid ${w.pid}`].filter(Boolean).map(esc)
    .concat(w.branch ? [`<span class="branch${w.branch.detached ? ' detached' : ''}" title="${esc(branchTitle(w.branch))}">${BRANCH_SVG}<span>${esc(w.branch.name)}</span></span>`] : []).join(' · ');
  const meta = $('#detail-meta');
  if (meta._html !== metaHtml) meta.innerHTML = meta._html = metaHtml;
  meta.title = w.cwd || ''; // 경로는 줄에서 빼고(브랜치까지만) 마우스를 올리면 보이게
  renderMemos(w);
  $('#auto-queue').checked = !state.manualQueue?.[w.name];
  const queueEl = $('#queue');
  const queueHtml = w.queue.length ? queueHead(w) +
      w.queue.map((q, i) => `<div class="qi"><span class="n">${i + 1}</span><span class="tx"><span class="qt">${esc(q)}</span>${attachChips(q, 'sm')}</span><button class="btn mini ghost memo-ic" data-tomemo="${i}" title="${_t('Backlog 로 되돌리기')}" aria-label="${_t('Backlog 로 되돌리기')}">${UNDO_SVG}</button><button class="btn mini ghost memo-ic" data-unqueue="${i}" title="${_t('큐에서 빼기')}" aria-label="${_t('큐에서 빼기')}">${X_SVG}</button></div>`).join('')
    : '';
  // 상태가 올 때마다 통째로 바꾸면 썸네일이 다시 로드되고 누르는 중인 타일이 사라진다 → 바뀐 때만
  if (queueEl._html !== queueHtml) { queueEl.innerHTML = queueEl._html = queueHtml; tickQueueCountdown(); }
  const fmt = (t) => fmtDate(t + clockSkew, TIME_HMS);
  timelineCache = timelineRows(w.log, w.shots, w.docs, w.past);
  // CLI 처럼 아래로 갈수록 최신. 맨 아래를 보고 있었거나 워커를 바꿨으면 새 줄을 따라 내려가고,
  // 위로 올려 지난 기록을 보는 중이면 그 자리를 지킨다
  const logEl = $('#log');
  const html = timelineCache.map((r, i) =>
    `<li class="k-${r.kind}${r.past ? ' past' : ''}" data-i="${i}"${r.kind === 'req' ? ` title="${_t('클릭: 터미널에서 이 요청 위치로 이동')}"` : ''}><time>${fmt(r.t)}</time>${r.tag ? `<span class="tag">${r.tag}</span>` : ''}${esc(r.text)}${r.shot ? shotImg(r.shot, 'tl-shot') : ''}${r.doc ? docCard(r.doc) : ''}${r.kind === 'req' || r.kind === 'queued' || r.kind === 'unqueued' ? attachChips(r.text, 'md') : ''}</li>`).join('');
  if (logEl._html !== html || logEl.dataset.w !== w.id) { // 브라우저가 innerHTML 을 정규화하므로 보낸 글로 비교
    const stick = logEl.dataset.w !== w.id || logEl._atBottom !== false;
    logEl.dataset.w = w.id;
    logEl.innerHTML = logEl._html = html;
    pinFor = null; // 줄을 새로 그렸으니 고정 줄도 새 요소 기준으로
    logEl._settling = true;
    afterFrame('log', () => {
      if (stick) logEl.scrollTop = logEl.scrollHeight;
      logEl._settling = false;
      if (stick) logEl._atBottom = true;
      updatePin();
    });
    markGoneSoon();
  }
  renderAttTab(w);
  // 워커를 바꾼 직후엔 프로파일(차트 · 턴 표 · 숫자 애니메이션, 실측 30~60ms)을 첫 화면이 그려진 뒤로 미룬다 — 채팅 · 타임라인이 먼저 보이게
  if (profileWid === w.id) renderProfile(w);
  else { profileWid = w.id; afterFrame('profile', () => setTimeout(() => { const cur = state.workers.find((x) => x.id === selected); if (cur) renderProfile(cur); }, 0)); }
  renderDiffButton(w);
  syncChat(w);
  // 접은 영역 제목줄에 건수를 보여 준다 (펼쳐 있으면 안에 보이므로 비움)
  const memoN = (state.memos?.[w.name] || []).length;
  setSecCount('sec-task', w.queue.length ? _t('대기 {n}', { n: w.queue.length }) : '');
  setSecCount('sec-memo', memoN ? _t('{n}건', { n: memoN }) : '');
}

// 상세 패널 위에 걸린 탭: 워커가 만든 결과물(w.docs) · 도구 캡처(w.shots) · 요청에 붙은 입력 첨부를 세 묶음으로 한 줄에 — 다른 로그 사이에서 찾느라 스크롤하지 않게.
// 첨부는 서버가 자르기 전에 따로 모은 w.atts(최근 100개, /clear 때 비움)가 본체이고, 그 기능 전에 쌓인 타임라인 · 지난 요청 글도 함께 읽는다.
// 바뀐 때만 다시 그린다(썸네일 다시 로드 방지)
function renderAttTab(w) {
  const seen = new Set(), items = [];
  // 끌어 넣은 경로도 가리키는 것에 따라 나눈다: /shots/ = 캡처, /docs/ = 결과물, 나머지(업로드) = 입력
  const catOf = (url) => url.startsWith('/shots/') ? 'shot' : url.startsWith('/docs/') ? 'doc' : 'in';
  const add = (t, text, clipped) => { for (const f of uploadsIn(text, clipped)) if (!seen.has(f.url)) { seen.add(f.url); items.push({ t, cat: catOf(f.url), html: attTile(f) }); } };
  for (const a of [...(w.atts || [])].reverse()) add(a.t, a.ref, false); // 최신부터 — 같은 파일은 가장 최근 시각 하나만
  for (const r of timelineCache) {
    if (r.kind !== 'req' && r.kind !== 'queued' && r.kind !== 'unqueued') continue;
    add(r.t, r.text, true);
  }
  // 도구 결과 캡처(w.shots, 최근 50장 · /clear 때 비움)도 섞는다 — 점선 테두리로 첨부와 구분, 누르면 같은 워커 캡처끼리 넘겨 보기
  for (const sh of w.shots || []) {
    if (seen.has(sh.url)) continue;
    seen.add(sh.url);
    const cap = [_t('📷 캡처'), sh.tool, sh.arg].filter(Boolean).join(' · ');
    items.push({ t: sh.t, cat: 'shot', html: shotImg(sh, 'att-img att-shot').replace('<img ', `<img onerror="this.remove()" `).replace(/title="[^"]*"/, `title="${esc(cap)}&#10;${_t('클릭해 크게 보기')}"`) });
  }
  // 결과물은 이름이 보이게 파일 타일 모양으로 — 여는 방식(크게 보기 · 새 탭)은 카드 · 타임라인과 같은 docImgAttr
  for (const d of w.docs || []) {
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    const ext = d.name.split('.').pop().toLowerCase();
    items.push({ t: d.t, cat: 'doc', html: `<a class="att-doc" href="${esc(d.url)}" target="_blank" rel="noopener" draggable="false"${docImgAttr(d, ext)} title="${_t('결과물')} · ${esc(d.title ? `${d.title}
` : '')}${esc(d.name)}&#10;${docOpenHint(IMG_DOC.has(ext) || VID_DOC.has(ext) || TXT_DOC.has(ext))}"><span class="ic">${DOC_ICON[ext] || '📄'}</span><span class="nm">${esc(d.name)}</span></a>` });
  }
  items.sort((a, b) => b.t - a.t);
  const tab = $('#att-tab'), box = $('#att-tab-list');
  tab.hidden = !items.length;
  // 결과물 · 캡처 · 입력 순으로 묶음마다 이름과 개수, 묶음 안은 최신 것부터. 빈 묶음은 뺀다
  const html = [['doc', '결과물'], ['shot', '캡처'], ['in', '입력']].map(([cat, label]) => {
    const g = items.filter((x) => x.cat === cat);
    return g.length ? `<span class="att-grp" data-cat="${cat}"><span class="att-grp-h">${_t(label)} <b>${g.length}</b></span><span class="att att-sm">${g.map((x) => x.html).join('')}</span></span>` : '';
  }).join('');
  if (box._html !== html) box.innerHTML = box._html = html;
}

// 첨부 탭의 이미지(입력 · 캡처 · 그림 결과물)에 마우스를 올리면 크게 본 모습을 툴팁처럼 띄운다.
// 탭은 상세 패널 위에 걸려 있어 위쪽이 넉넉하다 — 타일 위에, 모자라면 아래에. 설명(원래 title)은 그림 밑에 옮겨 브라우저 툴팁과 겹치지 않게
const attPeek = el('<div class="att-peek" hidden><img alt=""><div class="cap"></div></div>');
document.body.append(attPeek);
const peekHide = () => { attPeek.hidden = true; attPeek._for = null; };
$('#att-tab-list').addEventListener('mouseover', (e) => {
  const t = e.target.closest('img.att-img, a.att-doc[data-img]');
  if (!t || t === attPeek._for) return;
  if (t.title) { t.dataset.cap = t.title; t.removeAttribute('title'); }
  attPeek._for = t;
  const img = $('img', attPeek), src = t.tagName === 'IMG' ? t.currentSrc || t.src : t.href;
  $('.cap', attPeek).textContent = (t.dataset.cap || '').split('\n')[0];
  const place = () => {
    if (attPeek._for !== t) return;
    // 워커 카드를 최소화했으면 탭이 화면 위쪽에 붙어 위가 상단바뿐이다 — 늘 아래로, 남은 높이에 맞춰 그림을 줄인다
    const below = $('#floor').hidden, r0 = t.getBoundingClientRect();
    $('img', attPeek).style.maxHeight = below ? `${Math.max(120, Math.min(600, innerHeight - r0.bottom - 60))}px` : '';
    attPeek.hidden = false;
    const r = r0, pr = attPeek.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - pr.width - 8, r.left + r.width / 2 - pr.width / 2));
    const top = below ? r.bottom + 10 : r.top - pr.height - 10 >= 8 ? r.top - pr.height - 10 : Math.min(innerHeight - pr.height - 8, r.bottom + 10);
    attPeek.style.left = `${left}px`; attPeek.style.top = `${top}px`;
  };
  if (img.getAttribute('src') !== src) { attPeek.hidden = true; img.onload = place; img.onerror = peekHide; img.src = src; }
  else place();
});
$('#att-tab-list').addEventListener('mouseout', (e) => { if (attPeek._for && !attPeek._for.contains(e.relatedTarget)) peekHide(); });
addEventListener('scroll', peekHide, true);
document.addEventListener('pointerdown', peekHide, true);

// 타임라인 정리: 사용자 요청을 한 줄로 모아 강조한다.
//  · 대시보드 지시는 'assign' 과 곧이어 오는 'working: 같은 글' 두 줄로 찍힌다 → 한 줄('요청')
//  · 터미널에서 직접 친 요청은 'working: …' 만 찍힌다 → '요청'
//  · 감시·백그라운드 완료 알림으로 생긴 턴('working: <task-notification>…')은 요청이 아니다 → '알림'
//  · 'queue' 는 대기열에 들어간 지시 → '대기열' · 'unqueue' 는 대기열에서 지운 지시 → '대기열에서 제거'
function timelineRows(log, shots = [], docs = [], past = []) {
  const rows = [];
  for (const l of log) {
    if (l.kind === 'assign') { rows.push({ t: l.t, kind: 'req', tag: _t('요청'), text: l.text }); continue; }
    if (l.kind === 'queue') { rows.push({ t: l.t, kind: 'queued', tag: _t('대기열'), text: l.text }); continue; }
    if (l.kind === 'unqueue') { rows.push({ t: l.t, kind: 'unqueued', tag: _t('대기열에서 제거'), text: l.text }); continue; }
    // 예전 버전이 지난 요청을 타임라인 기록(w.log)에 직접 넣은 것 — 지금은 w.past 로 따로 온다(아래)
    if (l.kind === 'past') { rows.push({ t: l.t, kind: 'req', past: true, tag: _t('지난 요청'), text: l.text }); continue; }
    if (l.kind === 'pastnote') { rows.push({ t: l.t, kind: 'pastnote', text: _t('지난 세션 요청 {n}개 — 대화 기록에서 불러옴', { n: l.text }) }); continue; }
    const m = l.kind === 'status' && l.text.match(/^working: ([\s\S]*)$/);
    if (m) {
      const text = m[1];
      if (text.startsWith('<task-notification>')) {
        const sum = text.match(/<summary>([^<]*)/)?.[1] || _t('백그라운드 작업 알림');
        rows.push({ t: l.t, kind: 'bgnote', tag: _t('🔔 알림'), text: sum });
        continue;
      }
      const prev = rows.findLast((r) => r.kind === 'req');
      if (prev && l.t - prev.t < 15_000 && sameReq(prev.text, text)) continue; // 대시보드 지시와 같은 줄
      rows.push({ t: l.t, kind: 'req', tag: _t('요청'), text });
      continue;
    }
    rows.push({ t: l.t, kind: l.kind, text: srvText(l.text) });
  }
  // 도구 결과 캡처: 그 시각 자리에 썸네일 줄로 끼운다 (로그와 캡처는 같은 시계 — 둘 다 이 PC 의 시각)
  for (const s of shots || []) rows.push({ t: s.t, kind: 'shot', tag: _t('📷 캡처'), text: [s.tool, s.arg].filter(Boolean).join(' · '), shot: s });
  // 워커가 쓴 결과물 문서: 마지막으로 쓴(고친) 시각 자리에 카드 줄로
  for (const d of docs || []) rows.push({ t: d.t, kind: 'doc', tag: _t('📄 결과물'), text: '', doc: d });
  // 이어 붙인 세션의 지난 요청(서버가 대화 기록에서 채워 타임라인 한도와 따로 보관 — w.past): 맨 앞 것 바로 위에 머리 줄
  if (past?.length) {
    rows.push({ t: past[0].t - 1, kind: 'pastnote', text: _t('지난 세션 요청 {n}개 — 대화 기록에서 불러옴', { n: past.length }) });
    for (const p of past) rows.push({ t: p.t, kind: 'req', past: true, tag: _t('지난 요청'), text: p.text });
  }
  if (shots?.length || docs?.length || past?.length) rows.sort((a, b) => a.t - b.t); // 안정 정렬이라 같은 시각의 로그 순서는 그대로
  return rows;
}
// 카드·최소화 칩에 띄울 최근 캡처·결과물 문서 — 이번(또는 마지막) 턴에 나온 것만
function recentMedia(w) {
  const fresh = (x) => (x && (!w.turnStartedAt || x.t >= w.turnStartedAt - 5000) ? x : null);
  return { shot: fresh((w.shots || []).at(-1)), doc: fresh((w.docs || []).at(-1)) };
}
// 결과물 문서 카드. 미리보기(iframe)는 넣지 않는다 — 타임라인은 줄이 늘 때마다 통째로 다시 그려서 계속 다시 로드된다
const DOC_ICON = {
  html: '🌐', htm: '🌐', md: '📝', markdown: '📝', pdf: '📕', svg: '🖼️', csv: '📊', tsv: '📊', json: '🧾', jsonl: '🧾', xml: '🧾',
  docx: '📘', doc: '📘', hwp: '📘', hwpx: '📘', odt: '📘', rtf: '📘', xlsx: '📗', xls: '📗', ods: '📗', pptx: '📙', ppt: '📙', odp: '📙',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', bmp: '🖼️', mp4: '🎬', m4v: '🎬', mov: '🎬', webm: '🎬', zip: '🗜️', '7z': '🗜️',
};
// 결과물 문서는 이 PC 에서 보고 있으면 OS 기본 앱으로 연다(탐색기·Finder 에서 더블클릭한 것처럼) — Ctrl/⌘+클릭은 새 탭.
// 휴대폰 등 다른 기기에서는 그 PC 에서 열려 봐야 소용없으니 새 탭.
// 그림(data-img)은 캡처처럼 앱 안에서 크게 보고, 동영상(data-vid)은 첨부 동영상처럼 앱 안에서 재생한다 — 같은 png 가 캡처는 미리보기,
// 결과물은 OS 앱으로 열려 헷갈렸다. Ctrl/⌘+클릭이 OS 앱(다른 기기면 새 탭)
const LOCAL_VIEW = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
const IMG_DOC = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const VID_DOC = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']); // 서버 VIDEO_TYPES 와 같게
// 글 위주 결과물 — 누르면 앱 안 글 뷰어(openText). md 는 서식을 입혀, 나머지는 원문 그대로(json 은 들여쓰기)
const TXT_DOC = new Set(['md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini']);
const docOpenHint = (img) => _t(img ? (LOCAL_VIEW ? '클릭: 크게 보기 · Ctrl/⌘+클릭: 열기' : '클릭: 크게 보기 · Ctrl/⌘+클릭: 새 탭')
  : LOCAL_VIEW ? '클릭: 열기 · Ctrl/⌘+클릭: 새 탭' : '클릭: 새 탭에서 열기');
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a.card-doc, a.dock-doc, a.tl-doc, a.att-doc');
  if (!a || e.button || e.shiftKey) return;
  const mod = e.ctrlKey || e.metaKey, vid = a.dataset.vid != null, txt = a.dataset.txt != null, img = a.dataset.img != null || vid || txt;
  if (img && !mod) {
    e.preventDefault();
    if (txt) openText(a.getAttribute('href'), a.dataset.txt);
    else if (vid) openVideo(a.getAttribute('href'), { cap: a.dataset.vid }); else openShot(a.getAttribute('href'), { cap: a.dataset.img });
    return;
  }
  if (!LOCAL_VIEW || (mod && !img)) return;
  e.preventDefault();
  api(`/api${a.getAttribute('href')}/open`);
}, true);
const docImgAttr = (d, ext) => IMG_DOC.has(ext) ? ` data-img="${esc(d.path || d.name)}"` : VID_DOC.has(ext) ? ` data-vid="${esc(d.path || d.name)}"` : TXT_DOC.has(ext) ? ` data-txt="${esc(d.path || d.name)}"` : '';
// 워커 카드용 작은 타일 (아이콘 + 확장자). 끌면 링크가 아니라 카드가 끌리게 draggable=false
function docTile(d, cls = 'card-doc') {
  const ext = d.name.split('.').pop().toLowerCase();
  return `<a class="${cls}" href="${esc(d.url)}" target="_blank" rel="noopener" draggable="false"${docImgAttr(d, ext)} title="${esc(d.title ? `${d.title}\n` : '')}${esc(d.name)}&#10;${docOpenHint(IMG_DOC.has(ext) || VID_DOC.has(ext) || TXT_DOC.has(ext))}">` +
    `<span class="ic">${DOC_ICON[ext] || '📄'}</span><span class="ext">${esc(ext.toUpperCase())}</span></a>`;
}
function docCard(d) {
  const ext = d.name.split('.').pop().toLowerCase();
  // 폴더는 끝쪽 두 단계만 (전체 경로는 마우스를 올리면)
  const parts = d.path.slice(0, -d.name.length - 1).split(/[\\/]/), sep = d.path.includes('\\') ? '\\' : '/';
  const dir = parts.length > 3 ? `…${sep}${parts.slice(-2).join(sep)}` : parts.join(sep);
  return `<a class="tl-doc" href="${esc(d.url)}" target="_blank" rel="noopener"${docImgAttr(d, ext)} title="${esc(d.path)}&#10;${docOpenHint(IMG_DOC.has(ext) || VID_DOC.has(ext) || TXT_DOC.has(ext))}">` +
    `<span class="ic">${DOC_ICON[ext] || '📄'}</span><span class="meta">` +
    (d.title ? `<span class="ti">${esc(d.title)}</span>` : '') +
    `<span class="nm">${esc(d.name)}</span><span class="dir">${esc(dir)}</span></span></a>`;
}
// 사람이 지시에 첨부한 파일: 글에 들어간 data/uploads 경로를 서버의 /uploads/ 로 바로 보여 준다(따로 저장하지 않음).
// 이미지는 썸네일(누르면 크게 보기), 그 밖의 파일은 아이콘 + 원래 이름(누르면 새 탭). 이름은 /api/upload 가 지은 규칙
// (시각-난수.확장자 / 시각-난수-원래이름). 이미 정리됐으면(7일) 서버가 404 → 썸네일은 숨긴다
// size: 'md' = 타임라인, 'sm' = 입력칸 아래·대기열·나중에 할 작업(칸이 좁아 더 작게)
const UPLOAD_PATH_RE = /[\\/]uploads[\\/](\d{14}-[a-z0-9]{1,8}(?:\.[a-z0-9]+|-[\p{L}\p{N}._-]*[\p{L}\p{N}_-]))/giu;
const SHOT_PATH_RE = /[\\/]shots[\\/]([\w-]+)[\\/]([\w-]+\.(?:png|jpe?g|gif|webp))/gi; // 서버 SHOT_DIR · /shots/ GET 과 같은 이름 규칙
const IMG_EXT = /^(png|jpe?g|gif|webp|bmp)$/i;
const VIDEO_EXT = /^(mp4|m4v|mov|webm|ogv)$/i; // 서버 VIDEO_TYPES 와 같게 — 누르면 동영상 뷰어(openVideo)
// 타임라인 글은 서버가 300자로 자른다(pushLog) — 잘린 끝에 걸친 경로는 이름이 잘려 있어 빼야 깨진 타일이 안 생긴다
const LOG_CLIP = 290;
function uploadsIn(text, clipped = false) {
  text = String(text);
  const cut = clipped && text.length >= LOG_CLIP;
  const names = [...new Set([...text.matchAll(UPLOAD_PATH_RE)].filter((m) => !(cut && m.index + m[0].length >= text.length)).map((m) => m[1]))];
  const file = (name, label, url) => {
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return { name, label, ext, url, image: IMG_EXT.test(ext), video: VIDEO_EXT.test(ext) };
  };
  const list = names.map((name) => file(name, name.replace(/^\d{14}-[a-z0-9]{1,8}-/i, ''), `/uploads/${encodeURIComponent(name)}`));
  // 타임라인 썸네일을 끌어 넣은 경로도(dropZone → /api/file-path): 캡처(data/shots/<id>/<이름>) · 워커가 만든 결과물(w.docs 의 path)
  for (const m of text.matchAll(SHOT_PATH_RE)) {
    if (cut && m.index + m[0].length >= text.length) continue;
    list.push(file(m[2], m[2], `/shots/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}`));
  }
  for (const w of state.workers) for (const d of w.docs || []) {
    const at = d.path ? text.indexOf(d.path) : -1;
    if (at < 0 || (cut && at + d.path.length >= text.length)) continue;
    list.push(file(d.name, d.name, d.url));
  }
  return list.filter((f, i) => list.findIndex((g) => g.url === f.url) === i);
}
function attachChips(text, size = 'sm') {
  return attTiles(uploadsIn(text, size === 'md'), size);
}
function attTiles(list, size) {
  return list.length ? `<span class="att att-${size}">${list.map(attTile).join('')}</span>` : '';
}
function attTile(f) {
  if (goneUploads.has(f.url)) return ''; // 7일 정리로 원본이 지워진 파일(아래 checkGoneUploads)
  return f.image
    ? shotImg({ url: f.url }, 'att-img').replace('<img ', '<img onerror="this.remove()" ')
    : f.video
      // 첫 장면(#t=0.1)을 썸네일로 — 못 읽는 형식(브라우저가 재생 못 하는 코덱)이어도 ▶ 표시와 이름은 남는다
      ? `<span class="att-vid" data-video="${esc(f.url)}" title="${esc(f.label)}&#10;${_t('클릭해 재생')}"><video src="${esc(f.url)}#t=0.1" preload="metadata" muted playsinline></video><span class="play" aria-hidden="true"></span></span>`
      : `<a class="att-file" href="${esc(f.url)}" target="_blank" rel="noopener" draggable="false" title="${esc(f.label)}&#10;${_t('클릭: 새 탭에서 열기')}"><span class="ic">${DOC_ICON[f.ext] || '📄'}</span><span class="nm">${esc(f.label)}</span></a>`;
}
// 원본이 지워진 첨부 파일 타일 빼기 — 업로드는 7일 뒤 정리되는데(server cleanupUploads) 그림 타일은 못 읽으면 스스로 빠지지만
// 파일 타일은 눌러야 404 라 남았다. 새로 생긴 파일 타일(/uploads/…)을 모아 한 번에 묻고, 답은 기억해 다음부터는 그릴 때 거른다(attTile)
const goneUploads = new Set(), seenUploads = new Set();
let upGoneAsk = new Set(), upGoneTimer = null;
function checkGoneUploads(root) {
  for (const a of root.querySelectorAll?.('a.att-file[href^="/uploads/"]') || []) {
    const url = a.getAttribute('href');
    if (goneUploads.has(url)) a.remove();
    else if (!seenUploads.has(url)) { seenUploads.add(url); upGoneAsk.add(url); }
  }
  if (upGoneAsk.size && !upGoneTimer) upGoneTimer = setTimeout(async () => {
    upGoneTimer = null;
    const urls = [...upGoneAsk]; upGoneAsk = new Set();
    const names = urls.map((u) => { try { return decodeURIComponent(u.slice('/uploads/'.length)); } catch { return ''; } });
    let gone = [];
    try { gone = (await (await fetch('/api/uploads/gone', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ names }) })).json()).gone || []; }
    catch { for (const u of urls) seenUploads.delete(u); return; } // 옛 서버(경로 없음)·끊김 — 다음에 다시
    const goneSet = new Set(gone);
    urls.forEach((u, i) => { if (goneSet.has(names[i])) goneUploads.add(u); });
    for (const a of document.querySelectorAll('a.att-file[href^="/uploads/"]')) if (goneUploads.has(a.getAttribute('href'))) a.remove();
  }, 400);
}
new MutationObserver((list) => { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) checkGoneUploads(n.matches?.('a.att-file') ? n.parentNode || n : n); })
  .observe(document.body, { childList: true, subtree: true });
// 첨부 파일 타일을 눌러도 요청 줄 이동(타임라인)·카드 선택으로 번지지 않게 — 새 탭 열기(기본 동작)는 그대로
document.addEventListener('click', (e) => { if (e.target.closest?.('.att-file')) e.stopPropagation(); }, true);
// 입력칸 바로 아래에 지금 글에 들어간 첨부를 보여 준다. 글이 바뀔 때만 다시 그린다(썸네일 깜박임 방지)
function syncAttach(ta) {
  let box = ta.nextElementSibling;
  if (!box?.classList.contains('att-live')) { box = el('<div class="att-live"></div>'); ta.after(box); }
  const html = attachChips(ta.value, 'sm');
  if (box._html !== html) box.innerHTML = box._html = html;
}
// ---------- 도구 결과 캡처 보기 ----------
// 썸네일은 data-shot 에 원본 주소를 달아 두고, 어디서 눌러도(타임라인·카드) 같은 크게 보기를 연다
// 그린 뒤 위치 맞추기(스크롤 바닥 붙이기 · 고정 줄)는 다음 프레임 직전에 한 번에 — 그리는 도중에 크기를 읽으면 브라우저가
// 그때마다 배치를 새로 계산했다(워커 전환 한 번에 타임라인 · 채팅 · 이미지 로드마다 30~100ms씩, 실측). 같은 키는 한 번만
const frameJobs = new Map();
function afterFrame(key, fn) {
  if (!frameJobs.size) requestAnimationFrame(() => { const jobs = [...frameJobs.values()]; frameJobs.clear(); for (const f of jobs) { try { f(); } catch (e) { console.error(e); } } });
  frameJobs.set(key, fn);
}
// 목록이 맨 아래를 보고 있는지 — 그릴 때 scrollHeight 를 읽지 않게 스크롤할 때 적어 둔다(el._settling 동안은 우리가 옮기는 중이라 무시)
function trackBottom(el, near) {
  el._atBottom = true;
  el.addEventListener('scroll', () => { if (!el._settling) el._atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < near; }, { passive: true });
}
const shotImg = (s, cls) => `<img class="${cls}" src="${esc(s.url)}" data-shot="${esc(s.url)}" alt="${_t('캡처')}" loading="lazy" decoding="async" draggable="false" title="${_t('클릭해 크게 보기')}">`;
// 같은 워커의 캡처끼리 ←/→ 로 넘겨 본다. 몇 번째인지·찍힌 시각과 보관 한도 안내를 아래에 둔다
// 뷰어 공통: 'OS 앱으로 열기' · '파일 위치 열기' (이 PC 에서 볼 때만 — 다른 기기면 그 PC 에서 열려 봐야 소용없다).
// cur() 는 지금 보이는 파일 주소(캡처 넘기기 등). 버튼 줄 클릭은 뷰어의 '바깥 누르면 닫기'로 번지지 않게 막는다
function fileActs(box, cur) {
  if (!LOCAL_VIEW) return;
  const bar = el(`<div class="file-acts"><button class="btn mini" data-fa="open">${_t('OS 앱으로 열기')}</button><button class="btn mini" data-fa="folder">${_t('파일 위치 열기')}</button></div>`);
  bar.addEventListener('click', async (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-fa]');
    if (!b) return;
    api('/api/file-open', { url: cur(), folder: b.dataset.fa === 'folder' }); // 없으면 api 가 서버 안내를 띄운다
  });
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  (box.querySelector('.tv-head') || box).append(bar);
}
function openShot(url, single) { // single: { cap } — 결과물 그림 한 장(넘기기·보관 안내 없음)
  const upload = url.startsWith('/uploads/');
  const id = url.split('/')[2];
  const list = upload || single ? [] : state.workers.find((w) => w.id === id)?.shots || [];
  let i = Math.max(0, list.findIndex((s) => s.url === url));
  const box = el(`<div class="shot-view" title="${_t('바깥을 누르거나 Esc 로 닫기')}">
    <button class="shot-nav prev" title="${_t('이전 캡처 (←)')}">‹</button>
    <figure><img alt="${_t('캡처')}" draggable="false"><figcaption><div class="cap"></div><div class="meta"></div><div class="note"></div></figcaption></figure>
    <button class="shot-nav next" title="${_t('다음 캡처 (→)')}">›</button>
    <div class="zoom-bar"><span class="zoom-pct">100%</span><span class="zoom-help">${_t('휠·+/− 확대 · 드래그 이동 · 더블클릭·0 원래대로')}</span></div></div>`);
  // 확대: 휠(커서 자리 기준)·+/−·더블클릭(2.5배 ↔ 맞춤), 확대 중엔 끌어서 이동, 0 이면 원래대로. 넘기면 맞춤으로 돌아간다
  const img = $('img', box), pctEl = $('.zoom-pct', box);
  let z = 1, tx = 0, ty = 0;
  const paint = () => { img.style.transform = z === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${z})`; box.classList.toggle('zoomed', z > 1); pctEl.textContent = `${Math.round(z * 100)}%`; };
  // 화면 점 (sx, sy) 아래의 그림 자리가 그대로 있도록 배율만 바꾼다 — 가운데(C)는 변환 전 그림의 중심
  const zoomAt = (nz, sx, sy) => {
    nz = Math.min(12, Math.max(1, nz));
    // 변환 전 자리(offset*)로 잰다 — getBoundingClientRect 는 전환(.08s) 중간 값이라 휠을 연달아 굴리면 기준점이 밀렸다. 바탕(.shot-view)이 화면 전체 고정이라 offset 이 곧 화면 좌표
    const cx = img.offsetLeft + img.offsetWidth / 2, cy = img.offsetTop + img.offsetHeight / 2;
    if (sx == null) { sx = cx + tx; sy = cy + ty; }
    const ux = (sx - cx - tx) / z, uy = (sy - cy - ty) / z;
    z = nz; tx = nz === 1 ? 0 : sx - cx - ux * nz; ty = nz === 1 ? 0 : sy - cy - uy * nz;
    paint();
  };
  box.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); }, { passive: false });
  img.addEventListener('dblclick', (e) => zoomAt(z > 1 ? 1 : 2.5, e.clientX, e.clientY));
  let drag = null, dragged = false;
  img.addEventListener('pointerdown', (e) => { if (z === 1 || e.button) return; e.preventDefault(); img.setPointerCapture(e.pointerId); drag = { x: e.clientX - tx, y: e.clientY - ty }; dragged = false; box.classList.add('panning'); });
  img.addEventListener('pointermove', (e) => { if (!drag) return; tx = e.clientX - drag.x; ty = e.clientY - drag.y; dragged = true; paint(); });
  const endDrag = () => { drag = null; box.classList.remove('panning'); };
  img.addEventListener('pointerup', endDrag); img.addEventListener('pointercancel', endDrag);
  const show = () => {
    const s = list[i] || { url, tool: '', arg: '' };
    z = 1; tx = ty = 0; paint();
    $('img', box).src = s.url;
    $('.cap', box).textContent = single ? `${_t('결과물')} · ${single.cap}` : upload ? `${_t('사람이 첨부')} · data/uploads/${decodeURIComponent(url.slice('/uploads/'.length))}` : [s.tool, s.arg].filter(Boolean).join(' · ');
    $('.meta', box).textContent = list.length ? `${i + 1} / ${list.length}${s.t ? ` · ${new Date(s.t + clockSkew).toLocaleString(uiLocale(), { hour12: false })}` : ''}` : '';
    $('.note', box).textContent = single ? _t(LOCAL_VIEW ? '결과물 카드를 Ctrl/⌘+클릭하면 OS 기본 앱으로 엽니다.' : '결과물 카드를 Ctrl/⌘+클릭하면 새 탭에서 엽니다.') : upload ? _t('첨부 원본을 그대로 보여 줍니다 (7일 지나면 정리됨).') : _t('이미지는 최대 {n}장까지 관리됩니다.', { n: state.shotKeep || 50 });
    $('.prev', box).disabled = i <= 0;
    $('.next', box).disabled = i >= list.length - 1;
  };
  const go = (d) => { const n = i + d; if (n >= 0 && n < list.length) { i = n; show(); } };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(1); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); e.stopPropagation(); zoomAt(z * 1.25); }
    else if (e.key === '-') { e.preventDefault(); e.stopPropagation(); zoomAt(z / 1.25); }
    else if (e.key === '0') { e.preventDefault(); e.stopPropagation(); zoomAt(1); }
  };
  box.addEventListener('click', (e) => {
    if (dragged) { dragged = false; return; } // 끌다가 바깥에서 놓아도 닫지 않는다
    const nav = e.target.closest('.shot-nav');
    if (nav) { go(nav.classList.contains('prev') ? -1 : 1); return; }
    if (e.target.closest('figure')) return; // 그림·설명을 눌러도 닫지 않는다(글자 복사 등)
    close();
  });
  fileActs(box, () => (list[i] || { url }).url);
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  show();
}
// 결과물 글 보기 — 크게 보기(.shot-view)와 같은 어두운 바탕 위 글 패널. 바깥·Esc 로 닫는다.
// md 는 marked 로 서식을 입히고 DOMPurify 로 거른다(처음 열 때만 CDN 에서 불러옴 — 못 불러오면 원문 그대로). 2MB 넘으면 앞부분만
const TEXT_MAX = 2 << 20;
let mdLibs = null;
function loadMdLibs() {
  const js = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = no; document.head.append(s); });
  mdLibs ??= Promise.all([js('https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js'), js('https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js')])
    .catch((e) => { mdLibs = null; throw e; });
  return mdLibs;
}
async function openText(url, cap) {
  const ext = cap.split('.').pop().toLowerCase(), md = ext === 'md' || ext === 'markdown';
  const box = el(`<div class="shot-view txt-view" title="${_t('바깥을 누르거나 Esc 로 닫기')}">
    <div class="tv-panel"><div class="tv-head"><span class="tv-cap"></span><button class="btn ghost mini tv-x" data-tv="close">✕</button></div>
    <div class="tv-body"><div class="tv-note">${_t('불러오는 중…')}</div></div></div></div>`);
  $('.tv-cap', box).textContent = `${_t('결과물')} · ${cap}`;
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.addEventListener('click', (e) => {
    const act = e.target.closest('[data-tv]')?.dataset.tv;
    if (act === 'close' || !e.target.closest('.tv-panel')) close();
  });
  fileActs(box, () => url);
  $('.tv-head', box).append($('.tv-x', box)); // ✕ 는 맨 끝
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
  const body = $('.tv-body', box);
  let text;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    text = new TextDecoder().decode(await r.arrayBuffer());
  } catch { body.innerHTML = `<div class="tv-note">${esc(_t('파일을 읽지 못했어요 (지워졌거나 옮겨짐)'))}</div>`; return; }
  const cut = text.length > TEXT_MAX;
  if (cut) text = text.slice(0, TEXT_MAX);
  const note = cut ? `<div class="tv-note">${esc(_t('파일이 커서 앞부분만 보여 줘요'))}</div>` : '';
  if (md) {
    try {
      await loadMdLibs();
      body.innerHTML = note + `<article class="tv-md">${DOMPurify.sanitize(marked.parse(text))}</article>`;
      for (const a of body.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
      return;
    } catch {} // 못 불러오면(오프라인) 원문 그대로
  }
  if (ext === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
  body.innerHTML = note + '<pre class="tv-pre"></pre>';
  $('.tv-pre', body).textContent = text;
}
// 첨부 동영상 보기 — 캡처 크게 보기(.shot-view)와 같은 틀에 <video>. 바깥·Esc 로 닫는다
function openVideo(url, single) { // single: { cap } — 결과물 동영상(첨부 안내 없음)
  const box = el(`<div class="shot-view" title="${_t('바깥을 누르거나 Esc 로 닫기')}">
    <figure><video controls autoplay playsinline></video><figcaption><div class="cap"></div><div class="note"></div></figcaption></figure></div>`);
  const v = $('video', box);
  v.src = url;
  $('.cap', box).textContent = single ? `${_t('결과물')} · ${single.cap}` : `${_t('사람이 첨부')} · data/uploads/${decodeURIComponent(url.slice('/uploads/'.length))}`;
  $('.note', box).textContent = single ? '' : _t('첨부 원본을 그대로 보여 줍니다 (7일 지나면 정리됨).');
  v.addEventListener('error', () => {
    $('.note', box).innerHTML = `${esc(_t('이 브라우저가 재생할 수 없는 형식입니다.'))} <a href="${esc(url)}" download>${esc(_t('내려받기'))}</a>`;
  });
  const close = () => { v.pause(); box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  box.addEventListener('click', (e) => { if (!e.target.closest('figure')) close(); });
  fileActs(box, () => url);
  document.addEventListener('keydown', onKey, true);
  document.body.append(box);
}
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-video]');
  if (!t) return;
  e.stopPropagation(); // 카드 선택·타임라인 요청 이동으로 번지지 않게
  openVideo(t.dataset.video);
}, true);
// 타임라인 썸네일은 늦게 로드되며 높이가 늘어난다 → 맨 아래를 보던 중이면 바닥을 유지
// 썸네일마다 크기를 읽으면 그때마다 배치를 다시 계산했다(이미지 수십 장 → 실측 100ms 남짓) → 한 프레임에 한 번
trackBottom($('#log'), 160);
$('#log').addEventListener('load', (e) => {
  const logEl = e.currentTarget;
  if (e.target.tagName === 'IMG' && logEl._atBottom) afterFrame('log-img', () => { if (logEl._atBottom) { logEl._settling = true; logEl.scrollTop = logEl.scrollHeight; logEl._settling = false; } });
}, true);
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('[data-shot]');
  if (!t) return;
  e.stopPropagation(); // 카드 선택·타임라인 요청 이동으로 번지지 않게
  openShot(t.dataset.shot);
}, true);

// ---------- 세션 프로파일 ----------
const SERIES = [ // 쌓는 순서 = 아래 → 위
  { key: 'cacheRead', label: '캐시 읽기', color: 'var(--s-read)' }, // label 은 한국어 원문 — 그릴 때 _t
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
  return s < 60 ? _t('{s}초', { s }) : _t('{m}분 {s}초', { m: Math.floor(s / 60), s: s % 60 });
};
const turnInput = (t) => t.input + t.cacheWrite + t.cacheRead;

let profileSig = '';
let profileTurns = [];
let profileWid = null;
function renderProfile(w, force) {
  const p = w.profile;
  // lite 프로필(전체 값 도착 전)에는 차트 · 턴 목록 재료가 없다 — 빈 안내로 바꿨다 되돌리지 않고 다음 렌더를 기다린다
  if (p?.lite && !force) return;
  const sig = p && !p.lite ? `${w.id}|${p.calls}|${p.turnCount}|${p.total.output}|${p.total.cacheRead}|${p.bgRunning}|${p.sub.tokens}|${p.apiErrors?.length}|${p.toolErrors}|${p.cacheMisses}|${Math.round((p.time?.total || 0) / 2000)}|${$('#profile').clientWidth}` : `${w.id}|none`;
  if (sig === profileSig && !force) return;
  profileSig = sig;
  if (!p || p.lite || !p.turnCount) {
    $('#kpis').innerHTML = `<div class="profile-empty">${_t('첫 지시가 끝나면 토큰 사용량이 여기에 쌓입니다.')}</div>`;
    // 이전 워커의 차트·목록·요약이 남지 않게 프로파일 칸을 전부 비운다
    ['#chart-tools', '#chart-tooltime', '#subagents', '#turns-table'].forEach((s) => ($(s).innerHTML = ''));
    $('#profile-model').textContent = '';
    $('#profile-mini').textContent = '';
    return;
  }
  $('#profile-model').textContent = `${p.model || ''} · ${_t('컨텍스트 창 {n}', { n: fmtN(p.window) })}`;
  // 접었을 때 제목 옆에 보이는 한 줄 요약
  const tt0 = p.total;
  $('#profile-mini').textContent = `${_t('누적 {n}', { n: fmtN(tt0.input + tt0.cacheWrite + tt0.cacheRead + tt0.output) })} · ${fmtUsd(tt0.cost)} · ${_t('컨텍스트 {n}', { n: fmtN(p.context) })}${p.cacheHit != null ? ` · ${_t('캐시 {n}%', { n: Math.round(p.cacheHit * 100) })}` : ''}`;
  // 접혀 있으면 차트 칸 폭이 0 이라 최소 폭(240px)으로 그려진다 → 그리지 않고, 펼칠 때 다시 그리도록 서명을 비운다
  if ($('#profile').classList.contains('collapsed')) { profileSig = ''; return; }
  const t = p.total;
  const all = t.input + t.cacheWrite + t.cacheRead + t.output;
  const ctx = ctxLevel(p);
  const turns = p.turns;
  $('#kpis').innerHTML = [
    kpi('누적 토큰', fmtN(all), `${_t('입력 {n}', { n: fmtN(all - t.output) })} · ${_t('출력 {n}', { n: fmtN(t.output) })}${p.thinking ? ` <small title="${_t('출력 중 사고(thinking) 토큰 — 출력에 포함')}">(${_t('사고 {n}', { n: fmtN(p.thinking) })})</small>` : ''}`),
    kpi('추정 비용 <small>API 환산</small>', p.unpriced ? `${fmtUsd(t.cost)}+` : fmtUsd(t.cost),
      p.cacheMisses ? `<span class="warn-t" title="${_t('원인: {r}', { r: esc(missReasonsText(p.cacheMissReasons)) })}">⚠ ${_t('캐시 재작성 {n}회', { n: p.cacheMisses })} · +${fmtUsd(p.cacheMissCost)}</span>` : _t('턴 평균 {c}', { c: fmtUsd(t.cost / p.turnCount) })),
    kpi('현재 컨텍스트', fmtN(p.context),
      `${ctx.level ? `<span class="warn-t">⚠ ${ctx.text}</span>` : `${_t('한도의 {n}%', { n: Math.round(ctx.pct * 100) })} · <span title="${esc(compactText(p.compactLog))}">${_t('압축 {n}회', { n: p.compactions })}</span>`}`,
      `<div class="gauge"><i class="${ctx.level ? 'warn' : ''}" style="width:${Math.min(100, ctx.pct * 100)}%"></i></div>` + sparkline(turns.map((x) => x.context || 0))),
    kpi('캐시 적중률', p.cacheHit == null ? '—' : `${Math.round(p.cacheHit * 100)}%`, `${_t('캐시 읽기 {n}', { n: fmtN(t.cacheRead) })} · ${_t('쓰기 {n}', { n: fmtN(t.cacheWrite) })}`),
    kpi('턴 · API 호출', `${p.turnCount} · ${p.calls}`, `${_t('질문당 {n}회 왕복', { n: (p.calls / p.turnCount).toFixed(1) })} · ${_t('도구 {n}회', { n: p.tools })}`),
    kpi('응답 시간', fmtMs(p.time.avgTotal), `${_t('첫 응답 {t}', { t: fmtMs(p.time.avgFirst) })} · ${_t('모델 {n}%', { n: pct(p.time.model, p.time.total) })} · ${_t('도구 {n}%', { n: pct(p.time.tool, p.time.total) })}${p.time.approval ? ` · ${_t('승인 {n}%', { n: pct(p.time.approval, p.time.total) })}` : ''}`,
      timeBar(p.time)),
    kpi('서브에이전트', p.subagents.length ? `${p.subagents.length}${p.bgRunning ? ` <small class="sa-run">· ${_t('{n}개 진행 중', { n: p.bgRunning })}</small>` : ''}` : '—',
      p.subagents.length ? `${fmtN(p.sub.tokens)} · ${fmtUsd(p.sub.cost)} <small>(${_t('메인 별도')})</small>` : _t('이 세션에서 사용 안 함')),
    errKpi(p),
  ].join('');
  tweenProfile(w.id);
  renderSubagents(p);

  profileTurns = turns.slice(-8).reverse(); // 최근 요청 표의 행 순서 — 행 호버 툴팁이 이 순서로 찾는다
  const maxMs = Math.max(1, ...p.toolTime.map((x) => x.ms));
  $('#chart-tooltime').innerHTML = p.toolTime.length
    ? p.toolTime.map((x) => `<div class="hbar wide" title="${esc(x.name)} — ${_t('{n}회 · 총 {t} · 평균 {a} · 최대 {m}', { n: x.n, t: fmtMs(x.ms), a: fmtMs(x.ms / x.n), m: fmtMs(x.max) })}"><span class="n">${esc(x.name)}</span><span class="b"><i style="width:${(x.ms / maxMs) * 100}%" data-k="t:${esc(x.name)}"></i></span><span class="c">${fmtMs(x.ms)}</span><span class="d">${_t('{n}회 · 평균 {a} · 최대 {m}', { n: x.n, a: fmtMs(x.ms / x.n), m: fmtMs(x.max) })}</span></div>`).join('')
    : `<div class="profile-empty">${_t('도구 실행 기록 없음')}</div>`;
  const maxTool = Math.max(1, ...p.toolTop.map((x) => x[1]));
  $('#chart-tools').innerHTML = p.toolTop.length
    ? p.toolTop.map(([n, c]) => `<div class="hbar"><span class="n" title="${esc(n)}">${esc(n)}</span><span class="b"><i style="width:${(c / maxTool) * 100}%" data-k="u:${esc(n)}"></i></span><span class="c">${c}</span></div>`).join('')
    : `<div class="profile-empty">${_t('도구 사용 없음')}</div>`;

  const fmtT = (ts) => fmtDate(ts, TIME_HM);
  const live = w.status === 'working' || w.status === 'decision';
  $('#turns-table').innerHTML =
    `<thead><tr><th>#</th><th>${_t('시각')}</th><th>${_t('질문')}</th><th class="r">${_t('첫 응답')}</th><th class="r">${_t('소요')}</th><th class="r">API</th><th class="r">${_t('도구')}</th><th class="r">${_t('입력')}</th><th class="r">${_t('캐시 적중')}</th><th class="r">${_t('출력')}</th><th class="r">${_t('비용')}</th><th>${_t('비고')}</th></tr></thead><tbody>` +
    turns.slice(-8).reverse().map((x, i) => {
      const inp = turnInput(x);
      return `<tr class="${live && i === 0 ? 'live' : ''}" data-i="${i}"><td>${x.n}</td><td>${fmtT(x.start)}</td><td class="p" title="${esc(x.prompt)}">${esc(x.prompt)}</td>` +
        `<td class="r">${fmtMs(x.time.first)}</td><td class="r" title="${_t('모델 {a} · 도구 {b}', { a: fmtMs(x.time.model), b: fmtMs(x.time.tool) })}${x.time.approval ? ` · ${_t('승인 대기 {t}', { t: fmtMs(x.time.approval) })}` : ''}">${fmtMs(x.time.total)}</td><td class="r">${x.calls}</td><td class="r">${x.tools}</td>` +
        `<td class="r">${fmtN(inp)}</td><td class="r">${inp ? Math.round((x.cacheRead / inp) * 100) + '%' : '—'}</td><td class="r">${fmtN(x.output)}</td>` +
        `<td class="r">${fmtUsd(x.cost)}</td><td class="note">${turnNotes(x)}</td></tr>`;
    }).join('') + '</tbody>';
  growBars(w.id);
}

// ---------- 펼친 세션 프로파일: 숫자가 바뀌면 지난 값에서 새 값까지 차례로 올라가게(1→2→…→10), 막대는 지난 폭에서 늘어나게 ----------
// 다시 그릴 때마다 KPI 칸 글을 기억해 두고, 같은 워커에서 글이 바뀌었으면 그 안의 숫자들만 옛 값 → 새 값으로 0.7초 동안 바꿔 쓴다.
// 숫자 개수가 달라지면(형식이 바뀜) 애니메이션 없이 새 값 그대로
const TWEEN_NUM = /\d[\d,]*(?:\.\d+)?/g;
const twPrev = new Map();
let twWorker = null;
function tweenText(el, oldText) {
  const olds = (oldText.match(TWEEN_NUM) || []).map((s) => Number(s.replace(/,/g, '')));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), parts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const nums = [];
    n.nodeValue.replace(TWEEN_NUM, (s) => { nums.push({ s, to: Number(s.replace(/,/g, '')), dec: (s.split('.')[1] || '').length, comma: s.includes(',') }); return s; });
    if (nums.length) parts.push({ n, tpl: n.nodeValue, nums });
  }
  const all = parts.flatMap((p) => p.nums);
  if (!all.length || all.length !== olds.length) return;
  all.forEach((x, i) => { x.from = olds[i]; });
  if (all.every((x) => x.from === x.to)) return;
  // 강조 애니메이션 다시 걸기 — offsetWidth 로 되감으면 그리는 도중 배치를 새로 계산해(워커 전환 때 15~65ms) 다음 프레임에 붙인다
  el.classList.remove('tw-on'); afterFrame(el, () => el.classList.add('tw-on'));
  const t0 = performance.now(), dur = 700;
  const fmt = (x, v) => { const s = v.toFixed(x.dec); return x.comma ? Number(s).toLocaleString('en-US', { minimumFractionDigits: x.dec, maximumFractionDigits: x.dec }) : s; };
  const step = (now) => {
    if (!el.isConnected) return;
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    for (const p of parts) { let i = 0; p.n.nodeValue = p.tpl.replace(TWEEN_NUM, () => { const x = p.nums[i++]; return k >= 1 ? x.s : fmt(x, x.from + (x.to - x.from) * e); }); }
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function tweenProfile(id) {
  const same = twWorker === id;
  twWorker = id;
  for (const el of $('#kpis').querySelectorAll('.kpi')) {
    const key = el.dataset.k || el.querySelector('.k')?.textContent;
    for (const [part, sel] of [['v', '.v'], ['s', '.s']]) {
      const box = el.querySelector(sel);
      if (!box) continue;
      const k = `${key}|${part}`, now = box.textContent, old = twPrev.get(k);
      twPrev.set(k, now);
      if (same && old != null && old !== now) tweenText(box, old);
    }
  }
}
const barPrev = new Map();
function growBars(id) {
  for (const i of document.querySelectorAll('#chart-tools .b i, #chart-tooltime .b i')) {
    const k = `${id}|${i.dataset.k}`, to = i.style.width, from = barPrev.get(k);
    barPrev.set(k, to);
    if (from == null || from === to) continue;
    i.style.transition = 'none'; i.style.width = from; void i.offsetWidth;
    i.style.transition = ''; i.style.width = to;
  }
}

const CTX_WARN = 150_000; // 이 이상이면 매 턴 캐시 읽기 비용이 커지는 구간 — 새 세션 고려
function ctxLevel(p) {
  const pct = p.context / (p.window || 200_000);
  if (pct >= 0.8) return { level: 2, pct, text: _t('한도의 {n}% — 곧 자동 압축', { n: Math.round(pct * 100) }) };
  if (p.context >= CTX_WARN) return { level: 1, pct, text: _t('{n} — 새 세션 고려', { n: fmtN(p.context) }) };
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
const missReason = (k) => (MISS_REASON[k] ? _t(MISS_REASON[k]) : k);
const missReasonsText = (r) => Object.entries(r || {}).map(([k, n]) => _t('{r} {n}회', { r: missReason(k), n })).join(' · ') || '—';
function compactText(log) {
  if (!log?.length) return _t('자동 압축 기록 없음');
  return log.map((c) => `${new Date(c.ts + clockSkew).toLocaleString(uiLocale(), { hour12: false })} ${_t(c.trigger === 'manual' ? '수동 압축' : '자동 압축')} ${fmtN(c.pre)} → ${fmtN(c.post)}${c.ms ? ` (${fmtMs(c.ms)})` : ''}`).join('\n');
}
// 오류 KPI: API 오류(429 레이트리밋 등)·사용량 한도·도구 실패. 없으면 '—'
function errKpi(p) {
  const api = p.apiErrors || [], q = p.quota, limited = q && q.status === 'rejected' && q.resetsAt && q.resetsAt * 1000 > serverNow();
  const n = api.length + (p.toolErrors || 0);
  const last = api.at(-1);
  const apiT = api.length ? `${_t('API 오류 {n}건', { n: api.length })}${last?.status ? ` (${_t('최근 {s}', { s: last.status })})` : ''}` : '';
  const toolT = p.toolErrors ? `${_t('도구 실패 {n}건', { n: p.toolErrors })}${p.toolErrTop?.length ? ` · ${p.toolErrTop.map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}` : '';
  const sub = [apiT, toolT].filter(Boolean).join(' · ') || _t('이 세션에서 오류 없음');
  const tip = api.map((x) => `${fmtDate(x.ts + clockSkew, TIME_HMS)} ${x.status ?? ''} ${x.text}`).join('\n');
  return kpi('오류', n ? String(n) : '—',
    `${limited ? `<span class="warn-t">⚠ ${_t('사용량 한도({type}) · {t} 해제', { type: esc(q.rateLimitType || ''), t: new Date(q.resetsAt * 1000 + clockSkew).toLocaleTimeString(uiLocale(), { hour12: false, hour: '2-digit', minute: '2-digit' }) })}</span> · ` : ''}<span title="${esc(tip)}">${esc(sub)}</span>`);
}
function missText(m) {
  const gap = m.gap != null ? ` · ${_t('공백 {t}', { t: fmtMs(m.gap) })}` : '';
  if (m.reason) return `${_t('캐시 재작성')} — ${missReason(m.reason)}${gap} (${_t('API 진단')})`;
  return m.expired ? `${_t('캐시 만료 추정')}${gap} (TTL ${_t(m.ttl >= 3600_000 ? '1시간' : '5분')})` : `${_t('캐시 재작성')}${gap} (${_t('프롬프트·도구 변경 추정')})`;
}

function turnNotes(x) {
  const notes = [];
  if (x.cacheMiss) notes.push(`<span class="warn-t" title="${esc(missText(x.cacheMiss))}">⚠ ${_t(x.cacheMiss.expired ? '캐시 만료' : '캐시 재작성')} ${fmtN(x.cacheMiss.tokens)}${x.cacheMiss.extra != null ? ` +${fmtUsd(x.cacheMiss.extra)}` : ''}</span>`);
  if (x.sub) notes.push(`<span title="${_t('이 턴에서 띄운 서브에이전트')}">🤖 ${x.sub.n} · ${fmtN(x.sub.tokens)} · ${fmtUsd(x.sub.cost)}</span>`);
  if (x.toolErrors) notes.push(`<span class="warn-t" title="${_t('도구 결과가 오류(is_error)로 돌아온 횟수')}">✕ ${_t('도구 실패 {n}', { n: x.toolErrors })}</span>`);
  return notes.join(' ');
}

function renderSubagents(p) {
  $('#subagents').innerHTML = p.subagents.length
    ? p.subagents.map((s) => `<div class="sa">
        <div class="sa-top"><b>${s.running ? '<i class="sa-live"></i>' : ''}${esc(s.type)}</b><span>${s.running ? `<em class="sa-run">${_t('진행 중')}</em> · ` : ''}${s.background ? `${_t('백그라운드')} · ` : ''}${s.turn ? _t('턴 #{n}', { n: s.turn }) : ''}</span></div>
        <div class="sa-desc" title="${esc(s.description)}">${esc(s.description || '—')}</div>
        <div class="sa-meta">${s.model ? `${esc(String(s.model).replace(/^claude-/, ''))} · ` : ''}${_t('{n} 토큰', { n: fmtN(s.tokens) })} · ${fmtUsd(s.cost)} · ${_t('API {n}회', { n: s.calls })}${s.start && s.end ? ` · ${fmtMs(s.end - s.start)}` : ''}</div>
      </div>`).join('')
    : `<div class="profile-empty">${_t('서브에이전트(Explore 등)를 쓰면 메인 세션과 따로 집계됩니다.')}</div>`;
  // 돌고 있는 백그라운드 작업(감시·명령): 경과 시간은 1초마다 갱신(tick), 만료 시각이 있으면 함께
  if (p.bgTasks?.length) $('#subagents').insertAdjacentHTML('beforeend', p.bgTasks.map((b) => `<div class="sa">
      <div class="sa-top"><b><i class="sa-live"></i>${_t(b.kind === 'monitor' ? '감시' : '백그라운드 명령')}</b><span><em class="sa-run">${_t('진행 중')}</em> · <em data-since="${b.startedAt}"></em></span></div>
      <div class="sa-desc" title="${esc(b.desc)}">${esc(b.desc || '—')}</div>
      <div class="sa-meta">${b.expiresAt ? _t('만료 {t}', { t: new Date(b.expiresAt + clockSkew).toLocaleTimeString(uiLocale(), { hour12: false, hour: '2-digit', minute: '2-digit' }) }) : _t('만료 없음')}${b.id ? ` · ${esc(b.id)}` : ''}</div>
    </div>`).join(''));
}

function timeBar(tm) {
  if (!tm.total) return '';
  return '<div class="tbar">' + TSERIES.filter((x) => tm[x.key] > 0)
    .map((x) => `<i style="width:${(tm[x.key] / tm.total) * 100}%;background:${x.color}"></i>`).join('') + '</div>';
}

// 큰 숫자 옆 단위($ · M · k · % · 초 · 분)와 구분점(·)은 작고 흐리게 — 숫자가 먼저 읽히게. 태그(<small> 등) 앞 글자만 손댄다
function kpiValue(v) {
  const i = v.indexOf('<'), head = i < 0 ? v : v.slice(0, i);
  return head.replace(/[^\d.,\s—]+/g, (u) => `<span class="u">${u}</span>`) + (i < 0 ? '' : v.slice(i));
}
function kpi(k, v, s, extra = '') {
  const key = k.split(' <')[0];
  return `<div class="kpi" data-k="${esc(key)}"${INFO[key] ? ` data-info="${key}"` : ''}><div class="k">${_t(k)}${INFO[key] ? ' <i class="info">ⓘ</i>' : ''}</div>${v ? `<div class="v">${kpiValue(v)}</div>` : ''}<div class="s">${s}</div>${extra}</div>`;
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
  '최근 요청': {
    what: '최근 8턴의 질문·첫 응답·소요(마우스를 올리면 모델/도구 구성)·호출·도구·입력·캐시 적중·출력·비용과 비고(⚠ 캐시 재작성, 🤖 서브에이전트).',
    how: '위 차트와 같은 데이터를 표로. 소요 = 질문 시각 → 마지막 응답 시각.',
    use: '비용이 튄 턴을 질문 내용과 함께 확인. 캐시 적중이 낮은 턴의 공백 시간을 보면 만료 여부를 알 수 있다.',
    trust: '높음(소요 시간만 근사).',
  },
};

function showInfo(el) {
  // 영어 화면이면 영어판(info-en.js) — 없는 칸은 한국어 원문
  const ko = INFO[el.dataset.info];
  if (!ko) return;
  const i = { ...ko, ...(LANG === 'ko' ? {} : INFO_EN?.[el.dataset.info]) };
  const tip = $('#tip');
  tip.classList.add('info-tip');
  tip.innerHTML = `<div class="tt">${esc(i.title || el.dataset.info)}</div>` +
    [['의미', i.what], ['근거', i.how], ['활용', i.use], ['신뢰도', i.trust]]
      .map(([h, t]) => `<div class="ib"><b>${_t(h)}</b><span>${esc(t)}</span></div>`).join('');
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

// 턴별 값 흐름 — 각진 막대 기둥(세션 프로파일의 막대들과 같은 모양). 마지막(지금) 기둥만 진하게
function sparkline(vals) {
  if (vals.length < 2) return '<svg class="spark"></svg>';
  const v = vals.slice(-40), W = 100, H = 22, max = Math.max(...v, 1), bw = W / v.length;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${v.map((x, i) => { const h = Math.max(1, (x / max) * H); return `<rect x="${(i * bw).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${Math.max(0.5, bw - 0.8).toFixed(2)}" height="${h.toFixed(2)}"${i === v.length - 1 ? ' class="now"' : ''}/>`; }).join('')}</svg>`;
}

// 최근 요청 표: 행에 마우스를 올리면 그 턴의 토큰·캐시·시간·도구를 툴팁으로(예전 턴별 차트의 호버 내용)
function onChartHover(e) {
  const row = e.target.closest?.('tr[data-i]');
  if (!row) { $('#tip').hidden = true; return; }
  const t = profileTurns[Number(row.dataset.i)];
  if (!t) return;
  const inp = turnInput(t);
  const tip = $('#tip');
  tip.classList.remove("info-tip");
  tip.innerHTML = `<div class="tt">#${t.n} ${esc(t.prompt)}</div>` +
    SERIES.slice().reverse().map((s) => `<div class="row"><span><i style="background:${s.color}"></i>${_t(s.label)}</span><b>${fmtN(t[s.key])}</b></div>`).join('') +
    `<div class="row"><span><i style="background:var(--s-out)"></i>${_t('출력')}</span><b>${fmtN(t.output)}</b></div><hr>` +
    `<div class="row"><span>${_t('캐시 적중')}</span><b>${inp ? Math.round((t.cacheRead / inp) * 100) : 0}%</b></div>` +
    `<hr><div class="row"><span>${_t('소요 (첫 응답)')}</span><b>${fmtMs(t.time.total)} (${fmtMs(t.time.first)})</b></div>` +
    TSERIES.filter((x) => t.time[x.key]).map((x) => `<div class="row"><span><i style="background:${x.color}"></i>${_t(x.label)}</span><b>${fmtMs(t.time[x.key])}</b></div>`).join('') +
    (t.toolPer.length ? `<div class="row sub"><span>${_t('도구별')}</span><b>${t.toolPer.map(([k, v]) => `${esc(k)} ${fmtMs(v)}`).join(' · ')}</b></div>` : '') +
    `<div class="row"><span>${_t('API · 도구 호출')}</span><b>${t.calls} · ${t.tools}</b></div>` +
    `<div class="row"><span>${_t('추정 비용')}</span><b>${fmtUsd(t.cost)}</b></div>` +
    (t.sub ? `<div class="row"><span>🤖 ${_t('서브에이전트 {n}', { n: t.sub.n })}</span><b>${fmtN(t.sub.tokens)} · ${fmtUsd(t.sub.cost)}</b></div>` : '') +
    (t.cacheMiss ? `<hr><div class="warn-t">⚠ ${esc(missText(t.cacheMiss))}<br>${_t('재작성 {n} 토큰', { n: fmtN(t.cacheMiss.tokens) })}${t.cacheMiss.extra != null ? ` · ${_t('읽었으면 {c} 절약', { c: fmtUsd(t.cacheMiss.extra) })}` : ''}</div>` : '');
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
  tip.style.top = `${Math.min(e.clientY + 14, innerHeight - r.height - 8)}px`;
}
$('#turns-table').addEventListener('mousemove', onChartHover);
$('#turns-table').addEventListener('mouseleave', onChartHover);
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
    send(attachMsg(id));
    // 터치 기기: 입력칸에 바로 포커스를 주면 화면 키보드가 터미널을 가린다 — 대신 열린 상세 화면으로 내려 준다(카드 아래에 있어 안 보인다)
    if (TOUCH) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (!document.querySelector('input.rename')) $('#task-form').text.focus();
  });
}

// ---------- 계정 사용량 (상단, 구독 5시간·주간 한도) ----------
// 서버가 워커 상태줄에서 받은 rate_limits(statusline.mjs). 초기화 시각이 지나면 0% 로 본다. 30분 넘게 새 값이 없으면 흐리게
const fmtLeft = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return _t('{m}분', { m });
  const h = Math.floor(m / 60);
  return h < 24 ? _t('{h}시간 {m}분', { h, m: m % 60 }) : _t('{d}일 {h}시간', { d: Math.floor(h / 24), h: h % 24 });
};
// 미터 툴팁: 마우스를 올리면 바로(브라우저 title 은 1초쯤 늦게 떠서) #tip 에 항목별 설명을 띄운다. 미터는 매초 다시 그려
// 요소가 바뀌므로, 미터 위 마우스 위치를 들고 있다가 그릴 때마다 그 자리의 항목으로 다시 맞춘다
const meterTips = {};
const hoverTips = {}; // 미터 밖에서 같은 툴팁을 쓰는 항목(data-mt) → 내용을 만드는 함수(언어가 바뀌어도 그때 문구로)
let mtPt = null;
function showMeterTip() {
  const tip = $('#tip');
  const el = mtPt && document.elementFromPoint(mtPt.x, mtPt.y)?.closest('[data-mt]');
  const t = el && (meterTips[el.dataset.mt] || hoverTips[el.dataset.mt]?.());
  if (!t) { if (tip.classList.contains('mt-tip')) { tip.hidden = true; tip.classList.remove('mt-tip'); tip._mt = ''; } return; }
  const html = `<div class="tt">${esc(t.title)}</div>` +
    (t.rows || []).map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('') +
    (t.note ? `<div class="mt-note">${esc(t.note)}</div>` : '') +
    (t.act ? `<div class="tip-act">${esc(t.act)}</div>` : '');
  tip.classList.remove('info-tip'); tip.classList.add('mt-tip');
  if (tip._mt !== html) tip.innerHTML = tip._mt = html;
  tip.hidden = false;
  // 항목 아래에 고정(마우스를 따라다니지 않음) — 화면 오른쪽 끝을 넘지 않게. 헤더 아이콘이면 오른쪽 끝을 맞춤
  const r = el.getBoundingClientRect(), b = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - b.width - 8))}px`;
  tip.style.top = `${r.bottom + 8 + b.height < innerHeight ? r.bottom + 8 : Math.max(8, r.top - b.height - 8)}px`;
}
document.addEventListener('mousemove', (e) => {
  const on = e.target.closest?.('.meters, [data-mt]');
  if (on) { mtPt = { x: e.clientX, y: e.clientY }; showMeterTip(); } else if (mtPt) { mtPt = null; showMeterTip(); }
});
document.addEventListener('mouseout', (e) => { if (!e.relatedTarget && mtPt) { mtPt = null; showMeterTip(); } }); // 창 밖으로

function renderUsage() {
  const boxes = [$('#meters'), $('#meters-full')].filter(Boolean);
  if (!boxes.length) return;
  const u = state.usage, now = Date.now();
  for (const k in meterTips) delete meterTips[k];
  const m = (key, label, pct, color, tip, dim = false, after = '') => {
    meterTips[key] = tip;
    return `<span class="mt${dim ? ' dim' : ''}" data-mt="${key}"><span class="mt-l">${_t(label)}</span><span class="mt-bar" style="--p:${pct ?? 0}%;--uc:${color}"><b>${pct == null ? '—' : `${Math.round(pct)}%`}</b></span>${after}</span>`;
  };
  // 초기화까지 남은 시간은 큰 단위 하나로 짧게(32분 · 4시간 · 6일) — 정확한 시각은 마우스를 올리면
  const short = (ms) => { const mins = Math.max(0, Math.floor(ms / 60000)); return mins < 60 ? _t('{m}분', { m: mins }) : mins < 1440 ? _t('{h}시간', { h: Math.floor(mins / 60) }) : _t('{d}일', { d: Math.floor(mins / 1440) }); };
  const clock = (t) => new Date(t).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  // 색은 항목별로 고정(style.css --m-ctx · --m-5h · --m-wk) — 사용률에 따라 바꾸지 않는다
  const parts = [];
  // 컨텍스트: 선택한 워커의 현재 대화가 차지한 양 / 모델 컨텍스트 창 — 카드 ctx 배지와 같은 경고 기준(ctxLevel)
  const w = selected && state.workers.find((x) => x.id === selected);
  const p = w?.profile;
  if (p && p.context) {
    // 컨텍스트 왼쪽에 프롬프트 캐시가 만료되기까지 남은 시간(⏱ 분:초) — 마지막 API 호출 + TTL(5분/1시간). 지나면 다음 요청이 캐시를 새로 쓴다
    const c = p.cache;
    if (c) {
      const left = c.at + c.ttl + clockSkew - now, ttlName = _t(c.ttl >= 3600_000 ? '1시간' : '5분');
      const mmss = (ms) => { const sec = Math.ceil(ms / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
      meterTips.cache = {
        title: _t('프롬프트 캐시'),
        rows: [[_t('만료까지'), left > 0 ? mmss(left) : _t('만료됨')], ['TTL', ttlName], [_t('마지막 API 호출'), clock(c.at + clockSkew)]],
        note: left > 0 ? _t('그 전에 요청하면 대화를 캐시에서 읽어 싸고 빠릅니다. 요청할 때마다 다시 {ttl} 연장됩니다', { ttl: ttlName })
          : _t('다음 요청은 대화 전체를 캐시에 새로 써서 비용이 더 듭니다'),
      };
      parts.push(`<span class="mt-r mt-cache${left <= 0 ? ' gone' : ''}" data-mt="cache">${left > 0 ? `⏱ ${mmss(left)}` : _t('캐시 만료')}</span>`);
    }
    const ctx = ctxLevel(p), pct = Math.min(100, ctx.pct * 100);
    parts.push(m('ctx', '컨텍스트', pct, 'var(--m-ctx)', {
      title: `${_t('컨텍스트')} ${Math.round(pct)}%`,
      rows: [[_t('대상 워커'), w.name], [_t('사용'), `${fmtN(p.context)} / ${fmtN(p.window || 200_000)}`]],
      note: ctx.text || _t('지금 대화가 모델 컨텍스트 창을 차지한 양 — 가득 차면 자동 압축됩니다'),
    }));
  }
  // 5시간·주간: 계정 한도(서버가 워커 상태줄에서 받은 rate_limits). 초기화 시각이 지나면 0%, 30분 넘게 새 값이 없으면 흐리게.
  // 서버는 항목마다 받은 시각(at)·보낸 워커(from)를 붙이고, 새 값에 한 항목이 빠지면 초기화 전인 이전 값을 유지한다
  const rep = state.usageReporters || { ok: [], missing: [] };
  const wname = (id) => { const x = state.workers.find((v) => v.id === id); return x && x.name !== id ? `${x.name}(${id})` : id; };
  const names = (ids) => ids.map(wname).join(', ');
  const noReporter = rep.ok.length ? '' : `${_t('사용량을 보내는 워커가 없습니다')}${rep.missing.length ? _t(' — {names}은(는) 이 기능 이전에 떠서 보내지 못합니다. 새로 띄우면(추가 인자 --resume 으로 대화 이어받기) 보냅니다', { names: names(rep.missing) }) : _t(' — 워커를 띄우면 일하는 동안 받아 옵니다')}`;
  const limit = (key, label, x, base) => {
    if (!x) {
      const why = noReporter || (u ? _t('최근 받은 값에 {label} 한도가 없었습니다 — 진행 중인 {label} 구간이 없을 때 빠지는 것으로 보입니다. {names} 워커가 다음에 일하면 갱신됩니다', { label: _t(label), names: names(rep.ok) })
        : _t('아직 받은 값이 없습니다 — {names} 워커가 일하기 시작하면 표시됩니다', { names: names(rep.ok) }));
      return m(key, label, null, base, { title: _t('{label} 한도', { label: _t(label) }), note: why }, true);
    }
    const age = now - ((x.at ?? u.at) + clockSkew), stale = age > 30 * 60_000;
    const reset = x.resetsAt && x.resetsAt <= now;
    const pct = reset ? 0 : Math.max(0, Math.min(100, x.pct));
    const at = x.resetsAt ? new Date(x.resetsAt).toLocaleString(uiLocale(), { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const after = x.resetsAt ? `<span class="mt-r">${reset ? _t('초기화됨') : `↻ ${short(x.resetsAt - now)}`}</span>` : '';
    const rows = [];
    if (x.resetsAt) rows.push([_t('초기화'), reset ? _t('초기화됨') : `${at} (${_t('{left} 후', { left: fmtLeft(x.resetsAt - now) })})`]);
    rows.push([_t('받은 값'), `${age < 60_000 ? _t('방금') : _t('{t} 전', { t: fmtLeft(age) })}${x.from || u.from ? ` · ${wname(x.from || u.from)}` : ''}`]);
    return m(key, label, pct, base, { title: _t('{label} 한도 {n}% 사용', { label: _t(label), n: Math.round(pct) }), rows, note: stale ? (noReporter || _t('30분 넘게 새 값이 없어 흐리게 표시합니다')) : '' }, stale, after);
  };
  parts.push(limit('h5', '5시간', u?.fiveHour, 'var(--m-5h)'), limit('wk', '주간', u?.sevenDay, 'var(--m-wk)'));
  const html = parts.join('');
  let changed = false;
  for (const box of boxes) if (box._html !== html) { box.innerHTML = box._html = html; changed = true; }
  if (changed) requestAnimationFrame(placeMeters); // 미터 폭이 바뀌었으면 양보 단계를 다시 고른다
  if (mtPt) showMeterTip();
}

// 매초: 경과 시간 텍스트만 갱신
function tick() {
  renderUsage();
  document.querySelectorAll('[data-since]').forEach((n) => {
    const t = Number(n.dataset.since);
    n.textContent = t ? (n.classList.contains('age') ? _t(' · {t} 전', { t: dur(t) }) : dur(t)) : '';
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
  // 드래그 이미지가 찍힌 뒤 흐리게 · 카드와 휴지통 말고는 어둡게(body.card-drag)
  // 바로 놓으면 dragend 가 이 프레임보다 먼저 와 휴지통이 남았다 — 아직 끄는 중일 때만
  requestAnimationFrame(() => { if (dragEl === n) { n.classList.add('dragging'); trashEl.classList.add('show'); document.body.classList.add('card-drag'); } });
});
nodesEl.addEventListener('dragover', (e) => {
  if (memoDrag) return memoDragOver(e);
  if (!dragEl) return;
  e.preventDefault();
  const over = e.target.closest('.node');
  // repo 별로 묶여 있으면 다른 묶음으로는 옮기지 않는다 — 놓아도 다시 그릴 때 제 묶음으로 돌아간다
  if (!over || over === dragEl || over.dataset.repo !== dragEl.dataset.repo) return;
  const r = over.getBoundingClientRect();
  // 같은 줄이면 좌우 절반, 줄이 다르면 위아래 절반으로 앞/뒤 판정
  const sameRow = Math.abs(r.top - dragEl.getBoundingClientRect().top) < r.height / 2;
  const after = sameRow ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
  const ref = after ? over.nextSibling : over;
  if (ref !== dragEl && dragEl.nextSibling !== ref) {
    nodesEl.insertBefore(dragEl, ref);
    layoutRepoGroups(); // 묶음 보기에선 칸을 직접 지정하므로 DOM 순서만 바꿔서는 자리가 안 바뀐다
    requestAnimationFrame(drawTraces);
  }
});
nodesEl.addEventListener('drop', (e) => { e.preventDefault(); if (memoDrag) memoDrop(e); });
nodesEl.addEventListener('dragleave', (e) => {
  const n = e.target.closest?.('.node');
  if (n && !n.contains(e.relatedTarget)) n.classList.remove('dropping');
});
nodesEl.addEventListener('dragend', () => endNodeDrag());
function endNodeDrag() {
  trashEl.classList.remove('show', 'over');
  document.body.classList.remove('card-drag');
  if (!dragEl) return;
  dragEl.classList.remove('dragging');
  dragEl = null;
  const order = [...nodesEl.querySelectorAll('.node')].map((n) => n.dataset.name).filter(Boolean);
  state.order = order; // 서버 응답 전 깜빡임 방지
  api('/api/order', { order });
  requestAnimationFrame(drawTraces);
}
// 끄는 도중 상태 갱신으로 카드·칩이 다시 그려져 DOM 에서 빠지면 dragend 가 떨어진 노드에서 나 위로 올라오지 않는다 → 휴지통이 남았다.
// 끄는 동안엔 mousemove 가 오지 않으므로, 끌기 표시가 남은 채 마우스가 움직이면 끌기가 끝난 것으로 정리
document.addEventListener('mousemove', () => {
  if (dragEl) endNodeDrag();
  else if (dockDrag) endDockDrag();
  else if (trashEl.classList.contains('show')) { trashEl.classList.remove('show', 'over'); document.body.classList.remove('card-drag'); }
}, { passive: true });

// ---------- 휴지통: 칩을 끌기 시작하면 위에 뜨고, 놓으면 제거 ----------
// 워커 칩은 상세의 '제거'와 같고(실행 중이면 세션 종료), 대기실 칩은 저장된 역할 삭제와 같다. 둘 다 확인을 받는다
const trashEl = $('#trash');
trashEl.addEventListener('dragover', (e) => { if (!dragEl && !dockDrag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; trashEl.classList.add('over'); });
trashEl.addEventListener('dragleave', (e) => { if (!trashEl.contains(e.relatedTarget)) trashEl.classList.remove('over'); });
trashEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const n = dragEl || dockDrag; // 카드 또는 최소화 칩
  if (n) removeCard(n);
});
// 카드·칩 제거 — 휴지통에 놓거나 터치 기기의 카드 메뉴에서
async function removeCard(n) {
  if (n.classList.contains('socket')) {
    // 대기실 카드 한 장이 같은 이름의 종료된 워커 기록들을 대신 보여 주고 있었다 → 역할과 함께 그 기록도 지운다(서버). 미리 알려 준다
    const name = n.dataset.profile;
    if (!name) return;
    const past = state.workers.filter((w) => w.name === name && w.status === 'exited');
    const body = _t('"{name}" 역할을 목록에서 지울까요?', { name }) + (past.length ? `\n${_t('지난 기록(종료된 워커 {n}개: {ids})도 함께 지웁니다. 대화 기록은 남아 claude --resume 으로 이어받을 수 있어요.', { n: past.length, ids: past.map((w) => w.id).join(', ') })}` : '');
    if (!(await ask({ title: _t('저장된 역할 삭제'), body, ok: _t('삭제'), danger: true }))) return;
    await api('/api/profiles/delete', { name });
    if (past.some((w) => w.id === selected)) { selected = null; render(); }
    return;
  }
  const w = state.workers.find((x) => x.id === n.dataset.id);
  if (!w) return;
  const running = w.status !== 'exited';
  if (!(await ask({ title: _t('"{name}" 워커를 제거할까요?', { name: w.name }), body: _t(running ? '목록에서 지웁니다. 실행 중인 Claude 세션도 종료됩니다.' : '목록에서 지웁니다.'), ok: _t('제거'), danger: true }))) return;
  await api(`/api/workers/${w.id}/remove`);
  if (selected === w.id) { selected = null; render(); }
}

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
  if (act === 'more') { cardMenu(node); return; } // 터치 기기의 ⋯ (아래 '모바일')
  if (node.classList.contains('socket')) {
    const p = state.profiles.find((x) => x.name === node.dataset.profile);
    if (!p) return;
    if (act === 'launch') launchProfile(p.name, e.shiftKey);
    if (act === 'forget' && await ask({ title: _t('저장된 역할 삭제'), body: _t('"{name}" 역할을 목록에서 지울까요?', { name: p.name }), ok: _t('삭제'), danger: true })) api('/api/profiles/delete', { name: p.name });
    return;
  }
  // 이미 열린 카드를 다시 누르면 닫는다. 이름 더블클릭(이름 변경)의 첫 클릭에 닫히지 않게 잠깐 기다렸다가 —
  // 그 사이 두 번째 클릭이 오면 취소. 캡처 썸네일·이름 입력창을 누른 건 닫지 않는다
  if (node.dataset.id === selected && !$('#detail').hidden) {
    if (e.detail > 1) { clearTimeout(closeTimer); return; }
    if (e.target.closest('[data-shot], input.rename') || node.classList.contains('renaming')) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (selected === node.dataset.id && !node.classList.contains('renaming')) closeDetail(); }, 300);
    return;
  }
  select(node.dataset.id);
});
let closeTimer = null;

$('#inbox').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('.decision').dataset.id;
  let act = btn.dataset.act, message;
  if (act === 'deny-msg') {
    message = await ask({ title: _t('거부 사유'), body: _t('Claude 에게 그대로 전달됩니다.'), ok: _t('거부'), danger: true, input: '' });
    if (message === null) return;
    act = 'deny';
  }
  btn.closest('.decision').style.opacity = .5;
  if (act === 'allow') mgrOnApprove();
  await api(`/api/decisions/${id}`, { behavior: act, message });
});

const newForm = $('#new-form');
// 워커 추가 창 — 회로 기판 끝의 '워커 추가' 카드·최소화 칩 줄 끝의 + 칩·안내의 버튼이 연다(예전엔 헤더의 + 워커)
function toggleNewPanel(open = $('#new-panel').hidden) {
  const panel = $('#new-panel');
  panel.hidden = !open;
  $('#new-back').hidden = !open;
  for (const b of document.querySelectorAll('[data-new]')) b.classList.toggle('on', open);
  if (!open) return;
  if (!newForm.cwd.value && state.recentCwds[0]) newForm.cwd.value = state.recentCwds[0];
  // 헤더 바로 아래에 겹쳐 띄운다 — 헤더 높이는 폭(버튼 줄바꿈)에 따라 달라서 열 때마다 잰다
  const top = Math.round($('.topbar').getBoundingClientRect().bottom) + 12;
  panel.style.top = `${top}px`;
  panel.style.setProperty('--np-top', `${top}px`);
  newForm.name.focus({ preventScroll: true });
}
document.addEventListener('click', (e) => { if (e.target.closest?.('[data-new]')) toggleNewPanel(); });
$('#btn-cancel').onclick = () => toggleNewPanel(false);
// 어둡게 덮은 바깥을 누르거나 Esc 로 닫기 (최근 폴더 목록이 열려 있으면 Esc 는 그 목록부터 — 목록 쪽 처리에 맡김)
$('#new-back').addEventListener('click', () => toggleNewPanel(false));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || $('#new-panel').hidden || !recentPop.hidden || e.defaultPrevented) return;
  toggleNewPanel(false);
});
// 최근 작업 폴더 목록(최근 10개 — server.js recentCwdList). 브라우저 자동완성(datalist)은 입력칸에 채워 둔 경로와 맞는 것만
// 보여 줘서 사실상 하나만 떴고 Safari 는 잘 띄우지도 않았다 → ▾ 로 여는 목록. 입력칸에서 ↓ 로도 연다
const recentPop = $('#recent-pop'), recentBtn = $('#btn-recent');
function setRecentPop(open) {
  if (open) {
    const cur = newForm.cwd.value.trim().toLowerCase();
    recentPop.innerHTML = state.recentCwds.length
      ? state.recentCwds.map((c) => {
        const name = c.split(/[\\/]/).filter(Boolean).pop() || c;
        return `<button type="button" class="recent-item${c.toLowerCase() === cur ? ' on' : ''}" role="option" data-cwd="${esc(c)}" title="${esc(c)}"><b>${esc(name)}</b><small>${esc(ltrPath(c))}</small></button>`;
      }).join('')
      : `<div class="recent-empty">${_t('아직 띄운 작업 폴더가 없습니다')}</div>`;
  }
  recentPop.hidden = !open;
  recentBtn.setAttribute('aria-expanded', String(open));
  if (open) (recentPop.querySelector('.on') || recentPop.querySelector('.recent-item'))?.focus();
}
recentBtn.onclick = () => setRecentPop(recentPop.hidden);
recentPop.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cwd]');
  if (!b) return;
  newForm.cwd.value = b.dataset.cwd;
  setRecentPop(false);
  newForm.cwd.focus();
});
recentPop.addEventListener('keydown', (e) => {
  const items = [...recentPop.querySelectorAll('.recent-item')], i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRecentPop(false); newForm.cwd.focus(); }
});
newForm.cwd.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && recentPop.hidden) { e.preventDefault(); setRecentPop(true); } });
document.addEventListener('pointerdown', (e) => { if (!recentPop.hidden && !e.target.closest('#recent-pop, #btn-recent')) setRecentPop(false); });
$('#btn-pick').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.classList.add('busy');
  try {
    const { path } = await api('/api/pick-folder', { start: newForm.cwd.value || state.recentCwds[0] || '' });
    if (path) newForm.cwd.value = path;
  } finally { btn.disabled = false; btn.classList.remove('busy'); }
};
newForm.onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, cwd: f.cwd.value, args: f.args.value, permissionMode: f.permissionMode.value, save: f.save.checked };
  const { id } = await api('/api/workers', body);
  f.name.value = ''; f.args.value = '';
  toggleNewPanel(false);
  select(id);
};

const taskForm = $('#task-form');
// 업무 지시·나중에 할 작업 입력칸: 쓴 줄 수만큼 높이가 늘고 줄어든다(최소 3줄 = rows,
// 옆 패널 높이의 30% 까지 늘고 그 뒤로는 칸 안에서 스크롤 — 두 칸이 다 늘어도 기본 높이(580px)에서 타임라인 최소 높이(120px)가 남게).
// 코드로 값을 바꾼 뒤에도 불러 준다
const GROW_MAX = 0.3;
function autoGrow(ta) {
  if (!ta.matches('.task-form textarea, .memo-form textarea')) return;
  ta.style.height = 'auto';
  const sideH = $('.side').clientHeight || innerHeight;
  const max = Math.max(ta.offsetHeight, Math.round(Math.min(sideH, innerHeight) * GROW_MAX));
  const h = ta.scrollHeight + ta.offsetHeight - ta.clientHeight; // + 테두리
  ta.style.height = `${Math.min(h, max)}px`;
  ta.style.overflowY = h > max ? 'auto' : 'hidden';
  syncAttach(ta);
}
for (const ta of document.querySelectorAll('.task-form textarea, .memo-form textarea')) ta.addEventListener('input', () => autoGrow(ta));
// 업무 지시 칸: 파일 드롭·붙여넣기 → 커서 위치에 경로 삽입
function insertAtCursor(ta, text) {
  const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
  const before = ta.value.slice(0, s), pad = before && !/\s$/.test(before) ? ' ' : '';
  ta.value = `${before}${pad}${text} ${ta.value.slice(e)}`;
  ta.selectionStart = ta.selectionEnd = before.length + pad.length + text.length + 1;
  autoGrow(ta);
  syncAttach(ta); // 수정 칸(.memo-edit)은 autoGrow 대상이 아니라 따로
  ta.focus();
}
// 파일 드롭·Ctrl+V 붙여넣기 → 커서 위치에 경로 삽입 (업무 지시 · 나중에 할 작업 공통)
function acceptFiles(ta) {
  dropZone(ta, (files) => attachFiles(files, (p) => insertAtCursor(ta, p)), (p) => insertAtCursor(ta, p));
  ta.addEventListener('paste', (e) => {
    const files = droppedFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    attachFiles(files, (p) => insertAtCursor(ta, p));
  });
}
acceptFiles(taskForm.text);
acceptFiles($('#memo-form').text);
taskForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = taskForm.text.value.trim();
  if (!text || !selected) return;
  const to = selected, ta = taskForm.text;
  // 서버가 CLI 입력창을 읽어 보는 동안(server.js cliDraft) 글을 비워 두면 플레이스홀더가 비쳤다가 실패 시 글이 되돌아온다 —
  // 답이 올 때까지 글을 그대로 두고 잠가 두었다가, 보냈으면 비운다
  if (ta.readOnly) return;
  ta.readOnly = true;
  const r = await api(`/api/workers/${to}/task`, { text });
  ta.readOnly = false;
  // 쉬는 워커의 CLI 입력창에 쓰던 글이 있거나 입력창이 아닌 화면(선택창·! 셸 모드)이면 서버가 보내지 않는다(대기열에도 안 넣음 — server.js assignTask).
  // 흔들림 = 전송 실패: 글은 입력 칸에 남겨 두고 알린다
  if (r?.rejected) {
    toast(r.rejected === 'starting' ? _t('전송 실패 — 워커가 아직 시작 중입니다. 준비되면 다시 보내세요') : r.rejected === 'blocked'
      ? _t('전송 실패 — CLI 가 입력 대기 화면이 아닙니다(선택창, ! 셸 모드 등). 입력창으로 돌아온 뒤 다시 보내세요')
      : _t('전송 실패 — CLI 입력창에 쓰던 글이 있습니다. 그 글을 보내거나 지운 뒤 다시 보내세요') + (r.seen ? ` · ${_t('감지한 글')}: "${r.seen}"` : ''), r.seen ? 8000 : 4500);
    shake(ta);
    return;
  }
  if (r?.error) return;
  ta.value = '';
  autoGrow(ta);
  ta.focus();
  flyToWorker(to, ta, 'task');
};
function shake(node) {
  node.classList.remove('shake');
  void node.offsetWidth; // 연달아 막혀도 매번 다시 흔들리게
  node.classList.add('shake');
  node.addEventListener('animationend', () => node.classList.remove('shake'), { once: true });
}
// 입력 칸 공통 키(키 세트는 아래 '전송·개행 키 세트'): 업무 지시·메모가 같은 함수를 써서 키 동작이 어긋나지 않게 한다
const submitOnEnter = (form) => onEnterKey(form.text, () => form.requestSubmit());
submitOnEnter(taskForm);
// ---------- 메모 (역할별, 자동 실행 안 됨) ----------
let memoSig = '';
// 메모 카드의 수정(연필)·Tasks 로 보내기(종이비행기) 아이콘 — 같은 모양의 버튼(.memo-ic)
const MEMO_EDIT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
const MEMO_SEND_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7z"/></svg>';
// 수정 중: 저장(체크)·취소(엑스) — 같은 모양의 아이콘 버튼
const MEMO_SAVE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7"/></svg>';
const MEMO_CANCEL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
function renderMemos(w) {
  const list = state.memos?.[w.name] || [];
  const sig = `${w.id}|${w.name}|${list.map((m) => `${m.id}:${m.text}`).join('|')}`; // 글도 넣어야 수정이 반영된다
  if (sig === memoSig) return; // 상태 갱신마다 다시 그리면 버튼 클릭이 끊긴다
  if ($('#memos li.editing') && sig.startsWith(`${w.id}|`)) return; // 수정 중엔 다시 그리지 않는다 — 끝나면 다음 갱신에 반영
  memoSig = sig;
  const fmt = (t) => fmtDate(t + clockSkew, DATE_MD_HM);
  $('#memos').innerHTML = list.length
    ? `<li class="mh">${_t('{n}건', { n: list.length })}</li>` + list.map((m) => `<li data-id="${m.id}" draggable="true" title="${_t('워커 카드에 끌어다 놓으면 그 워커의 Backlog 로 옮겨집니다')}"><span class="mt">${esc(m.text)}</span>${attachChips(m.text, 'sm')}
        <span class="ma"><time>${fmt(m.createdAt)}</time><button class="btn mini ghost memo-ic" data-memo="edit" title="${_t('내용 수정')}" aria-label="${_t('내용 수정')}">${MEMO_EDIT_SVG}</button><button class="btn mini ghost memo-ic" data-memo="send" title="${_t('Tasks 로 보내기 (작업 중이면 대기열)')}" aria-label="${_t('Tasks 로 보내기')}">${MEMO_SEND_SVG}</button><button class="btn mini ghost memo-ic" data-memo="remove" title="${_t('삭제')}" aria-label="${_t('삭제')}">${X_SVG}</button></span></li>`).join('')
    : ''; // 비어 있으면 아무것도 두지 않는다 — 업무 지시처럼 입력칸에서 섹션이 끝나 타임라인과의 간격이 같다
}
// 수정: 본문 자리에 입력칸을 띄운다. 키 세트의 전송 키로 저장 · Esc 취소 — 추가 칸과 같은 키
function editMemo(li, w) {
  if (li.classList.contains('editing')) return;
  const id = li.dataset.id, old = (state.memos?.[w.name] || []).find((m) => m.id === id)?.text ?? $('.mt', li).textContent;
  li.classList.add('editing');
  li.draggable = false; // 입력칸에서 글자를 끌어 선택할 수 있게
  const ta = el('<textarea class="memo-edit" rows="3"></textarea>');
  ta.value = old;
  // 안내 글은 .me-hint — 전역 .hint(빈 화면 안내, 위아래 큰 여백)와 이름이 겹치면 수정 칸 아래가 텅 빈다
  const bar = el(`<span class="ma"><span class="me-hint">${_t(keySet === '2' ? 'Enter 저장 · Esc 취소' : 'Alt(⌘)+Enter 저장 · Esc 취소')}</span><button class="btn mini ghost memo-ic" data-edit="save" title="${_t('저장')}" aria-label="${_t('저장')}">${MEMO_SAVE_SVG}</button><button class="btn mini ghost memo-ic" data-edit="cancel" title="${_t('취소')}" aria-label="${_t('취소')}">${MEMO_CANCEL_SVG}</button></span>`);
  const keep = [...li.children];
  keep.forEach((c) => (c.hidden = true));
  li.append(ta, bar);
  syncAttach(ta); // 입력칸과 버튼 줄 사이에 첨부 타일
  ta.addEventListener('input', () => syncAttach(ta));
  acceptFiles(ta);
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  const done = () => { ta.nextElementSibling?.classList.contains('att-live') && ta.nextElementSibling.remove(); ta.remove(); bar.remove(); keep.forEach((c) => (c.hidden = false)); li.classList.remove('editing'); li.draggable = true; memoSig = ''; renderMemos(w); };
  const save = async () => {
    const text = ta.value.trim();
    if (text === old.trim()) return done();
    if (!text) { toast(_t('내용이 비었습니다 — 지우려면 ✕'), 2400); return; }
    li.classList.add('busy');
    const r = await api('/api/memos', { role: w.name, op: 'edit', id, text });
    li.classList.remove('busy');
    if (r.error) { toast(r.error, 3000); return; }
    const m = (state.memos?.[w.name] || []).find((x) => x.id === id);
    if (m) m.text = text; // 서버 상태가 오기 전에 바로 보이게
    done();
  };
  onEnterKey(ta, save);
  ta.addEventListener('keydown', (e) => {
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
submitOnEnter(memoForm); // 업무 지시 칸과 같은 키
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
// 최소화(회로 기판 숨김) 중엔 헤더 아래 칩·매니저가 연출의 출발·도착점 — 숨은 카드는 크기가 0 이라 화면 왼쪽 위로 날아갔다
const floorMin = () => $('#floor').hidden;
const workerAvatar = (id) => (floorMin() ? dockEls : nodeEls).get(id)?.querySelector('.avatar');
const managerEl = () => (floorMin() ? $('.brand-mark') : $('.core-dot'));
function flyToWorker(id, fromEl, kind) {
  const w = state.workers.find((x) => x.id === id), target = workerAvatar(id);
  if (!w || !target || !fromEl) return;
  const color = charId === 'clawd-white' ? 'var(--char-white)' : avatarColor(w.name) || 'var(--accent)';
  flyNote(fromEl, target, color, `fly-note ${kind}`, () => {
    const nd = (floorMin() ? dockEls : nodeEls).get(id);
    if (!nd?.isConnected) return;
    const stage = nd.querySelector('.stage') || nd;
    stage.style.setProperty('--fc', color);
    stage.classList.remove('got'); void stage.offsetWidth; stage.classList.add('got');
    setTimeout(() => stage.classList.remove('got'), 900);
  });
}
// 작업 완료 → 경험치: 반대 방향으로, 워커 카드의 캐릭터에서 금빛 구슬이 매니저 클로드로 날아가 '+N XP' 가 떠오른다
// reason: 'clear'(/clear) · 'cache'(턴 캐시 적중률, detail = %) · 없음(작업 완료). 잃은 경험치는 날아가지 않고 매니저 위에 빨갛게
const XP_REASON = { clear: () => ' · /clear', cache: (d) => ` · ${_t('캐시 {n}%', { n: d })}` };
function flyXpToManager(id, xp, reason, detail) {
  const from = workerAvatar(id), dot = managerEl();
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
    // 꼬리: 지난 프레임 위치에서 지금 위치까지 7px 간격으로 점을 떨군다 — 빠른 구간에서도 끊기지 않게.
    // 점(6px)이 겹칠 만큼만 — 더 촘촘하면 Safari 에서 빛나는 점 수백 개를 합성하느라 버벅이고 빛이 뭉개졌다
    const seg = Math.hypot(x - lastX, y - lastY), n = Math.max(1, Math.floor(seg / 7));
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
$('#memos').addEventListener('click', (e) => {
  const act = e.target.closest('[data-memo]')?.dataset.memo;
  const li = e.target.closest('li[data-id]');
  const w = state.workers.find((x) => x.id === selected);
  if (!act || !li || !w) return;
  memoAct(act, li, w);
});
async function memoAct(act, li, w) {
  if (act === 'edit') return editMemo(li, w);
  if (act === 'remove' && !(await ask({ title: _t('이 작업을 지울까요?'), body: li.querySelector('.mt')?.textContent.slice(0, 120) || '', ok: _t('지우기'), danger: true }))) return;
  li.classList.add('busy');
  const r = await api('/api/memos', { role: w.name, op: act, id: li.dataset.id, workerId: w.id });
  if (r.error) { li.classList.remove('busy'); toast(r.error, 3000); if (act === 'send') shake(li); return; } // 보내기 실패는 흔들림으로
  if (act === 'send') flyToWorker(w.id, li, 'task'); // 성공은 날아가는 쪽지로 알린다
}

// ---------- 메모 → 다른 워커 카드로 끌어 옮기기 ----------
// 카드 순서 변경 드래그(dragEl)와 섞이지 않게 따로 표시한다. dragover 중엔 dataTransfer 를 읽을 수 없어 변수로 들고 다닌다
// 놓을 곳: 워커 카드, 또는 카드를 최소화했을 때 헤더 아래 칩
let memoDrag = null;
const memoTargetName = (t) => t.classList.contains('dchip') ? state.workers.find((x) => x.id === t.dataset.id)?.name : t.dataset.name;
const memoTarget = (e) => {
  const n = e.target.closest?.('.node, .dchip');
  const name = n && memoTargetName(n);
  return name && name !== memoDrag.role ? n : null;
};
const clearMemoDrop = () => document.querySelectorAll('.node.dropping, .dchip.dropping').forEach((n) => n.classList.remove('dropping'));
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
  // 목록 안에서 자리를 옮겨 놓고 목록 밖(놓을 수 없는 곳)에서 끝났으면 원래 순서로 되돌린다
  if (memoDrag?.moved && !memoDrag.saved) { memoSig = ''; const w = state.workers.find((x) => x.id === selected); if (w) renderMemos(w); }
  memoDrag = null;
  clearMemoDrop();
});
// 같은 목록 안에서 끌면 순서 바꾸기 — 끄는 동안 자리를 바꿔 미리 보여 주고(칩 순서 바꾸기와 같은 방식), 목록 안에 놓으면 저장
$('#memos').addEventListener('dragover', (e) => {
  if (!memoDrag) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const over = e.target.closest?.('li[data-id]');
  if (!over || over === memoDrag.li) return;
  const r = over.getBoundingClientRect();
  const before = e.clientY < r.top + r.height / 2;
  if (before ? over.previousElementSibling !== memoDrag.li : over.nextElementSibling !== memoDrag.li) {
    over.parentNode.insertBefore(memoDrag.li, before ? over : over.nextElementSibling);
    memoDrag.moved = true;
  }
});
$('#memos').addEventListener('drop', (e) => {
  const d = memoDrag;
  if (!d) return;
  e.preventDefault();
  if (!d.moved) return;
  d.saved = true;
  const ids = [...$('#memos').querySelectorAll('li[data-id]')].map((li) => li.dataset.id);
  api('/api/memos', { role: d.role, op: 'reorder', ids });
});
function memoDragOver(e) {
  const n = memoTarget(e);
  if (!n) return; // 같은 역할 카드나 빈 곳에는 놓을 수 없다
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!n.classList.contains('dropping')) { clearMemoDrop(); n.classList.add('dropping'); }
}
async function memoDrop(e) {
  const n = memoTarget(e), d = memoDrag;
  if (!n) return;
  n.classList.remove('dropping');
  d.li.classList.add('busy');
  const to = memoTargetName(n);
  const r = await api('/api/memos', { role: d.role, op: 'move', id: d.id, to });
  if (r.error) { d.li.classList.remove('busy'); toast(r.error, 3000); }
  else toast(_t("'{name}' 의 Backlog 로 옮겼습니다", { name: to }));
}
const dockList = $('#dock-list');
// 칩 줄은 스크롤바를 숨겼다(style.css .dock-list) — 세로 휠을 가로 스크롤로
dockList.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || dockList.scrollWidth <= dockList.clientWidth) return;
  e.preventDefault();
  dockList.scrollLeft += e.deltaY;
}, { passive: false });
// 최소화한 칩 끌어서 순서 바꾸기 — 회로 기판 카드 드래그와 같은 방식(끄는 동안 DOM 자리를 바꿔 미리 보여 주고, 놓으면 저장)
dockList.addEventListener('dragstart', (e) => {
  const c = e.target.closest?.('.dchip');
  if (!c) { e.preventDefault(); return; } // 썸네일 이미지·링크는 끌지 않는다
  dockDrag = c;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', c.dataset.name || '');
  requestAnimationFrame(() => { if (dockDrag === c) { c.classList.add('dragging'); trashEl.classList.add('show'); document.body.classList.add('card-drag'); } }); // 카드 끌기와 같은 휴지통·어둡게
});
dockList.addEventListener('dragover', (e) => {
  if (memoDrag) return memoDragOver(e);
  if (!dockDrag) return;
  e.preventDefault();
  const over = e.target.closest('.dslot'), slot = dockDrag.parentElement;
  if (!over || over === slot) return;
  const r = over.getBoundingClientRect();
  const ref = e.clientX > r.left + r.width / 2 ? over.nextSibling : over;
  if (ref !== slot && slot.nextSibling !== ref) dockList.insertBefore(slot, ref);
});
dockList.addEventListener('dragend', () => endDockDrag());
function endDockDrag() {
  trashEl.classList.remove('show', 'over');
  document.body.classList.remove('card-drag');
  if (!dockDrag) return;
  dockDrag.classList.remove('dragging');
  dockDrag = null;
  // 칩에는 대기실 슬롯이 없다 — 회로 기판 순서에서 칩에 있는 이름 자리만 칩 순서대로 채우고, 슬롯 자리는 그대로 둔다
  const chips = [...new Set([...dockList.querySelectorAll('.dchip')].map((c) => c.dataset.name).filter(Boolean))];
  const inDock = new Set(chips);
  const floor = [...new Set([...nodesEl.querySelectorAll('.node')].map((n) => n.dataset.name).filter(Boolean))];
  let k = 0;
  const order = floor.map((name) => (inDock.has(name) ? chips[k++] : name));
  for (; k < chips.length; k++) if (!order.includes(chips[k])) order.push(chips[k]);
  state.order = order; // 서버 응답 전 깜빡임 방지
  renderFloor(); // 펼쳤을 때도 같은 순서로
  renderDock();
  api('/api/order', { order });
}
dockList.addEventListener('drop', (e) => { if (memoDrag) { e.preventDefault(); memoDrop(e); } });
dockList.addEventListener('dragleave', (e) => {
  const c = e.target.closest?.('.dchip');
  if (c && !c.contains(e.relatedTarget)) c.classList.remove('dropping');
});

$('#queue').addEventListener('click', (e) => {
  if (e.target.closest('[data-resume]') && selected) { api(`/api/workers/${selected}/resume`, {}); return; }
  // ✕ 빼기 · ↩ 나중에 할 작업으로 — 번호와 함께 글도 보내, 그사이 CLI 로 나간 지시면 서버가 거절한다(두 번 실행 방지)
  const b = e.target.closest('[data-unqueue], [data-tomemo]');
  const w = b && selected && state.workers.find((x) => x.id === selected);
  if (!w) return;
  const op = b.dataset.tomemo != null ? 'tomemo' : 'unqueue', i = Number(b.dataset.tomemo ?? b.dataset.unqueue);
  b.disabled = true;
  fetch(`/api/workers/${w.id}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: i, text: w.queue[i] }) })
    .then((r) => { if (r.status === 409) toast(_t('이미 CLI 로 보낸 지시라 옮기지 못했어요')); else if (op === 'tomemo' && r.ok) toast(_t('Backlog 로 옮겼어요')); })
    .catch(() => { b.disabled = false; });
});

// 역할별 대기열 자동 투입 켜기/끄기 (server.js config.manualQueue)
$('#auto-queue').addEventListener('change', (e) => { if (selected) api(`/api/workers/${selected}/autoqueue`, { on: e.target.checked }); });

// ---------- 다크/라이트 테마 ----------
// 고른 테마는 브라우저에 기억한다(첫 그리기 전 적용은 index.html 머리의 짧은 스크립트). 터미널은 두 테마 모두 어둡다
// 좌우 스위치: 왼쪽 다크(🌙) · 오른쪽 라이트(☀), 기본 다크. 손잡이가 물방울처럼 — 움찔했다가 길게 늘어나 미끄러지고,
// 뒤에 남은 작은 방울이 끈적하게 이어져 따라오다 합쳐지며, 도착하면 납작해졌다 출렁이며 멈춘다(style.css, index.html 의 gooey 필터).
// 움직이는 동안 다시 누르면(클릭·Enter·Space) 무시한다 — 중간에 방향이 뒤집히며 상태와 위치가 어긋나지 않게
// ---------- 전송·개행 키 세트 (헤더 ⌨) ----------
// 1: Alt(⌘)+Enter 전송 · Enter 개행   2: Enter 전송 · Shift/Ctrl+Enter 개행 · ⌘(Alt)+Enter 는 아무 일도 안 함 (기본)
// 업무 지시·메모·메모 고치기·입력 확인 창·CLI 터미널이 모두 이 규칙을 따른다. 브라우저에 기억(am.keys)
const KEYS_KEY = 'am.keys';
// 기본은 2(Enter 전송). 예전엔 1 이 기본이라 저장값이 없었다 — 이제 1 을 고른 사람만 '1' 로 남긴다
let keySet = '2';
try { if (localStorage.getItem(KEYS_KEY) === '1') keySet = '1'; } catch {}
// Enter 가 할 일: 'send' | 'newline' | null(아무 일도 안 함)
function enterAction(e) {
  if (keySet === '2') return e.metaKey || e.altKey ? null : e.shiftKey || e.ctrlKey ? 'newline' : 'send';
  return e.altKey || e.metaKey ? 'send' : 'newline';
}
// 입력 칸의 Enter. 한글 조합 중 Enter 는 입력기가 글자를 확정하는 키라 그 keydown 은 막지 않는다(막으면 확정이 깨진다).
// 맥 Chrome 은 조합 확정 keydown(229) 뒤에 Enter keydown 을 한 번 더 보내고, Safari 는 확정과 함께 줄바꿈까지 넣는다 →
// 전송은 잠깐(40ms) 미뤄 한 번만 하고, 그사이 확정된 마지막 글자까지 담는다(끝에 붙은 줄바꿈은 보내는 쪽이 trim 으로 버린다)
function onEnterKey(ta, send) {
  let timer = null;
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // 터치 기기의 입력칸: Enter 는 늘 줄바꿈(화면 키보드엔 보조키가 없어 전송은 칸의 ↑ 버튼). 외장 키보드의 Alt·⌘+Enter 는 전송
    const composing = e.isComposing || e.keyCode === 229, act = TOUCH ? (e.altKey || e.metaKey ? 'send' : 'newline') : enterAction(e);
    if (act === 'send') {
      if (!composing) e.preventDefault();
      timer ??= setTimeout(() => { timer = null; send(); }, 40);
      return;
    }
    if (composing) return;
    if (!act) { e.preventDefault(); return; }
    // 그냥·Shift+Enter 는 칸이 알아서 줄을 바꾼다. Ctrl·Alt·⌘+Enter 는 안 바꿔서 직접 넣는다(execCommand 라 ⌘Z 로 되돌릴 수 있다)
    if (e.ctrlKey || e.altKey || e.metaKey) { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
  });
}
onEnterKey($('#ask-input'), () => $('#ask-modal [data-ask="ok"]').click());
const KEY_SETS = [
  { id: '1', send: 'Alt(⌘)+Enter', newline: 'Enter' },
  { id: '2', send: 'Enter', newline: 'Shift/Ctrl+Enter' },
];
// 입력 칸 안내 문구도 키 세트대로
function applyKeyHints() {
  const k = KEY_SETS.find((x) => x.id === keySet);
  const hint = (verb) => `${_t(verb)} : ${k.send}\n${_t('개행')} : ${k.newline}\n${_t('*CLI에서도 동일하게 작동')}`;
  // 터치 기기는 화면 키보드에 Alt·⌘ 가 없다 — 입력칸 오른쪽 아래 버튼으로 보낸다(Enter 는 줄바꿈)
  taskForm.text.placeholder = TOUCH ? _t('지시를 적고 ↑ 를 누르면 보냅니다') : hint('전송');
  $('#memo-form').text.placeholder = TOUCH ? _t('적고 + 를 누르면 추가됩니다') : hint('추가');
  $('#cv-keys').textContent = TOUCH ? _t('↑ 를 누르면 보냅니다') : `${_t('전송')} ${k.send} · ${_t('개행')} ${k.newline}`;
}
applyKeyHints();
document.addEventListener('langchange', applyKeyHints);
const keysBtn = $('#btn-keys'), keysPop = $('#keys-pop');
function renderKeysPop() {
  keysPop.innerHTML = `<div class="pop-h">${_t('전송·개행 키')}</div>` + KEY_SETS.map((k) => {
    const on = k.id === keySet;
    return `<button class="lang-item keys-item${on ? ' on' : ''}" role="menuitemradio" aria-checked="${on}" data-keys="${k.id}">
      <span class="lang-check" aria-hidden="true">${on ? '✓' : ''}</span><span class="keys-desc"><span>${_t('전송')} <kbd>${k.send}</kbd></span><span>${_t('개행')} <kbd>${k.newline}</kbd></span></span></button>`;
  }).join('');
}
function setKeysPop(open) {
  keysPop.hidden = !open;
  keysBtn.setAttribute('aria-expanded', String(open));
  if (open) { setLangPop(false); setCharPop(false); setPowerPop(false); if (!updPop.hidden) setUpdPop(false); renderKeysPop(); keysPop.querySelector('.keys-item.on')?.focus(); }
}
keysBtn.addEventListener('click', () => setKeysPop(keysPop.hidden));
keysPop.addEventListener('click', (e) => {
  const b = e.target.closest('[data-keys]');
  if (!b || b.dataset.keys === keySet) return;
  keySet = b.dataset.keys;
  try { keySet === '2' ? localStorage.removeItem(KEYS_KEY) : localStorage.setItem(KEYS_KEY, keySet); } catch {}
  applyKeyHints();
  setKeysPop(false);
  keysBtn.focus();
});
document.addEventListener('click', (e) => { if (!keysPop.hidden && !e.target.closest('.keys-wrap')) setKeysPop(false); });
document.addEventListener('keydown', (e) => {
  if (keysPop.hidden) return;
  if (e.key === 'Escape') { setKeysPop(false); keysBtn.focus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...keysPop.querySelectorAll('.keys-item')], i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});

// ---------- 언어 (헤더 🌐) ----------
// 누르면 작은 목록이 열린다. 지금 언어는 ✓ 로 표시만 하고 눌러도 아무 일도 없다(setLang 이 같은 언어면 무시)
const langBtn = $('#btn-lang'), langPop = $('#lang-pop');
function renderLangPop() {
  langPop.innerHTML = LANGS.map(([k, name]) => `<button class="lang-item${k === LANG ? ' on' : ''}" role="menuitemradio" aria-checked="${k === LANG}" lang="${k}" data-lang="${k}">
    <span class="lang-check" aria-hidden="true">${k === LANG ? '✓' : ''}</span>${name}</button>`).join('');
}
function setLangPop(open) {
  langPop.hidden = !open;
  langBtn.setAttribute('aria-expanded', String(open));
  if (open) { if (!updPop.hidden) setUpdPop(false); setCharPop(false); setPowerPop(false); renderLangPop(); langPop.querySelector('.lang-item.on')?.focus(); }
}
langBtn.addEventListener('click', () => setLangPop(langPop.hidden));
langPop.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]');
  if (!b || b.dataset.lang === LANG) return; // 이미 그 언어 — 반응하지 않음 (목록도 그대로)
  setLangPop(false);
  setLang(b.dataset.lang);
  langBtn.focus();
});
document.addEventListener('click', (e) => { if (!langPop.hidden && !e.target.closest('.lang-wrap')) setLangPop(false); });
document.addEventListener('keydown', (e) => {
  if (langPop.hidden) return;
  if (e.key === 'Escape') { setLangPop(false); langBtn.focus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...langPop.querySelectorAll('.lang-item')], i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});
// ---------- 꾸미기 (헤더 👕): 캐릭터 · 테마 ----------
// 테마 = 오리지널(style.css 그대로) + 사용자가 프로젝트 themes/<id>/ 에 넣은 테마. 고르면 그 theme.css 를 style.css 뒤에 붙이고
// html[data-skin=<id>] 를 단다. 브라우저에 기억(am.skin) — index.html 머리 스크립트가 첫 화면부터 붙인다.
// theme.json 의 mode(light/dark)가 있으면 고를 때 그 모드로 넘어간다. 만드는 법은 themes/README.md
const SKIN_KEY = 'am.skin';
function themeLink(t) {
  let link = document.getElementById('user-theme');
  if (!t) { link?.remove(); return; }
  if (!link) { link = document.createElement('link'); link.rel = 'stylesheet'; link.id = 'user-theme'; link.addEventListener('load', applyScheme); document.head.appendChild(link); }
  const href = `/themes/${encodeURIComponent(t.id)}/theme.css?v=${encodeURIComponent(t.rev || '')}`;
  if (link.getAttribute('href') !== href) link.setAttribute('href', href); // theme.css 를 고치면 rev 가 바뀌어 다시 읽는다
}
function setSkin(id) {
  const root = document.documentElement, t = userThemes.find((x) => x.id === id);
  if (t) root.dataset.skin = t.id; else delete root.dataset.skin;
  themeLink(t);
  try { t ? localStorage.setItem(SKIN_KEY, t.id) : localStorage.removeItem(SKIN_KEY); } catch {}
  const light = root.dataset.theme === 'light';
  if (t?.mode && (t.mode === 'light') !== light) { applyTheme(t.mode === 'light'); setThemeSwitch(t.mode === 'light'); }
  else term.options.theme = termTheme(light);
}
// 서버 목록 받기 — 꾸미기 메뉴를 열 때마다 다시 읽어, 서버를 켜 둔 채 themes/ 에 폴더를 넣거나 theme.css 를 고쳐도 반영된다
async function loadThemes() {
  let list;
  try { const j = await (await fetch('/api/themes')).json(); list = j.themes; themeDir = j.dir || themeDir; } catch { return; }
  if (!Array.isArray(list)) return;
  userThemes = list;
  try { localStorage.setItem('am.themes', JSON.stringify(list)); } catch {}
  const cur = document.documentElement.dataset.skin;
  if (cur && !curTheme()) setSkin(''); // 폴더가 없어졌으면 오리지널로
  else if (cur) { themeLink(curTheme()); term.options.theme = termTheme(document.documentElement.dataset.theme === 'light'); }
  if (!charPop.hidden) renderCharPop();
}
// ---------- 내 테마 만들기 안내 ----------
// ① 예시를 복사해 새 테마 폴더 만들기(바로 적용) · themes 폴더 열기 ② 원하는 느낌을 적으면 워커에게 줄 요청문 만들기(복사 · 입력칸에 넣기)
// ---------- 글꼴 (꾸미기 → 글꼴) ----------
// 이 PC 에 설치된 글꼴 이름만 지정한다 — 글꼴 파일은 싣지 않는다. 브라우저에 기억(am.font.ui · am.font.term), 비우면 기본.
// 화면 글꼴은 --ui-family, CLI 글꼴은 터미널(xterm 은 CSS 를 따르지 않아 옵션으로)과 --mono(경로·시각 등 작은 고정폭 글자) 앞에 붙인다
const FONT_KEYS = { ui: 'am.font.ui', term: 'am.font.term', lh: 'am.font.lh' };
const BASE_UI = getComputedStyle(document.documentElement).getPropertyValue('--ui-family').trim();
const BASE_MONO = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();
function fontPrefs() {
  const get = (k) => { try { return (localStorage.getItem(k) || '').trim(); } catch { return ''; } };
  // CLI 행간(xterm lineHeight, 글자 높이의 배수) — 같은 글꼴도 PC(화면 배율·글꼴 파일)마다 줄 사이가 달라 보여 PC 마다 맞춘다
  const lh = Number(get(FONT_KEYS.lh));
  return { ui: get(FONT_KEYS.ui), term: get(FONT_KEYS.term), lh: lh >= 1 && lh <= 2 ? lh : 1 };
}
const fontStack = (name, base) => (name ? `"${name.replace(/["\\;{}]/g, '')}", ${base}` : base);
function applyFonts() {
  const f = fontPrefs(), root = document.documentElement.style;
  if (f.ui) root.setProperty('--ui-family', fontStack(f.ui, BASE_UI)); else root.removeProperty('--ui-family');
  if (f.term) root.setProperty('--mono', fontStack(f.term, BASE_MONO)); else root.removeProperty('--mono');
  const fam = fontStack(f.term, BASE_MONO);
  let refit = false;
  if (term.options.fontFamily !== fam) { term.options.fontFamily = fam; refit = true; }
  if (term.options.lineHeight !== f.lh) { term.options.lineHeight = f.lh; refit = true; } // 줄 높이가 바뀌면 한 화면 줄 수도 바뀐다
  if (refit) requestAnimationFrame(() => fitTerm(true));
}
applyFonts();
const fontModal = $('#font-modal');
function openFontSet() {
  const f = fontPrefs();
  $('#fs-ui').value = f.ui; $('#fs-term').value = f.term;
  $('#fs-lh').value = f.lh; $('#fs-lh-val').textContent = f.lh.toFixed(2);
  renderSchemeSel(); loadWtSchemes();
  fontModal.hidden = false;
  if (!fontNames.length) loadFontNames(false);
  requestAnimationFrame(() => $('#fs-ui').focus());
}
function closeFontSet() { setFontPop(null); fontModal.hidden = true; charBtn.focus(); }
function saveFont(which, v) {
  try { v ? localStorage.setItem(FONT_KEYS[which], v) : localStorage.removeItem(FONT_KEYS[which]); } catch {}
  applyFonts();
}
// 글꼴 목록 — 브라우저 자동완성(datalist)은 입력칸에 이미 적힌 이름과 맞는 것만 보여 줘서, 이름이 들어 있으면 목록이 사실상 안 떴다
// → 직접 그리는 목록: 입력칸을 누르면(클릭·↓ — 창을 열 때 자동 포커스로는 펼치지 않음) 전체를 보이고 지금 이름에 맞춰 스크롤, 글자를 치면 그 글자가 든 이름만.
// 이름마다 그 글꼴로 그린다. 목록은 '불러오기'(Local Font Access) 뒤에 생기고, 이미 허락한 브라우저면 창을 열 때 바로 읽는다
let fontNames = [], fontPopFor = null, fontHl = -1;
const fontPop = $('#fs-pop');
async function loadFontNames(ask) {
  if (!window.queryLocalFonts) { if (ask) toast(_t('이 브라우저는 글꼴 목록을 못 불러와요 — 이름을 직접 적어 주세요'), 4000); return; }
  try {
    if (!ask && (await navigator.permissions?.query({ name: 'local-fonts' }).catch(() => null))?.state !== 'granted') return;
    fontNames = [...new Set((await window.queryLocalFonts()).map((x) => x.family))].sort((a, b) => a.localeCompare(b));
    if (ask) toast(_t('글꼴 {n}개 — 입력 칸을 누르면 골라 쓸 수 있어요', { n: fontNames.length }), 3500);
  } catch { if (ask) toast(_t('글꼴 목록 권한이 거절됐어요 — 이름을 직접 적어 주세요'), 4000); }
}
function setFontPop(input, filter = '') {
  if (!input || !fontNames.length) { fontPop.hidden = true; fontPopFor = null; return; }
  const q = filter.trim().toLowerCase(), cur = input.value.trim().toLowerCase();
  const list = q ? fontNames.filter((n) => n.toLowerCase().includes(q)) : fontNames;
  if (!list.length) { fontPop.hidden = true; fontPopFor = null; return; }
  if (fontPop.parentElement !== input.parentElement) input.parentElement.append(fontPop);
  fontPop.innerHTML = list.map((n) => `<button type="button" class="recent-item${n.toLowerCase() === cur ? ' on' : ''}" role="option" tabindex="-1" data-font="${esc(n)}" style="font-family:&quot;${esc(n.replace(/["\\;{}]/g, ''))}&quot;, var(--ui-family)">${esc(n)}</button>`).join('');
  fontPop.hidden = false; fontPopFor = input; fontHl = -1;
  fontPop.querySelector('.on')?.scrollIntoView({ block: 'center' });
}
function pickFont(name) {
  const input = fontPopFor;
  if (!input) return;
  input.value = name; saveFont(input.id === 'fs-ui' ? 'ui' : 'term', name);
  setFontPop(null); input.focus();
}
for (const id of ['fs-ui', 'fs-term']) {
  const el = $('#' + id);
  el.addEventListener('input', () => { saveFont(id === 'fs-ui' ? 'ui' : 'term', el.value.trim()); setFontPop(el, el.value); });
  el.addEventListener('click', () => { if (fontPopFor !== el) setFontPop(el); });
  el.addEventListener('blur', () => setTimeout(() => { if (fontPopFor === el && !fontPop.contains(document.activeElement)) setFontPop(null); }, 150));
  el.addEventListener('keydown', (e) => {
    const items = [...fontPop.querySelectorAll('.recent-item')];
    if (e.key === 'ArrowDown' && fontPopFor !== el) { e.preventDefault(); setFontPop(el); return; }
    if (fontPopFor !== el || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (fontHl < 0) fontHl = Math.max(0, items.findIndex((b) => b.classList.contains('on')));
      else fontHl = (fontHl + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((b, i) => b.classList.toggle('hl', i === fontHl));
      items[fontHl].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && fontHl >= 0) { e.preventDefault(); pickFont(items[fontHl].dataset.font); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setFontPop(null); }
  });
}
// CLI 색 구성표 목록 — 기본은 앱 테마, 그 밑에 Windows Terminal 기본 구성표, 서버 PC 의 Windows Terminal 구성표(있으면)
let wtLocal = [];
const schemeAll = () => [...WT_SCHEMES, ...wtLocal];
function renderSchemeSel() {
  const sel = $('#fs-scheme'), cur = termScheme()?.name || '';
  const opt = (s, g) => `<option value="${g}:${esc(s.name)}"${s.name === cur ? ' selected' : ''}>${esc(s.name)}</option>`;
  sel.innerHTML = `<option value=""${cur ? '' : ' selected'}>${esc(_t('기본 (앱 테마 색)'))}</option>`
    + `<optgroup label="${esc(_t('Windows Terminal 기본'))}">${WT_SCHEMES.map((s) => opt(s, 'wt')).join('')}</optgroup>`
    + (wtLocal.length ? `<optgroup label="${esc(_t('이 PC 의 Windows Terminal'))}">${wtLocal.map((s) => opt(s, 'pc')).join('')}</optgroup>` : '');
  // 지금 구성표가 목록에 없으면(다른 PC 에서 고른 것 등) 그 이름으로 한 줄 남긴다
  if (cur && !schemeAll().some((s) => s.name === cur)) sel.insertAdjacentHTML('beforeend', `<option value="keep" selected>${esc(cur)}</option>`);
  renderSchemeSwatch();
}
function renderSchemeSwatch() {
  const sc = termScheme(), t = sc ? schemeTheme(sc) : termTheme(document.documentElement.dataset.theme === 'light');
  const keys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  $('#fs-scheme-prev').style.cssText = `background:${t.background || ''};color:${t.foreground || ''}`;
  $('#fs-scheme-prev').innerHTML = `<span>❯ claude</span>` + keys.map((k) => `<i style="background:${t[k] || 'transparent'}" title="${k}"></i>`).join('');
}
async function loadWtSchemes() {
  try { const j = await (await fetch('/api/term-schemes')).json(); wtLocal = Array.isArray(j.schemes) ? j.schemes.filter((s) => hexOk(s.background) && !WT_SCHEMES.some((w) => w.name === s.name)) : []; } catch { wtLocal = []; }
  if (!fontModal.hidden) renderSchemeSel();
}
$('#fs-scheme').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v === 'keep') return;
  const [g, ...rest] = v.split(':'), name = rest.join(':');
  const s = v ? (g === 'pc' ? wtLocal : WT_SCHEMES).find((x) => x.name === name) : null;
  try { s ? localStorage.setItem(SCHEME_KEY, JSON.stringify(s)) : localStorage.removeItem(SCHEME_KEY); } catch {}
  applyScheme();
  term.options.theme = termTheme(document.documentElement.dataset.theme === 'light');
  renderSchemeSwatch();
});
$('#fs-lh').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('#fs-lh-val').textContent = v.toFixed(2);
  saveFont('lh', v === 1 ? '' : String(v));
});
fontPop.addEventListener('mousedown', (e) => e.preventDefault()); // 입력칸 포커스를 뺏지 않게(blur 로 닫히지 않게)
fontPop.addEventListener('click', (e) => { const b = e.target.closest('[data-font]'); if (b) pickFont(b.dataset.font); });
fontModal.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-fs]')?.dataset.fs;
  if (e.target === fontModal || act === 'close') { closeFontSet(); return; }
  if (act === 'reset') { setFontPop(null); $('#fs-ui').value = ''; $('#fs-term').value = ''; saveFont('ui', ''); saveFont('term', ''); $('#fs-lh').value = 1; $('#fs-lh-val').textContent = '1.00'; saveFont('lh', '');
    try { localStorage.removeItem(SCHEME_KEY); } catch {}
    applyScheme(); term.options.theme = termTheme(document.documentElement.dataset.theme === 'light'); renderSchemeSel(); return; }
  if (act === 'load') {
    // Chrome·Edge 의 Local Font Access — 처음 한 번 브라우저가 권한을 묻는다. 없거나 거절하면 이름을 직접 적는다
    await loadFontNames(true);
  }
});
fontModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeFontSet(); } });
const themeModal = $('#theme-modal');
const tgId = () => $('#tg-id').value.trim();
function tgFail(m) { const el = $('#tg-err'); el.textContent = m; el.hidden = !m; }
function openThemeGuide() {
  tgFail('');
  themeModal.hidden = false;
  loadThemes();
  requestAnimationFrame(() => $('#tg-id').focus());
}
function closeThemeGuide() { themeModal.hidden = true; charBtn.focus(); }
function themePrompt() {
  const id = THEME_ID_RE.test(tgId()) ? tgId() : 'my-theme', mood = $('#tg-mood').value.trim() || _t('멋진 나만의');
  const dir = themeDir ? `${themeDir.replace(/[\\/]+$/, '')}/${id}` : `themes/${id}`;
  return _t('클로드 키우기(이 대시보드)의 사용자 테마를 만들어 줘. 먼저 {readme} 를 읽고 그 규칙대로, "{mood}" 느낌의 테마를 {dir}/ 폴더에 만들어 줘. 폴더가 없으면 {example} 을 복사해서 시작하고, theme.json(name · swatch · mode · terminal)과 theme.css 를 채워 줘. 색 변수 위주로 바꾸고, 배경은 .theme-bg 를 꾸며 줘. 글자가 잘 읽히고 작업 중 · 결정 대기 · 완료 상태색이 서로 구분되게 해 줘. 다 되면 👕 꾸미기 → 테마에서 고르면 된다고 알려 줘.', {
    readme: themeDir ? `${themeDir.replace(/[\\/]+$/, '')}/README.md` : 'themes/README.md', mood, dir, example: themeDir ? `${themeDir.replace(/[\\/]+$/, '')}/_example` : 'themes/_example',
  });
}
const THEME_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
themeModal.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-tg]')?.dataset.tg;
  if (e.target === themeModal || a === 'close') return closeThemeGuide();
  if (!a) return;
  tgFail('');
  if (a === 'create') {
    const id = tgId();
    if (!THEME_ID_RE.test(id)) { $('#tg-id').focus(); return tgFail(_t('이름은 영문 · 숫자 · - · _ 로, 영문이나 숫자로 시작해 주세요')); }
    const r = await fetch('/api/themes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => null);
    const j = await r?.json().catch(() => ({}));
    if (r?.status === 409) return tgFail(_t('같은 이름의 테마가 이미 있어요'));
    if (!r?.ok || !j?.theme) return tgFail(_t('테마를 만들지 못했어요'));
    await loadThemes();
    setSkin(j.theme.id);
    themeModal.hidden = true;
    toast(_t('{dir} 을 만들고 적용했어요 — theme.css 를 고쳐 보세요', { dir: j.dir || `themes/${id}` }), 6000);
  } else if (a === 'open') {
    const r = await fetch('/api/themes/open', { method: 'POST' }).catch(() => null);
    if (!(await r?.json().catch(() => null))?.ok) tgFail(_t('폴더를 열지 못했어요'));
  } else if (a === 'copy') {
    try { await navigator.clipboard.writeText(themePrompt()); toast(_t('요청문을 복사했어요 — 워커 입력칸에 붙여넣으세요')); }
    catch { tgFail(_t('복사하지 못했어요')); }
  } else if (a === 'send') {
    const ta = taskForm?.text;
    if (!selected || !ta || $('#detail').hidden) return tgFail(_t('먼저 워커 카드를 눌러 열어 주세요'));
    ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n${themePrompt()}` : themePrompt();
    ta.dispatchEvent(new Event('input'));
    themeModal.hidden = true;
    ta.focus();
    toast(_t('요청문을 입력칸에 넣었어요 — 확인하고 보내세요'));
  }
});
// 캡처 단계에서 처리하고 막는다 — Esc 가 터미널(=Claude 중단)로 새지 않게
themeModal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeThemeGuide(); }
}, true);
// ---------- 캐릭터 ----------
// 누르면 캐릭터 목록(머리 미리보기 + 이름)이 열린다. 고르면 화면의 캐릭터를 모두 새 캐릭터로 다시 그리고 브라우저에 기억(am.char).
// 맨 아래 '+ 캐릭터 추가' 로 그림을 올려 새 캐릭터를 만들고, 올린 캐릭터는 ✎ 로 고치고 ✕ 로 지운다(기본 클로드·흰 클로드는 그대로)
const charBtn = $('#btn-char'), charPop = $('#char-pop');
function renderCharPop() {
  charPop.innerHTML = CHARS.map((c) => {
    const on = c.id === charId;
    return `<div class="char-row"><button class="lang-item char-item${on ? ' on' : ''}" role="menuitemradio" aria-checked="${on}" data-id="${c.id}">
      <span class="lang-check" aria-hidden="true">${on ? '✓' : ''}</span><span class="char-prev">${c.preview ? c.preview() : c.worker('logo')}</span><span class="char-nm">${esc(c.custom ? c.name : _t(c.name))}</span></button>${c.custom
      ? `<button class="char-act" data-edit="${c.id}" title="${_t('고치기')}" aria-label="${_t('고치기')}">✎</button><button class="char-act del" data-del="${c.id}" title="${_t('지우기')}" aria-label="${_t('지우기')}">✕</button>` : ''}</div>`;
  }).join('') + `<button class="lang-item char-add" data-add>${_t('+ 캐릭터 추가')}</button>`;
  charPop.insertAdjacentHTML('afterbegin', `<div class="pop-h">${_t('캐릭터')}</div>`);
  const cur = document.documentElement.dataset.skin || '';
  const skins = [{ id: '', name: _t('오리지널'), swatch: 'linear-gradient(135deg, #15171d 45%, #d97757)' }, ...userThemes];
  charPop.insertAdjacentHTML('beforeend', `<div class="pop-h">${_t('테마')}</div>` + skins.map((k) => {
    const on = k.id === cur;
    return `<button class="lang-item skin-item${on ? ' on' : ''}" role="menuitemradio" aria-checked="${on}" data-skin="${esc(k.id)}">
      <span class="lang-check" aria-hidden="true">${on ? '✓' : ''}</span><span class="skin-sw" style="background:${esc(k.swatch || 'var(--surface-3)')}"></span><span class="char-nm">${esc(k.name)}</span></button>`;
  }).join('') + `<button class="lang-item char-add" data-theme-guide>${_t('+ 테마 만들기')}</button>`);
  const f = fontPrefs();
  charPop.insertAdjacentHTML('beforeend', `<div class="pop-h">${_t('글꼴 · CLI 색')}</div><button class="lang-item char-add" data-font-set>${esc([f.ui, f.term, termScheme()?.name].filter(Boolean).join(' · ') || _t('기본 글꼴'))} — ${_t('바꾸기…')}</button>`);
}
function setCharPop(open) {
  charPop.hidden = !open;
  charBtn.setAttribute('aria-expanded', String(open));
  if (open) { setLangPop(false); if (!updPop.hidden) setUpdPop(false); setPowerPop(false); renderCharPop(); charPop.querySelector('.char-item.on')?.focus(); loadThemes(); }
}
// 화면에 이미 그려진 캐릭터(svg.clawd)를 그 자리의 종류(data-v · 매니저)대로 지금 캐릭터로 바꿔 끼운다 — 목록 미리보기는 그대로
function repaintChars() {
  markChar();
  for (const s of document.querySelectorAll('svg.clawd')) {
    if (!s.closest('.char-pop, .char-edit')) s.outerHTML = s.classList.contains('mgr') ? managerSVG(mgrStage) : clawdSVG(s.dataset.v);
  }
  setFavicon(faviconAlert, true);
  mgrUpdate();
  requestAnimationFrame(drawTraces); // 매니저 키가 달라지면 회로 선 출발점도 달라진다
}
function setChar(id) {
  charId = CHARS.some((c) => c.id === id) ? id : 'clawd';
  try { charId === 'clawd' ? localStorage.removeItem(CHAR_KEY) : localStorage.setItem(CHAR_KEY, charId); } catch {}
  repaintChars();
}
// 서버 목록 받기 — 다른 브라우저에서 고치거나 지운 것도 반영. 지금 캐릭터가 없어졌으면 클로드로
async function loadChars() {
  let list;
  try { list = (await (await fetch('/api/characters')).json()).characters; } catch { return; }
  if (!Array.isArray(list)) return;
  let cached = null; try { cached = localStorage.getItem(CHARS_KEY); } catch {}
  if (cached === JSON.stringify(list)) return;
  setCharList(list);
  setChar(charId);
  if (!charPop.hidden) renderCharPop();
}
loadChars();
loadThemes();
charBtn.addEventListener('click', () => setCharPop(charPop.hidden));
charPop.addEventListener('click', async (e) => {
  if (e.target.closest('[data-add]')) { setCharPop(false); openCharEditor(null); return; }
  if (e.target.closest('[data-theme-guide]')) { setCharPop(false); openThemeGuide(); return; }
  if (e.target.closest('[data-font-set]')) { setCharPop(false); openFontSet(); return; }
  const ed = e.target.closest('[data-edit]')?.dataset.edit;
  if (ed) { setCharPop(false); openCharEditor(ed); return; }
  const del = e.target.closest('[data-del]')?.dataset.del;
  if (del) {
    const c = CHARS.find((x) => x.id === del);
    setCharPop(false);
    if (!c || !(await ask({ title: _t('캐릭터를 지울까요?'), body: _t("'{name}' 캐릭터와 올린 그림을 모두 지워요.", { name: c.name }), ok: _t('지우기'), danger: true }))) return;
    const r = await fetch(`/api/characters/${del}`, { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) { toast(_t('지우지 못했어요')); return; }
    await loadChars();
    return;
  }
  const sk = e.target.closest('.skin-item');
  if (sk) {
    if (sk.dataset.skin === (document.documentElement.dataset.skin || '')) return;
    setCharPop(false);
    setSkin(sk.dataset.skin);
    charBtn.focus();
    return;
  }
  const b = e.target.closest('[data-id]');
  if (!b || b.dataset.id === charId) return; // 이미 그 캐릭터 — 반응하지 않음
  setCharPop(false);
  setChar(b.dataset.id);
  charBtn.focus();
});
document.addEventListener('click', (e) => { if (!charPop.hidden && !e.target.closest('.char-wrap')) setCharPop(false); });
document.addEventListener('keydown', (e) => {
  if (charPop.hidden) return;
  if (e.key === 'Escape') { setCharPop(false); charBtn.focus(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = [...charPop.querySelectorAll('.char-item, .char-add, .skin-item, [data-theme-guide]')], i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});
document.addEventListener('langchange', () => { if (!charPop.hidden) renderCharPop(); });

// ---------- 올린 그림 다듬기 (브라우저에서) ----------
// 1) 배경: 네 귀퉁이가 같은 불투명 색이면 가장자리에서 이어진 그 색을 투명으로(흰 배경 그림 등)
// 2) 여백: 보이는 픽셀만 남게 딱 맞게 자른다
// 3) 도트: 도트를 몇 배로 키운 그림이면 칸 경계(옆 줄과 색이 달라지는 곳)를 찾아 칸마다 한 픽셀로 되돌린다.
//    작은 그림(128px 이하)도 도트로 보고 픽셀 그대로 키운다. 그 밖의 그림은 긴 변 320px 까지 부드럽게 줄인다
const CHAR_MAX_FILE = 20 * 1024 * 1024;
async function processCharImage(file) {
  if (!/^image\//.test(file.type)) throw new Error(_t('그림 파일만 올릴 수 있어요'));
  if (file.size > CHAR_MAX_FILE) throw new Error(_t('20MB 를 넘는 그림은 올릴 수 없어요'));
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error(_t('그림을 읽지 못했어요')); }
  if (bmp.width > 4096 || bmp.height > 4096) throw new Error(_t('4096px 를 넘는 그림은 올릴 수 없어요'));
  const W = bmp.width, H = bmp.height;
  const cv = new OffscreenCanvas(W, H), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  const id = cx.getImageData(0, 0, W, H), d = id.data, px = new Uint32Array(d.buffer);
  clearBackground(d, W, H);
  // 보이는 영역
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) throw new Error(_t('그림에 보이는 부분이 없어요'));
  const cw = x1 - x0 + 1, chh = y1 - y0 + 1;
  // 안 보이는 픽셀은 색이 제각각일 수 있어 하나로 맞춘 뒤 칸 경계를 찾는다
  const at = (x, y) => { const v = px[y * W + x]; return d[(y * W + x) * 4 + 3] ? v : 0; };
  const bx = [x0], by = [y0];
  for (let x = x0 + 1; x <= x1; x++) for (let y = y0; y <= y1; y++) if (at(x, y) !== at(x - 1, y)) { bx.push(x); break; }
  for (let y = y0 + 1; y <= y1; y++) for (let x = x0; x <= x1; x++) if (at(x, y) !== at(x, y - 1)) { by.push(y); break; }
  bx.push(x1 + 1); by.push(y1 + 1);
  const nw = bx.length - 1, nh = by.length - 1;
  const grid = nw <= cw * 0.7 && nh <= chh * 0.7 && nw <= 1024 && nh <= 1024;
  let out, pixel;
  if (grid) {
    out = new OffscreenCanvas(nw, nh);
    const o = out.getContext('2d'), od = o.createImageData(nw, nh), op = new Uint32Array(od.data.buffer);
    for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) op[j * nw + i] = at(bx[i], by[j]);
    o.putImageData(od, 0, 0);
    pixel = true;
  } else {
    cx.putImageData(id, 0, 0);
    pixel = Math.max(cw, chh) <= 128;
    const k = pixel ? 1 : Math.min(1, 320 / Math.max(cw, chh));
    out = new OffscreenCanvas(Math.max(1, Math.round(cw * k)), Math.max(1, Math.round(chh * k)));
    const o = out.getContext('2d');
    o.imageSmoothingQuality = 'high';
    o.drawImage(cv, x0, y0, cw, chh, 0, 0, out.width, out.height);
  }
  return { data: await canvasDataURL(out), w: out.width, h: out.height, pixel, canvas: out };
}
function clearBackground(d, W, H) {
  const idx = [0, W - 1, (H - 1) * W, H * W - 1];
  if (idx.some((i) => d[i * 4 + 3] < 255)) return; // 이미 투명 배경
  const [r, g, b] = [d[0], d[1], d[2]], near = (i, t) => Math.abs(d[i * 4] - r) <= t && Math.abs(d[i * 4 + 1] - g) <= t && Math.abs(d[i * 4 + 2] - b) <= t;
  if (!idx.every((i) => near(i, 10))) return; // 귀퉁이 색이 제각각 — 배경을 알 수 없으니 그대로
  const seen = new Uint8Array(W * H), stack = [];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const i = stack.pop();
    if (seen[i] || !near(i, 30)) continue;
    seen[i] = 1; d[i * 4 + 3] = 0;
    const x = i % W;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (i >= W) stack.push(i - W);
    if (i < (H - 1) * W) stack.push(i + W);
  }
}
async function canvasDataURL(cv) {
  const blob = await cv.convertToBlob({ type: 'image/png' });
  return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
}
// 탭 아이콘: 작은 자리와 같은 기준(세로로 길면 위쪽 정사각형)으로 잘라 64×64 가운데 아래쪽에
async function charIcon(src, pixel) {
  const w = src.width, h = src.height > src.width * 1.15 ? src.width : src.height;
  const k = 64 / Math.max(w, h), cv = new OffscreenCanvas(64, 64), c = cv.getContext('2d');
  c.imageSmoothingEnabled = !pixel;
  c.drawImage(src, 0, 0, w, h, Math.round((64 - w * k) / 2), Math.round(64 - h * k), Math.round(w * k), Math.round(h * k));
  return canvasDataURL(cv);
}

// ---------- 캐릭터 추가·고치기 창 ----------
// 매니저 칸 6개: 기본(매니저 시작 모습 · 워커 그림이 없으면 워커도, 꼭 필요) · 1~5단계(매니저가 성장하면 바뀌는 모습, 비우면 바로 앞 단계 그림)
// 워커 칸 1개(w): 워커 카드·칩에 쓰는 그림. 비우면 매니저 기본 그림을 같이 쓴다.
// 칸 번호는 문자열('0'~'5', 'w'). 칸을 누르거나 그림을 끌어다 놓으면 다듬은 결과가 바로 보인다. 저장해야 서버에 올라간다
const charModal = $('#char-modal'), charFile = $('#char-file');
let ce = null; // { id, slots: { n: { src, w, h, pixel, data?, canvas? } }, cleared: Set, pick }
const CHAR_MGR_SLOTS = ['0', '1', '2', '3', '4', '5'];
function charStageLabel(n) { return n === 'w' ? _t('모든 워커') : n === '0' ? _t('기본') : _t('{n}단계', { n }); }
function renderCharEditor() {
  const slot = (n) => {
    let s = ce.slots[n], inherited = false;
    if (!s && n === 'w') { s = ce.slots[0]; inherited = !!s; }
    if (!s) for (let k = Number(n) - 1; k >= 0 && !s; k--) if (ce.slots[k]) { s = ce.slots[k]; inherited = true; }
    const img = s ? `<img src="${s.src}" alt=""${s.pixel ? ' class="px"' : ''}>` : '';
    return `<div class="cs-slot${ce.slots[n] ? ' set' : ''}${inherited ? ' inh' : ''}" data-n="${n}" role="button" tabindex="0" title="${_t('눌러서 그림 고르기 · 끌어다 놓기')}">
      <div class="cs-prev">${img}${!ce.slots[n] ? `<span class="cs-plus">+</span>` : ''}</div>
      <div class="cs-label">${charStageLabel(n)}${n === '0' ? ' <b>*</b>' : ''}</div>
      ${ce.slots[n] && n !== '0' ? `<button class="cs-clear" data-clear="${n}" title="${_t('비우기')}" aria-label="${_t('비우기')}">✕</button>` : ''}</div>`;
  };
  $('#char-stages').innerHTML = `<div class="cs-group"><div class="cs-gh">${_t('매니저')}</div><div class="cs-row">${CHAR_MGR_SLOTS.map(slot).join('')}</div></div>
    <div class="cs-group cs-worker"><div class="cs-gh">${_t('워커')}</div><div class="cs-row">${slot('w')}</div></div>`;
}
function openCharEditor(id) {
  const c = id && CHARS.find((x) => x.id === id);
  let meta = null; try { meta = c && JSON.parse(localStorage.getItem(CHARS_KEY) || '[]').find((m) => m.id === id); } catch {}
  ce = { id: meta ? id : null, slots: {}, cleared: new Set(), icon: null };
  if (meta) for (const [n, s] of Object.entries(meta.stages)) ce.slots[n] = { src: `/characters/${s.file}`, w: s.w, h: s.h, pixel: s.pixel };
  $('#char-edit-title').textContent = meta ? _t('캐릭터 고치기') : _t('캐릭터 추가');
  $('#char-name').value = meta?.name || '';
  $('#char-err').hidden = true;
  renderCharEditor();
  charModal.hidden = false;
  requestAnimationFrame(() => $('#char-name').focus());
}
function closeCharEditor() { charModal.hidden = true; ce = null; }
async function setCharSlot(n, file) {
  const err = $('#char-err');
  err.hidden = true;
  try {
    const r = await processCharImage(file);
    if (!ce) return;
    ce.slots[n] = { src: r.data, data: r.data, w: r.w, h: r.h, pixel: r.pixel, canvas: r.canvas };
    ce.cleared.delete(n);
    if (n === '0') ce.icon = await charIcon(r.canvas, r.pixel);
    if (!$('#char-name').value.trim()) $('#char-name').value = file.name.replace(/\.[^.]+$/, '').slice(0, 30);
    renderCharEditor();
  } catch (e) { err.textContent = e.message; err.hidden = false; }
}
$('#char-stages').addEventListener('click', (e) => {
  const clr = e.target.closest('[data-clear]')?.dataset.clear;
  if (clr) { delete ce.slots[clr]; ce.cleared.add(clr); renderCharEditor(); return; }
  const slot = e.target.closest('.cs-slot');
  if (!slot) return;
  ce.pick = slot.dataset.n;
  charFile.value = '';
  charFile.click();
});
$('#char-stages').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('cs-slot')) { e.preventDefault(); e.target.click(); }
});
charFile.addEventListener('change', () => { if (charFile.files[0] && ce) setCharSlot(ce.pick, charFile.files[0]); });
$('#char-stages').addEventListener('dragover', (e) => {
  const slot = e.target.closest('.cs-slot');
  if (!slot || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault(); e.stopPropagation();
  for (const s of charModal.querySelectorAll('.cs-slot.dropping')) if (s !== slot) s.classList.remove('dropping');
  slot.classList.add('dropping');
});
$('#char-stages').addEventListener('dragleave', (e) => e.target.closest('.cs-slot')?.classList.remove('dropping'));
$('#char-stages').addEventListener('drop', (e) => {
  const slot = e.target.closest('.cs-slot'), f = e.dataTransfer.files[0];
  if (!slot) return;
  e.preventDefault(); e.stopPropagation();
  slot.classList.remove('dropping');
  if (f) setCharSlot(slot.dataset.n, f);
});
async function saveCharEditor() {
  const err = $('#char-err'), name = $('#char-name').value.trim();
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  if (!ce.slots[0]) return fail(_t('기본 그림을 넣어 주세요'));
  if (!name) { $('#char-name').focus(); return fail(_t('이름을 적어 주세요')); }
  const stages = {};
  for (const [n, s] of Object.entries(ce.slots)) if (s.data) stages[n] = { data: s.data, pixel: s.pixel };
  for (const n of ce.cleared) if (!ce.slots[n]) stages[n] = null;
  const body = { name, stages };
  if (ce.icon) body.icon = ce.icon;
  const btn = $('[data-ce="save"]', charModal);
  btn.disabled = true;
  try {
    const r = await fetch(ce.id ? `/api/characters/${ce.id}` : '/api/characters', { method: ce.id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.char) return fail(_t('저장하지 못했어요'));
    const id = j.char.id;
    closeCharEditor();
    await loadChars();
    setChar(id); // 새로 만들었거나 고친 캐릭터로 바로 바꿔 보여 준다
  } catch { fail(_t('저장하지 못했어요')); } finally { btn.disabled = false; }
}
charModal.addEventListener('click', (e) => {
  const a = e.target.closest('[data-ce]')?.dataset.ce;
  if (a === 'save') saveCharEditor();
  else if (a === 'cancel' || e.target === charModal) closeCharEditor();
});
// 캡처 단계에서 처리하고 막는다 — Esc 가 터미널(=Claude 중단)로 새지 않게
charModal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCharEditor(); charBtn.focus(); }
}, true);
// 언어가 바뀌면: 한 번 만들고 내용만 갱신하는 카드·칩은 새 언어로 다시 만들고, 종류가 같으면 다시 안 그리는 안내도 다시 그린다
document.addEventListener('langchange', () => {
  for (const n of nodeEls.values()) n.remove();
  nodeEls.clear();
  for (const c of dockEls.values()) c.parentElement.remove(); // 칩만 지우면 그 칸(.dslot)의 썸네일이 줄 끝에 남았다
  dockEls.clear();
  $('.empty', $('#nodes'))?.remove();
  $('.dock-empty', $('#dock-list'))?.remove();
  delete $('#hint').dataset.kind;
  setThemeSwitch(document.documentElement.dataset.theme === 'light');
  // 내용이 같으면 다시 안 그리는 영역(결정함·프로파일·메모)도 새 언어로 다시 그리게
  inboxSig = ''; profileSig = ''; memoSig = '';
  render();
  tick();
  const w = state.workers.find((x) => x.id === selected);
  if (w && !$('#profile').classList.contains('collapsed')) renderProfile(w, true);
  if (diffOpen) renderDiff();
});

// ---------- 업데이트 확인 (헤더, 🌐 오른쪽) ----------
// 서버가 시작할 때 한 번 확인하고(updates.js), 아이콘을 누르면 다시 확인한다. 새 버전이 있으면 아이콘에 점.
// 설치는 하지 않고 방법만 알려 준다
const updBtn = $('#btn-upd'), updPop = $('#upd-pop');
function updRow(title, x, kind) {
  let status, guide = '';
  if (!x) status = `<span class="upd-dim">${_t('확인 전')}</span>`;
  else if (x.error === 'git') status = `<span class="upd-dim">${_t('git 저장소가 아니라 확인할 수 없어요')}</span>`;
  else if (x.error === 'claude') status = `<span class="upd-dim">${_t('설치된 Claude Code 를 찾지 못했어요')}</span>`;
  else if (x.error === 'version') status = `<span class="upd-dim">${_t('이 설치본의 릴리즈 버전을 알 수 없어요 (최신 release-{v})', { v: esc(x.latest) })}</span>`;
  else if (x.error === 'network') status = `<span class="upd-dim">${_t('인터넷에 접속하지 못해 최신 버전을 모르겠어요')}</span>`;
  else if (x.newer) {
    const latest = kind === 'app' ? `release-${x.latest}` : x.latest;
    status = `<b class="upd-new">${_t('새 버전 {v}', { v: esc(latest) })}</b>`;
    guide = kind === 'app'
      ? `<div class="upd-guide">${_t('프로젝트 폴더에서 <code>git pull</code> 후 <b>↻ 서버 재시작</b>')}</div>`
      : `<div class="upd-guide">${_t('1. 터미널에서 <code>claude update</code><br>2. 서버 + 워커 모두 종료 후 다시 돌아와 작업 중이던 워커를 투입하세요.')}</div>`;
  } else status = `<span class="upd-ok">${_t('최신 버전이에요')}</span>`;
  const cur = x?.current != null ? (kind === 'app' ? `release-${x.current}` : x.current) : '—';
  // 클로드 키우기: 릴리즈 노트 — 누르면 큰 창에 모든 릴리즈(최신 → 과거)를 스크롤로
  let notes = '';
  if (kind === 'app' && x?.url) notes = `<button class="upd-notes" data-notes>${_t(x.newer ? '새 버전 릴리즈 노트 보기' : '릴리즈 노트 보기')}</button>`;
  // Claude Code: 설치된 버전 다음 ~ 최신의 변경 내역(CHANGELOG) — 버전 번호를 알면
  if (kind === 'claude' && (x?.current || x?.latest)) notes = `<button class="upd-notes" data-notes="claude">${_t(x.newer ? '새 버전 릴리즈 노트 보기' : '릴리즈 노트 보기')}</button>`;
  return `<div class="upd-row"><div class="upd-top"><b>${title}</b><span class="upd-cur">${esc(cur)}</span></div>${status}${guide}${notes}</div>`;
}
function renderUpd() {
  const u = state.updates || {};
  const any = !!(u.app?.newer || u.claude?.newer);
  $('.upd-dot', updBtn).hidden = !any;
  updBtn.title = _t(any ? '새 업데이트가 있어요' : '업데이트 확인');
  if (updPop.hidden) return;
  const when = u.checkedAt ? new Date(u.checkedAt + clockSkew).toLocaleTimeString(uiLocale(), { hour12: false, hour: '2-digit', minute: '2-digit' }) : null;
  const html = `<div class="upd-h">${_t('업데이트')}</div>` +
    updRow(_t('클로드 키우기'), u.app, 'app') + updRow('Claude Code', u.claude, 'claude') +
    `<div class="upd-foot">${u.checking ? _t('확인 중…') : when ? _t('마지막 확인 {t}', { t: when }) : ''}</div>`;
  if (updPop._html !== html) updPop.innerHTML = updPop._html = html;
}
function setUpdPop(open) {
  updPop.hidden = !open;
  updBtn.setAttribute('aria-expanded', String(open));
  if (open) { setLangPop(false); setCharPop(false); setPowerPop(false); fetch('/api/updates/check', { method: 'POST' }).catch(() => {}); }
  renderUpd();
}
updBtn.addEventListener('click', () => { if (!notesPop.hidden) { setNotesPop(false); return; } setUpdPop(updPop.hidden); });
document.addEventListener('click', (e) => { if (!updPop.hidden && !e.target.closest('.upd-wrap')) setUpdPop(false); });
document.addEventListener('keydown', (e) => { if (!updPop.hidden && e.key === 'Escape') { setUpdPop(false); updBtn.focus(); } });
updPop.addEventListener('click', (e) => { const b = e.target.closest('[data-notes]'); if (b) { setUpdPop(false); setNotesPop(true, b.dataset.notes || 'app'); } });

// ---------- 릴리즈 노트 (업데이트 창 → 릴리즈 노트 보기) ----------
// 서버가 GitHub 에서 받은 릴리즈 전체(최신 → 과거)를 큰 창에 스크롤로. 본문은 GitHub 이 만든 HTML — 허용한 태그만 남기고
// 링크는 http(s) 만 새 탭으로(그 밖의 속성·스크립트·그림은 버린다)
const notesPop = $('#notes-pop');
const NOTE_TAGS = new Set(['P', 'UL', 'OL', 'LI', 'BR', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'BLOCKQUOTE', 'HR', 'DEL', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD']);
function cleanNoteHtml(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html'), root = doc.body.firstChild;
  const walk = (el) => {
    for (const c of [...el.children]) {
      walk(c);
      if (!NOTE_TAGS.has(c.tagName)) { c.replaceWith(...c.childNodes); continue; }
      const href = c.tagName === 'A' ? c.getAttribute('href') : null;
      for (const a of [...c.attributes]) c.removeAttribute(a.name);
      if (href && /^https?:\/\//i.test(href)) { c.setAttribute('href', href); c.setAttribute('target', '_blank'); c.setAttribute('rel', 'noopener'); }
    }
  };
  walk(root);
  return root.innerHTML;
}
let notesReq = 0;
// CHANGELOG 의 마크다운은 '- 항목' 목록과 `코드` · **굵게** · [링크](주소) 정도라 직접 바꾼다(CDN 렌더러 없이 오프라인에서도).
// 결과는 릴리즈 노트와 같은 cleanNoteHtml 로 한 번 더 거른다
function changelogHtml(md) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  let html = '', list = false;
  for (const line of String(md).split('\n')) {
    const li = line.match(/^\s*[-*] (.*)$/);
    if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (list && line.trim()) { html += '</ul>'; list = false; }
    if (line.trim()) html += /^#{1,6} /.test(line) ? `<h4>${inline(line.replace(/^#+ /, ''))}</h4>` : `<p>${inline(line)}</p>`;
  }
  return cleanNoteHtml(html + (list ? '</ul>' : ''));
}
async function renderClaudeNotes(head, my) {
  let d;
  try { d = await (await fetch('/api/claude-notes')).json(); } catch { d = { error: 'network' }; }
  if (my !== notesReq || notesPop.hidden) return;
  const gh = `<a class="upd-notes" href="${esc(d.url || 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md')}" target="_blank" rel="noopener">CHANGELOG ↗</a>`;
  if (d.error || !d.versions?.length) {
    notesPop.innerHTML = head(gh) + `<div class="notes-body"><div class="upd-dim">${_t('인터넷에 접속하지 못해 릴리즈 노트를 불러오지 못했어요')}</div></div>`;
    return;
  }
  const vn = (v) => String(v).split('.').map(Number), gt = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
  const cur = d.current ? vn(d.current) : null;
  const note = [
    d.source === 'local' ? _t('인터넷에 접속하지 못해 이 PC 에 받아 둔 기록을 보여 줘요 (설치된 버전까지만 있어요)') : '',
    d.more ? _t('사이에 버전이 {n}개 더 있어요 — 전체는 CHANGELOG 에서', { n: d.more }) : '',
  ].filter(Boolean).map((t) => `<div class="upd-dim notes-note">${t}</div>`).join('');
  // 버전마다 접는 칸 — 최신 하나만 펼친다(버전당 항목이 수십 개라 다 펼치면 길다). 영어 원문 그대로
  const items = d.versions.map((x, i) => {
    const n = (x.md.match(/^\s*[-*] /gm) || []).length;
    const badge = d.current === x.v ? `<span class="notes-badge cur">${_t('지금 버전')}</span>` : cur && gt(vn(x.v), cur) ? `<span class="notes-badge new">${_t('새 버전')}</span>` : '';
    return `<details class="notes-rel notes-cc"${i === 0 ? ' open' : ''}><summary class="notes-rt"><b>${esc(x.v)}</b>${badge}<span class="notes-n">${_t('{n}개 항목', { n })}</span></summary><div class="notes-md">${changelogHtml(x.md)}</div></details>`;
  }).join('');
  notesPop.innerHTML = head(gh) + `<div class="notes-body">${note}${items}</div>`;
}
async function setNotesPop(open, kind = 'app') {
  notesPop.hidden = !open;
  if (!open) return;
  setLangPop(false); setCharPop(false); setPowerPop(false);
  const title = kind === 'claude' ? _t('Claude Code 릴리즈 노트') : _t('릴리즈 노트');
  const head = (extra = '') => `<div class="notes-head"><div class="upd-h">${title}</div>${extra}<button class="notes-x" data-notes-close aria-label="${_t('닫기')}">✕</button></div>`;
  notesPop.innerHTML = head() + `<div class="notes-body"><div class="upd-dim">${_t('불러오는 중…')}</div></div>`;
  const my = ++notesReq;
  if (kind === 'claude') return renderClaudeNotes(head, my);
  let d;
  try { d = await (await fetch('/api/releases')).json(); } catch { d = { error: 'network' }; }
  if (my !== notesReq || notesPop.hidden) return;
  const gh = d.url ? `<a class="upd-notes" href="${esc(d.url)}/releases" target="_blank" rel="noopener">GitHub ↗</a>` : '';
  if (d.error || !d.releases?.length) {
    const why = d.error === 'git' ? _t('git 저장소가 아니라 릴리즈를 찾을 수 없어요') : d.error === 'limit' ? _t('GitHub 요청 한도에 걸렸어요 — 잠시 뒤 다시 열어 주세요')
      : d.error ? _t('인터넷에 접속하지 못해 릴리즈 노트를 불러오지 못했어요') : _t('아직 릴리즈가 없어요');
    notesPop.innerHTML = head(gh) + `<div class="notes-body"><div class="upd-dim">${why}</div></div>`;
    return;
  }
  const num = (tag) => Number(String(tag).match(/release-(\d+)$/)?.[1] ?? NaN);
  const items = d.releases.map((r) => {
    const n = num(r.tag);
    const badge = n === d.current ? `<span class="notes-badge cur">${_t('지금 버전')}</span>` : Number.isFinite(n) && d.current != null && n > d.current ? `<span class="notes-badge new">${_t('새 버전')}</span>` : '';
    const date = r.at ? new Date(r.at).toLocaleDateString(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const body = r.html ? cleanNoteHtml(r.html) : `<p class="upd-dim">${_t('작성된 노트가 없어요')}</p>`;
    return `<section class="notes-rel"><div class="notes-rt"><a href="${esc(r.link)}" target="_blank" rel="noopener"><b>${esc(r.name)}</b></a>${badge}${r.pre ? `<span class="notes-badge">${_t('미리보기')}</span>` : ''}<time>${esc(date)}</time></div><div class="notes-md">${body}</div></section>`;
  }).join('');
  notesPop.innerHTML = head(gh) + `<div class="notes-body">${items}</div>`;
}
notesPop.addEventListener('click', (e) => { if (e.target.closest('[data-notes-close]')) { setNotesPop(false); updBtn.focus(); } });
document.addEventListener('click', (e) => { if (!notesPop.hidden && !e.target.closest('.upd-wrap')) setNotesPop(false); });
document.addEventListener('keydown', (e) => { if (!notesPop.hidden && e.key === 'Escape') { setNotesPop(false); updBtn.focus(); } });
document.addEventListener('langchange', () => { updPop._html = ''; renderUpd(); });

const themeSw = $('#btn-theme'), themeKnob = $('.ts-knob', themeSw), themeFace = $('.ts-face', themeSw);
const THEME_ANIM_MS = 720;
let themeBusy = false;
function setThemeSwitch(light) {
  themeSw.setAttribute('aria-checked', String(light));
  themeSw.setAttribute('aria-label', _t(light ? '다크 모드로' : '라이트 모드로'));
  themeFace.textContent = light ? '☀' : '🌙';
}
function applyTheme(light) {
  if (light) document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
  term.options.theme = termTheme(light); // 터미널도 같이
  applyScheme(); // 채팅 바탕(--chat-bg)을 새 테마 값으로
  try { light ? localStorage.setItem('am.theme', 'light') : localStorage.removeItem('am.theme'); } catch {}
}
setThemeSwitch(document.documentElement.dataset.theme === 'light');
// 마우스를 올리면 바로 설명(미터 툴팁과 같은 것) — 전환 방향과 직접 만든 테마 안내
hoverTips.theme = () => ({
  title: _t(themeSw.getAttribute('aria-checked') === 'true' ? '다크 모드로' : '라이트 모드로'),
  note: _t('직접 만든 테마도 쓸 수 있어요. 👕 꾸미기 → 테마 → + 테마 만들기에서 새 테마를 만들거나 Claude 에게 맡길 수 있어요. 테마는 프로젝트의 themes 폴더에 있고 저장소에 올라가지 않아요.'),
  act: _t('클릭: 라이트·다크 전환'),
});
themeSw.addEventListener('click', (e) => {
  e.preventDefault();
  if (themeBusy) return; // 연출 중 입력은 취소
  const light = themeSw.getAttribute('aria-checked') !== 'true';
  applyTheme(light);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setThemeSwitch(light); return; }
  themeBusy = true;
  themeSw.classList.add('busy', light ? 'go-right' : 'go-left');
  const swap = setTimeout(() => { themeFace.textContent = light ? '☀' : '🌙'; }, THEME_ANIM_MS * 0.4); // 가장 늘어난 순간쯤 아이콘 교체
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(swap); clearTimeout(fallback);
    themeKnob.removeEventListener('animationend', finish);
    setThemeSwitch(light); // 마지막 프레임 = 고정 위치라 튀지 않는다
    themeSw.classList.remove('busy', 'go-right', 'go-left');
    themeBusy = false;
  };
  themeKnob.addEventListener('animationend', finish);
  const fallback = setTimeout(finish, THEME_ANIM_MS + 200); // 애니메이션 이벤트를 못 받아도 잠기지 않게
});

// ---------- Chrome 권장 띠 ----------
// Safari 에선 터미널 그리기가 느리고 한글 입력이 조합 이벤트 없이 들어오는 등(실측) Chrome 기준으로 맞춘 부분이 많다.
// Chrome 이 아니면 늘 띠를 보인다(닫기 없음). Edge·Whale 등도 사용자 에이전트 문자열엔 'Chrome/' 이 있어
// 브라우저가 밝히는 브랜드(userAgentData)로 가린다 — 그게 없는 브라우저(Safari·Firefox)는 문자열로
function browserName() {
  const ua = navigator.userAgent;
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand);
  if (brands.includes('Google Chrome')) return 'Chrome';
  const named = [[/Edg\//, 'Edge'], [/Whale\//, 'Whale'], [/OPR\//, 'Opera'], [/SamsungBrowser\//, 'Samsung Internet'], [/Firefox\//, 'Firefox'], [/FxiOS\//, 'Firefox'], [/CriOS\//, 'Chrome']];
  for (const [re, name] of named) if (re.test(ua)) return name;
  if (/Chrome\//.test(ua)) return brands.find((b) => !/not.?a.?brand|chromium/i.test(b)) || (brands.length ? 'Chromium' : 'Chrome');
  if (/Safari\//.test(ua)) return 'Safari';
  return _t('알 수 없는 브라우저');
}
// 띠 대신 헤더 🌐 오른쪽 경고 아이콘 — 마우스를 올리면 바로 설명(미터 툴팁과 같은 것).
// 누르면 Chrome 이 설치돼 있으면 서버가 이 대시보드를 Chrome 으로 열고(브라우저는 다른 앱을 못 띄운다), 없으면 이 주소를 복사
{
  const name = browserName(), btn = $('#btn-browser');
  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(location.href); toast(_t('주소를 복사했습니다 — Chrome 주소창에 붙여넣으세요')); }
    catch { toast(_t('주소: {url}', { url: location.href }), 6000); }
  };
  if (name !== 'Chrome' && !TOUCH) { // 휴대폰에선 'Chrome 으로 열기'가 서버 PC 쪽에서 열려 의미가 없다
    btn.hidden = false;
    btn.dataset.mt = 'browser';
    hoverTips.browser = () => ({
      title: _t('Chrome 이 아닌 브라우저'),
      rows: [[_t('지금 브라우저'), browserName()]],
      note: _t('클로드 키우기는 Chrome 에 맞춰 만들어져, Chrome 에서 더 쾌적하게 이용할 수 있어요.'),
      act: state.chrome ? _t('클릭: Chrome 으로 열기') : _t('클릭: 이 주소 복사 → Chrome 주소창에 붙여넣기 (이 PC 에서 Chrome 을 찾지 못했습니다)'),
    });
  }
  btn.addEventListener('click', async () => {
    if (state.chrome) {
      const r = await api('/api/open-chrome');
      if (r.ok) { toast(_t('Chrome 으로 열었습니다')); return; }
    }
    copyUrl();
  });
}

// ---------- 서버 재시작 ----------
// 서버가 실행기를 '기다렸다 띄우기'로 남기고 내려간다 → 돌아오면 화면이 스스로 새로고침(ws.onopen 의 serverDown 처리)
async function restartServer() {
  const r = await api('/api/restart');
  if (r.error) return; // 옛 서버(이 API 없음)는 api() 가 알림을 띄운다 → ⏻ 서버만 종료 후 Launch 실행
  serverDown = true;
  $('#down-detail').textContent = _t('서버를 다시 켜는 중입니다… 워커는 그대로 실행 중입니다.');
  $('#down-screen').hidden = false;
}

// ---------- 서버 종료 ----------
let serverDown = false;
// ⏻ 를 누르면 종료 방법별 설명과 버튼이 든 작은 창(업데이트 창과 같은 모양). 버튼을 누르면 바로 실행
const powerBtn = $('#btn-power'), powerPop = $('#power-pop');
function setPowerPop(open) {
  powerPop.hidden = !open;
  powerBtn.setAttribute('aria-expanded', String(open));
  if (open) { setLangPop(false); setCharPop(false); if (!updPop.hidden) setUpdPop(false); powerPop.querySelector('.power-act')?.focus(); }
}
powerBtn.addEventListener('click', () => setPowerPop(powerPop.hidden));
document.addEventListener('click', (e) => { if (!powerPop.hidden && !e.target.closest('.power-wrap')) setPowerPop(false); });
document.addEventListener('keydown', (e) => { if (!powerPop.hidden && e.key === 'Escape') { setPowerPop(false); powerBtn.focus(); } });
powerPop.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-power]')?.dataset.power;
  if (!act) return;
  setPowerPop(false);
  if (act === 'restart') return restartServer();
  try { await api('/api/shutdown', { workers: act === 'all' }); } catch {}
  serverDown = true;
  $('#down-detail').textContent = _t(act === 'all' ? '모든 워커도 함께 종료했습니다.' : '워커는 백그라운드에서 계속 실행 중입니다 — 서버를 다시 켜면 그대로 다시 붙습니다.');
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
// Claude Code 가 전체 화면 모드(대체 화면)로 떠 있으면 지난 대화를 Claude 가 화면 안에서 다시 그려, 터미널엔 지금 보이는
// 한 화면만 있다 — 위로 넘어간 요청 줄은 지워진 게 아니라 찾을 수 없을 뿐이다. 새로 띄우는 워커는 일반 모드(server.js
// CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN)라 기록이 남는다. 그 전에 띄운 워커만 이 경우
const termFullscreen = () => term.buffer.active.type === 'alternate';
const FULLSCREEN_MSG = () => _t('이 워커는 전체 화면 모드로 떠 있어 지난 대화로 이동할 수 없습니다 — 워커를 새로 띄우면 됩니다');
function markGoneReqs() {
  if (!selected || $('#detail').hidden) return;
  const full = termFullscreen();
  for (const li of $('#log').querySelectorAll('li.k-req')) {
    const i = Number(li.dataset.i), row = timelineCache[i];
    if (!row) continue;
    const gone = findPromptLine(row.text, laterSame(i)) < 0 && findTurnEndBefore(row.t + clockSkew) < 0;
    li.classList.toggle('gone', gone && !full); // 전체 화면 모드는 만료가 아니라 흐리게 하지 않는다
    li.title = !gone ? _t('클릭: 터미널에서 이 요청 위치로 이동') : full ? FULLSCREEN_MSG() : _t('만료된 요청이라 처리할 수 없습니다.');
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
    pinEl.innerHTML = `<time>${esc(hit.querySelector('time')?.textContent || '')}</time><span class="tag">${_t('요청')}</span><span class="tx">${esc(row?.text || '')}</span>`;
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
    if (line < 0) { toast(termFullscreen() ? FULLSCREEN_MSG() : _t('만료된 요청이라 처리할 수 없습니다.'), termFullscreen() ? 5000 : 3200); return; }
    toast(_t('요청 줄이 터미널에 남지 않아 그 무렵(직전 턴 종료) 위치로 이동했습니다'), 2800);
  }
  // 요청 줄이 터미널 맨 위에 오게 — 이미 보이고 있어도 옮긴다. 끝에 가까워 맨 위로 못 올리면 맨 아래까지만(xterm 이 baseY 로 자른다)
  term.scrollToLine(Math.min(line, term.buffer.active.baseY));
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

try { if (localStorage.getItem(FLOOR_MIN_KEY)) setFloorMin(true); } catch {}

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

// ---------- 옆 패널 넓히기 (왼쪽 세로선을 끌기 — 터미널 위를 덮는다) ----------
// 기본 폭(평소 격자 칸 360px · 크게 보기 고정 폭)이 최소. 늘린 만큼(--side-extra) 왼쪽으로 겹쳐 덮고, 터미널은 최소
// 240px 이 보이게 남긴다. 터미널 크기는 그대로라 pty 크기도 안 바뀐다. 평소·크게 보기 폭을 따로 기억 · 더블클릭: 기본 폭
// 기본 폭의 절반보다 더 줄이려고 오른쪽으로 끌면 스냅으로 완전히 접혀 '‹' 띠만 남는다(터미널이 그만큼 넓어짐).
// 띠를 누르거나 다시 왼쪽으로 끌면 기본 폭으로 펼친다. 접힘도 모드별로 기억
const TERM_KEEP = 240;
const sideEl = $('.side'), sideGrip = $('#side-grip');
const sideMode = () => (document.body.classList.contains('term-full') ? 'full' : 'normal');
const SIDE_KEYS = { normal: 'am.sideExtra', full: 'am.sideExtraFull' };
const SIDE_MIN_KEYS = { normal: 'am.sideMin', full: 'am.sideMinFull' };
const sideWant = { normal: 0, full: 0 }, sideMin = { normal: false, full: false };
try {
  for (const m in SIDE_KEYS) sideWant[m] = Number(localStorage.getItem(SIDE_KEYS[m])) || 0;
  for (const m in SIDE_MIN_KEYS) sideMin[m] = localStorage.getItem(SIDE_MIN_KEYS[m]) === '1';
} catch {}
function setSideExtra(px) {
  const maxExtra = Math.max(0, $('#term-wrap').getBoundingClientRect().width - TERM_KEEP);
  const extra = Math.round(Math.max(0, Math.min(maxExtra || px, px || 0)));
  sideEl.classList.toggle('cover', extra > 0);
  // 변수는 #detail 에 둔다 — 옆 패널(덮개 폭)과 크게 보기 터미널 제목줄(닫기 버튼이 덮개 가장자리를 따라감)이 함께 쓴다
  const host = $('#detail');
  if (extra > 0) host.style.setProperty('--side-extra', `${extra}px`); else host.style.removeProperty('--side-extra');
  requestAnimationFrame(() => updatePin());
  return extra;
}
// 접기/펼치기 — 클래스는 #detail 에 둔다(평소 화면은 격자 칸 폭, 크게 보기는 터미널 오른쪽 끝이 함께 바뀐다)
function setSideMin(on) {
  $('#detail').classList.toggle('side-min', on);
  if (on) setSideExtra(0);
  requestAnimationFrame(() => updatePin());
}
const saveSide = (mode) => {
  try {
    sideWant[mode] > 0 ? localStorage.setItem(SIDE_KEYS[mode], String(sideWant[mode])) : localStorage.removeItem(SIDE_KEYS[mode]);
    sideMin[mode] ? localStorage.setItem(SIDE_MIN_KEYS[mode], '1') : localStorage.removeItem(SIDE_MIN_KEYS[mode]);
  } catch {}
};
// 지금 모드에 기억한 폭·접힘을 적용 — 처음, 크게 보기 전환 때, 창이 좁아져 터미널이 줄 때(상세가 숨겨져 폭이 0 이면 건너뜀)
const applySideWant = () => {
  const m = sideMode();
  if (sideMin[m] !== $('#detail').classList.contains('side-min')) setSideMin(sideMin[m]);
  if (sideMin[m]) return;
  if (sideWant[m] || sideEl.classList.contains('cover')) setSideExtra(sideWant[m]);
};
applySideWant();
new ResizeObserver(() => { if ($('#term-wrap').getBoundingClientRect().width) applySideWant(); }).observe($('#term-wrap'));
let sideLastMode = sideMode(); // body 클래스는 끌기 중에도 바뀌므로 크게 보기 전환일 때만 반응
new MutationObserver(() => { if (sideMode() !== sideLastMode) { sideLastMode = sideMode(); applySideWant(); } }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
// 기본 폭(넓히지 않았을 때의 패널 폭) — 평소 화면은 격자 칸 360px, 크게 보기는 --full-side-w(style.css 의 clamp 와 같은 식)
const sideBase = () => (sideMode() === 'full' ? Math.min(460, Math.max(340, innerWidth * 0.26)) : 360);
sideGrip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  sideGrip.setPointerCapture(e.pointerId);
  const mode = sideMode(), startX = e.clientX;
  // 끌기 값 v: 기본 폭에서 늘린(+)/줄인(-) 양. 접힌 상태는 -기본 폭에서 시작 → 기본 폭의 절반보다 더 줄이면 접힘
  const base = sideBase();
  const startV = sideMin[mode] ? -base : (parseFloat($('#detail').style.getPropertyValue('--side-extra')) || 0);
  sideGrip.classList.add('dragging'); document.body.classList.add('resizing-side');
  let extra = Math.max(0, startV), min = sideMin[mode];
  const move = (ev) => {
    const v = startV + (startX - ev.clientX);
    const nowMin = v < -base / 2;
    if (nowMin !== min) { min = sideMin[mode] = nowMin; setSideMin(min); } // 바로 반영 — 터미널 크기가 바뀌어 applySideWant 가 돌아도 되돌리지 않게
    extra = min ? 0 : setSideExtra(v);
  };
  const up = () => {
    sideGrip.removeEventListener('pointermove', move);
    sideGrip.classList.remove('dragging'); document.body.classList.remove('resizing-side');
    sideWant[mode] = extra; sideMin[mode] = min;
    saveSide(mode);
  };
  sideGrip.addEventListener('pointermove', move);
  sideGrip.addEventListener('pointerup', up, { once: true });
  sideGrip.addEventListener('pointercancel', up, { once: true });
});
const resetSide = () => { const m = sideMode(); sideMin[m] = false; setSideMin(false); sideWant[m] = setSideExtra(0); saveSide(m); };
sideGrip.addEventListener('dblclick', resetSide);
$('#side-expand').addEventListener('click', resetSide);

// ---------- 옆 패널 영역 높이 조절 (업무 지시 · 나중에 할 작업 · 타임라인 사이 가로선 끌기) ----------
// 끈 영역(가로선 위쪽)에 높이를 주고, 남는 자리는 타임라인이 갖는다. 영역마다 브라우저에 기억 · 더블클릭: 기본(내용 크기)
const SIDE_LOG_MIN = 80; // 타임라인이 최소한 남길 높이
function setSecH(sec, h) {
  if (h == null) { sec.classList.remove('sized'); sec.style.removeProperty('--sec-h'); return; }
  sec.classList.add('sized');
  sec.style.setProperty('--sec-h', `${Math.round(h)}px`);
}
// 제목과 입력칸까지는 항상 보이게 — 그 아래 목록(대기열·메모)만 줄어든다 (영역이 스크롤돼 있어도 같은 값이 나오게 scrollTop 을 더함)
const secMinH = (sec) => sec.querySelector('form').getBoundingClientRect().bottom - sec.getBoundingClientRect().top + sec.scrollTop;
// 입력칸 높이가 바뀔 때마다(줄 수만큼 늘어남·첨부 표시) 영역의 최소 높이를 맞춘다 — style.css 의 --sec-min
const secMinObs = new ResizeObserver((entries) => {
  for (const e of entries) {
    const sec = e.target.closest('.side-sec');
    if (sec && !sec.classList.contains('collapsed')) sec.style.setProperty('--sec-min', `${Math.ceil(secMinH(sec))}px`);
  }
});
for (const f of document.querySelectorAll('.side > .side-sec form')) secMinObs.observe(f);
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

// ---------- 옆 패널 영역 접기 (업무 지시 · 나중에 할 작업 · 타임라인 제목줄 클릭) ----------
// 영역마다 브라우저에 기억. 접은 영역 아래 가로선(높이 조절)은 쓸 일이 없어 숨긴다
const SEC_FOLD_KEY = (id) => `am.secFold.${id}`;
function setSecCount(id, text) {
  const el = document.querySelector(`#${id} .sec-count`);
  const t = $('#' + id).classList.contains('collapsed') ? text : '';
  if (el && el.textContent !== t) el.textContent = t;
}
function setSecFolded(sec, on, save = true) {
  sec.classList.toggle('collapsed', on);
  sec.querySelector('.sec-toggle').setAttribute('aria-expanded', String(!on));
  for (const r of document.querySelectorAll('.side-resizer')) {
    r.classList.toggle('off', $('#' + r.dataset.sec).classList.contains('collapsed') || $('#sec-log').classList.contains('collapsed'));
  }
  if (save) try { on ? localStorage.setItem(SEC_FOLD_KEY(sec.id), '1') : localStorage.removeItem(SEC_FOLD_KEY(sec.id)); } catch {}
  const w = state?.workers?.find((x) => x.id === selected);
  if (w) renderDetail();
}
for (const h of document.querySelectorAll('.side .sec-toggle')) {
  const sec = h.closest('.side-sec');
  try { if (localStorage.getItem(SEC_FOLD_KEY(sec.id))) setSecFolded(sec, true, false); } catch {}
  h.addEventListener('click', () => setSecFolded(sec, !sec.classList.contains('collapsed')));
  h.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); h.click(); } });
}

// 크게/원래대로 전환은 FLIP 애니메이션: 바뀌기 전 위치·크기(First)와 바뀐 뒤(Last)를 재서, 원래 자리에서
// 목표 자리로 늘어나고 줄어드는 것처럼 보이게 한다. 늘어나는 동안 글자가 찌그러져 보이지 않게 터미널 내용은
// 잠깐 감췄다가, 크기를 맞춘(fit) 뒤 서서히 보여 준다.
function setTermFull(on) {
  const wrap = $('#term-wrap'), inner = $('#term');
  const first = wrap.getBoundingClientRect();
  wrap.classList.toggle('full', on);
  document.body.classList.toggle('term-full', on);
  scheduleSelLink();
  // 아이콘만 — 크게(바깥으로 벌린 모서리) ↔ 원래대로(안으로 모은 모서리). 설명은 툴팁
  const fb = $('#btn-full'), tip = _t(on ? '원래 크기로' : '터미널 크게 보기 (다시 누르거나 ✕ 로 복귀)');
  fb.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${on ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5' : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'}"/></svg>`;
  fb.title = tip; fb.setAttribute('aria-label', tip);
  const w = state.workers.find((x) => x.id === selected);
  $('#term-title').textContent = w ? w.name : '';
  // 터미널 글자는 상자가 늘어나는 동안 찌그러져 보여 숨겨 둔다. 예전엔 상자가 다 커진 뒤에야 글자 크기를 맞추고(다시 그리기) 페이드해
  // 옆 패널보다 한참 늦게 보였다 → 새 크기는 클래스를 바꾼 순간 이미 정해지므로(transform 은 배치에 영향 없음) 글자 크기는 바로 맞추고,
  // 상자가 거의 다 커졌을 때(감속 곡선이라 60% 시점이면 크기 차이가 몇 %) 글자를 드러낸다
  const reveal = () => { clearTimeout(revealTimer); inner.style.opacity = ''; inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 110, easing: 'ease-out' }); };
  const done = () => { placeMeters(); if (!diffOpen) term.focus(); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { requestAnimationFrame(() => { fitTerm(); done(); }); return; }
  const last = wrap.getBoundingClientRect();
  termAnim?.cancel();
  inner.style.opacity = '0';
  termAnim = wrap.animate([
    { transformOrigin: '0 0', transform: `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})` },
    { transformOrigin: '0 0', transform: 'none' },
  ], { duration: 280, easing: 'cubic-bezier(.2, .8, .2, 1)' });
  termAnim.onfinish = () => { termAnim = null; if (inner.style.opacity === '0') reveal(); done(); };
  // 글자 크기 맞추기는 애니메이션(옆 패널 포함)을 먼저 띄운 뒤에 — 다시 그리기가 메인 스레드를 잡아도 transform·opacity 움직임은 멈추지 않는다.
  // 첫 프레임이 그려진 다음(rAF → setTimeout)에 하고, 드러낼 시점은 클릭부터 170ms 로 잡는다
  const t0 = performance.now();
  clearTimeout(revealTimer);
  requestAnimationFrame(() => setTimeout(() => {
    fitTerm();
    revealTimer = setTimeout(reveal, Math.max(0, 170 - (performance.now() - t0)));
  }));
  // 옆 패널: 넓은 화면의 크게 보기에선 오른쪽에 따로 붙는다(style.css) → 터미널이 커지는 동안 오른쪽에서 밀려 들어오고,
  // 원래대로 돌아갈 땐 제자리에서 살짝 떠오르며 나타난다. 좁은 화면은 크게 보기에 옆 패널이 없다(터미널만)
  if (matchMedia('(min-width: 1101px)').matches) {
    // 움직임과 페이드를 따로 돌린다 — 같은 감속 곡선에 묶으면 투명도가 처음 0.1초에 거의 다 차서 페이드가 안 보였다.
    // 지연 없이 터미널(280ms)과 같이 시작하고 그 안에 끝낸다 — 예전엔 지연 + 0.36~0.48초 페이드라 패널이 늦게 보였다
    sideAnim?.forEach((a) => a.cancel());
    const side = $('.side');
    sideAnim = [
      side.animate(on ? [{ transform: 'translateX(32px)' }, { transform: 'none' }] : [{ transform: 'translateY(6px)' }, { transform: 'none' }],
        { duration: on ? 260 : 200, easing: 'cubic-bezier(.2, .8, .2, 1)' }),
      side.animate([{ opacity: 0 }, { opacity: 1 }], { duration: on ? 240 : 180, easing: 'ease-out' }),
    ];
  }
}
let sideAnim = null;

// ---------- diff 보기 ----------
// 워커가 고친 파일의 변경을 터미널 자리에 덮어 보여 준다 — Edit·Write(메인·서브에이전트)와 셸 명령(서버가 명령 전후를 git 으로 비교). 터미널은 그 아래 그대로 있어(크기도 그대로)
// 닫으면 다시 맞출 것 없이 바로 돌아온다. 내용은 열 때·새 수정이 생길 때만 서버에서 가져온다(상태 방송엔 개수만)
let diffOpen = false, diffData = null, diffKey = '', diffTimer = null;
// 왼쪽 목록은 파일을 고친 요청을 오래된 것부터(오름차순) 나열하고, 요청을 누르면 그 요청에서 바뀐 파일이 펼쳐진다.
// diffSel: 보고 있는 { turn, file } — turn 은 문자열 키(번호 없는 요청은 'null'). diffExpanded: 펼친 요청 키.
// diffFollow: 마지막 요청을 보고 있으면 새 요청이 생길 때 따라간다(사람이 지난 요청을 고르면 멈춤)
let diffSel = null, diffExpanded = new Set(), diffFollow = true;
const turnKey = (t) => String(t ?? null);
const diffKeyOf = (w) => `${w.id}:${w.profile?.edits?.n || 0}:${w.profile?.edits?.last || 0}`;
function renderDiffButton(w) {
  const e = w.profile?.edits, n = e?.files || 0;
  for (const b of document.querySelectorAll('.btn-diff')) {
    const html = n ? `diff <b>${n}</b>` : 'diff';
    if (b._html !== html) b.innerHTML = b._html = html;
    b.classList.toggle('on', diffOpen);
    b.classList.toggle('none', !n);
    b.title = n ? `${_t('고친 파일 {n}개', { n })} · +${e.add} −${e.del} — ${_t('누르면 변경 내용')}${diffOpen ? _t(' (다시 누르면 터미널로)') : ''}` : _t('아직 고친 파일이 없습니다');
  }
  // 열려 있는 동안 새 수정이 생기거나 다른 워커로 바뀌면 다시 가져온다
  if (diffOpen && diffKeyOf(w) !== diffKey) { clearTimeout(diffTimer); diffTimer = setTimeout(loadDiff, 150); }
}
async function loadDiff() {
  const w = state.workers.find((x) => x.id === selected);
  if (!w || !diffOpen) return;
  const key = diffKeyOf(w);
  let data;
  try { data = await (await fetch(`/api/workers/${w.id}/diff`)).json(); } catch { toast(_t('변경 내용을 가져오지 못했습니다'), 3000); return; }
  if (!diffOpen || selected !== w.id) return;
  if (diffData?.wid !== w.id) { diffSel = null; diffExpanded = new Set(); diffFollow = true; } // 다른 워커면 마지막 요청부터
  diffData = { ...data, wid: w.id };
  diffKey = key;
  renderDiff();
}
// 🗑 diff 목록 비우기 — 이 세션의 지금까지 수정을 목록에서 뺀다(파일은 그대로). 이후 수정부터 다시 쌓인다
$('#diff-clear').addEventListener('click', async () => {
  const w = state.workers.find((x) => x.id === selected);
  if (!w) return;
  if (!(await ask({ title: _t('diff 목록을 비울까요?'), body: _t('지금까지의 요청·파일 변경 기록을 목록에서 지웁니다. 실제 파일은 바뀌지 않고, 앞으로의 수정부터 다시 쌓입니다.'), ok: _t('비우기'), danger: true }))) return;
  const r = await api(`/api/workers/${w.id}/diffclear`, {});
  if (r?.error) return;
  diffSel = null; diffExpanded = new Set(); diffFollow = true;
  loadDiff();
});
// 채팅 보기에서 diff 를 열었으면 닫을 때 채팅 보기로 돌아간다(저장해 둔 보기 설정도 채팅 그대로)
let diffFromChat = false;
function setDiffOpen(on) {
  if (on && chatOpen) { diffFromChat = true; setChatOpen(false, true); } // 채팅 보기와 diff 는 같은 자리 — 하나만
  diffOpen = on;
  $('#diff-view').hidden = !on;
  $('#term-wrap').classList.toggle('diffing', on);
  const w = state.workers.find((x) => x.id === selected);
  if (w) renderDiffButton(w);
  if (on) { term.blur(); diffKey = ''; $('.term-stage').scrollLeft = 0; loadDiff(); } // 터치 기기의 확대 보기는 옆으로 밀려 있을 수 있다
  else if (diffFromChat) { diffFromChat = false; setChatOpen(true); }
  else term.focus();
}
// ---------- 채팅 보기 (터미널 자리) ----------
// 터미널(실제 Claude Code)은 뒤에서 그대로 돌고, 이 화면은 트랜스크립트에서 모은 대화(server /chat · profile.js chatPush)를
// 타임라인으로 다시 그린다. 내 요청은 오른쪽 말풍선, 클로드 쪽(도구 칩 · 답 글 · 권한 카드)은 왼쪽 코랄 줄을 따라 시간순.
// 보내기는 업무 지시와 같은 길(/task — CLI 입력창에 붙여 넣고 Enter). 상태 방송엔 chatRev 표시만 싣고 내용은 열 때·바뀔 때 가져간다
const CHAT_KEY = 'am.chatOpen', CHIP_FOLD = 8;
let chatOpen = false, chatData = { wid: null, gen: null, rev: 0, key: null, items: [] }, chatTimer = null, chatLoading = false;
const chatHtml = new Map(); // `${gen}|${seq}:${rev}` → 그린 HTML (마크다운은 한 번만)
const chatUnfold = new Set(); // 펼친 도구 묶음(첫 칩 seq)
// 보낸 글은 기록(트랜스크립트)에 남아야 목록에 생겨 몇 초 늦게 보였다 — 보내자마자 흐린 말풍선으로 먼저 띄우고,
// 기록에 같은 글의 요청이 들어오면 지운다(공백 빼고 비교). 대기열로 간 Tasks 는 투입될 때까지 '대기열'로 남는다. 10분이 지나면 버린다
let chatPending = [];
// 비교용: Claude Code 는 붙인 그림 경로를 [Image #N] 으로 바꿔 기록한다 → 경로·[Image #N]·공백을 빼고 비교
const chatNorm = (t) => String(t || '').replace(/\[Image #\d+\]/g, '').replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|]*?\.(?:png|jpe?g|gif|webp|bmp|svg)/gi, '').replace(/\s+/g, '');
// 기록에 들어온 요청 하나가 흐린 말풍선 하나를 지운다 — 같은 글이 먼저, 없으면 앞부분(12자)이 같은 것(글이 조금 바뀌어 기록됨)
function chatSettle(wid) {
  const now = Date.now();
  chatPending = chatPending.filter((p) => now - p.at < 600_000);
  const mine = chatPending.filter((p) => p.wid === wid).sort((a, b) => a.at - b.at);
  if (!mine.length || chatData.wid !== wid) return;
  const used = new Set();
  for (const x of chatData.items) {
    if (x.k !== 'u') continue;
    const t = x.ts + clockSkew, live = mine.filter((p) => !used.has(p) && t >= p.at - 5000);
    // 글이 똑같지 않아도 앞부분이 같으면 같은 글(슬래시 명령 · 붙인 글 정리 등으로 조금 바뀌어 기록됨). 전혀 다른 글로는 지우지 않는다 —
    // 예전엔 아무 요청이나 가장 오래된 흐린 말풍선을 지워, 전달되지 못한 글이 흔적 없이 사라져 보였다
    const xn = chatNorm(x.text), hit = live.find((p) => xn === p.norm) || live.find((p) => p.norm.slice(0, 12) && xn.slice(0, 12) === p.norm.slice(0, 12));
    if (hit) used.add(hit);
  }
  chatPending = chatPending.filter((p) => !used.has(p));
}
try { chatOpen = localStorage.getItem(CHAT_KEY) === '1'; } catch {}
function chatMd(text) {
  if (window.marked && window.DOMPurify) {
    try { return `<div class="cv-md">${DOMPurify.sanitize(marked.parse(text))}</div>`; } catch {}
  }
  return `<div class="cv-md cv-plain">${esc(text)}</div>`;
}
const chatTime = (ts) => fmtDate(ts + clockSkew, TIME_HM);
function chatChip(x) {
  const st = x.st === 'err' ? ' err' : x.st === 'ok' ? '' : ' run';
  return `<span class="cv-chip${st}" title="${esc(`${x.name}${x.arg ? ` · ${x.arg}` : ''}`)}">${esc(x.name)}${x.arg ? ` <b>${esc(x.arg)}</b>` : ''}${x.st === 'err' ? ' ✕' : x.st === 'ok' ? '' : ' …'}</span>`;
}
// 요청에 붙은 파일: 글 속 업로드 경로 + 붙인 그림의 원본 경로(files). 경로를 모르는 그림(클립보드)은 개수만
function chatAtt(x) {
  const tiles = attachChips(`${x.text} ${(x.files || []).join(' ')}`, 'sm');
  return tiles || (x.img ? `<div class="cv-sys">🖼 ${_t('이미지 {n}개', { n: x.img })}</div>` : '');
}
function chatItemHtml(x) {
  const k = `${chatData.gen}|${x.seq}:${x.rev}`; // 워커·세션마다 seq 가 겹치므로 세대(gen)까지
  if (chatHtml.has(k)) return chatHtml.get(k);
  let h = '';
  if (x.k === 'u') h = `<div class="cv-ev cv-u"><div class="cv-lab"><b>${_t('나')}</b>${chatTime(x.ts)}</div><div class="cv-msg">${esc(x.text)}${chatAtt(x)}</div></div>`;
  else if (x.k === 'a') h = chatMd(x.text);
  else if (x.k === 'n') h = `<div class="cv-ev cv-n"><span class="cv-dot"></span><div class="cv-sys">${esc(x.text)}</div></div>`;
  else if (x.k === 'x') h = `<div class="cv-ev cv-n"><span class="cv-dot"></span><div class="cv-sys">${_t('사용자가 중단함')} · ${chatTime(x.ts)}</div></div>`;
  else if (x.k === 'e') h = `<div class="cv-ev cv-n cv-err"><span class="cv-dot"></span><div class="cv-sys">${_t('API 오류')} · ${esc(x.text)}</div></div>`;
  chatHtml.set(k, h);
  return h;
}
// 이어지는 도구는 칩 한 줄로, 이어지는 답 글은 이름표 하나 아래로 묶는다
// limit: 끝에서 그만큼의 묶음만 그린다(renderChat 의 chatWin) — 앞이 잘렸으면 맨 위에 '이전 대화' 줄
function chatBlocks(items, limit = Infinity) {
  let out = [];
  for (const x of items) {
    const last = out.at(-1);
    if (x.k === 't') { if (last?.k === 't') last.list.push(x); else out.push({ k: 't', list: [x] }); }
    else if (x.k === 'a') { if (last?.k === 'a') last.list.push(x); else out.push({ k: 'a', list: [x] }); }
    else out.push({ k: x.k, x });
  }
  const cut = Math.max(0, out.length - limit);
  if (cut) out = out.slice(cut);
  return (cut ? `<button type="button" class="cv-older" data-older="1">${_t('이전 대화 {n}개 더 보기', { n: cut })}</button>` : '') + out.map((b) => {
    if (b.k === 't') {
      const id = b.list[0].seq, open = chatUnfold.has(id) || b.list.length <= CHIP_FOLD + 1;
      const shown = open ? b.list : b.list.slice(0, CHIP_FOLD);
      const more = open ? '' : `<button type="button" class="cv-chip cv-more" data-unfold="${id}">+${b.list.length - CHIP_FOLD}</button>`;
      return `<div class="cv-ev cv-t"><span class="cv-dot"></span><div class="cv-chips">${shown.map(chatChip).join('')}${more}</div></div>`;
    }
    if (b.k === 'a') return `<div class="cv-ev cv-a"><span class="cv-dot"></span><div class="cv-body"><div class="cv-lab"><b>${_t('클로드')}</b>${chatTime(b.list[0].ts)}</div>${b.list.map(chatItemHtml).join('')}</div></div>`;
    return chatItemHtml(b.x);
  }).join('');
}
// 끝줄: 결정 대기면 권한 카드, 작업 중이면 '생각 중'
function chatTail(w) {
  const st = viewStatus(w);
  if (st === 'decision' && w.askQ) return ''; // 질문은 입력칸 위 카드(#cv-ask)로
  if (st === 'decision') {
    const perm = /^권한 요청/.test(w.ask || '');
    const q = perm ? _t('도구 실행을 허락할까요?') : _t('클로드가 답을 기다려요');
    const btns = perm
      ? `<button type="button" class="cv-yes" data-key="enter">${_t('허락')}</button><button type="button" data-key="esc">${_t('거절')}</button><button type="button" data-cv="cli">${_t('CLI 에서 고르기')}</button>`
      : `<button type="button" class="cv-yes" data-cv="cli">${_t('CLI 에서 답하기')}</button>`;
    return `<div class="cv-ev cv-p"><span class="cv-dot"></span><div class="cv-perm"><div class="cv-q">${q}</div>${w.ask ? `<code>${esc(w.ask.replace(/^권한 요청\s*/, '').replace(/\s*— 터미널에서 선택하세요$/, ''))}</code>` : ''}<div class="cv-btns">${btns}</div></div></div>`;
  }
  if (st === 'working') return `<div class="cv-ev cv-a cv-think"><span class="cv-dot"></span><div class="cv-sys"><span class="cv-typing"><i></i><i></i><i></i></span> ${_t('생각 중')}</div></div>`;
  return '';
}
function renderChat() {
  const w = state.workers.find((x) => x.id === selected);
  const list = $('#cv-list');
  if (!w || !chatOpen) return;
  const items = chatData.wid === w.id ? chatData.items : [];
  // 아직 클로드가 읽지 않은 글(보낸 직후 · 작업 사이에 전달 · Tasks 대기열) — 대화 끝에 '대기 중' 구분선 아래로 모은다.
  // 대기열(w.queue)은 채팅에서 보낸 흐린 말풍선과 같은 글이면 한 번만
  // 서버가 들고 있는 글(qi = 번호, src: 'now' = 바로 전송 w.nowQ · 'q' = Tasks 대기열 w.queue)은 빼기 · Backlog 로 옮기기 버튼.
  // 이미 CLI 에 넣은 글(클로드가 다음 틈에 읽음)은 뺄 수 없다
  const pend = chatPending.filter((x) => x.wid === w.id), lists = { now: w.nowQ || [], q: w.queue || [] }, claimed = { now: new Set(), q: new Set() };
  const qOf = (norm, srcs) => {
    for (const src of srcs) { const i = lists[src].findIndex((t, j) => !claimed[src].has(j) && chatNorm(t) === norm); if (i >= 0) { claimed[src].add(i); return { src, qi: i }; } }
    return { qi: -1 };
  };
  const pendRows = pend.map((x) => ({ ...x, label: _t(x.label), ...qOf(x.norm, x.mode === 'now' ? ['now', 'q'] : ['q', 'now']) }));
  const rest = (src, label) => lists[src].map((t, i) => ({ text: t, norm: chatNorm(t), src, qi: i, label: label(i) })).filter((q) => !claimed[src].has(q.qi));
  const waiting = [...pendRows, ...rest('now', () => _t('작업 사이에 전달')), ...rest('q', (i) => _t('대기열 {n}번', { n: i + 1 }))];
  const waitActs = (x) => x.qi >= 0
    ? `<span class="cv-wait-acts" data-src="${x.src}" data-qi="${x.qi}"><button type="button" class="cv-wq" data-wq="tomemo" title="${_t('Backlog 로 옮기기')}" aria-label="${_t('Backlog 로 옮기기')}">${UNDO_SVG}</button><button type="button" class="cv-wq" data-wq="unqueue" title="${_t('삭제')}" aria-label="${_t('삭제')}">${X_SVG}</button></span>`
    : '';
  if (list._wid !== w.id) chatWin = CHAT_WIN; // 워커를 바꾸면 다시 최근 것만
  const html = (items.length || waiting.length ? chatBlocks(items, chatWin) : `<div class="cv-empty">${_t(chatLoading ? '불러오는 중…' : '아직 대화가 없어요')}</div>`)
    + (waiting.length ? `<div class="cv-wait-sep"><span>${_t('대기 중 · 클로드가 아직 읽지 않음')} ${waiting.length}</span></div>` : '')
    + waiting.map((x) => `<div class="cv-ev cv-u cv-pending"${x.qi >= 0 ? '' : ` title="${_t('이미 CLI 입력에 넣은 글이라 뺄 수 없어요')}"`}><div class="cv-lab">${waitActs(x)}<b>${_t('나')}</b>${esc(x.label)}</div><div class="cv-msg">${esc(x.text)}${chatAtt({ text: x.text })}</div></div>`).join('')
    + chatTail(w);
  if (list._html === html) return;
  const stick = list._wid !== w.id || list._atBottom !== false, older = chatOlder;
  const fromBottom = older ? list.scrollHeight - list.scrollTop : 0; // 앞에 붙일 때만 읽는다(드묾)
  list.innerHTML = list._html = html;
  for (const a of list.querySelectorAll('.cv-md a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
  chatOlder = false;
  list._wid = w.id;
  list._settling = true;
  afterFrame('chat', () => {
    if (stick) list.scrollTop = list.scrollHeight;
    else if (older) list.scrollTop = list.scrollHeight - fromBottom; // 앞에 붙였으면 보던 줄을 그 자리에
    list._settling = false;
    if (stick) list._atBottom = true;
  });
}
// 대화를 처음엔 끝 CHAT_WIN 묶음만 그린다 — 300개를 다 그리면 배치 계산만 60~130ms(실측 묶음 130~180개 · 요소 1.8~2.8k)라
// 워커를 바꿀 때와 작업 중 새 글이 올 때마다 화면이 멈췄다. 맨 위까지 올리거나 '이전 대화' 를 누르면 앞으로 더 붙인다
const CHAT_WIN = 40, CHAT_MORE = 80;
let chatWin = CHAT_WIN, chatOlder = false;
function chatShowOlder() {
  const list = $('#cv-list');
  if (!list.querySelector('[data-older]')) return;
  chatWin += CHAT_MORE; chatOlder = true;
  renderChat();
}
trackBottom($('#cv-list'), 60);
$('#cv-list').addEventListener('scroll', (e) => { if (!e.currentTarget._settling && e.currentTarget.scrollTop < 80) chatShowOlder(); }, { passive: true });
$('#cv-list').addEventListener('click', (e) => { if (e.target.closest('[data-older]')) chatShowOlder(); });
const chatCache = new Map(), CHAT_CACHE_N = 8; // 워커 id → chatData
async function loadChat() {
  const w = state.workers.find((x) => x.id === selected);
  if (!w || !chatOpen) return;
  const key = w.chatRev;
  // 워커를 바꾸면 그 워커의 지난 대화(chatCache)를 곧장 그리고 바뀐 것만 받는다 — 매번 통째로(~100KB) 받고 그리느라
  // 돌아온 워커도 채팅이 뜨기까지 250ms 남짓 걸렸다
  if (chatData.wid !== w.id) {
    const c = chatCache.get(w.id);
    chatData = c || { wid: w.id, gen: null, rev: 0, key: null, items: [] };
    chatLoading = !c;
    renderChat();
  }
  const q = chatData.gen ? `?gen=${encodeURIComponent(chatData.gen)}&since=${chatData.rev}` : '';
  let d;
  try { d = await (await fetch(`/api/workers/${w.id}/chat${q}`)).json(); } catch { chatLoading = false; return; }
  chatLoading = false;
  if (!chatOpen || selected !== w.id || d.error) return;
  if (d.full) chatData.items = d.items;
  else {
    const at = new Map(chatData.items.map((x, i) => [x.seq, i]));
    for (const x of d.items) { const i = at.get(x.seq); if (i == null) chatData.items.push(x); else chatData.items[i] = x; }
    chatData.items.sort((a, b) => a.seq - b.seq);
    if (chatData.items.length > 300) chatData.items.splice(0, chatData.items.length - 300);
  }
  Object.assign(chatData, { wid: w.id, gen: d.gen, rev: d.rev, key });
  chatCache.delete(w.id); chatCache.set(w.id, chatData); // 최근에 본 순서 — 오래된 것부터 버린다
  if (chatCache.size > CHAT_CACHE_N) chatCache.delete(chatCache.keys().next().value);
  chatSettle(w.id);
  if (chatHtml.size > 2000) chatHtml.clear();
  renderChat();
}
// 상태가 올 때마다(render): 버튼 표시 · 바뀌었으면 가져오기 · 끝줄(상태) 다시 그리기
// 서버에 '이 워커를 채팅으로 보는 중'을 알린다 — 그동안 클로드의 질문은 터미널 대신 채팅 카드로 온다(server holdAsk)
let chatViewSent = '';
function sendChatView() {
  const k = chatOpen && selected ? selected : '';
  if (k === chatViewSent) return;
  const prev = chatViewSent;
  chatViewSent = k;
  if (k || prev) send({ type: 'chatview', id: k || prev, on: Boolean(k) });
}
// ---------- 채팅에서 답하기: 클로드의 질문(AskUserQuestion) 카드 ----------
// 입력칸 바로 위에 따로 그린다(목록은 상태가 올 때마다 다시 그려져 쓰던 '기타' 글이 날아가므로). 질문이 바뀔 때만 새로 그린다.
// 하나만 고르는 질문이 하나뿐이면 누르는 즉시 보낸다. 여러 개 고르기는 이름을 ', ' 로 잇고, '기타' 글은 그 질문의 답(여러 개면 덧붙임)
let askState = null; // { id, qs, sel: Set[], other: string[] }
function renderAsk(w) {
  const box = $('#cv-ask'), q = chatOpen && w.askQ;
  if (!q) { if (box._id) { box.innerHTML = ''; box._id = null; box.hidden = true; askState = null; } return; }
  if (box._id === q.id) return;
  box._id = q.id; box.hidden = false;
  if (q.kind === 'plan') { renderPlanAsk(box, q); return; }
  askState = { id: q.id, qs: q.questions, sel: q.questions.map(() => new Set()), other: q.questions.map(() => '') };
  box.innerHTML = `<div class="cv-ask-card"><div class="cv-q">${_t('클로드가 묻고 있어요')}</div>${q.questions.map((x, i) => `<div class="cv-aq">
    <div class="cv-aq-h">${x.header ? `<span class="cv-aq-tag">${esc(x.header)}</span>` : ''}<span>${esc(x.question)}</span>${x.multiSelect ? `<small>${_t('여러 개 고를 수 있어요')}</small>` : ''}</div>
    <div class="cv-aq-opts">${(x.options || []).map((o, j) => `<button type="button" class="cv-opt" data-q="${i}" data-o="${j}"><b>${esc(o.label)}</b>${o.description ? `<span>${esc(o.description)}</span>` : ''}</button>`).join('')}</div>
    <input class="cv-other" data-q="${i}" placeholder="${esc(_t('기타 — 직접 쓰기 (Enter 로 보내기)'))}"></div>`).join('')}
    <div class="cv-btns"><button type="button" class="cv-yes" data-ask="send" disabled>${_t('답하기')}</button><button type="button" data-ask="cli">${_t('CLI 에서 답하기')}</button></div></div>`;
  const l = $('#cv-list'); l.scrollTop = l.scrollHeight;
}
// 계획 승인 카드(plan mode 끝 — ExitPlanMode). 승인 · 고칠 점을 적어 수정 요청(클로드가 계획을 다시 쓴다) · CLI 에서 고르기(진행 방식 고르기 등)
function renderPlanAsk(box, q) {
  askState = { id: q.id, kind: 'plan' };
  box.innerHTML = `<div class="cv-ask-card cv-plan"><div class="cv-q">${_t('이 계획대로 진행할까요?')}</div>
    <div class="cv-plan-body">${chatMd(q.plan || '')}</div>
    <textarea class="cv-other cv-plan-fb" rows="2" placeholder="${esc(_t('고칠 점 — 적고 수정 요청 (Ctrl+Enter)'))}"></textarea>
    <div class="cv-btns"><button type="button" class="cv-yes" data-plan="approve">${_t('승인')}</button><button type="button" data-plan="revise" disabled>${_t('수정 요청')}</button><button type="button" data-ask="cli">${_t('CLI 에서 고르기')}</button></div></div>`;
  for (const a of box.querySelectorAll('.cv-md a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
  const l = $('#cv-list'); l.scrollTop = l.scrollHeight;
}
async function planSend(approve) {
  const w = state.workers.find((x) => x.id === selected), a = askState, box = $('#cv-ask');
  if (!w || a?.kind !== 'plan') return;
  const feedback = $('.cv-plan-fb', box).value.trim();
  if (!approve && !feedback) return;
  for (const b of box.querySelectorAll('button, textarea')) b.disabled = true;
  const r = await api(`/api/workers/${w.id}/answer`, approve ? { id: a.id, approve: true } : { id: a.id, feedback });
  if (r?.error) { for (const b of box.querySelectorAll('button, textarea')) b.disabled = false; $('[data-plan="revise"]', box).disabled = !$('.cv-plan-fb', box).value.trim(); }
}
function askAnswers() {
  const a = askState, out = {};
  a.qs.forEach((x, i) => {
    const picked = (x.options || []).filter((_, j) => a.sel[i].has(j)).map((o) => o.label), other = a.other[i].trim();
    const v = x.multiSelect ? [...picked, ...(other ? [other] : [])].join(', ') : other || picked[0] || '';
    if (v) out[x.question] = v;
  });
  return Object.keys(out).length === a.qs.length ? out : null;
}
function askSync() {
  const box = $('#cv-ask');
  for (const b of box.querySelectorAll('.cv-opt')) b.classList.toggle('on', askState.sel[b.dataset.q].has(Number(b.dataset.o)));
  $('[data-ask="send"]', box).disabled = !askAnswers();
}
async function askSend(cli) {
  const w = state.workers.find((x) => x.id === selected), a = askState;
  if (!w || !a || (a.kind === 'plan' && !cli)) return;
  const answers = cli ? null : askAnswers();
  if (!cli && !answers) return;
  const box = $('#cv-ask');
  for (const b of box.querySelectorAll('button, input')) b.disabled = true;
  const r = await api(`/api/workers/${w.id}/answer`, cli ? { id: a.id, cli: true } : { id: a.id, answers });
  if (r?.error) { for (const b of box.querySelectorAll('button, input, textarea')) b.disabled = false; if (a.kind !== 'plan') askSync(); return; }
  if (cli) setChatOpen(false);
}
$('#cv-ask').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !askState) return;
  if (b.dataset.plan) return planSend(b.dataset.plan === 'approve');
  if (b.dataset.ask) return askSend(b.dataset.ask === 'cli');
  if (askState.kind === 'plan') return;
  const i = Number(b.dataset.q), j = Number(b.dataset.o), x = askState.qs[i], set = askState.sel[i];
  if (x.multiSelect) { if (set.has(j)) set.delete(j); else set.add(j); }
  else { set.clear(); set.add(j); askState.other[i] = ''; const inp = $(`.cv-other[data-q="${i}"]`, $('#cv-ask')); if (inp) inp.value = ''; }
  askSync();
  if (!x.multiSelect && askState.qs.length === 1) askSend(false);
});
$('#cv-ask').addEventListener('input', (e) => {
  const inp = e.target.closest('.cv-other');
  if (!inp || !askState) return;
  if (askState.kind === 'plan') { $('[data-plan="revise"]', $('#cv-ask')).disabled = !inp.value.trim(); return; }
  const i = Number(inp.dataset.q);
  askState.other[i] = inp.value;
  if (inp.value.trim() && !askState.qs[i].multiSelect) askState.sel[i].clear(); // 하나 고르기면 직접 쓴 글이 답
  askSync();
});
$('#cv-ask').addEventListener('keydown', (e) => {
  if (askState?.kind === 'plan') { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.target.closest('.cv-plan-fb')) { e.preventDefault(); planSend(false); } return; }
  if (e.key === 'Enter' && !e.isComposing && e.target.closest('.cv-other')) { e.preventDefault(); askSend(false); }
});
// 위 막대(CLI | 채팅 · 워커 정보(#detail-meta — 상세 헤더에서 옮김) · 상태)는 터미널에서도 늘 보인다
function chatBar(w) {
  const st = viewStatus(w);
  const stEl = $('#cv-st');
  stEl.textContent = statusLabel(st);
  stEl.style.color = `var(--${st === 'waiting' ? 'idle' : st}, var(--dim))`;
}
// 채팅 글자 크기 — 목록(대화 내용)만 비율로 키운다(CSS zoom: 글·칩·썸네일이 함께). 입력칸·막대는 그대로
const CHAT_ZOOM_KEY = 'am.chatZoom', CHAT_ZOOMS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5];
let chatZoom = 1;
try { const z = Number(localStorage.getItem(CHAT_ZOOM_KEY)); if (CHAT_ZOOMS.includes(z)) chatZoom = z; } catch {}
function setChatZoom(z) {
  const list = $('#cv-list'), keep = list.scrollHeight - list.scrollTop - list.clientHeight < 60; // 맨 아래를 보고 있었으면 그대로 맨 아래
  chatZoom = z;
  list.style.zoom = z === 1 ? '' : String(z);
  $('.cv-zpct').textContent = `${Math.round(z * 100)}%`;
  for (const b of document.querySelectorAll('#cv-zoom [data-zoom]')) b.disabled = (b.dataset.zoom === '-1' && z === CHAT_ZOOMS[0]) || (b.dataset.zoom === '1' && z === CHAT_ZOOMS.at(-1));
  try { z === 1 ? localStorage.removeItem(CHAT_ZOOM_KEY) : localStorage.setItem(CHAT_ZOOM_KEY, String(z)); } catch {}
  if (keep) list.scrollTop = list.scrollHeight;
}
const stepChatZoom = (d) => setChatZoom(d ? CHAT_ZOOMS[Math.max(0, Math.min(CHAT_ZOOMS.length - 1, CHAT_ZOOMS.indexOf(chatZoom) + d))] : 1);
$('#cv-zoom').addEventListener('click', (e) => { const b = e.target.closest('[data-zoom]'); if (b) stepChatZoom(Number(b.dataset.zoom)); });
// 목록 위 Ctrl(⌘)+휠 = 채팅 글자만(브라우저 전체 확대 대신)
$('#cv-list').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  stepChatZoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });
setChatZoom(chatZoom);
function chatSeg() {
  $('#cv-zoom').hidden = !chatOpen;
  for (const b of document.querySelectorAll('.btn-chat')) b.classList.toggle('on', chatOpen);
  for (const b of document.querySelectorAll('.cv-seg [data-cv]')) b.classList.toggle('on', (b.dataset.cv === 'chat') === chatOpen);
}
function syncChat(w) {
  chatSeg();
  chatBar(w);
  sendChatView();
  renderAsk(w);
  if (!chatOpen) return;
  if (chatData.wid !== w.id || chatData.key !== w.chatRev) { clearTimeout(chatTimer); chatTimer = setTimeout(loadChat, chatData.wid === w.id ? 120 : 0); }
  renderChat();
}
function setChatOpen(on, keepPref = false) {
  if (!keepPref) { // 직접 CLI/채팅을 고르면 그 선택대로 — diff 를 닫아도 채팅으로 돌아가지 않는다
    diffFromChat = false;
    try { localStorage.setItem(CHAT_KEY, on ? '1' : '0'); } catch {}
  }
  if (on === chatOpen) return;
  chatOpen = on;
  chatSeg();
  sendChatView();
  if (on && diffOpen) setDiffOpen(false);
  $('#chat-view').hidden = !on;
  $('#term-wrap').classList.toggle('chatting', on);
  peekHidden = false; cliPeekCheck();
  if (on) {
    term.blur();
    loadMdLibs().then(() => { chatHtml.clear(); $('#cv-list')._html = ''; renderChat(); }).catch(() => {}); // 못 불러오면 글 그대로
    const w = state.workers.find((x) => x.id === selected);
    if (w) syncChat(w);
    setTimeout(() => chatForm.text.focus(), 0);
  } else { loadTermSnapIfPending(); term.focus(); } // 채팅 중 미뤄 둔 터미널 기록을 이제 받는다
}
for (const b of document.querySelectorAll('.btn-chat')) b.onclick = () => setChatOpen(!chatOpen);
const chatForm = $('#chat-form');
function chatGrow() {
  const ta = chatForm.text;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  ta.style.overflowY = ta.scrollHeight > 180 ? 'auto' : 'hidden';
  syncAttach(ta);
}
chatForm.text.addEventListener('input', chatGrow);
acceptFiles(chatForm.text);
onEnterKey(chatForm.text, () => chatForm.requestSubmit());
// 보내기 세 갈래(입력칸 오른쪽 버튼): 바로 전송(작업 중이어도 지금 CLI 에) · Tasks(업무 지시와 같음 — 쉬면 바로, 작업 중이면 대기열) ·
// Backlog(나중에 할 작업 — 자동 실행 안 됨). 입력칸 Enter 는 바로 전송. 입력칸에서 Tab 이면 세 버튼을 차례로(마지막 다음은 첫 버튼), Shift+Tab 은 반대 방향, 입력칸으로는 /
async function chatSend(mode) {
  const ta = chatForm.text, text = ta.value.trim();
  const w = state.workers.find((x) => x.id === selected);
  if (!text || !w || ta.readOnly) return;
  if (mode === 'memo') {
    const r = await api('/api/memos', { role: w.name, op: 'add', text });
    if (r?.error) return;
    flyToWorker(w.id, ta, 'memo');
  } else {
    ta.readOnly = true;
    const r = await api(`/api/workers/${w.id}/task`, mode === 'now' ? { text, mode: 'now' } : { text });
    ta.readOnly = false;
    if (r?.rejected) {
      toast(r.rejected === 'starting' ? _t('전송 실패 — 워커가 아직 시작 중입니다. 준비되면 다시 보내세요') : r.rejected === 'blocked'
        ? _t('전송 실패 — CLI 가 입력 대기 화면이 아닙니다(선택창, ! 셸 모드 등). 입력창으로 돌아온 뒤 다시 보내세요')
        : _t('전송 실패 — CLI 입력창에 쓰던 글이 있습니다. 그 글을 보내거나 지운 뒤 다시 보내세요') + (r.seen ? ` · ${_t('감지한 글')}: "${r.seen}"` : ''), r.seen ? 8000 : 4500);
      shake(ta);
      return;
    }
    if (r?.error) return;
    flyToWorker(w.id, ta, 'task');
    const busy = viewStatus(w) === 'working';
    chatPending.push({ wid: w.id, text, mode, norm: chatNorm(text), at: Date.now(), label: mode === 'now' ? (busy ? '작업 사이에 전달' : '보내는 중…') : busy ? '대기열' : '보내는 중…' });
    $('#cv-list')._html = ''; renderChat();
    const l = $('#cv-list'); l.scrollTop = l.scrollHeight;
  }
  ta.value = '';
  chatGrow();
  ta.focus();
}
chatForm.onsubmit = (e) => { e.preventDefault(); chatSend('now'); };
// 대기 중인 글 빼기 · Backlog 로 — Tasks 칸의 ✕ · ↩ 와 같은 API(번호 + 글, 그사이 CLI 로 나갔으면 409)
$('#cv-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-wq]');
  const w = b && state.workers.find((x) => x.id === selected);
  if (!w) return;
  const box = b.parentElement, now = box.dataset.src === 'now', key = now ? 'nowQ' : 'queue';
  const op = b.dataset.wq, i = Number(box.dataset.qi), text = w[key]?.[i];
  if (text == null) return toast(_t('이미 CLI 로 보낸 지시라 옮기지 못했어요'));
  b.disabled = true;
  const r = await fetch(`/api/workers/${w.id}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index: i, text, now }) }).catch(() => null);
  if (!r) { b.disabled = false; return; }
  if (r.status === 409) { toast(_t('이미 CLI 로 보낸 지시라 옮기지 못했어요')); b.disabled = false; return; }
  if (!r.ok) { b.disabled = false; return; }
  const norm = chatNorm(text), k = chatPending.findIndex((p) => p.wid === w.id && p.norm === norm);
  if (k >= 0) chatPending.splice(k, 1); // 흐린 말풍선도 같이 — 상태가 오기 전에 바로 사라지게
  w[key] = w[key].filter((_, j) => j !== i);
  $('#cv-list')._html = ''; renderChat();
  toast(_t(op === 'tomemo' ? 'Backlog 로 옮겼어요' : '대기열에서 뺐어요'), 1500);
});
$('#cv-acts').addEventListener('click', (e) => { const b = e.target.closest('[data-send]'); if (b) chatSend(b.dataset.send); });
// 입력칸 Tab → 첫 버튼(사이에 낀 첨부 타일 링크를 건너뛰게 직접 옮긴다)
chatForm.text.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
  e.preventDefault();
  $('#cv-acts [data-send]').focus();
});
$('#cv-acts').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  // 세 버튼 안에서 돈다 — Tab 은 다음(마지막에서 첫 버튼으로), Shift+Tab 은 반대로. 입력칸으로는 / 로 돌아간다
  const bs = [...$('#cv-acts').querySelectorAll('[data-send]')], i = bs.indexOf(document.activeElement);
  bs[(i + (e.shiftKey ? bs.length - 1 : 1)) % bs.length].focus();
});
// ---------- 채팅 입력칸 / 자동 완성 (CLI 처럼) ----------
// 맨 앞이 / 이고 아직 띄어쓰기 전이면 명령 목록을 입력칸 위에 띄운다. 목록은 워커 작업 폴더 기준(server slashcmds.js)으로 1분 담아 둔다.
// ↑↓ 고르기 · Tab 채우기(인자를 더 쓸 때) · Enter 채우고 바로 보내기(CLI 와 같음) · Esc 닫기. 이름이 앞에서 맞는 것(짧은 것부터) 먼저, 그다음 이름·설명에 들어 있는 것
const SLASH_SRC = { builtin: '기본', project: '프로젝트', user: '내 명령', plugin: '플러그인' };
let slashList = { wid: null, at: 0, items: [] }, slashLoading = null, slashMenu = { items: [], i: 0, open: false };
async function slashCommandsFor(wid) {
  if (slashList.wid === wid && Date.now() - slashList.at < 60_000) return slashList.items;
  slashLoading ??= fetch(`/api/workers/${wid}/commands`).then((r) => r.json()).then((d) => { slashList = { wid, at: Date.now(), items: d.commands || [] }; return slashList.items; })
    .catch(() => []).finally(() => { slashLoading = null; });
  return slashLoading;
}
const slashQuery = (ta) => { const m = ta.value.slice(0, ta.selectionStart).match(/^\/(\S*)$/); return m ? m[1].toLowerCase() : null; };
function slashClose() {
  slashMenu.open = false;
  $('#cv-slash').hidden = true;
}
function slashPaint() {
  const box = $('#cv-slash'), { items, i } = slashMenu;
  box.innerHTML = items.map((x, k) => `<button type="button" class="cv-sl${k === i ? ' on' : ''}" data-k="${k}" tabindex="-1"><b>/${esc(x.name)}</b><span>${esc(x.desc || '')}</span><small>${_t(SLASH_SRC[x.src] || '')}</small></button>`).join('');
  box.hidden = false;
  box.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
// '/명령 ' 뒤(인자를 쓰는 중)엔 그 명령의 인자 힌트(argument-hint)와 설명을 한 줄로 — 키는 가로채지 않는다(Enter 는 그대로 보내기)
function slashHint(ta) {
  const m = ta.value.match(/^\/(\S+)\s/);
  const x = m && ta.selectionStart > m[1].length && slashList.wid === selected && slashList.items.find((c) => c.name === m[1]);
  if (!x || (!x.hint && !x.desc)) return false;
  const box = $('#cv-slash');
  slashMenu.open = false;
  box.innerHTML = `<div class="cv-sl cv-sl-hint"><b>/${esc(x.name)}</b><span>${x.hint ? `<i>${esc(x.hint)}</i> ` : ''}${esc(x.desc || '')}</span><small>${_t(SLASH_SRC[x.src] || '')}</small></div>`;
  box.hidden = false;
  return true;
}
async function slashUpdate() {
  const ta = chatForm.text, q = slashQuery(ta);
  if (q == null && selected && /^\/\S+\s/.test(ta.value)) { await slashCommandsFor(selected); if (!slashHint(ta)) slashClose(); return; }
  if (q == null || !selected) return slashClose();
  const wid = selected, all = await slashCommandsFor(wid);
  if (selected !== wid || slashQuery(ta) !== q) return; // 기다리는 사이 글이 바뀌었으면 다음 입력에 맡긴다
  const head = all.filter((x) => x.name.toLowerCase().startsWith(q)).sort((a, b) => a.name.length - b.name.length); // 짧은 이름부터(/c → /clear)
  const rest = q ? all.filter((x) => !head.includes(x) && (x.name.toLowerCase().includes(q) || (x.desc || '').toLowerCase().includes(q))) : [];
  const items = [...head, ...rest].slice(0, 50);
  if (!items.length) return slashClose();
  const keep = slashMenu.open ? slashMenu.items[slashMenu.i]?.name : null;
  slashMenu = { items, i: Math.max(0, items.findIndex((x) => x.name === keep)), open: true };
  slashPaint();
}
function slashFill(send) {
  const ta = chatForm.text, x = slashMenu.items[slashMenu.i];
  if (!x) return;
  const after = ta.value.slice(ta.selectionStart).replace(/^\S*/, '');
  ta.value = `/${x.name}${after.startsWith(' ') ? '' : ' '}${after.trimStart()}`;
  const at = x.name.length + 2;
  ta.setSelectionRange(at, at);
  slashClose();
  chatGrow();
  ta.focus();
  if (send) chatForm.requestSubmit();
  else slashHint(ta); // 채웠으면 바로 인자 힌트
}
chatForm.text.addEventListener('input', slashUpdate);
chatForm.text.addEventListener('click', slashUpdate);
chatForm.text.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') slashUpdate(); });
chatForm.text.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== chatForm.text) slashClose(); }, 150));
// 입력칸의 다른 키 처리(Enter 보내기 · Tab 버튼 이동 · Esc 중단)보다 먼저 받는다
chatForm.text.addEventListener('keydown', (e) => {
  if (!slashMenu.open || e.isComposing) return;
  const n = slashMenu.items.length;
  const take = () => { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { take(); slashMenu.i = (slashMenu.i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; slashPaint(); }
  else if (e.key === 'Tab' && !e.shiftKey) { take(); slashFill(false); }
  else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { take(); slashFill(true); }
  else if (e.key === 'Escape') { take(); slashClose(); }
}, true);
$('#cv-slash').addEventListener('mousedown', (e) => e.preventDefault()); // 누르는 동안 입력칸 포커스를 잃지 않게
$('#cv-slash').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]');
  if (!b) return;
  slashMenu.i = Number(b.dataset.k);
  slashFill(false);
});
// ---------- 채팅 내용 드래그 → 물어보기 · 복사 ----------
// 대화 목록에서 글을 고르면 고른 곳 위에 작은 버튼을 띄운다. 물어보기 = 고른 글을 인용(> …)으로 입력칸 맨 위에 넣고
// 그 아래에 커서 — 이어서 질문을 쓰면 된다(쓰던 글이 있으면 그 앞에). 입력칸에 넣기 = 고른 글 그대로 커서 자리에. 복사 = 클립보드. 선택이 풀리면(새 메시지로 목록이 다시 그려질 때 포함) 버튼도 닫는다
const quoteBar = el(`<div class="cv-quote" hidden><button type="button" data-q="ask">${_t('물어보기')}</button><button type="button" data-q="paste">${_t('입력칸에 넣기')}</button><button type="button" data-q="copy">${_t('복사')}</button></div>`);
$('#chat-view').append(quoteBar);
let quoteText = '';
function quoteHide() { quoteBar.hidden = true; quoteText = ''; }
function quoteShow() {
  const sel = getSelection(), list = $('#cv-list');
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
  if (!text || !list.contains(sel.anchorNode) || !list.contains(sel.focusNode)) return quoteHide();
  const r = sel.getRangeAt(0).getBoundingClientRect(), box = $('#chat-view').getBoundingClientRect();
  quoteText = text.slice(0, 4000);
  quoteBar.hidden = false;
  const w = quoteBar.offsetWidth, h = quoteBar.offsetHeight;
  const x = Math.min(Math.max(8, r.left + r.width / 2 - box.left - w / 2), box.width - w - 8);
  const above = r.top - box.top - h - 6;
  quoteBar.style.left = `${x}px`;
  const y = above >= 40 ? above : r.bottom - box.top + 6; // 위 막대에 걸리면 고른 글 아래로
  quoteBar.style.top = `${Math.min(Math.max(40, y), box.height - h - 8)}px`; // 고른 글이 일부 가려져 있어도 창 안에
}
$('#cv-list').addEventListener('mouseup', () => setTimeout(quoteShow, 0));
$('#cv-list').addEventListener('keyup', (e) => { if (e.shiftKey) quoteShow(); });
$('#cv-list').addEventListener('scroll', quoteHide);
document.addEventListener('selectionchange', () => { if (!quoteBar.hidden && getSelection()?.isCollapsed) quoteHide(); });
document.addEventListener('mousedown', (e) => { if (!quoteBar.contains(e.target)) quoteHide(); });
quoteBar.addEventListener('mousedown', (e) => e.preventDefault()); // 누르는 동안 선택이 풀리지 않게
quoteBar.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-q]');
  if (!b || !quoteText) return;
  const text = quoteText;
  getSelection()?.removeAllRanges(); // 먼저 — 입력칸에 넣은 뒤에 풀면 입력칸 커서까지 맨 앞으로 간다
  quoteHide();
  quoteText = text;
  if (b.dataset.q === 'copy') {
    try { await navigator.clipboard.writeText(quoteText); toast(_t('복사했습니다'), 1500); } catch { toast(_t('복사하지 못했습니다'), 2500); }
  } else if (b.dataset.q === 'paste') {
    insertAtCursor(chatForm.text, quoteText);
    chatGrow();
  } else {
    const ta = chatForm.text, quoted = quoteText.split(/\r?\n/).map((l) => `> ${l}`).join('\n') + '\n\n';
    ta.value = quoted + ta.value;
    ta.focus();
    ta.setSelectionRange(quoted.length, quoted.length);
    chatGrow();
  }
  quoteText = '';
});
// 채팅 보기에서 Esc = 작업 중단(터미널의 Esc 와 같음). 예전엔 입력칸에 포커스가 있을 때만 돼 세 버튼 · 대화 목록을 누른 뒤나
// 아무 데도 포커스가 없을 땐 듣지 않았다. 쓰던 글이 있는 입력칸(채팅 · 질문 카드의 기타 등)에선 실수로 멈추지 않게 빼고,
// 창(모달) · 크게 보기 · / 목록 · 드래그 버튼처럼 Esc 로 닫는 것이 먼저 받는다(그쪽이 stopPropagation)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || !chatOpen || !selected || $('#detail').hidden) return;
  if (document.querySelector('.modal-back:not([hidden]), .shot-view')) return;
  const f = document.activeElement;
  if (f?.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') && (f !== chatForm.text || f.value)) return;
  if (f && f !== document.body && !f.closest('#chat-view, .cv-bar, #detail')) return;
  const w = state.workers.find((x) => x.id === selected);
  if (!w || viewStatus(w) !== 'working') return;
  e.preventDefault();
  // 연달아 누른 Esc 는 한 번만(서버도 2초 안의 Esc 는 버린다 — 빈 입력창에 Esc 두 번이면 Claude Code 가 되감기 메뉴를 연다)
  if (Date.now() - chatEscAt < 2000) return;
  chatEscAt = Date.now();
  api(`/api/workers/${selected}/interrupt`, {});
  toast(_t('중단했어요 (Esc)'), 1500);
});
let chatEscAt = 0;
// 어느 입력칸에도 포커스가 없을 때 / = 채팅 입력칸으로(검색창 단축키처럼 — / 자체는 넣지 않는다).
// 터미널은 xterm 의 숨은 글상자에 포커스가 있어 textarea 로 걸러진다. 창(모달)·크게 보기 뷰어가 떠 있으면 건드리지 않는다
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing || !chatOpen || !selected || $('#detail').hidden) return;
  if (document.activeElement?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  if (document.querySelector('.modal-back:not([hidden]), .shot-view')) return;
  e.preventDefault();
  chatForm.text.focus();
});
$('.cv-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cv]');
  if (b) setChatOpen(b.dataset.cv === 'chat');
});
$('#chat-view').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.cv === 'cli') return setChatOpen(false);
  if (b.dataset.unfold) { chatUnfold.add(Number(b.dataset.unfold)); $('#cv-list')._html = ''; return renderChat(); }
  // 권한 선택창: Enter = 맨 위(허락), Esc = 거절 — 터미널 선택창에 키를 대신 보낸다
  if (b.dataset.key) sendInput(b.dataset.key === 'enter' ? '\r' : '\x1b');
});
document.addEventListener('langchange', () => { chatHtml.clear(); $('#cv-list')._html = ''; renderChat(); });
if (chatOpen) { chatOpen = false; setChatOpen(true); } // 지난번에 채팅 보기로 두었으면 그대로
const fmtClock = (t) => fmtDate(t + clockSkew, TIME_HMS);
// 요청 글: 붙여 넣은 글 표시(<pasted_content …>) 같은 태그는 빼고 한 줄로
const reqText = (t) => String(t || '').replace(/<\/?[a-z_-]+[^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
// 요청별로 묶기: 요청(오름차순) → 그 요청에서 고친 파일(처음 고친 순) · 파일별 +/− 는 그 요청 안의 수정만 센다
function diffGroups() {
  const files = diffData?.files || [], byTurn = new Map();
  for (const f of files) for (const ed of f.edits) {
    const k = turnKey(ed.turn);
    if (!byTurn.has(k)) byTurn.set(k, new Map());
    const m = byTurn.get(k);
    const x = m.get(f.file) || { ...f, edits: [], add: 0, del: 0, first: Infinity, last: 0, created: false };
    x.edits.push(ed); x.add += ed.add; x.del += ed.del; x.first = Math.min(x.first, ed.ts); x.last = Math.max(x.last, ed.ts);
    if (ed.kind === 'create') x.created = true;
    x.deleted = ed.kind === 'delete'; // 시간순이라 마지막 수정이 지운 것이면 지금은 없는 파일
    m.set(f.file, x);
  }
  const reqOf = new Map((diffData?.requests || []).map((r) => [turnKey(r.turn), r]));
  return [...byTurn.entries()].map(([k, m]) => {
    const fs = [...m.values()].sort((a, b) => a.first - b.first);
    for (const x of fs) x.edits.sort((a, b) => a.ts - b.ts);
    const r = reqOf.get(k) || {};
    return { key: k, turn: r.turn ?? (k === 'null' ? null : Number(k)), prompt: r.prompt, start: r.start ?? fs[0].first, files: fs,
      add: fs.reduce((a, x) => a + x.add, 0), del: fs.reduce((a, x) => a + x.del, 0) };
  }).sort((a, b) => (a.turn ?? -1) - (b.turn ?? -1));
}
function renderDiff() {
  const groups = diffGroups(), latest = groups.at(-1);
  const find = (sel) => sel && groups.find((g) => g.key === sel.turn)?.files.find((x) => x.file === sel.file);
  // 고른 것이 없거나 사라졌으면, 또는 마지막 요청을 따라가는 중이면 마지막 요청의 첫 파일
  if (latest && (!find(diffSel) || (diffFollow && diffSel.turn !== latest.key))) {
    diffSel = { turn: latest.key, file: latest.files[0].file };
    diffExpanded.add(latest.key);
  }
  if (!latest) diffSel = null;
  const allFiles = diffData?.files || [];
  const add = allFiles.reduce((a, f) => a + f.add, 0), del = allFiles.reduce((a, f) => a + f.del, 0);
  $('#diff-clear').hidden = !allFiles.length;
  $('#diff-sum').innerHTML = allFiles.length
    ? `${_t('요청 <b>{n}</b>', { n: groups.length })} · ${_t('파일 <b>{n}</b>', { n: allFiles.length })} <span class="d-add">+${add}</span> <span class="d-del">−${del}</span>` : _t('고친 파일 없음');
  const list = $('#diff-files');
  const fileRow = (g, x) => {
    const slash = x.rel.lastIndexOf('/') + 1 || x.rel.lastIndexOf('\\') + 1;
    const on = diffSel && diffSel.turn === g.key && diffSel.file === x.file;
    return `<li class="df${on ? ' sel' : ''}" data-turn="${g.key}" data-file="${esc(x.file)}" title="${esc(x.file)}">
      <span class="df-name">${esc(x.rel.slice(slash))}${x.deleted ? ` <i class="df-gone">${_t('삭제')}</i>` : x.created ? ` <i class="df-new">${_t('새 파일')}</i>` : ''}</span>
      <span class="df-dir"><bdi>${esc(x.rel.slice(0, slash))}</bdi></span>
      <span class="df-stat"><span class="d-add">+${x.add}</span> <span class="d-del">−${x.del}</span>${x.edits.length > 1 ? ` · ${_t('{n}번', { n: x.edits.length })}` : ''}</span></li>`;
  };
  const listHtml = groups.map((g) => {
    const open = diffExpanded.has(g.key), cur = diffSel?.turn === g.key;
    const text = reqText(g.prompt) || _t('(지난 요청 — 글이 남아 있지 않음)');
    return `<li class="dr${open ? ' open' : ''}${cur ? ' cur' : ''}">
      <div class="dr-head" data-turn="${g.key}" role="button" tabindex="0" aria-expanded="${open}" title="${esc(text)}">
        <span class="dr-main"><span class="dr-top"><b>${g.turn != null ? `#${g.turn}` : '#?'}</b><time>${fmtClock(g.start).slice(0, -3)}</time>
          <span class="dr-stat">${_t('파일 {n}', { n: g.files.length })} · <span class="d-add">+${g.add}</span> <span class="d-del">−${g.del}</span></span></span>
        <span class="dr-text">${esc(text)}</span></span>
      </div>
      ${open ? `<ul class="dr-files">${g.files.map((x) => fileRow(g, x)).join('')}</ul>` : ''}</li>`;
  }).join('');
  if (list._html !== listHtml) {
    const first = !list._html;
    list.innerHTML = list._html = listHtml;
    if (first) list.querySelector('.df.sel')?.scrollIntoView({ block: 'nearest' }); // 처음 열 땐 마지막 요청이 보이게
  }
  const g = diffSel && groups.find((x) => x.key === diffSel.turn), f = g && find(diffSel);
  const main = $('#diff-main');
  // git 저장소가 아니면 셸 명령 비교를 못 한다 — 비어 있는 게 '안 고침'으로 읽히지 않게 늘 알린다
  const shellNote = diffData && diffData.shellTracked === false
    ? `<div class="diff-warn">${_t('이 작업 폴더는 git 저장소가 아니라, 셸 명령(sed·스크립트 등)으로 바뀐 파일은 여기 나오지 않습니다.')}</div>` : '';
  if (!f) { main.innerHTML = `${shellNote}<div class="diff-empty">${_t('이 워커가 고친 파일이 아직 없습니다.')}</div>`; main._file = main._html = null; return; }
  // 고른 요청 안에서 이 파일을 고친 순서대로(위에서 아래로)
  const reqLine = `<div class="diff-reqline"><b>${_t('요청')} ${g.turn != null ? `#${g.turn}` : '#?'}</b>${esc(reqText(g.prompt) || _t('(지난 요청 — 글이 남아 있지 않음)'))}</div>`;
  const html = shellNote + `<div class="diff-path">${reqLine}${esc(f.rel)}<small>${_t('수정 {n}번', { n: f.edits.length })}</small></div>` + f.edits.map((ed) => {
    const tool = ed.tool === 'Bash' ? `${_t('셸 명령')} $ ${ed.cmd || ''}` : ed.tool || (ed.kind === 'create' ? 'Write' : 'Edit');
    const head = [fmtClock(ed.ts), ed.agent ? `🤖 ${ed.agent}` : '', tool, ed.kind === 'create' ? _t('새 파일') : ed.kind === 'delete' ? _t('삭제') : '']
      .filter(Boolean).join(' · ');
    const body = ed.hunks.map((h) => {
      let o = h.oldStart, n = h.newStart;
      const rows = h.lines.map((l) => {
        const sign = l[0], text = esc(l.slice(1));
        if (sign === '+') return `<tr class="dl-add"><td></td><td>${n++}</td><td class="dl-s">+</td><td>${text}</td></tr>`;
        if (sign === '-') return `<tr class="dl-del"><td>${o++}</td><td></td><td class="dl-s">−</td><td>${text}</td></tr>`;
        if (sign === '\\') return `<tr class="dl-meta"><td></td><td></td><td></td><td>${text}</td></tr>`; // \ No newline at end of file
        return `<tr><td>${o++}</td><td>${n++}</td><td class="dl-s"></td><td>${text}</td></tr>`;
      }).join('');
      return `<tr class="dl-hunk"><td colspan="4">@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</td></tr>${rows}`;
    }).join('') || (ed.binary && !ed.img ? `<tr class="dl-meta"><td></td><td></td><td></td><td>${_t('바이너리 파일 — 내용은 비교하지 않음')}</td></tr>` : '');
    // 셸 명령이 바꾼 그림: 전/후를 좌우로 나란히(새 파일은 전, 지운 파일은 후가 빈 칸). 못 꺼내면(git gc 등) 그 칸에 안내
    const imgSide = (side, label) => `<figure class="di-side"><figcaption>${_t(label)}</figcaption>${ed.img[side]
      ? `<a href="/api/workers/${selected}/diff-image?edit=${encodeURIComponent(ed.id)}&side=${side}" target="_blank" rel="noopener"><img loading="lazy" alt="${_t(label)}" src="/api/workers/${selected}/diff-image?edit=${encodeURIComponent(ed.id)}&side=${side}" onerror="this.parentNode.outerHTML='<span class=&quot;di-none&quot;>${_t('그림을 꺼낼 수 없음')}</span>'"></a>`
      : `<span class="di-none">${_t(side === 'before' ? '없음 (새 파일)' : '없음 (삭제됨)')}</span>`}</figure>`;
    const imgCmp = ed.img ? `<div class="diff-img">${imgSide('before', '변경 전')}${imgSide('after', '변경 후')}</div>` : '';
    return `<section class="diff-edit"><div class="de-head"><span title="${esc(head)}">${esc(head)}</span><span class="d-add">+${ed.add}</span><span class="d-del">−${ed.del}</span>${ed.userModified ? `<i class="de-user" title="${_t('승인 창에서 사람이 내용을 고쳐서 반영됨')}">${_t('사람이 고침')}</i>` : ''}${ed.cut ? `<i title="${_t('너무 길어 앞부분만 보여 줌')}">${_t('일부만')}</i>` : ''}</div>${body ? `<table class="diff-tbl">${body}</table>` : ''}${imgCmp}</section>`;
  }).join('');
  const view = `${g.key}|${f.file}`; // 같은 요청·파일을 다시 그릴 땐 보던 스크롤 자리를 지킨다
  if (main._html !== html) {
    const keep = main._file === view ? main.scrollTop : 0;
    main.innerHTML = main._html = html;
    main.scrollTop = keep;
    main._file = view;
  }
}
// 요청 줄: 펼치기/접기 · 파일 줄: 그 요청에서 이 파일의 변경 보기
function toggleDiffReq(key) {
  if (diffExpanded.has(key)) diffExpanded.delete(key); else diffExpanded.add(key);
  renderDiff();
}
$('#diff-files').addEventListener('click', (e) => {
  const head = e.target.closest('.dr-head');
  if (head) { toggleDiffReq(head.dataset.turn); return; }
  const li = e.target.closest('li.df');
  if (!li) return;
  const groups = diffGroups();
  diffSel = { turn: li.dataset.turn, file: li.dataset.file };
  diffFollow = li.dataset.turn === groups.at(-1)?.key; // 마지막 요청을 고르면 다시 따라간다
  renderDiff();
});
$('#diff-files').addEventListener('keydown', (e) => {
  const head = e.target.closest('.dr-head');
  if (head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleDiffReq(head.dataset.turn); }
});
for (const b of document.querySelectorAll('.btn-diff')) b.onclick = () => setDiffOpen(!diffOpen);
$('#btn-full').onclick = () => setTermFull(!$('#term-wrap').classList.contains('full'));
$('#btn-full-exit').onclick = () => setTermFull(false);
$('#btn-remove').onclick = async () => {
  if (!selected || !(await ask({ title: _t('워커를 제거할까요?'), body: _t('목록에서 지웁니다. 실행 중이면 Claude 세션도 종료됩니다.'), ok: _t('제거'), danger: true }))) return;
  await api(`/api/workers/${selected}/remove`);
  selected = null; render();
};
// 상세 닫기 — 선택된 워커 카드(또는 칩)를 다시 누르면 (닫기 버튼 대신: 버튼줄이 좁은 화면·영어에서 넘치지 않게)
function closeDetail() { if (selected) saveTermScroll(selected); selected = null; render(); }

connect();

// 다른 탭에 있다가 돌아오면, 열어 둔 워커의 완료를 확인 처리하도록 다시 그린다
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });

// ---------- 모바일(터치 기기) ----------
// 마우스로 하던 일(끌어 놓기 · 더블클릭 · 휴지통)을 손가락으로: 카드·칩·메모를 길게 누르거나 카드의 ⋯ 를 누르면
// 화면 아래에서 메뉴가 올라온다. 터미널 아래엔 화면 키보드에 없는 키 줄(term-keys)
const sheetEl = el(`<div class="sheet-back" hidden><div class="sheet panel" role="menu"><div class="sheet-h"></div><div class="sheet-list"></div><button type="button" class="sheet-item sheet-cancel"></button></div></div>`);
document.body.append(sheetEl);
let sheetDone = null;
// 고른 항목의 key 를 돌려준다. 취소·바깥 누르기 → null
function sheet(title, items) {
  sheetDone?.(null);
  const list = items.filter(Boolean);
  $('.sheet-h', sheetEl).textContent = title;
  $('.sheet-h', sheetEl).hidden = !title;
  $('.sheet-list', sheetEl).innerHTML = list.map((it, i) =>
    `<button type="button" class="sheet-item${it.danger ? ' danger' : ''}" role="menuitem" data-i="${i}"${it.disabled ? ' disabled' : ''}>${esc(it.label)}</button>`).join('');
  $('.sheet-cancel', sheetEl).textContent = _t('취소');
  sheetEl.hidden = false;
  return new Promise((resolve) => {
    sheetDone = (v) => { sheetDone = null; sheetEl.hidden = true; resolve(v); };
    sheetEl.onclick = (e) => {
      const b = e.target.closest('.sheet-item[data-i]');
      if (b) sheetDone(list[b.dataset.i].key);
      else if (e.target === sheetEl || e.target.closest('.sheet-cancel')) sheetDone(null);
    };
  });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetDone) { e.preventDefault(); e.stopPropagation(); sheetDone(null); } }, true);

// 카드(대기실 포함)·최소화 칩 메뉴 — 투입 · 중단 · 이름 바꾸기 · 앞뒤로 옮기기 · 제거
const cardOrder = () => [...new Set([...nodesEl.querySelectorAll('.node')].map((n) => n.dataset.name).filter(Boolean))];
function moveCard(name, dir) {
  const order = cardOrder(), i = order.indexOf(name), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  state.order = order; // 서버 응답 전 깜빡임 방지 (끌어 놓기와 같다)
  renderFloor(); renderDock();
  api('/api/order', { order });
}
async function cardMenu(n) {
  const socket = n.classList.contains('socket');
  const w = !socket && state.workers.find((x) => x.id === n.dataset.id);
  const name = socket ? n.dataset.profile : w?.name;
  if (!name) return;
  const order = cardOrder(), i = order.indexOf(name);
  const at = socket && state.resumable?.[name];
  const key = await sheet(socket ? _t('{name} · 대기실', { name }) : `${w.id} · ${name}`, [
    socket && { key: 'launch', label: at ? _t('▶ 이어서 투입 (마지막 세션 {t})', { t: fmtAgo(at) }) : _t('▶ 투입') },
    at && { key: 'fresh', label: _t('▶ 새 세션으로 투입') },
    w && ['working', 'decision'].includes(w.status) && { key: 'stop', label: _t('⏸ 중단') },
    { key: 'rename', label: _t('이름 바꾸기') },
    { key: 'prev', label: _t('← 앞으로 옮기기'), disabled: i <= 0 },
    { key: 'next', label: _t('뒤로 옮기기 →'), disabled: i < 0 || i >= order.length - 1 },
    { key: 'remove', label: _t(socket ? '저장된 역할 삭제' : '제거'), danger: true },
  ]);
  if (key === 'launch' || key === 'fresh') launchProfile(name, key === 'fresh');
  if (key === 'stop') api(`/api/workers/${w.id}/interrupt`);
  if (key === 'prev' || key === 'next') moveCard(name, key === 'prev' ? -1 : 1);
  if (key === 'remove') removeCard(n);
  if (key === 'rename') {
    const to = await ask({ title: _t('이름 바꾸기'), ok: _t('저장'), input: name });
    if (!to || to === name) return;
    const r = await api(socket ? '/api/profiles/rename' : `/api/workers/${w.id}/rename`, { from: name, name: to });
    if (r.error) toast(r.error, 3500);
  }
}

// 나중에 할 작업 메뉴 — 보내기 · 수정 · 위아래로 · 다른 워커로 옮기기 · 삭제
async function memoMenu(li) {
  const w = state.workers.find((x) => x.id === selected);
  if (!w) return;
  const lis = [...$('#memos').querySelectorAll('li[data-id]')], i = lis.indexOf(li);
  const others = cardOrder().filter((n) => n !== w.name); // 끌어 놓기처럼 대기실 역할에도 옮길 수 있다
  const key = await sheet($('.mt', li)?.textContent.slice(0, 80) || '', [
    { key: 'send', label: _t('Tasks 로 보내기') },
    { key: 'edit', label: _t('내용 수정') },
    { key: 'up', label: _t('↑ 위로'), disabled: i <= 0 },
    { key: 'down', label: _t('↓ 아래로'), disabled: i >= lis.length - 1 },
    { key: 'move', label: _t('다른 워커로 옮기기…'), disabled: !others.length },
    { key: 'remove', label: _t('삭제'), danger: true },
  ]);
  if (key === 'up' || key === 'down') {
    const ids = lis.map((l) => l.dataset.id), j = i + (key === 'up' ? -1 : 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const list = state.memos?.[w.name];
    if (list) list.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)); // 서버 상태가 오기 전에 바로 보이게
    memoSig = ''; renderMemos(w);
    api('/api/memos', { role: w.name, op: 'reorder', ids });
  } else if (key === 'move') {
    const to = await sheet(_t('어느 워커로 옮길까요?'), others.map((n) => ({ key: n, label: n })));
    if (!to) return;
    li.classList.add('busy');
    const r = await api('/api/memos', { role: w.name, op: 'move', id: li.dataset.id, to });
    if (r.error) { li.classList.remove('busy'); toast(r.error, 3000); }
    else toast(_t("'{name}' 의 Backlog 로 옮겼습니다", { name: to }));
  } else if (key) memoAct(key, li, w);
}

// 터미널 키 줄 — 화면 키보드에 없는 키를 CLI 에 바로 보낸다. 누를 때 포커스를 옮기지 않아 열린 키보드가 닫히지 않는다
const TERM_KEYS = { esc: '\x1b', ctrlc: '\x03', stab: '\x1b[Z', tab: '\t', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', enter: '\r' };
const termKeys = $('#term-keys');
let termTyping = false;
// 터미널을 눌러 스크롤할 때마다 화면 키보드가 뜨지 않게 평소엔 inputmode=none — ⌨ 를 눌렀을 때만 키보드로 입력
function setTermTyping(on) {
  const ta = term.textarea;
  termTyping = on;
  $('[data-key="type"]', termKeys).classList.toggle('on', on);
  if (!ta) return;
  if (on) { ta.blur(); ta.inputMode = 'text'; term.focus(); }
  else { ta.inputMode = 'none'; ta.blur(); }
}
termKeys.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
termKeys.addEventListener('click', async (e) => {
  const k = e.target.closest('[data-key]')?.dataset.key;
  if (!k || !selected) return;
  if (TERM_KEYS[k]) { if (!termLocked()) send({ type: 'input', id: selected, data: TERM_KEYS[k] }); return; }
  if (k === 'type') setTermTyping(!termTyping);
  if (k === 'zoom') {
    termZoom = !termZoom;
    try { localStorage.setItem(TOUCH_ZOOM_KEY, termZoom ? '1' : '0'); } catch {}
    $('.term-stage').scrollLeft = 0;
    fitTerm();
  }
  if (k === 'paste') {
    try {
      const text = await navigator.clipboard.readText();
      if (text) term.paste(text); else toast(_t('클립보드가 비어 있습니다'));
    } catch { toast(_t('클립보드를 읽지 못했습니다 — 브라우저가 허용하지 않았어요'), 3000); }
  }
});

if (TOUCH) {
  if (term.textarea) {
    term.textarea.inputMode = 'none';
    term.textarea.addEventListener('blur', () => { if (termTyping) setTermTyping(false); });
  }
  // 터미널 손가락 스크롤: xterm 6 은 터치로 스크롤되지 않는다(실측 — 스크롤 영역이 자체 스크롤바라 브라우저 기본 스크롤도 없음).
  // 처음 8px 움직임으로 방향을 정해 세로면 기록을 줄 단위로 올리고 내리고(손을 떼면 관성), 가로면 확대 보기의 터미널을 옆으로 민다
  const stage = $('.term-stage');
  let pan = null, glide = 0;
  const lineH = () => ($('#term .xterm-screen')?.clientHeight || 0) / term.rows || 16;
  stage.addEventListener('touchstart', (e) => {
    cancelAnimationFrame(glide);
    const t = e.touches[0];
    pan = e.touches.length === 1 && !diffOpen ? { x: t.clientX, y: t.clientY, left: stage.scrollLeft, axis: null, rest: 0, v: 0, at: e.timeStamp } : null;
  }, { passive: true });
  stage.addEventListener('touchmove', (e) => {
    if (!pan) return;
    const t = e.touches[0], dx = t.clientX - pan.x, dy = t.clientY - pan.y;
    if (!pan.axis && Math.hypot(dx, dy) > 8) {
      pan.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      pan.y = t.clientY; // 세로는 방향이 정해진 자리부터 센다(처음 8px 만큼 튀지 않게)
    }
    if (!pan.axis) return;
    e.preventDefault(); e.stopPropagation();
    if (pan.axis === 'x') { stage.scrollLeft = pan.left - dx; return; }
    const step = pan.y - t.clientY, dt = Math.max(1, e.timeStamp - pan.at);
    pan.y = t.clientY; pan.at = e.timeStamp;
    pan.v = step / dt; // px/ms — 손을 뗄 때 관성에 쓴다
    pan.rest += step / lineH();
    const n = Math.trunc(pan.rest);
    if (n) { term.scrollLines(n); pan.rest -= n; }
  }, { passive: false });
  stage.addEventListener('touchend', () => {
    if (pan?.axis === 'y' && Math.abs(pan.v) > 0.2) {
      let v = pan.v, rest = 0, last = performance.now();
      const step = (now) => {
        const dt = now - last; last = now;
        rest += (v * dt) / lineH();
        const n = Math.trunc(rest);
        if (n) { term.scrollLines(n); rest -= n; }
        v *= Math.pow(0.995, dt); // 서서히 멈춘다
        if (Math.abs(v) > 0.02) glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    }
    pan = null;
  });
  // 터치로 끌면 브라우저가 HTML 끌어 놓기를 시작한다(카드 순서·휴지통·메모 옮기기) — 길게 누르기 메뉴와 겹치지 않게 막는다
  document.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
  // 길게 누르기(0.5초, 손가락이 10px 넘게 움직이면 스크롤로 보고 취소) → 메뉴. 그 뒤 따라오는 클릭은 삼킨다(카드가 열리지 않게)
  const LP = '.node, .dchip, #memos li[data-id]';
  let lpTimer = 0, lpAt = null, lpFired = false;
  const lpCancel = () => { clearTimeout(lpTimer); lpAt = null; };
  document.addEventListener('pointerdown', (e) => {
    lpFired = false;
    if (e.pointerType !== 'touch') return;
    const t = e.target.closest(LP), inner = e.target.closest('button, a, input, textarea, [data-shot]');
    if (!t || (inner && inner !== t) || t.matches('.renaming, .editing')) return;
    lpAt = { x: e.clientX, y: e.clientY };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      lpAt = null; lpFired = true;
      navigator.vibrate?.(12);
      if (t.matches('#memos li')) memoMenu(t); else cardMenu(t);
    }, 500);
  }, true);
  document.addEventListener('pointermove', (e) => { if (lpAt && Math.hypot(e.clientX - lpAt.x, e.clientY - lpAt.y) > 10) lpCancel(); }, true);
  document.addEventListener('pointerup', lpCancel, true);
  document.addEventListener('pointercancel', lpCancel, true);
  document.addEventListener('click', (e) => { if (lpFired) { lpFired = false; e.preventDefault(); e.stopPropagation(); } }, true);
  document.addEventListener('contextmenu', (e) => { if (e.target.closest(LP)) e.preventDefault(); }); // 안드로이드: 길게 누르면 뜨는 기본 메뉴
  // 툴팁(ⓘ·미터·차트)은 눌렀을 때 뜬다(브라우저가 보내는 마우스 호환 이벤트). 스크롤하면 닫는다 — 떠 있는 채로 내용을 가리지 않게
  addEventListener('scroll', () => { const tip = $('#tip'); if (!tip.hidden) { tip.hidden = true; mtPt = null; } }, { passive: true, capture: true });
  // 헤더 로고를 누르면 맨 위(워커 카드)로 — 상세 화면을 보다가 다른 워커로 갈 때
  $('.brand').addEventListener('click', () => scrollTo({ top: 0, behavior: 'smooth' }));
}
