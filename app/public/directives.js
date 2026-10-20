// ---------- 작업 지시 ----------
// 서버(directives.js)가 state.directives 로 보내는 상시 지시를 보여 주고 고친다(/api/directives).
// - 헤더 버튼: 전체 창 — 새 지시 · 추천 · 목록(공용 / 워커별 / 보관함). 목록의 역할 칩을 눌러 바로 붙이고 뗀다
// - 상세 패널 Tasks 머리 아래: 이 워커에 붙은 지시 칩 · '+ 지시' 팝업(보관함 · 추천에서 한 번에 붙이기) · 전달 상태
(() => {
  const T = (s, v) => _t(s, v);
  const ICON = '<svg class="dv-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4.5H6.5A1.5 1.5 0 0 0 5 6v13.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H16M9 3h6v3H9zM8.5 11h7M8.5 14.5h7M8.5 18h4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const GLOBE = '<svg class="dv-g" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/></svg>';
  const list = () => state.directives || [];
  const roles = () => [...new Set([...state.workers.filter((w) => w.status !== 'exited').map((w) => w.name), ...(state.profiles || []).map((p) => p.name)])];
  const applies = (d, r) => (d.global ? !(d.except || []).includes(r) : (d.roles || []).includes(r));
  const presets = () => (state.directivePresets || []).filter((p) => !list().some((d) => d.preset === p.key));
  const cur = () => state.workers.find((x) => x.id === selected);
  // 누르는 즉시 화면에 반영하고(서버 상태가 오면 그걸로 덮인다) 실패하면 되돌린다 — 상태 방송이 무거우면(워커 많음 · 1MB 안팎)
  // 응답이 늦어 눌러도 그대로인 것처럼 보였고, 다시 누른 만큼 추천이 겹쳐 들어갔다
  function local(body) {
    const xs = list(), d = xs.find((x) => x.id === body.id);
    if (body.op === 'role' && d) {
      const drop = (a) => (a || []).filter((x) => x !== body.role);
      if (d.global) d.except = body.on ? drop(d.except) : [...drop(d.except), body.role];
      else d.roles = body.on ? [...drop(d.roles), body.role] : drop(d.roles);
    }
    if (body.op === 'remove') state.directives = xs.filter((x) => x.id !== body.id);
    if (body.op === 'edit' && d) Object.assign(d, { global: Boolean(body.global ?? d.global), roles: body.roles ?? d.roles, except: body.except ?? d.except });
    if (body.op === 'add') state.directives = [...xs, { id: `tmp${Date.now()}`, title: body.title, text: body.text, preset: body.preset, global: Boolean(body.global), roles: body.roles || [], except: [] }];
    const w = cur();
    if (w && w.status !== 'exited') w.dirPending = true; // 바뀐 것은 다음 메시지에 — 서버 상태가 오면 정확한 값으로
  }
  const post = async (body) => {
    const before = JSON.parse(JSON.stringify(list()));
    local(body);
    window.renderDirectives();
    const r = await api('/api/directives', body);
    if (r.error) { state.directives = before; window.renderDirectives(); toast(r.error, 3000); }
    return r;
  };

  // ---------- 창 ----------
  const back = el(`<div class="modal-back sc-back dv-back" hidden><div class="modal panel sc-modal dv-modal" role="dialog" aria-modal="true" tabindex="-1">
      <div class="gr-head"><div><h3 class="dv-title"></h3><small class="gr-sub dv-sub"></small><div class="dv-desc"></div></div>
        <button class="btn ghost gr-x" data-dv="close">✕</button></div>
      <form class="sc-form dv-form" autocomplete="off">
        <div class="sc-row"><label class="sc-l" data-k="제목"></label><input name="title" maxlength="40"></div>
        <div class="sc-row top"><label class="sc-l" data-k="내용"></label><textarea name="text" rows="3" maxlength="2000"></textarea></div>
        <div class="sc-acts"><span class="sc-err"></span><button type="button" class="btn ghost sc-cancel" data-k="취소"></button><button type="submit" class="btn primary sc-save"></button></div>
      </form>
      <div class="dv-presets"></div>
      <div class="dv-list"></div>
      <p class="gr-foot dv-foot"></p>
    </div></div>`);
  document.body.append(back);
  const box = back.firstElementChild, form = $('.dv-form', box);
  let editing = null, preset = null;

  const close = () => { back.hidden = true; };
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-dv=close]')) close(); });
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  // 붙일 곳 칩 줄 — 맨 앞 '모든 워커'(켜면 새로 띄우는 워커까지 전부), 뒤로 역할 칩. 켜진 칩 = 이 헤더를 받는 역할.
  // 모든 워커가 켜져 있으면 역할 칩은 다 켜진 채로 보이고, 끄면 그 워커만 빠진다. 아무것도 안 켜면 보관만
  function chipRow(global, on, names) {
    return `<button type="button" class="dv-rc dv-rc-all${global ? ' on' : ''}" data-all title="${esc(T(global ? '모든 워커에서 떼기' : '모든 워커에 붙이기 (새로 띄우는 워커 포함)'))}">${GLOBE}${esc(T('모든 워커'))}</button>` +
      names.map((r) => `<button type="button" class="dv-rc${on(r) ? ' on' : ''}" data-role="${esc(r)}" title="${esc(T(on(r) ? '{r} 에서 떼기' : '{r} 에 붙이기', { r }))}">${esc(r)}</button>`).join('');
  }
  $('.sc-cancel', box).onclick = () => { fill(); renderList(); };

  // 입력칸 채우기 — 새 지시({ role } 이면 그 역할만 골라 둔 채) 또는 고칠 지시
  function fill(d = {}, isEdit = false) {
    editing = isEdit ? d.id : null;
    preset = d.preset || null;
    form.title.value = d.title || '';
    form.text.value = d.text || '';
    $('.sc-err', box).textContent = '';
    $('.sc-save', box).textContent = T(isEdit ? '고치기 저장' : '헤더 추가');
    $('.sc-cancel', box).hidden = !isEdit && !d.text;
    form.classList.toggle('editing', isEdit);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // 붙일 곳은 여기서 정하지 않는다 — 새 헤더는 아무 데도 안 붙은 채로 목록에 들어가고, 목록의 칩으로 붙인다. 고칠 때는 붙은 곳 그대로
    const body = { op: editing ? 'edit' : 'add', id: editing, title: form.title.value, text: form.text.value, preset };
    const r = await api('/api/directives', body);
    if (r.error) { $('.sc-err', box).textContent = r.error; return; }
    toast(T(editing ? '헤더를 고쳤어요' : '헤더를 추가했어요 — 아래 목록에서 붙일 워커를 고르세요'), editing ? undefined : 3500);
    fill();
    renderList();
  });
  form.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || e.altKey)) { e.preventDefault(); form.requestSubmit(); } });

  function renderPresets() {
    const ps = presets();
    $('.dv-presets', box).innerHTML = ps.length ? `<span class="dv-ph">${esc(T('추천'))}</span>${ps.map((p) => `<button type="button" class="dv-pre" data-pre="${p.key}" title="${esc(T(p.text))}">+ ${esc(T(p.title))}</button>`).join('')}` : '';
  }
  $('.dv-presets', box).addEventListener('click', (e) => {
    const p = (state.directivePresets || []).find((x) => x.key === e.target.closest('[data-pre]')?.dataset.pre);
    if (!p) return;
    fill({ title: T(p.title), text: T(p.text), preset: p.key });
    form.text.focus();
  });

  function item(d) {
    const names = roles();
    for (const r of [...(d.roles || []), ...(d.except || [])]) if (!names.includes(r)) names.push(r);
    return `<li class="sc-item dv-item${d.id === editing ? ' editing' : ''}${d.global || d.roles?.length ? '' : ' off'}" data-id="${d.id}">
        <div class="sc-main">
          <div class="sc-top"><b>${esc(d.title)}</b></div>
          <div class="sc-text" title="${esc(d.text)}">${esc(d.text)}</div>
          <div class="dv-roles">${chipRow(d.global, (r) => applies(d, r), names)}</div>
        </div>
        <div class="sc-btns">
          <button class="btn ghost" data-act="edit" title="${esc(T('고치기'))}">✎</button>
          <button class="btn ghost" data-act="remove" title="${esc(T('지우기'))}" aria-label="${esc(T('지우기'))}">✕</button>
        </div>
      </li>`;
  }
  // 한 목록 — 공용 · 워커별 · 보관을 나누지 않고 칩으로 구분한다 (어디에도 안 붙은 것은 흐리게)
  function renderList() {
    const all = list();
    $('.dv-list', box).innerHTML = all.length ? `<ol class="sc-list dv-ol">${all.map(item).join('')}</ol>`
      : `<div class="sc-empty">${esc(T('아직 헤더가 없어요 — 위에 직접 쓰거나 추천에서 골라 보세요'))}</div>`;
    renderPresets();
  }
  $('.dv-list', box).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'), id = e.target.closest('.dv-item')?.dataset.id;
    if (!id) return;
    const d = list().find((x) => x.id === id);
    if (!d) return;
    // 모든 워커: 켜면 전부(뺀 워커 없이), 끄면 아무 데도 안 붙은 상태로
    if (e.target.closest('[data-all]')) { post({ op: 'edit', id, global: !d.global, roles: [], except: [] }); return; }
    if (e.target.closest('[data-role]')) { const r = e.target.closest('[data-role]').dataset.role; post({ op: 'role', id, role: r, on: !applies(d, r) }); return; }
    if (!b) return;
    if (b.dataset.act === 'edit') { fill(d, true); renderList(); form.text.focus(); return; }
    if (b.dataset.act === 'remove') {
      if (!(await ask({ title: T('이 헤더를 지울까요?'), body: `${d.title}\n${d.text}`, ok: T('지우기'), danger: true }))) return;
      if (editing === id) fill();
      post({ op: 'remove', id });
    }
  });
  function texts() {
    $('.dv-title', box).textContent = T('헤더');
    const all = list();
    $('.dv-sub', box).textContent = T('전체 {n}개 · 모든 워커 {g}개', { n: all.length, g: all.filter((d) => d.global).length });
    $('.dv-desc', box).textContent = T('워커(세션)에 보내는 다음 메시지에 함께 전달되어 작동에 반영됩니다. 고치면 다시 전달됩니다.');
    box.querySelectorAll('[data-k]').forEach((x) => { x.textContent = T(x.dataset.k); });
    $('.gr-x', box).setAttribute('aria-label', T('닫기'));
    form.title.placeholder = T('짧은 이름 (예: 작업 끝나면 커밋)');
    form.text.placeholder = T('워커가 늘 따를 규칙 — 예: 작업 단위가 끝나면 묻지 말고 바로 커밋한다');
    $('.dv-foot', box).textContent = T('세션마다 첫 메시지에 한 번 붙여 보내요 · 고치면 다음 메시지에 새 내용으로 · /compact 뒤에도 다시 · 메시지 원문은 그대로');
  }

  window.openDirectives = (init = {}) => {
    texts();
    init.edit ? fill(init.edit, true) : fill(init);
    renderList();
    back.hidden = false;
    form[init.edit ? 'text' : 'title'].focus();
  };

  // ---------- 헤더 버튼 ----------
  const btn = el(`<button id="btn-dir" class="btn ghost lang-btn sched-btn">${ICON}<i class="sched-n" hidden></i></button>`);
  (document.querySelector('#btn-sched') || document.querySelector('#btn-ureport'))?.after(btn);
  btn.onclick = () => window.openDirectives();
  newDot(btn, 'directives');

  // ---------- 상세 패널: 이 워커에 붙은 헤더 ----------
  // 붙이기는 헤더 버튼 창(모든 워커 / 골라서)에서만 한다 — 여기는 붙은 것을 보여 주고 떼기 · 고치기만
  const bar = el(`<div class="dv-bar"><div class="dv-chips"></div><span class="dv-state"></span></div>`);
  document.querySelector('#sec-task')?.prepend(bar); // Tasks 제목 위, 예약 목록(schedule.js)보다 앞
  bar.addEventListener('click', (e) => {
    const w = cur(), c = e.target.closest('[data-id]');
    if (!w || !c) return;
    const d = list().find((x) => x.id === c.dataset.id);
    if (!d) return;
    if (e.target.closest('.dv-x')) {
      post({ op: 'role', id: d.id, role: w.name, on: !applies(d, w.name) });
      if (d.global && applies(d, w.name)) toast(T('공용 헤더에서 이 워커만 뺐어요'));
      return;
    }
    window.openDirectives({ edit: d });
  });

  window.renderDirectives = () => {
    const all = list(), g = all.filter((d) => d.global).length;
    btn.title = T('헤더 · 공용 {g}개 · 전체 {n}개', { g, n: all.length });
    btn.setAttribute('aria-label', btn.title);
    const n = $('.sched-n', btn); n.hidden = !all.length; n.textContent = all.length;
    const w = cur();
    bar.hidden = !w;
    if (w) {
      const mine = all.filter((d) => applies(d, w.name));
      const out = all.filter((d) => d.global && !applies(d, w.name)); // 공용인데 이 워커만 뺀 것 — 눌러 다시 넣게 흐리게 보인다
      $('.dv-chips', bar).innerHTML = [
        ...mine.map((d) => `<span class="dv-chip${d.global ? ' g' : ''}" data-id="${d.id}" title="${esc(d.text)}">${d.global ? GLOBE : ''}<span>${esc(d.title)}</span><button type="button" class="dv-x" title="${esc(T('이 워커에서 떼기'))}" aria-label="${esc(T('이 워커에서 떼기'))}">✕</button></span>`),
        ...out.map((d) => `<span class="dv-chip g out" data-id="${d.id}" title="${esc(T('공용 헤더 — 이 워커는 빠짐'))}">${GLOBE}<span>${esc(d.title)}</span><button type="button" class="dv-x" title="${esc(T('다시 넣기'))}" aria-label="${esc(T('다시 넣기'))}">+</button></span>`),
      ].join('');
      const st = $('.dv-state', bar);
      st.textContent = w.status === 'exited' ? '' : w.dirPending ? T(mine.length ? '다음 메시지에 전달' : '다음 메시지에 해제 전달') : mine.length ? T('✓ 전달됨') : '';
      st.className = `dv-state${w.dirPending ? ' wait' : ''}`;
      st.title = w.dirPending ? T('바뀐 헤더는 이 워커가 다음 메시지를 받을 때 함께 넘어가요') : T('이 세션에 지금 헤더가 전달됐어요');
    }
    if (!back.hidden) { texts(); renderList(); }
  };
  document.addEventListener('langchange', () => window.renderDirectives());
})();
