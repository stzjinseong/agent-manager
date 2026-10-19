// ---------- 알림 보관함 ----------
// 상단 알림 띠(서버 재시작 안내 · 하루 요약 도착)에 '보관' 버튼을 달아, 지금 처리하지 않을 알림을 헤더의 보관함으로 넣어 둔다.
// - 보관: 띠가 보관함 버튼으로 빨려 들어가고(뚜껑이 열렸다 닫힘), 띠는 숨는다
// - 꺼내기: 보관함에서 띠가 튀어나와 원래 자리로 돌아간다. 보관함 안에서 바로 처리(재시작 · 열어 보기)도 된다
// - 알림이 끝나면(서버를 재시작함 · 요약을 읽음) 보관함에서도 저절로 빠진다
// 보관 목록은 이 브라우저에만 기억한다(localStorage) — 띠를 그리는 곳(renderStale · renderDaily)이 window.isStashed 로 묻는다
(() => {
  const T = (s, v) => _t(s, v);
  const KEY = 'am.stash';
  const BOX = '<svg class="st-ico" viewBox="0 0 24 24" aria-hidden="true"><path class="st-body" d="M5 10v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-9M10 13.5h4" stroke-linecap="round" stroke-linejoin="round"/><path class="st-lid" d="M3.5 6.5A1.5 1.5 0 0 1 5 5h14a1.5 1.5 0 0 1 1.5 1.5V9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" stroke-linejoin="round"/></svg>';
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let items = (() => { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } })();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch {} };

  // 보관할 수 있는 알림 — now(): 지금 떠 있어야 할 알림의 키(없으면 null). 키에 날짜 등이 들어가 다음 알림은 다시 뜬다
  const KINDS = {
    stale: {
      bar: () => $('#stale-bar'),
      now: () => (state.serverStale ? 'stale' : null),
      ico: '↻', title: () => T('서버 재시작 필요'), sub: () => T('서버 코드가 바뀌었습니다 — 새 기능을 쓰려면 서버를 재시작하세요 (워커는 그대로 유지)'),
      act: () => T('↻ 지금 재시작'), run: () => restartServer(),
    },
    daily: {
      bar: () => $('.daily-bar'),
      now: () => (state.daily && !state.daily.seen ? `daily:${state.daily.date}` : null),
      ico: '📬', title: () => T('하루 요약 카드가 도착했어요'), sub: () => state.daily?.date || '',
      act: () => T('열어 보기'), run: () => $('.daily-bar .db-open')?.click(),
    },
  };
  window.isStashed = (key) => items.some((x) => x.key === key);

  // ---------- 헤더 버튼 · 목록 ----------
  const btn = el(`<button id="btn-stash" class="btn ghost lang-btn sched-btn stash-btn">${BOX}<i class="sched-n" hidden></i></button>`);
  document.querySelector('#btn-theme')?.after(btn); // 헤더 버튼들 중 맨 왼쪽 — 다크/라이트 토글 바로 오른쪽
  newDot(btn, 'stash');
  const pop = el('<div class="panel st-pop" hidden></div>');
  document.body.append(pop);
  const closePop = () => { pop.hidden = true; };
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closePop(); });
  btn.onclick = () => {
    if (!pop.hidden) return closePop();
    renderPop();
    pop.hidden = false;
    const r = btn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
  };

  const ago = (t) => {
    const m = Math.floor((Date.now() - t) / 60000);
    return m < 1 ? T('방금 보관') : m < 60 ? T('{n}분 전 보관', { n: m }) : T('{n}시간 전 보관', { n: Math.floor(m / 60) });
  };
  function renderPop() {
    pop.innerHTML = `<div class="st-h">${esc(T('알림 보관함'))}</div>` + (items.length ? items.map((x) => {
      const k = KINDS[x.kind];
      return `<div class="st-item" data-key="${esc(x.key)}">
          <span class="st-i" aria-hidden="true">${k.ico}</span>
          <div class="st-main"><b>${esc(k.title())}</b><span>${esc(k.sub())}</span><small>${esc(ago(x.at))}</small></div>
          <div class="st-acts"><button type="button" class="btn ghost" data-act="out">${esc(T('꺼내기'))}</button><button type="button" class="btn" data-act="run">${esc(k.act())}</button></div>
        </div>`;
    }).join('') : `<div class="st-empty">${esc(T('보관한 알림이 없어요 — 알림 띠의 \'보관\' 을 누르면 여기로 들어와요'))}</div>`);
  }
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'), key = e.target.closest('[data-key]')?.dataset.key;
    const x = items.find((i) => i.key === key);
    if (!b || !x) return;
    if (b.dataset.act === 'out') { takeOut(x, e.target.closest('.st-item')); return; }
    closePop();
    KINDS[x.kind].run();
  });

  // ---------- 연출 ----------
  // 띠 모양 그대로 떼어 낸 복제본을 띄워 움직인다(진짜 띠는 숨기거나 제자리에 둔 채)
  function ghost(bar, rect) {
    const g = bar.cloneNode(true);
    g.removeAttribute('id'); g.hidden = false;
    g.classList.add('st-ghost');
    Object.assign(g.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    document.body.append(g);
    return g;
  }
  const center = (r) => [r.left + r.width / 2, r.top + r.height / 2];
  function lid(open) { btn.classList.toggle('st-open', open); }
  function bump() { btn.classList.remove('st-got'); void btn.offsetWidth; btn.classList.add('st-got'); }

  function putIn(kind) {
    const k = KINDS[kind], bar = k.bar(), key = k.now();
    if (!bar || !key || window.isStashed(key)) return;
    const rect = bar.getBoundingClientRect();
    items = [...items.filter((x) => x.key !== key), { key, kind, at: Date.now() }];
    save();
    if (reduce() || !rect.width) { render(); bump(); return; }
    const g = ghost(bar, rect);
    render(); // 띠를 숨긴다 — 아래 띠는 renderTopStack 이 당겨 올린다
    lid(true);
    const [x0, y0] = center(rect), [x1, y1] = center(btn.getBoundingClientRect());
    const dx = x1 - x0, dy = y1 - y0, s = Math.max(0.04, 22 / rect.width);
    g.animate([
      { transform: 'none', opacity: 1, borderRadius: '10px' },
      { transform: 'scale(.94, .72)', opacity: 1, offset: 0.22 },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.35}px) scale(${Math.min(0.45, s * 6)}, ${Math.min(0.5, s * 7)})`, opacity: 0.9, offset: 0.62 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s}, ${s * 1.4})`, opacity: 0.2, borderRadius: '40px' },
    ], { duration: 640, easing: 'cubic-bezier(.5, 0, .7, .45)' }).finished.then(() => {
      g.remove();
      lid(false);
      bump();
    });
  }

  function takeOut(x, row) {
    const k = KINDS[x.kind];
    items = items.filter((i) => i.key !== x.key);
    save();
    if (row) row.classList.add('st-leave');
    setTimeout(renderPop, reduce() ? 0 : 200);
    render(); // 띠가 다시 보인다
    const bar = k.bar();
    if (reduce() || !bar || bar.hidden) return;
    lid(true);
    bar.style.visibility = 'hidden';
    // renderTopStack 의 '내려오며 나타나기'(MutationObserver → 다음 마이크로태스크)를 지우고 이쪽 연출로 대신한다
    requestAnimationFrame(() => {
      bar.getAnimations().forEach((a) => a.cancel());
      const rect = bar.getBoundingClientRect(), g = ghost(bar, rect);
      const [x0, y0] = center(btn.getBoundingClientRect()), [x1, y1] = center(rect);
      const dx = x0 - x1, dy = y0 - y1, s = Math.max(0.04, 22 / rect.width);
      g.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${s}, ${s * 1.4})`, opacity: 0.2, borderRadius: '40px' },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.5}px) scale(${Math.min(0.5, s * 7)}, ${Math.min(0.55, s * 8)})`, opacity: 0.95, offset: 0.4 },
        { transform: 'translateY(6px) scale(1.02, .94)', opacity: 1, offset: 0.82, borderRadius: '10px' },
        { transform: 'none', opacity: 1, borderRadius: '10px' },
      ], { duration: 680, easing: 'cubic-bezier(.2, .7, .3, 1)' }).finished.then(() => {
        g.remove();
        bar.style.visibility = '';
      });
      setTimeout(() => lid(false), 260);
    });
  }

  // 띠마다 '보관' 버튼 — 서버 재시작 띠는 재시작 버튼 옆, 하루 요약 띠는 ✕ 앞
  function addStashButton(kind, before) {
    const bar = KINDS[kind].bar();
    if (!bar) return;
    const b = el(`<button type="button" class="btn ghost st-put">${BOX}<span></span></button>`);
    b.onclick = () => putIn(kind);
    before ? bar.querySelector(before)?.before(b) : bar.append(b);
  }
  addStashButton('stale');
  addStashButton('daily', '.db-x');

  window.renderStash = () => {
    if (!state.now) return; // 첫 상태가 오기 전엔 알림이 끝났는지 모른다
    // 끝난 알림(재시작함 · 읽음 · 다음 날 카드)은 보관함에서도 뺀다
    const live = items.filter((x) => KINDS[x.kind] && KINDS[x.kind].now() === x.key);
    if (live.length !== items.length) { items = live; save(); }
    const n = $('.sched-n', btn);
    n.hidden = !items.length; n.textContent = items.length;
    btn.title = items.length ? T('알림 보관함 · {n}개', { n: items.length }) : T('알림 보관함');
    btn.setAttribute('aria-label', btn.title);
    for (const b of document.querySelectorAll('.st-put')) { b.lastElementChild.textContent = T('보관'); b.title = T('나중에 처리 — 헤더의 보관함으로 넣어 두기'); }
    if (!pop.hidden) renderPop();
  };
  document.addEventListener('langchange', () => window.renderStash());
})();
