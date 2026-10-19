// ---------- 예약 · 반복 실행 ----------
// 서버(schedule.js)가 state.schedules 로 보내는 예약을 보여 주고 고친다(/api/schedules).
// - 헤더 시계 버튼: 전체 예약 창(새 예약 · 목록 · 켜기/끄기 · 지금 실행 · 고치기 · 지우기)
// - 상세 패널 업무 지시 칸 아래: 이 역할의 예약 몇 줄 + '예약' 버튼 (지시 칸에 쓴 글로 새 예약을 시작)
(() => {
  const T = (s, v) => _t(s, v);
  // 선 아이콘 — 시계(헤더 버튼 · 상세 패널 예약 줄 · '예약' 버튼), 모래시계(워커 기다리는 중). 글자색을 따른다
  const CLOCK = '<svg class="sc-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9 3.5h6" stroke-linecap="round"/></svg>';
  const HOURGLASS = '<svg class="sc-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11M6.5 20.5h11M8 3.5v2.5c0 2.8 4 4 4 6s-4 3.2-4 6v2.5M16 3.5v2.5c0 2.8-4 4-4 6s4 3.2 4 6v2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const two = (n) => String(n).padStart(2, '0');
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  // '오늘 09:00' · '내일 09:00' · '10. 18. (토) 09:00'
  const when = (t) => {
    if (!t) return '';
    const d = new Date(t), now = new Date(), hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
    if (sameDay(d, now)) return T('오늘 {t}', { t: hm });
    if (sameDay(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return T('내일 {t}', { t: hm });
    return `${d.toLocaleDateString(uiLocale(), { month: 'numeric', day: 'numeric', weekday: 'short' })} ${hm}`;
  };
  const rule = (s) => {
    if (s.kind === 'once') return T('한 번 · {t}', { t: when(s.at) });
    if (s.kind === 'interval') return s.everyMin % 60 ? T('{n}분마다', { n: s.everyMin }) : T('{n}시간마다', { n: s.everyMin / 60 });
    const days = s.days?.length && s.days.length < 7 ? s.days.map((d) => T(DAYS[d])).join('·') : T('매일');
    return `${days} ${s.time}`;
  };
  const result = (r) => {
    if (!r) return '';
    if (r.ok) return `<span class="sc-ok">✓ ${esc(T('{t} 넣음', { t: when(r.t) }))}</span>`;
    if (r.retry) return `<span class="sc-retry">↻ ${esc(srvText(r.retry))}</span>`;
    if (r.wait) return `<span class="sc-wait" title="${esc(when(r.t))}">${HOURGLASS} ${esc(srvText(r.wait))}</span>`;
    return `<span class="sc-skip" title="${esc(when(r.t))}">⚠ ${esc(T('건너뜀'))}: ${esc(srvText(r.skip))}</span>`;
  };
  const list = () => (state.schedules || []).slice().sort((a, b) => (b.enabled - a.enabled) || ((a.nextRun || Infinity) - (b.nextRun || Infinity)));
  const roles = () => [...new Set([...state.workers.filter((w) => w.status !== 'exited').map((w) => w.name), ...(state.profiles || []).map((p) => p.name)])];

  // ---------- 창 ----------
  const back = el(`<div class="modal-back sc-back" hidden><div class="modal panel sc-modal" role="dialog" aria-modal="true" tabindex="-1">
      <div class="gr-head"><div><h3 class="sc-title"></h3><small class="gr-sub sc-sub"></small></div>
        <button class="btn ghost gr-x" data-sc="close">✕</button></div>
      <form class="sc-form" autocomplete="off">
        <div class="sc-row"><label class="sc-l" data-k="역할"></label><select name="role"></select></div>
        <div class="sc-row top"><label class="sc-l" data-k="지시"></label><textarea name="text" rows="3"></textarea></div>
        <div class="sc-row"><label class="sc-l" data-k="언제"></label>
          <div class="sc-kinds" role="radiogroup">
            <button type="button" data-kind="daily" data-k="매일·요일"></button><button type="button" data-kind="interval" data-k="반복"></button><button type="button" data-kind="once" data-k="한 번"></button>
          </div></div>
        <div class="sc-row sc-k daily"><span class="sc-l"></span><div class="sc-when">
          <input type="time" name="time" value="09:00">
          <div class="sc-days">${DAYS.map((d, i) => `<button type="button" data-day="${i}" data-k="${d}"></button>`).join('')}</div>
          <small class="sc-hint" data-k="요일을 안 고르면 매일"></small></div></div>
        <div class="sc-row sc-k interval"><span class="sc-l"></span><div class="sc-when">
          <input type="number" name="everyMin" min="5" step="5" value="60"> <span data-k="분마다"></span>
          <span class="sc-presets">${[30, 60, 120, 240].map((m) => `<button type="button" data-min="${m}">${m < 60 ? `${m}m` : `${m / 60}h`}</button>`).join('')}</span></div></div>
        <div class="sc-row sc-k once"><span class="sc-l"></span><div class="sc-when"><input type="datetime-local" name="at"></div></div>
        <div class="sc-row"><label class="sc-l" data-k="놓치면"></label><div class="sc-when">
          <div class="sc-kinds"><button type="button" data-off="wait" data-k="미뤘다 실행"></button><button type="button" data-off="skip" data-k="건너뛰기"></button></div>
          <small class="sc-hint sc-off-hint"></small></div></div>
        <div class="sc-acts"><span class="sc-err"></span><button type="button" class="btn ghost sc-cancel" data-k="취소"></button><button type="submit" class="btn primary sc-save"></button></div>
      </form>
      <ol class="sc-list"></ol>
      <p class="gr-foot sc-foot"></p>
    </div></div>`);
  document.body.append(back);
  const box = back.firstElementChild, form = $('.sc-form', box);
  let editing = null; // 고치는 예약 id
  let kind = 'daily';
  let whenOff = 'wait'; // 그 시각에 워커·서버가 꺼져 있었으면: 'wait' 돌아오면 넣기 · 'skip' 넘어가기
  const days = new Set();

  const close = () => { back.hidden = true; };
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-sc=close]')) close(); });
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  function setKind(k) {
    kind = k;
    box.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === k));
    box.querySelectorAll('.sc-k').forEach((r) => { r.hidden = !r.classList.contains(k); });
  }
  box.querySelectorAll('[data-kind]').forEach((b) => { b.onclick = () => setKind(b.dataset.kind); });
  function setOff(v) {
    whenOff = v;
    box.querySelectorAll('[data-off]').forEach((b) => b.classList.toggle('on', b.dataset.off === v));
    $('.sc-off-hint', box).textContent = T(v === 'wait' ? '그 시각에 워커나 서버가 꺼져 있었으면 워커가 다시 뜰 때 넣어요 (24시간까지)' : '그 시각에 워커나 서버가 꺼져 있었으면 그 회차는 넘어가요');
  }
  box.querySelectorAll('[data-off]').forEach((b) => { b.onclick = () => setOff(b.dataset.off); });
  box.querySelectorAll('[data-day]').forEach((b) => {
    b.onclick = () => { const d = Number(b.dataset.day); days.has(d) ? days.delete(d) : days.add(d); b.classList.toggle('on', days.has(d)); };
  });
  box.querySelectorAll('[data-min]').forEach((b) => { b.onclick = () => { form.everyMin.value = b.dataset.min; }; });
  $('.sc-cancel', box).onclick = () => fill();

  // 입력칸 채우기: 새 예약(role·text 만) 또는 고칠 예약
  function fill(s = {}, isEdit = false) {
    editing = isEdit ? s.id : null;
    const names = roles();
    if (s.role && !names.includes(s.role)) names.unshift(s.role);
    form.role.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join('');
    form.role.value = s.role || names[0] || '';
    form.text.value = s.text || '';
    form.time.value = s.time || '09:00';
    form.everyMin.value = s.everyMin || 60;
    const at = s.at ? new Date(s.at) : new Date(Date.now() + 3600_000);
    form.at.value = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
    days.clear(); (s.days || []).forEach((d) => days.add(d));
    box.querySelectorAll('[data-day]').forEach((b) => b.classList.toggle('on', days.has(Number(b.dataset.day))));
    setKind(s.kind || 'daily');
    setOff(s.whenOff || 'wait');
    $('.sc-err', box).textContent = '';
    $('.sc-save', box).textContent = T(isEdit ? '고치기 저장' : '예약 추가');
    $('.sc-cancel', box).hidden = !isEdit;
    form.classList.toggle('editing', isEdit);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { op: editing ? 'edit' : 'add', id: editing, role: form.role.value, text: form.text.value, kind, whenOff };
    if (kind === 'daily') { body.time = form.time.value; body.days = [...days]; }
    if (kind === 'interval') body.everyMin = Number(form.everyMin.value);
    if (kind === 'once') body.at = new Date(form.at.value).getTime();
    const r = await api('/api/schedules', body);
    if (r.error) { $('.sc-err', box).textContent = r.error; return; }
    toast(T(editing ? '예약을 고쳤어요' : '예약을 추가했어요'));
    fill({ role: body.role });
  });
  form.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.altKey)) { e.preventDefault(); form.requestSubmit(); } });

  // 목록
  function renderList() {
    const items = list();
    $('.sc-list', box).innerHTML = items.length ? items.map((s) => `
      <li class="sc-item${s.enabled ? '' : ' off'}${s.id === editing ? ' editing' : ''}" data-id="${s.id}">
        <label class="sc-switch" title="${esc(T(s.enabled ? '끄기' : '켜기'))}"><input type="checkbox" data-act="toggle"${s.enabled ? ' checked' : ''}><i></i></label>
        <div class="sc-main">
          <div class="sc-top"><b class="sc-rule">${esc(rule(s))}</b><span class="sc-role">${esc(s.role)}</span>
            <span class="sc-mode">${esc(T(s.whenOff === 'skip' ? '놓치면 건너뜀' : '놓치면 미룸'))}</span>
            <span class="sc-next">${s.enabled && s.pendingSince ? `<i class="sc-pend">${HOURGLASS} ${esc(T('워커 기다리는 중'))}</i>` : ''}${s.enabled && s.nextRun ? esc(T('다음 {t}', { t: when(s.nextRun) })) : s.enabled && s.pendingSince ? '' : esc(T(s.kind === 'once' && s.lastRun ? '끝남' : '꺼짐'))}</span></div>
          <div class="sc-text" title="${esc(s.text)}">${esc(s.text)}</div>
          ${s.lastResult ? `<div class="sc-res">${result(s.lastResult)}</div>` : ''}
        </div>
        <div class="sc-btns">
          <button class="btn ghost" data-act="run" title="${esc(T('지금 한 번 넣기 (다음 예약은 그대로)'))}">▶</button>
          <button class="btn ghost" data-act="edit" title="${esc(T('고치기'))}">✎</button>
          <button class="btn ghost" data-act="remove" title="${esc(T('지우기'))}" aria-label="${esc(T('지우기'))}">✕</button>
        </div>
      </li>`).join('') : `<li class="sc-empty">${esc(T('아직 예약이 없어요 — 위에서 역할 · 지시 · 시각을 정해 추가하세요'))}</li>`;
  }
  $('.sc-list', box).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'), id = e.target.closest('[data-id]')?.dataset.id;
    if (!b || !id) return;
    const s = (state.schedules || []).find((x) => x.id === id);
    if (!s) return;
    if (b.dataset.act === 'edit') { fill(s, true); renderList(); form.text.focus(); return; }
    if (b.dataset.act === 'remove') {
      if (!(await ask({ title: T('이 예약을 지울까요?'), body: `${rule(s)} · ${s.role}\n${s.text}`, ok: T('지우기'), danger: true }))) return;
      if (editing === id) fill();
      api('/api/schedules', { op: 'remove', id });
      return;
    }
    if (b.dataset.act === 'run') {
      const r = await api('/api/schedules', { op: 'run', id });
      if (!r.error) toast(r.result?.ok ? T('{role} 에 넣었어요', { role: s.role }) : `${T('건너뜀')}: ${srvText(r.result?.skip || r.result?.retry || '')}`, 3000);
    }
  });
  $('.sc-list', box).addEventListener('change', (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (id && e.target.dataset.act === 'toggle') api('/api/schedules', { op: 'toggle', id });
  });

  function texts() {
    $('.sc-title', box).textContent = T('예약 실행');
    const on = (state.schedules || []).filter((s) => s.enabled).length;
    $('.sc-sub', box).textContent = T('켜진 예약 {n}개', { n: on });
    box.querySelectorAll('[data-k]').forEach((x) => { x.textContent = T(x.dataset.k); });
    $('.gr-x', box).setAttribute('aria-label', T('닫기'));
    form.text.placeholder = T('정해 둔 시각에 이 역할의 워커에 보낼 지시');
    $('.sc-foot', box).textContent = T('이 PC 시각 기준 · 클로드 키우기가 켜져 있을 때만 돌아요 · 작업 중이면 대기열로 · 5시간 한도 90% 이상이면 건너뜀 · CLI 입력창이 막혀 있으면 1분마다 다시(10번)');
  }

  window.openSchedules = (preset) => {
    texts();
    fill(preset || {});
    renderList();
    back.hidden = false;
    (preset?.text ? $('.sc-save', box) : form.text).focus();
  };

  // ---------- 헤더 버튼 ----------
  const btn = el(`<button id="btn-sched" class="btn ghost lang-btn sched-btn">
      ${CLOCK}
      <i class="sched-n" hidden></i>
    </button>`);
  (document.querySelector('#btn-daily') || document.querySelector('#btn-ureport'))?.after(btn);
  btn.onclick = () => window.openSchedules();
  newDot(btn, 'schedules'); // 새 기능 점 (app.js)

  // ---------- 상세 패널: 이 역할의 예약 ----------
  const mini = el(`<div class="sc-mini"><div class="sc-mini-list"></div><button type="button" class="btn ghost sc-mini-add"></button></div>`);
  // Tasks 제목 위 — directives.js 가 나중에 헤더 칩 줄을 맨 앞에 끼우므로 순서는 헤더 칩 · 예약 · 제목 · 입력창
  document.querySelector('#sec-task .side-h')?.before(mini);
  // 버튼은 directives.js 가 헤더 칩 오른쪽으로 옮긴다 — mini 안에서 찾지 말고 잡아 둔 것을 쓴다
  const miniAdd = $('.sc-mini-add', mini);
  miniAdd.onclick = () => {
    const w = state.workers.find((x) => x.id === selected);
    window.openSchedules({ role: w?.name, text: document.querySelector('#task-form textarea')?.value.trim() });
  };
  mini.addEventListener('click', (e) => { if (e.target.closest('.sc-mini-item')) window.openSchedules({ role: state.workers.find((x) => x.id === selected)?.name }); });

  window.renderSchedules = () => {
    const all = state.schedules || [];
    const on = all.filter((s) => s.enabled).length;
    const label = T('예약 실행');
    btn.title = on ? T('예약 실행 · 켜진 예약 {n}개', { n: on }) : label;
    btn.setAttribute('aria-label', btn.title);
    const n = $('.sched-n', btn); n.hidden = !on; n.textContent = on;
    const w = state.workers.find((x) => x.id === selected);
    const mine = w ? all.filter((s) => s.role === w.name).sort((a, b) => (b.enabled - a.enabled) || ((a.nextRun || Infinity) - (b.nextRun || Infinity))) : [];
    $('.sc-mini-list', mini).innerHTML = mine.map((s) => `<div class="sc-mini-item${s.enabled ? '' : ' off'}" title="${esc(s.text)}">${s.enabled && s.pendingSince ? HOURGLASS : CLOCK} <b>${esc(rule(s))}</b> <span>${esc(s.text)}</span>${s.enabled && s.nextRun ? `<em>${esc(when(s.nextRun))}</em>` : ''}</div>`).join('');
    miniAdd.innerHTML = `${CLOCK}${esc(T('예약'))}`;
    miniAdd.title = T('업무 지시 칸에 쓴 글로 예약 만들기');
    if (!back.hidden) { texts(); renderList(); }
  };
  document.addEventListener('langchange', () => window.renderSchedules());
})();
