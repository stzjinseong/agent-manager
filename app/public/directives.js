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
  const kindOf = (d) => (d.global ? 'all' : d.roles?.length ? 'pick' : 'keep');
  const presets = () => (state.directivePresets || []).filter((p) => !list().some((d) => d.preset === p.key));
  const cur = () => state.workers.find((x) => x.id === selected);
  const post = async (body) => { const r = await api('/api/directives', body); if (r.error) toast(r.error, 3000); return r; };

  // ---------- 창 ----------
  const back = el(`<div class="modal-back sc-back dv-back" hidden><div class="modal panel sc-modal dv-modal" role="dialog" aria-modal="true" tabindex="-1">
      <div class="gr-head"><div><h3 class="dv-title"></h3><small class="gr-sub dv-sub"></small></div>
        <button class="btn ghost gr-x" data-dv="close">✕</button></div>
      <form class="sc-form dv-form" autocomplete="off">
        <div class="sc-row"><label class="sc-l" data-k="제목"></label><input name="title" maxlength="40"></div>
        <div class="sc-row top"><label class="sc-l" data-k="내용"></label><textarea name="text" rows="3" maxlength="2000"></textarea></div>
        <div class="sc-row top"><label class="sc-l" data-k="붙일 곳"></label><div class="sc-when">
          <div class="sc-kinds" role="radiogroup"><button type="button" data-kind="all" data-k="모든 워커"></button><button type="button" data-kind="pick" data-k="골라서"></button><button type="button" data-kind="keep" data-k="보관만"></button></div>
          <div class="dv-roles"></div>
          <small class="sc-hint dv-kind-hint"></small></div></div>
        <div class="sc-acts"><span class="sc-err"></span><button type="button" class="btn ghost sc-cancel" data-k="취소"></button><button type="submit" class="btn primary sc-save"></button></div>
      </form>
      <div class="dv-presets"></div>
      <div class="dv-list"></div>
      <p class="gr-foot dv-foot"></p>
    </div></div>`);
  document.body.append(back);
  const box = back.firstElementChild, form = $('.dv-form', box);
  let editing = null, kind = 'all', preset = null;
  const picked = new Set(); // 'pick' 이면 붙일 역할, 'all' 이면 뺄 역할

  const close = () => { back.hidden = true; };
  back.addEventListener('click', (e) => { if (e.target === back || e.target.closest('[data-dv=close]')) close(); });
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  // 역할 칩: 켜진 칩 = 이 지시를 받는 역할 (모든 워커면 기본으로 다 켜져 있고 끄면 빠진다)
  function renderFormRoles() {
    const names = roles();
    for (const r of picked) if (!names.includes(r)) names.push(r);
    const on = (r) => (kind === 'all' ? !picked.has(r) : picked.has(r));
    $('.dv-roles', box).hidden = kind === 'keep' || !names.length;
    $('.dv-roles', box).innerHTML = names.map((r) => `<button type="button" class="dv-rc${on(r) ? ' on' : ''}" data-role="${esc(r)}">${esc(r)}</button>`).join('');
    $('.dv-kind-hint', box).textContent = T(kind === 'all' ? '새로 띄우는 워커에도 붙어요 · 칩을 끄면 그 워커만 빠져요' : kind === 'pick' ? '켠 워커에만 붙어요' : '아무 워커에도 안 붙이고 보관만 해요 — 나중에 워커 패널의 + 지시 에서 골라 붙여요');
  }
  $('.dv-roles', box).addEventListener('click', (e) => {
    const r = e.target.closest('[data-role]')?.dataset.role;
    if (!r) return;
    picked.has(r) ? picked.delete(r) : picked.add(r);
    renderFormRoles();
  });
  function setKind(k) {
    if (k !== kind) picked.clear();
    kind = k;
    box.querySelectorAll('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === k));
    renderFormRoles();
  }
  box.querySelectorAll('[data-kind]').forEach((b) => { b.onclick = () => setKind(b.dataset.kind); });
  $('.sc-cancel', box).onclick = () => { fill(); renderList(); };

  // 입력칸 채우기 — 새 지시({ role } 이면 그 역할만 골라 둔 채) 또는 고칠 지시
  function fill(d = {}, isEdit = false) {
    editing = isEdit ? d.id : null;
    preset = d.preset || null;
    form.title.value = d.title || '';
    form.text.value = d.text || '';
    kind = null;
    setKind(isEdit ? kindOf(d) : d.role ? 'pick' : 'all');
    (isEdit ? (d.global ? d.except : d.roles) || [] : d.role ? [d.role] : []).forEach((r) => picked.add(r));
    renderFormRoles();
    $('.sc-err', box).textContent = '';
    $('.sc-save', box).textContent = T(isEdit ? '고치기 저장' : '지시 추가');
    $('.sc-cancel', box).hidden = !isEdit && !d.text;
    form.classList.toggle('editing', isEdit);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { op: editing ? 'edit' : 'add', id: editing, title: form.title.value, text: form.text.value, preset, global: kind === 'all', roles: kind === 'pick' ? [...picked] : [], except: kind === 'all' ? [...picked] : [] };
    const r = await api('/api/directives', body);
    if (r.error) { $('.sc-err', box).textContent = r.error; return; }
    toast(T(editing ? '작업 지시를 고쳤어요' : '작업 지시를 추가했어요'));
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
    const role = form.dataset.role; // 워커 패널에서 열었으면 그 워커에
    fill({ title: T(p.title), text: T(p.text), preset: p.key, role });
    form.text.focus();
  });

  function item(d) {
    const names = roles();
    for (const r of [...(d.roles || []), ...(d.except || [])]) if (!names.includes(r)) names.push(r);
    const chips = names.map((r) => `<button type="button" class="dv-rc${applies(d, r) ? ' on' : ''}" data-act="role" data-role="${esc(r)}" title="${esc(T(applies(d, r) ? '{r} 에서 떼기' : '{r} 에 붙이기', { r }))}">${esc(r)}</button>`).join('');
    return `<li class="sc-item dv-item${d.id === editing ? ' editing' : ''}" data-id="${d.id}">
        <label class="sc-switch" title="${esc(T('모든 워커'))}"><input type="checkbox" data-act="global"${d.global ? ' checked' : ''}><i></i></label>
        <div class="sc-main">
          <div class="sc-top"><b>${esc(d.title)}</b>${d.global ? `<span class="dv-all">${GLOBE}${esc(T('모든 워커'))}</span>` : ''}</div>
          <div class="sc-text" title="${esc(d.text)}">${esc(d.text)}</div>
          ${names.length ? `<div class="dv-roles">${chips}</div>` : ''}
        </div>
        <div class="sc-btns">
          <button class="btn ghost" data-act="edit" title="${esc(T('고치기'))}">✎</button>
          <button class="btn ghost" data-act="remove" title="${esc(T('지우기'))}" aria-label="${esc(T('지우기'))}">✕</button>
        </div>
      </li>`;
  }
  function renderList() {
    const all = list();
    const groups = [
      ['all', T('공용 · 모든 워커'), all.filter((d) => d.global)],
      ['pick', T('워커별'), all.filter((d) => !d.global && d.roles?.length)],
      ['keep', T('보관함 · 아직 안 붙음'), all.filter((d) => !d.global && !d.roles?.length)],
    ].filter(([, , xs]) => xs.length);
    $('.dv-list', box).innerHTML = groups.length ? groups.map(([k, h, xs]) => `<h4 class="dv-gh">${esc(h)} <small>${xs.length}</small></h4><ol class="sc-list dv-ol" data-group="${k}">${xs.map(item).join('')}</ol>`).join('')
      : `<div class="sc-empty">${esc(T('아직 작업 지시가 없어요 — 위에 직접 쓰거나 추천에서 골라 보세요'))}</div>`;
    renderPresets();
  }
  $('.dv-list', box).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'), id = e.target.closest('[data-id]')?.dataset.id;
    if (!b || !id || b.dataset.act === 'global') return;
    const d = list().find((x) => x.id === id);
    if (!d) return;
    if (b.dataset.act === 'role') { const r = b.dataset.role; post({ op: 'role', id, role: r, on: !applies(d, r) }); return; }
    if (b.dataset.act === 'edit') { fill(d, true); renderList(); form.text.focus(); return; }
    if (b.dataset.act === 'remove') {
      if (!(await ask({ title: T('이 작업 지시를 지울까요?'), body: `${d.title}\n${d.text}`, ok: T('지우기'), danger: true }))) return;
      if (editing === id) fill();
      post({ op: 'remove', id });
    }
  });
  // 스위치: 모든 워커 ↔ 골라서. 켜면 지금 붙은 역할 밖은 다 받게 되고, 끄면 지금 받던 역할만 남긴다
  $('.dv-list', box).addEventListener('change', (e) => {
    const id = e.target.closest('[data-id]')?.dataset.id, d = list().find((x) => x.id === id);
    if (!d || e.target.dataset.act !== 'global') return;
    const on = e.target.checked;
    post({ op: 'edit', id, global: on, except: [], roles: on ? [] : roles().filter((r) => applies(d, r)) });
  });

  function texts() {
    $('.dv-title', box).textContent = T('작업 지시');
    const all = list();
    $('.dv-sub', box).textContent = T('공용 {g}개 · 워커별 {r}개 · 보관함 {k}개', { g: all.filter((d) => d.global).length, r: all.filter((d) => !d.global && d.roles?.length).length, k: all.filter((d) => !d.global && !d.roles?.length).length });
    box.querySelectorAll('[data-k]').forEach((x) => { x.textContent = T(x.dataset.k); });
    $('.gr-x', box).setAttribute('aria-label', T('닫기'));
    form.title.placeholder = T('짧은 이름 (예: 작업 끝나면 커밋)');
    form.text.placeholder = T('워커가 늘 따를 규칙 — 예: 작업 단위가 끝나면 묻지 말고 바로 커밋한다');
    $('.dv-foot', box).textContent = T('세션마다 첫 메시지에 한 번 붙여 보내요 · 고치면 다음 메시지에 새 내용으로 · /compact 뒤에도 다시 · 메시지 원문은 그대로');
  }

  window.openDirectives = (init = {}) => {
    texts();
    form.dataset.role = init.role || '';
    init.edit ? fill(init.edit, true) : fill(init);
    renderList();
    back.hidden = false;
    form[init.edit || init.role ? 'text' : 'title'].focus();
  };

  // ---------- 헤더 버튼 ----------
  const btn = el(`<button id="btn-dir" class="btn ghost lang-btn sched-btn">${ICON}<i class="sched-n" hidden></i></button>`);
  (document.querySelector('#btn-sched') || document.querySelector('#btn-ureport'))?.after(btn);
  btn.onclick = () => window.openDirectives();
  newDot(btn, 'directives');

  // ---------- 상세 패널: 이 워커의 지시 ----------
  const bar = el(`<div class="dv-bar"><div class="dv-chips"></div><button type="button" class="btn ghost dv-add"></button><span class="dv-state"></span></div>`);
  document.querySelector('#sec-task .side-h')?.after(bar);
  const pop = el(`<div class="panel dv-pop" hidden></div>`);
  document.body.append(pop);
  const closePop = () => { pop.hidden = true; };
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.dv-add')) closePop(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closePop(); });

  function renderPop() {
    const w = cur();
    if (!w) return closePop();
    const off = list().filter((d) => !applies(d, w.name));
    const ps = presets();
    const row = (attrs, title, sub, extra = '') => `<button type="button" class="dv-pi" ${attrs}><b>${extra}${esc(title)}</b><span>${esc(sub)}</span></button>`;
    pop.innerHTML = `
      ${off.length ? `<div class="dv-ph">${esc(T('보관함 · 다른 워커'))}</div>${off.map((d) => row(`data-id="${d.id}"`, d.title, d.text, d.global ? GLOBE : '')).join('')}` : ''}
      ${ps.length ? `<div class="dv-ph">${esc(T('추천'))}</div>${ps.map((p) => row(`data-pre="${p.key}"`, T(p.title), T(p.text))).join('')}` : ''}
      ${!off.length && !ps.length ? `<div class="dv-pe">${esc(T('붙일 지시가 더 없어요'))}</div>` : ''}
      <div class="dv-pf"><button type="button" class="btn ghost" data-pop="new">✎ ${esc(T('새로 쓰기'))}</button><button type="button" class="btn ghost" data-pop="all">${esc(T('모두 관리'))}</button></div>`;
  }
  pop.addEventListener('click', async (e) => {
    const w = cur();
    if (!w) return;
    const t = e.target.closest('[data-id],[data-pre],[data-pop]');
    if (!t) return;
    if (t.dataset.id) { await post({ op: 'role', id: t.dataset.id, role: w.name, on: true }); renderPop(); return; }
    if (t.dataset.pre) {
      const p = (state.directivePresets || []).find((x) => x.key === t.dataset.pre);
      if (p) await post({ op: 'add', title: T(p.title), text: T(p.text), preset: p.key, roles: [w.name] });
      renderPop();
      return;
    }
    closePop();
    window.openDirectives(t.dataset.pop === 'new' ? { role: w.name } : {});
  });
  $('.dv-add', bar).onclick = () => {
    if (!pop.hidden) return closePop();
    renderPop();
    pop.hidden = false;
    const r = $('.dv-add', bar).getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8)}px`;
  };
  bar.addEventListener('click', (e) => {
    const w = cur(), c = e.target.closest('[data-id]');
    if (!w || !c) return;
    const d = list().find((x) => x.id === c.dataset.id);
    if (!d) return;
    if (e.target.closest('.dv-x')) {
      post({ op: 'role', id: d.id, role: w.name, on: !applies(d, w.name) });
      if (d.global && applies(d, w.name)) toast(T('공용 지시에서 이 워커만 뺐어요'));
      return;
    }
    window.openDirectives({ edit: d });
  });

  window.renderDirectives = () => {
    const all = list(), g = all.filter((d) => d.global).length;
    btn.title = T('작업 지시 · 공용 {g}개 · 전체 {n}개', { g, n: all.length });
    btn.setAttribute('aria-label', btn.title);
    const n = $('.sched-n', btn); n.hidden = !all.length; n.textContent = all.length;
    const w = cur();
    bar.hidden = !w;
    if (w) {
      const mine = all.filter((d) => applies(d, w.name));
      const out = all.filter((d) => d.global && !applies(d, w.name)); // 공용인데 이 워커만 뺀 것 — 눌러 다시 넣게 흐리게 보인다
      $('.dv-chips', bar).innerHTML = [
        ...mine.map((d) => `<span class="dv-chip${d.global ? ' g' : ''}" data-id="${d.id}" title="${esc(d.text)}">${d.global ? GLOBE : ''}<span>${esc(d.title)}</span><button type="button" class="dv-x" title="${esc(T('이 워커에서 떼기'))}" aria-label="${esc(T('이 워커에서 떼기'))}">✕</button></span>`),
        ...out.map((d) => `<span class="dv-chip g out" data-id="${d.id}" title="${esc(T('공용 지시 — 이 워커는 빠짐'))}">${GLOBE}<span>${esc(d.title)}</span><button type="button" class="dv-x" title="${esc(T('다시 넣기'))}" aria-label="${esc(T('다시 넣기'))}">+</button></span>`),
      ].join('');
      $('.dv-add', bar).innerHTML = `${ICON}${esc(mine.length ? '+' : T('+ 작업 지시'))}`;
      $('.dv-add', bar).title = T('보관함 · 추천에서 이 워커에 지시 붙이기');
      const st = $('.dv-state', bar);
      st.textContent = w.status === 'exited' ? '' : w.dirPending ? T(mine.length ? '다음 메시지에 전달' : '다음 메시지에 해제 전달') : mine.length ? T('✓ 전달됨') : '';
      st.className = `dv-state${w.dirPending ? ' wait' : ''}`;
      st.title = w.dirPending ? T('바뀐 지시는 이 워커가 다음 메시지를 받을 때 함께 넘어가요') : T('이 세션에 지금 내용이 전달됐어요');
    }
    if (!pop.hidden) renderPop();
    if (!back.hidden) { texts(); renderList(); if (!editing) renderFormRoles(); }
  };
  document.addEventListener('langchange', () => window.renderDirectives());
})();
