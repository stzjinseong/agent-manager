// ---------- 하루 요약 카드 ----------
// 서버(rolestats.js)가 역할 이름마다 쌓은 기록으로 하루 요약 카드를 만들고, 마지막 카드의 머리말을 state.daily 로 보낸다.
// - 매일 오후 5시(KST)에 카드가 만들어지면 헤더 아래에 '도착' 띠가 겹쳐 뜨고, 누르면 그날의 요약을 연다.
//   헤더의 우편함 버튼은 언제든 다시 열기(안 읽은 카드가 있으면 점)
(() => {
  const T = (s, v) => _t(s, v);
  const money = (v) => fmtUsd(v || 0);
  const dur = (ms) => {
    const m = Math.round((ms || 0) / 60_000);
    if (m < 1) return ms > 0 ? T('1분 미만') : T('없음');
    return m < 60 ? T('{n}분', { n: m }) : T('{h}시간 {m}분', { h: Math.floor(m / 60), m: m % 60 });
  };
  const hhmm = (t) => new Date(t).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
  const dateLabel = (d) => new Date(`${d}T12:00:00+09:00`).toLocaleDateString(uiLocale(), { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul' });

  // ---------- 공통 모달 ----------
  const back = el(`<div class="modal-back gr-back" hidden><div class="modal panel gr-modal" role="dialog" aria-modal="true" tabindex="-1"></div></div>`);
  document.body.append(back);
  const box = back.firstElementChild;
  const close = () => { back.hidden = true; };
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-gr=close]')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !back.hidden) close(); });
  const show = (html, cls) => { box.className = `modal panel gr-modal ${cls}`; box.innerHTML = html; back.hidden = false; box.focus(); };

  const tile = (label, value, sub = '') => `<div class="gr-tile"><small>${esc(label)}</small><b>${esc(value)}</b>${sub ? `<em>${esc(sub)}</em>` : ''}</div>`;

  // ---------- 하루 요약 카드 ----------
  const bar = el(`<div class="daily-bar" role="status" hidden>
      <span class="db-ico" aria-hidden="true">📬</span>
      <span class="db-text"></span>
      <button class="btn db-open"></button>
      <button class="btn ghost db-x" aria-label=""></button>
    </div>`);
  document.querySelector('#top-stack').append(bar); // 상단 알림 띠 묶음 — 재시작 안내 띠 등과 차례로 쌓인다
  let dismissed = null; // 띠만 닫은 카드 날짜 — 헤더 버튼의 점은 읽을 때까지 남는다

  // 헤더의 우편함 버튼 — 나의 사용 리포트 버튼 옆
  const btn = el(`<button id="btn-daily" class="btn ghost lang-btn daily-btn" hidden>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5h17v11h-17z" stroke-linejoin="round"/><path d="m3.5 7.5 8.5 6.5 8.5-6.5" stroke-linejoin="round"/></svg>
      <i class="upd-dot" hidden></i>
    </button>`);
  document.querySelector('#btn-ureport')?.after(btn);
  btn.onclick = () => openDaily(state.daily?.date);
  newDot(btn, 'daily'); // 새 기능 점 (app.js) — 안 읽은 카드 점과 같은 자리
  bar.querySelector('.db-open').onclick = () => openDaily(state.daily?.date);
  bar.querySelector('.db-x').onclick = () => { dismissed = state.daily?.date; renderDaily(); };

  window.renderDaily = () => {
    const d = state.daily;
    btn.hidden = !d;
    const label = T('하루 요약');
    btn.title = label; btn.setAttribute('aria-label', label);
    btn.querySelector('.upd-dot').hidden = !d || d.seen;
    const show = Boolean(d && !d.seen && dismissed !== d.date && !window.isStashed?.(`daily:${d.date}`)); // 보관함에 넣었으면 숨김 (stash.js)
    bar.hidden = !show;
    if (!show) return;
    bar.querySelector('.db-text').innerHTML = `<b>${esc(T('하루 요약 카드가 도착했어요'))}</b> <small>${esc(dateLabel(d.date))} · ${esc(T('오후 5시 기준'))}</small>`;
    bar.querySelector('.db-open').textContent = T('열어 보기');
    bar.querySelector('.db-x').textContent = '✕';
    bar.querySelector('.db-x').setAttribute('aria-label', T('나중에 보기'));
    bar.querySelector('.db-x').title = T('나중에 보기');
  };

  async function openDaily(date) {
    let c;
    try { c = await (await fetch(`/api/daily${date ? `?date=${encodeURIComponent(date)}` : ''}`)).json(); } catch { return; }
    if (!c || c.none) return;
    show(dailyHtml(c), 'gr-daily');
    box.querySelectorAll('[data-date]').forEach((b) => { b.onclick = () => openDaily(b.dataset.date); });
    if (!c.seen) fetch('/api/daily/seen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: c.date }) }).catch(() => {});
  }

  function dailyHtml(c) {
    const t = c.total;
    const dates = state.daily?.dates || [c.date];
    const ends = t.done + t.interrupted + t.failed;
    const lead = !t.roles ? T('오늘은 워커들이 쉬었어요 — 기록된 작업이 없어요.')
      : c.mvp ? T('오늘의 MVP 는 {name} — 작업 {n}개를 끝냈어요.', { name: c.mvp, n: c.roles.find((r) => r.name === c.mvp)?.done || 0 })
      : T('오늘은 요청 {n}개를 보냈어요.', { n: t.prompts });
    return `
      <div class="gr-head">
        <div class="gr-lv daily">📬</div>
        <div><h3>${esc(T('하루 요약'))} · ${esc(dateLabel(c.date))}</h3>
          <small class="gr-sub">${esc(T('{time} 기준 (한국 시간)', { time: hhmm(c.at) }))}</small></div>
        <button class="btn ghost gr-x" data-gr="close" aria-label="${esc(T('닫기'))}">✕</button>
      </div>
      ${dates.length > 1 ? `<div class="gr-dates">${dates.slice().reverse().map((d) => `<button data-date="${d}" class="${d === c.date ? 'on' : ''}">${esc(new Date(`${d}T12:00:00+09:00`).toLocaleDateString(uiLocale(), { month: 'numeric', day: 'numeric', timeZone: 'Asia/Seoul' }))}</button>`).join('')}</div>` : ''}
      <p class="gr-lead">${esc(lead)}</p>
      <div class="gr-tiles">
        ${tile(T('끝낸 작업'), t.done.toLocaleString(), ends > t.done ? T('중단 {i} · 오류 {f}', { i: t.interrupted, f: t.failed }) : '')}
        ${tile(T('커밋'), t.commits.toLocaleString())}
        ${tile(T('비용'), money(t.cost))}
        ${tile(T('결정 대기 시간'), dur(t.decisionMs))}
        ${tile(T('일한 워커'), t.roles.toLocaleString())}
      </div>
      <div class="gr-roles">${c.roles.map((r) => `
        <section class="gr-rrow">
          <header><b>${esc(r.name)}</b>
            ${r.name === c.mvp ? '<span class="gr-mvp">MVP</span>' : ''}
            <small>${esc(T('작업 {d}', { d: r.done }))}${r.interrupted ? ` · ${esc(T('중단 {n}', { n: r.interrupted }))}` : ''}${r.failed ? ` · ${esc(T('오류 {n}', { n: r.failed }))}` : ''} · ${esc(T('커밋 {n}', { n: r.commits }))} · ${esc(money(r.cost))}${r.decisionMs > 60_000 ? ` · ${esc(T('결정 대기 {t}', { t: dur(r.decisionMs) }))}` : ''}</small></header>
          ${r.prompts.length ? `<ol>${r.prompts.map((p) => `<li><time>${hhmm(p.t)}</time><span>${esc(p.text)}</span></li>`).join('')}</ol>` : `<p class="gr-none">${esc(T('보낸 요청 기록 없음'))}</p>`}
        </section>`).join('')}</div>
      <p class="gr-foot">${esc(T('매일 오후 5시(한국 시간)에 그날 기록을 묶어 보내요 · 금액은 API 가격 환산'))}</p>`;
  }

  document.addEventListener('langchange', () => window.renderDaily());
})();
