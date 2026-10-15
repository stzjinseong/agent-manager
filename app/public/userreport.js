// ---------- 나의 Claude 사용 리포트 (사용자 프로파일) ----------
// 워커 세션들을 모은 서버 집계(/api/user-profile — userprofile.js)를 받아, 기간(전체·30일·7일)으로 거른 뒤 그린다.
// 차트는 모두 손으로 그린 SVG(바깥 라이브러리 없음). 색은 역할로만 쓴다(style.css #ur-modal 의 --ur-* · --k-*):
// 요청 = 테마 강조색 · 금액 = 금색 · AI = 보라 · 좋음/주의/나쁨 = 초록/호박/빨강(점수·상태에만) · 요청 유형 = --k-*(도넛·배너 전용)
// 사람이 보낸 요청만 센다 — 백그라운드·서브에이전트 알림(auto)과 슬래시 명령(cmd)은 빼고, 비용·도구 같은 세션 값은 그 기간에 요청이 있던 세션 기준
(() => {
  const KIND = {
    feature: { label: '작업 지시', color: 'var(--k-feature)' },
    bug: { label: '버그·문제 해결', color: 'var(--k-bug)' },
    ask: { label: '조사·질문', color: 'var(--k-ask)' },
    ops: { label: '커밋·빌드·배포', color: 'var(--k-ops)' },
    review: { label: '리뷰·정리', color: 'var(--k-review)' },
    reply: { label: '확인·짧은 답', color: 'var(--k-reply)' },
    etc: { label: '기타', color: 'var(--k-etc)' },
  };
  const PERSONA = {
    feature: ['빌더형', '아이디어를 바로 기능으로 옮기는 타입 — 만들고 고치는 지시가 가장 많아요'],
    bug: ['해결사형', '문제를 잡는 데 Claude 를 가장 많이 써요 — 버그·오류 해결 요청이 중심이에요'],
    ask: ['탐험가형', '먼저 묻고 이해한 뒤 움직이는 타입 — 조사·질문 비중이 높아요'],
    ops: ['운영자형', '커밋·빌드·배포 같은 흐름 관리를 Claude 에 많이 맡겨요'],
    review: ['정리형', '리뷰·리팩터링으로 코드를 다듬는 요청이 두드러져요'],
    reply: ['대화형', 'Claude 와 짧게 주고받으며 방향을 잡아 가는 타입이에요'],
    etc: ['자유형', '여러 종류의 요청을 고르게 섞어 써요'],
  };
  const DAY = 86_400_000;
  const $u = (s) => document.querySelector(s);
  const T = (s, v) => (typeof _t === 'function' ? _t(s, v) : s);
  const E = (s) => (typeof esc === 'function' ? esc(s) : String(s));
  const money = (v) => (v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${v.toFixed(v >= 10 ? 1 : 2)}`);
  const num = (v) => (v >= 10_000 ? `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}k` : Math.round(v).toLocaleString());
  const pct = (v) => `${Math.round(v * 100)}%`;
  const hrs = (ms) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

  let data = null, range = 30;
  const modal = $u('#ur-modal');

  // ---------- 집계 ----------
  function crunch() {
    const since = range ? Date.now() - range * DAY : 0;
    const reqs = [], sess = [];
    let auto = 0, cmds = 0;
    for (const s of data.sessions) {
      let any = false;
      for (const t of s.turns) {
        if (t.t < since) continue;
        any = true;
        if (t.kind === 'auto') { auto++; continue; }
        if (t.kind === 'cmd') { cmds++; continue; }
        reqs.push({ ...t, role: s.role });
      }
      if (any) sess.push(s);
    }
    const cost = data.sessions.reduce((a, s) => a + s.turns.filter((t) => t.t >= since).reduce((b, t) => b + t.cost, 0), 0);
    const tok = sess.reduce((a, s) => { a.in += s.tokens.input + s.tokens.cacheWrite + s.tokens.cacheRead; a.read += s.tokens.cacheRead; return a; }, { in: 0, read: 0 });
    const kinds = {};
    for (const r of reqs) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
    const tools = {};
    for (const s of sess) for (const [k, v] of Object.entries(s.tools || {})) tools[k] = (tools[k] || 0) + v;
    const models = {};
    for (const s of sess) for (const [k, v] of Object.entries(s.models || {})) models[k] = (models[k] || 0) + v;
    const roles = new Map();
    for (const s of data.sessions) {
      const ts = s.turns.filter((t) => t.t >= since);
      if (!ts.length) continue;
      const r = roles.get(s.role) || { role: s.role, req: 0, cost: 0, sess: 0, read: 0, in: 0, edits: 0 };
      r.req += ts.filter((t) => t.kind !== 'auto' && t.kind !== 'cmd').length; r.cost += ts.reduce((a, t) => a + t.cost, 0); r.sess++;
      r.read += s.tokens.cacheRead; r.in += s.tokens.input + s.tokens.cacheWrite + s.tokens.cacheRead; r.edits += s.edits.add + s.edits.del;
      roles.set(s.role, r);
    }
    // 날짜별 — 기간이 전체면 기록이 있는 첫날부터(최대 120일)
    const first = reqs.length ? Math.min(...reqs.map((r) => r.t)) : Date.now();
    const nDays = Math.max(7, Math.min(range || 120, Math.ceil((Date.now() - first) / DAY) + 1));
    const days = [];
    for (let i = nDays - 1; i >= 0; i--) { const t = Date.now() - i * DAY; days.push({ key: dayKey(t), t, req: 0, cost: 0 }); }
    const dayIdx = new Map(days.map((d, i) => [d.key, i]));
    for (const s of data.sessions) for (const t of s.turns) {
      const i = dayIdx.get(dayKey(t.t));
      if (i == null || t.t < since) continue;
      days[i].cost += t.cost;
      if (t.kind !== 'auto' && t.kind !== 'cmd') days[i].req++;
    }
    const punch = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of reqs) { const d = new Date(r.t); punch[d.getDay()][d.getHours()]++; }
    const sum = (f) => sess.reduce((a, s) => a + f(s), 0);
    return {
      reqs, sess, auto, cmds, cost, kinds, tools, models, days, punch,
      roles: [...roles.values()].sort((a, b) => b.cost - a.cost),
      cacheHit: tok.in ? tok.read / tok.in : null,
      interrupts: sum((s) => s.interrupts || 0), compactions: sum((s) => s.compactions || 0),
      subagents: sum((s) => s.subagents || 0),
      edits: { add: sum((s) => s.edits.add), del: sum((s) => s.edits.del), files: sum((s) => s.edits.files) },
      work: sum((s) => (s.time?.model || 0) + (s.time?.tool || 0)),
      toolCalls: Object.values(tools).reduce((a, b) => a + b, 0),
    };
  }

  // ---------- 그리기 도우미 ----------
  function spark(vals, color) {
    if (vals.length < 2) return '';
    const W = 120, H = 30, max = Math.max(...vals, 1);
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, H - 2 - (v / max) * (H - 4)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    return `<svg class="ur-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${line}L${W},${H}L0,${H}Z" fill="${color}" fill-opacity=".14"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }
  function ring(v, color) {
    const r = 15, c = 2 * Math.PI * r, f = v == null ? 0 : Math.max(0, Math.min(1, v));
    return `<svg class="ur-ring" viewBox="0 0 40 40" style="--rc:${color}"><circle cx="20" cy="20" r="${r}" fill="none" stroke="var(--ur-track)" stroke-width="3.5"/>
      <circle class="ur-ring-v" cx="20" cy="20" r="${r}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 20 20)"/></svg>`;
  }
  const card = (title, sub, body, cls = '') => `<section class="ur-card ${cls}"><header><h4>${E(T(title))}</h4>${sub ? `<small>${sub}</small>` : ''}</header>${body}</section>`;

  function kpis(d) {
    const human = d.reqs.length;
    const reqSeries = d.days.map((x) => x.req), costSeries = d.days.map((x) => x.cost);
    const items = [
      { k: '내 요청', v: human, f: num, s: T('하루 평균 {n}건', { n: (human / d.days.length).toFixed(1) }), extra: spark(reqSeries, 'var(--ur-req)') },
      { k: '사용 금액(API 환산)', v: d.cost, f: money, s: T('요청 1건 평균 {v}', { v: money(human ? d.cost / human : 0) }), extra: spark(costSeries, 'var(--ur-cost)') },
      { k: '캐시 적중', v: (d.cacheHit ?? 0) * 100, f: (x) => `${Math.round(x)}%`, s: d.cacheHit == null ? '—' : d.cacheHit >= 0.95 ? T('아주 좋음') : d.cacheHit >= 0.9 ? T('보통') : T('낮음 — 비용이 새고 있어요'), extra: ring(d.cacheHit, d.cacheHit >= 0.95 ? 'var(--ur-good)' : d.cacheHit >= 0.9 ? 'var(--ur-mid)' : 'var(--ur-bad)'), side: true },
      { k: 'Claude 작업 시간', v: d.work, f: hrs, s: T('세션 {n}개', { n: d.sess.length }) },
      { k: '바꾼 코드 줄', v: d.edits.add + d.edits.del, f: num, s: `<b class="ur-add">+${num(d.edits.add)}</b> <b class="ur-del">−${num(d.edits.del)}</b> · ${T('파일 {n}개', { n: num(d.edits.files) })}` },
      { k: '도구 호출', v: d.toolCalls, f: num, s: T('서브에이전트 {n}번', { n: d.subagents }) },
    ];
    return `<div class="ur-kpis">${items.map((it) => `<div class="ur-kpi${it.side ? ' ur-side' : ''}"><div class="ur-kpi-t"><span>${E(T(it.k))}</span><b class="ur-count" data-to="${it.v}" data-fmt="${items.indexOf(it)}">${it.f(0)}</b><small>${it.s}</small></div>${it.extra || ''}</div>`).join('')}</div>`;
  }
  // 숫자가 0 부터 차오르는 연출
  function countUp(d) {
    const fmts = [num, money, (x) => `${Math.round(x)}%`, hrs, num, num];
    const els = modal.querySelectorAll('.ur-count'), t0 = performance.now(), dur = 900;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      els.forEach((el) => { el.textContent = fmts[+el.dataset.fmt](Number(el.dataset.to) * e); });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // 성향 레이더 — 요청 유형 비중(가장 큰 유형을 1로), 위임(요청당 서브에이전트), 자동화(도구 중 명령 실행 비율), 효율(캐시 적중)
  function axesOf(d) {
    const human = d.reqs.filter((r) => r.kind !== 'reply' && r.kind !== 'etc').length || 1;
    const share = (k) => (d.kinds[k] || 0) / human;
    const maxShare = Math.max(...['feature', 'bug', 'ask', 'ops', 'review'].map(share), 0.01);
    return [
      ['구현', share('feature') / maxShare], ['디버깅', share('bug') / maxShare], ['탐구', share('ask') / maxShare],
      ['운영', share('ops') / maxShare], ['위임', Math.min(1, (d.subagents / Math.max(1, d.reqs.length)) * 5)],
      ['자동화', Math.min(1, ((d.tools.Bash || 0) + (d.tools.PowerShell || 0)) / Math.max(1, d.toolCalls) * 2.5)], ['효율', d.cacheHit ?? 0],
    ];
  }
  const AXIS_WHY = { 구현: '작업 지시 비중', 디버깅: '버그·문제 요청 비중', 탐구: '조사·질문 비중', 운영: '커밋·빌드 요청 비중', 위임: '서브에이전트 활용', 자동화: '명령 실행 도구 비율', 효율: '캐시 적중' };
  function radar(d) {
    const axes = axesOf(d);
    const C = 130, R = 92, n = axes.length;
    const pt = (i, v) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [C + Math.cos(a) * R * v, C + Math.sin(a) * R * v]; };
    const grid = [0.25, 0.5, 0.75, 1].map((g) => `<polygon class="ur-rgrid" points="${axes.map((_, i) => pt(i, g).join(',')).join(' ')}"/>`).join('');
    const spokes = axes.map((_, i) => `<line class="ur-rgrid" x1="${C}" y1="${C}" x2="${pt(i, 1)[0]}" y2="${pt(i, 1)[1]}"/>`).join('');
    const shape = axes.map(([, v], i) => pt(i, Math.max(0.06, v)).join(',')).join(' ');
    const labels = axes.map(([k, v], i) => { const [x, y] = pt(i, 1.2); return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${E(T(k))}<tspan class="ur-rv" x="${x}" dy="13">${Math.round(v * 100)}</tspan></text>`; }).join('');
    const dots = axes.map(([, v], i) => { const [x, y] = pt(i, Math.max(0.06, v)); return `<circle class="ur-rdot" cx="${x}" cy="${y}" r="3.2"/>`; }).join('');
    return `<svg class="ur-radar" viewBox="-20 -14 300 290"><defs><radialGradient id="ur-rg" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="var(--accent)" stop-opacity=".55"/><stop offset="1" stop-color="var(--accent)" stop-opacity=".12"/></radialGradient></defs>
      ${grid}${spokes}<polygon class="ur-rshape" points="${shape}" fill="url(#ur-rg)"/>${dots}${labels}</svg>`;
  }
  const topKind = (d) => Object.entries(d.kinds).filter(([k]) => k !== 'reply' && k !== 'etc').sort((a, b) => b[1] - a[1])[0]?.[0] || 'etc';
  // 맨 위 성향 배너 — 들어오자마자 '당신은 ○○형' 을 크게, 근거 몇 개를 '왜?' 미끼로 보여 주고 아래 상세로 이끈다
  function hero(d) {
    const top = topKind(d), [name, desc] = PERSONA[top], col = KIND[top].color, total = d.reqs.length || 1;
    const axes = axesOf(d).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const aiName = lastAi()?.report?.persona?.name;
    const chips = [
      `<span><b>${pct((d.kinds[top] || 0) / total)}</b>${E(T('가장 많은 요청 · {k}', { k: T(KIND[top].label) }))}</span>`,
      ...axes.map(([k, v]) => `<span><b>${Math.round(v * 100)}</b>${E(T(k))} · ${E(T(AXIS_WHY[k]))}</span>`),
    ].join('');
    return `<section class="ur-hero-banner" style="--k:${col}">
      <div class="ur-hb-glow"></div><div class="ur-hb-stars"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <div class="ur-hb-text">
        <small>${E(T('나의 Claude 사용 성향'))}</small>
        <h2>${E(T('당신은'))} <span class="ur-hb-name">${E(T(name))}</span>${E(T('이에요!'))}</h2>
        <p>${E(T(desc))}</p>
        <div class="ur-hb-chips">${chips}</div>
        ${aiName ? `<p class="ur-hb-ai">${E(T('AI 코치는 당신을 “{n}” 라고 불러요', { n: aiName }))}</p>` : ''}
        <button class="ur-hb-more" data-ur="why">${E(T('왜 그런지 보기'))} <span>↓</span></button>
      </div>
      <div class="ur-hb-radar">${radar(d)}</div>
    </section>`;
  }
  function donut(d) {
    const total = d.reqs.length || 1, R = 64, r = 42, C = 80;
    let a0 = -Math.PI / 2;
    const order = Object.keys(KIND).filter((k) => d.kinds[k]);
    const arcs = order.map((k) => {
      const f = d.kinds[k] / total, a1 = a0 + f * Math.PI * 2, big = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${C + Math.cos(ang) * rad},${C + Math.sin(ang) * rad}`;
      const path = f >= 0.999 ? `M${C - R},${C}a${R},${R} 0 1,0 ${R * 2},0a${R},${R} 0 1,0 ${-R * 2},0M${C - r},${C}a${r},${r} 0 1,1 ${r * 2},0a${r},${r} 0 1,1 ${-r * 2},0`
        : `M${p(R, a0)}A${R},${R} 0 ${big} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${big} 0 ${p(r, a0)}Z`;
      a0 = a1;
      return `<path class="ur-arc" d="${path}" fill="${KIND[k].color}"><title>${E(T(KIND[k].label))} ${d.kinds[k]} (${pct(f)})</title></path>`;
    }).join('');
    const legend = order.map((k) => `<li><i style="background:${KIND[k].color}"></i>${E(T(KIND[k].label))}<b>${pct(d.kinds[k] / total)}</b><small>${d.kinds[k]}</small></li>`).join('');
    return `<div class="ur-donut-wrap"><svg class="ur-donut" viewBox="0 0 160 160">${arcs}<text x="80" y="76" text-anchor="middle" class="ur-donut-n">${num(d.reqs.length)}</text><text x="80" y="95" text-anchor="middle" class="ur-donut-s">${E(T('요청'))}</text></svg><ul class="ur-legend">${legend}</ul></div>`;
  }
  // 날짜별 요청 수 · 금액 — 눈금이 다른 두 값을 한 축에 겹치지 않고 위아래 두 줄 막대로(날짜 축 공유).
  // 선으로 이으면 요청이 없던 날을 지나며 0 으로 꺾여 큰 삼각형이 생겼다
  function timeline(d) {
    const W = 760, padL = 40, padR = 8, n = d.days.length, bw = (W - padL - padR) / n, x = (i) => padL + i * bw;
    const barW = Math.max(1, Math.min(bw * 0.68, 28)); // 7일처럼 날이 적으면 막대가 뭉툭해지지 않게 상한
    const plot = (top, h, vals, fmt, cls, label) => {
      const max = Math.max(...vals, 0), y = (v) => top + h - (max ? (v / max) * h : 0);
      const bars = vals.map((v, i) => (v ? `<rect class="ur-bar ${cls}" x="${(x(i) + (bw - barW) / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${(top + h - y(v)).toFixed(1)}" rx="${Math.min(3, bw * 0.3).toFixed(1)}"><title>${d.days[i].key} · ${T('요청 {n}건', { n: d.days[i].req })} · ${money(d.days[i].cost)}</title></rect>` : '')).join('');
      return `<text class="ur-plot-h" x="${padL}" y="${top - 8}">${E(T(label))}</text>`
        + [0, 1].map((g) => `<line class="ur-gline${g ? '' : ' base'}" x1="${padL}" x2="${W - padR}" y1="${y(max * g)}" y2="${y(max * g)}"/><text class="ur-tick" x="${padL - 6}" y="${y(max * g) + 3}" text-anchor="end">${g && max ? fmt(max) : 0}</text>`).join('')
        + bars;
    };
    const top1 = 22, h1 = 112, top2 = top1 + h1 + 34, h2 = 56, H = top2 + h2 + 22;
    const ticks = d.days.map((dd, i) => (i % Math.ceil(n / 8) === 0 || i === n - 1 ? `<text class="ur-tick" x="${(x(i) + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${dd.key.slice(5).replace('-', '/')}</text>` : '')).join('');
    return `<svg class="ur-timeline" viewBox="0 0 ${W} ${H}">${plot(top1, h1, d.days.map((dd) => dd.req), num, 'is-req', '요청 수')}${plot(top2, h2, d.days.map((dd) => dd.cost), money, 'is-cost', '사용 금액')}${ticks}</svg>`;
  }
  // 요일 × 시간 — 원 크기·진하기 = 요청 수
  function punchcard(d) {
    const max = Math.max(...d.punch.flat(), 1), cw = 26, ch = 26, padL = 26, padT = 6;
    const order = [1, 2, 3, 4, 5, 6, 0];
    const dots = order.map((wd, row) => d.punch[wd].map((v, h) => {
      if (!v) return `<circle class="ur-pc0" cx="${padL + h * cw + cw / 2}" cy="${padT + row * ch + ch / 2}" r="1.6"/>`;
      const f = v / max;
      return `<circle class="ur-pc" cx="${padL + h * cw + cw / 2}" cy="${padT + row * ch + ch / 2}" r="${(3 + f * 8.5).toFixed(1)}" style="opacity:${(0.35 + f * 0.65).toFixed(2)}"><title>${T(WEEK[wd])} ${h}${T('시')} · ${T('요청 {n}건', { n: v })}</title></circle>`;
    }).join('')).join('');
    const rows = order.map((wd, row) => `<text class="ur-tick" x="${padL - 8}" y="${padT + row * ch + ch / 2 + 4}" text-anchor="end">${E(T(WEEK[wd]))}</text>`).join('');
    const cols = [0, 6, 12, 18, 23].map((h) => `<text class="ur-tick" x="${padL + h * cw + cw / 2}" y="${padT + 7 * ch + 12}" text-anchor="middle">${h}${E(T('시'))}</text>`).join('');
    // 가장 바쁜 시간대
    let best = [0, 0, 0];
    d.punch.forEach((r, wd) => r.forEach((v, h) => { if (v > best[0]) best = [v, wd, h]; }));
    const peak = best[0] ? T('가장 활발: {w}요일 {h}시', { w: T(WEEK[best[1]]), h: best[2] }) : '';
    return { svg: `<svg class="ur-punch" viewBox="0 0 ${padL + 24 * cw + 4} ${padT + 7 * ch + 18}">${rows}${dots}${cols}</svg>`, peak };
  }
  function toolBars(d) {
    const top = Object.entries(d.tools).sort((a, b) => b[1] - a[1]).slice(0, 9), max = top[0]?.[1] || 1;
    return `<ul class="ur-hbars">${top.map(([k, v], i) => `<li><span>${E(k)}</span><div><i style="width:${((v / max) * 100).toFixed(1)}%;--d:${i * 60}ms"></i></div><b>${num(v)}</b><small>${pct(v / Math.max(1, d.toolCalls))}</small></li>`).join('')}</ul>`;
  }
  function roleTable(d) {
    const max = Math.max(...d.roles.map((r) => r.cost), 0.01);
    return `<table class="ur-roles"><thead><tr><th>${E(T('역할'))}</th><th>${E(T('요청'))}</th><th>${E(T('금액'))}</th><th>${E(T('캐시'))}</th><th>${E(T('바꾼 줄'))}</th></tr></thead><tbody>${
      d.roles.slice(0, 10).map((r, i) => `<tr><td><span class="ur-rank">${i + 1}</span>${E(r.role)}<small>${T('세션 {n}', { n: r.sess })}</small></td><td>${num(r.req)}</td>
        <td class="ur-cost"><div><i style="width:${((r.cost / max) * 100).toFixed(1)}%"></i></div>${money(r.cost)}</td>
        <td><span class="ur-hit is-${r.in && r.read / r.in >= 0.95 ? 'good' : r.in && r.read / r.in >= 0.9 ? 'mid' : 'bad'}">${r.in ? pct(r.read / r.in) : '—'}</span></td><td>${num(r.edits)}</td></tr>`).join('')}</tbody></table>`;
  }
  // 요청 길이 — 내가 보낸 요청 글이 몇 글자였나(구간별 건수·비율, 가로 막대). 모델이 둘 이상이면 아래에 모델 비중
  // 요청 글은 세션 프로파일이 200자까지만 들고 있어 마지막 구간은 '200자 이상'
  function modelsAndLength(d) {
    const bins = [[0, 11, '한 마디', '10자 이하'], [11, 31, '짧은 지시', '11~30자'], [31, 81, '보통', '31~80자'], [81, 200, '자세한 지시', '81~199자'], [200, Infinity, '긴 설명', '200자 이상']];
    const n = d.reqs.length || 1;
    const counts = bins.map(([lo, hi]) => d.reqs.filter((r) => r.len >= lo && r.len < hi).length), mx = Math.max(...counts, 1);
    const top = counts.indexOf(Math.max(...counts));
    const rows = bins.map(([, , name, range], i) => `<li class="${i === top ? 'is-top' : ''}"><span><b>${E(T(name))}</b><small>${E(T(range))}</small></span><div><i style="width:${((counts[i] / mx) * 100).toFixed(1)}%;--d:${i * 70}ms"></i></div><b>${counts[i]}${E(T('건'))}</b><small>${pct(counts[i] / n)}</small></li>`).join('');
    const lens = d.reqs.map((r) => r.len).sort((x, y) => x - y), med = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    const avg = d.reqs.length ? Math.round(d.reqs.reduce((s, r) => s + r.len, 0) / d.reqs.length) : 0;
    const ent = Object.entries(d.models).sort((x, y) => y[1] - x[1]), tot = ent.reduce((s, [, v]) => s + v, 0) || 1;
    const palette = ['var(--k-feature)', 'var(--k-bug)', 'var(--k-ask)', 'var(--k-ops)', 'var(--k-review)']; // 정해진 순서(검증한 범주색) — 5개 넘으면 되풀이
    const models = ent.length > 1 ? `<div class="ur-models"><span class="ur-models-h">${E(T('답한 모델'))}</span><div class="ur-seg">${ent.map(([m, v], i) => `<i style="width:${((v / tot) * 100).toFixed(2)}%;background:${palette[i % palette.length]}" title="${E(m)} ${pct(v / tot)}"></i>`).join('')}</div><div class="ur-seg-leg">${ent.map(([m, v], i) => `<span><i style="background:${palette[i % palette.length]}"></i>${E(m.replace(/^claude-/, ''))} <b>${pct(v / tot)}</b></span>`).join('')}</div></div>`
      : ent.length ? `<p class="ur-model-one">${E(T('답한 모델: {m} (전부)', { m: ent[0][0].replace(/^claude-/, '') }))}</p>` : '';
    return `<div class="ur-len-stat"><div><b>${avg}${E(T('자'))}</b><small>${E(T('평균'))}</small></div><div><b>${med}${E(T('자'))}</b><small>${E(T('가운데 값'))}</small></div><div><b>${E(T(bins[top][2]))}</b><small>${E(T('가장 많은 길이'))}</small></div></div>
      <ul class="ur-lenbars">${rows}</ul>${models}`;
  }
  // 점검 — 규칙으로 찾은 좋은 점·바꿀 점
  function insights(d) {
    const out = [], human = d.reqs.length;
    if (!human) return '';
    const work = d.reqs.filter((r) => r.kind !== 'reply');
    const short = work.filter((r) => r.len < 15).length / Math.max(1, work.length);
    if (short > 0.3) out.push(['tip', '짧은 지시가 많아요', T('지시 {p}가 15자 미만이에요. 대상·완료 조건을 한 줄 더 적으면 되묻기와 왕복이 줄어요.', { p: pct(short) })]);
    const reply = (d.kinds.reply || 0) / human;
    if (reply > 0.2) out.push(['tip', '확인 답장이 잦아요', T('요청의 {p}가 "응·네" 같은 짧은 답이에요. 처음 지시에 "묻지 말고 진행" 범위를 정해 두면 흐름이 끊기지 않아요.', { p: pct(reply) })]);
    const intr = d.interrupts / human;
    if (intr > 0.08) out.push(['warn', '중간에 멈춘 작업', T('요청 {p}를 도중에 중단했어요. 방향이 어긋날 때가 많다면 큰 작업은 먼저 계획을 받아 보세요.', { p: pct(intr) })]);
    if (d.cacheHit != null && d.cacheHit < 0.9) out.push(['warn', '캐시가 자주 깨져요', T('캐시 적중 {p}. 오래 쉬었다 이어 쓰거나 모델·설정을 자주 바꾸면 처음부터 다시 읽어 비용이 커져요.', { p: pct(d.cacheHit) })]);
    else if (d.cacheHit != null && d.cacheHit >= 0.97) out.push(['good', '캐시 활용 최상급', T('캐시 적중 {p} — 같은 맥락을 이어 가며 아주 효율적으로 쓰고 있어요.', { p: pct(d.cacheHit) })]);
    const perSess = human / Math.max(1, d.sess.length);
    if (perSess > 60) out.push(['tip', '세션이 길어요', T('세션당 요청 {n}건 · 압축 {c}번. 주제가 바뀌면 /clear 로 새로 시작하는 편이 빠르고 싸요.', { n: Math.round(perSess), c: d.compactions })]);
    const night = d.reqs.filter((r) => { const h = new Date(r.t).getHours(); return h >= 22 || h < 5; }).length / human;
    if (night > 0.2) out.push(['tip', '야간 작업 비중', T('요청 {p}가 밤 10시~새벽 5시예요. 긴 작업은 맡겨 두고 쉬는 것도 방법이에요.', { p: pct(night) })]);
    if (d.subagents / human > 0.15) out.push(['good', '위임을 잘 써요', T('요청 100건당 서브에이전트 {n}번 — 조사·병렬 작업을 잘 나눠 맡기고 있어요.', { n: Math.round((d.subagents / human) * 100) })]);
    else if (human > 30 && d.subagents / human < 0.03) out.push(['tip', '서브에이전트를 거의 안 써요', T('넓은 조사는 서브에이전트에 맡기면 메인 맥락이 가벼워져요.')]);
    const top = d.roles[0];
    if (top && d.roles.length > 1 && top.cost / Math.max(0.01, d.cost) > 0.5) out.push(['info', '한 역할에 집중', T("'{r}' 역할이 금액의 {p}를 써요.", { r: top.role, p: pct(top.cost / d.cost) })]);
    if (d.auto > human * 0.3) out.push(['good', '백그라운드 작업 활용', T('알림 {n}건 — 오래 걸리는 일을 뒤에서 돌리며 작업하고 있어요.', { n: d.auto })]);
    const ICON = { good: '✦', tip: '➜', warn: '!', info: 'i' };
    return `<div class="ur-insights">${out.map(([lv, h, p], i) => `<div class="ur-ins is-${lv}" style="--d:${i * 60}ms"><span class="ur-ins-i">${ICON[lv]}</span><div><b>${E(T(h))}</b><p>${E(p)}</p></div></div>`).join('') || `<p class="ur-empty">${E(T('눈에 띄는 점이 없어요 — 고르게 잘 쓰고 있어요.'))}</p>`}</div>`;
  }

  // ---------- AI 코치 리포트 — 이 PC 의 Claude CLI(구독 사용량)로 요청 글 샘플을 분석(/api/user-profile/llm) ----------
  // byDays = 기간(7·30·0)마다 마지막 리포트(서버가 따로 보관). 지금 탭의 것만 보여 준다 — 탭을 바꾸면 그 기간 리포트, 없으면 '분석 받기'
  let ai = { byDays: {}, busy: false, count: 0, err: '' };
  const lastAi = () => ai.byDays?.[range] || null;
  const RANGE_LABEL = { 7: '최근 7일', 30: '최근 30일', 0: '전체 기간' };
  async function loadAi() {
    try { ai = { ...ai, ...(await (await fetch(`/api/user-profile/llm?days=${range}`)).json()) }; } catch {}
    renderAi(); renderAiNotes(); // 지표 카드의 AI 해설도 같이
  }
  function aiBody() {
    const note = T('요청 글 최근 {n}개와 통계를 이 PC 의 Claude(sonnet)로 보내 분석해요 · 구독 사용량을 써요 · 1분 안팎', { n: ai.count || 0 });
    if (ai.busy) return `<div class="ur-ai-busy"><div class="ur-orb"><i></i><i></i><i></i></div><b>${E(T('Claude 가 요청 {n}개를 읽고 있어요…', { n: ai.count || 0 }))}</b><small>${E(T('창을 닫아도 계속 돌아요'))}</small><div class="ur-skel"><span></span><span></span><span></span></div></div>`;
    const btn = (label) => `<button class="ur-ai-btn" data-ai="run"${ai.count ? '' : ' disabled'}><span>✦</span>${E(T(label))}</button>`;
    const err = ai.err ? `<p class="ur-ai-err">${E(ai.err)}</p>` : '';
    const L = lastAi(), R = L?.report;
    if (!R) return `<div class="ur-ai-cta"><div class="ur-ai-glow"></div><h5>${E(T('내 요청 습관을 Claude 에게 코칭받기'))}</h5><p>${E(T('강점·약점·바꿔 쓸 요청 예시·다음 주 실천 과제를 받아요.'))}</p>${btn('AI 분석 받기')}<small>${E(note)}</small>${err}</div>`;
    const MN = {"clarity":"명확성","context":"맥락 제공","done":"완료 기준","firstpass":"한 번에 끝냄","flow":"한 번에 맡기기"};
    const list = (arr, cls, ic) => (arr || []).length ? `<ul class="ur-ai-list ${cls}">${arr.map((x, i) => `<li style="--d:${i * 70}ms"><span class="ur-ai-ic">${ic}</span><div><b>${E(x.title || '')}</b><p>${E(x.detail || '')}</p>${x.evidence ? `<span class="ur-ev">${E(T('근거'))} · ${E(T(MN[x.metric] || x.metric || ''))} ${E(String(x.evidence).replace(new RegExp('^\\s*(' + x.metric + '|' + (MN[x.metric] || '') + ')\\s*', 'i'), ''))}</span>` : ''}</div></li>`).join('')}</ul>` : `<p class="ur-empty">${E(T('지표로 뒷받침되는 항목이 없어요'))}</p>`;
    return `<div class="ur-ai">
      <div class="ur-ai-top"><div><div class="ur-ai-head">${E(R.headline || '')}</div>
        <div class="ur-ai-persona"><span class="ur-badge" style="--k:var(--ur-ai)">${E(R.persona?.name || '')}</span><p>${E(R.persona?.desc || '')}</p></div></div></div>
      <div class="ur-ai-cols"><div><h5 class="ur-ai-h is-good">${E(T('잘하고 있는 점'))}</h5>${list(R.strengths, 'is-good', '✓')}</div><div><h5 class="ur-ai-h is-tip">${E(T('바꿔 보면 좋은 점'))}</h5>${list(R.improvements, 'is-tip', '➜')}</div></div>
      ${R.next ? `<div class="ur-next"><span>${E(T('다음 일주일 실천 과제'))}</span><b>${E(R.next)}</b></div>` : ''}
      ${(R.rewrites || []).length || (R.patterns || []).length ? `<details class="ur-more"><summary>${E(T('자세히 — 고쳐 쓰기 예시 {a}개 · 반복 패턴 {b}개', { a: (R.rewrites || []).length, b: (R.patterns || []).length }))}</summary>${(R.rewrites || []).map((w) => `<div class="ur-rw"><div class="ur-rw-b">${E(w.before || '')}</div><div class="ur-rw-a"><span>➜</span>${E(w.after || '')}</div>${w.why ? `<small>${E(w.why)}</small>` : ''}</div>`).join('')}${(R.patterns || []).length ? `<ul class="ur-pat">${R.patterns.map((p) => `<li>${E(p)}</li>`).join('')}</ul>` : ''}</details>` : ''}
      <div class="ur-ai-foot"><small>${E(T('{when} · {range} · 요청 {n}개 분석 · {model}', { when: new Date(L.at).toLocaleString(), range: T(RANGE_LABEL[L.days] || '전체 기간'), n: L.n, model: L.model || '' }))}</small>${btn('다시 분석')}</div>${err}
    </div>`;
  }
  // 요청 습관 지표 — 서버가 정해진 공식으로 센 값(userprofile.js metricsOf). 링 위에 마우스를 올리면 공식, AI 리포트가 있으면 그 지표 해설 한 줄
  function metricsCard() {
    const M = data.metrics?.[range];
    if (!M) return '';
    const comments = metricComments();
    const items = M.list.map((x, i) => {
      const v = x.score ?? 0, r = 26, c = 2 * Math.PI * r;
      const col = x.score == null ? 'rgb(var(--ink) / .2)' : v >= 75 ? 'var(--ur-good)' : v >= 40 ? 'var(--ur-warn)' : 'var(--ur-bad)'; // 상태색 3단계
      return `<div class="ur-metric" data-k="${E(x.key)}" style="--d:${i * 80}ms;--c:${col}" title="${E(T('공식'))}: ${E(T(x.formula))}">
        <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="${r}" class="bg"/><circle cx="32" cy="32" r="${r}" class="fg" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle">${x.score ?? '–'}</text></svg>
        <b>${E(T(x.name))}</b><small>${E(x.desc)}</small>${comments[x.key] ? `<p class="ur-metric-ai">${E(comments[x.key])}</p>` : ''}
        ${x.examples?.length && x.score != null && x.score < 75 ? `<details><summary>${E(T('낮은 쪽 예시'))}</summary>${x.examples.map((e) => `<q>${E(e)}</q>`).join('')}</details>` : ''}</div>`;
    }).join('');
    return `<section class="ur-card wide"><header><h4>${E(T('요청 습관 지표'))}</h4><small>${E(T('링에 마우스를 올리면 공식'))}</small></header><div class="ur-metrics">${items}</div></section>`;
  }
  const metricComments = () => lastAi()?.report?.comments || {};
  // AI 카드·지표 해설만 갈아 끼운다 — 본문 전체를 다시 그리면 이미 다 나온 카드들의 등장 연출이 처음부터 다시 돈다.
  // 내용이 그대로면 손대지 않는다(다시 열 때 지난 리포트가 그대로 오는 경우 — 목록 연출이 또 돌지 않게)
  let shownAi = '';
  function renderAi() {
    const el = $u('#ur-ai'), h = aiBody();
    if (el && h !== shownAi) el.innerHTML = shownAi = h;
  }
  function renderAiNotes() {
    const comments = metricComments();
    document.querySelectorAll('#ur-body .ur-metric').forEach((m) => {
      const t = comments[m.dataset.k] || '';
      let p = m.querySelector('.ur-metric-ai');
      if (!t) return p?.remove();
      if (!p) { p = document.createElement('p'); p.className = 'ur-metric-ai'; m.querySelector('small').after(p); }
      if (p.textContent !== t) p.textContent = t;
    });
    // 배너의 'AI 코치는 당신을 … 라고 불러요' 한 줄도 같이(hero)
    const more = document.querySelector('#ur-body .ur-hb-more'), n = lastAi()?.report?.persona?.name;
    if (!more) return;
    let hb = more.parentElement.querySelector('.ur-hb-ai');
    if (!n) return hb?.remove();
    if (!hb) { hb = document.createElement('p'); hb.className = 'ur-hb-ai'; more.before(hb); }
    const t = T('AI 코치는 당신을 “{n}” 라고 불러요', { n });
    if (hb.textContent !== t) hb.textContent = t;
  }
  async function runAi() {
    ai.busy = true; ai.err = ''; renderAi();
    try {
      const r = await fetch('/api/user-profile/llm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: range, lang: document.documentElement.lang === 'en' ? 'en' : 'ko' }) });
      const j = await r.json();
      if (!r.ok || j.error) ai.err = j.error === 'empty' ? T('이 기간에 분석할 요청이 없어요') : T('분석 결과를 읽지 못했어요 — 잠시 뒤 다시 시도해 주세요');
      else ai.byDays = { ...ai.byDays, [j.days]: j };
    } catch { ai.err = T('서버에 연결할 수 없습니다'); }
    ai.busy = false; renderAi(); renderAiNotes();
  }

  function render() {
    const body = $u('#ur-body');
    if (!data) { body.innerHTML = `<div class="ur-loading"><span></span>${E(T('워커 세션을 읽는 중…'))}</div>`; return; }
    const d = crunch();
    $u('#ur-sub').textContent = T('워커 세션 {s}개 · 기록 시작 {d}', { s: data.sessions.length, d: new Date(data.since).toLocaleDateString() });
    if (!d.reqs.length) { body.innerHTML = `<p class="ur-empty big">${E(T('이 기간에 워커로 보낸 요청이 없어요.'))}</p>`; return; }
    const pc = punchcard(d);
    // 읽는 순서 = 이야기 순서: 나는 누구(배너) → ① 왜 그 성향인가(근거) → ② 요청을 얼마나 잘 하나(지표·길이·점검)
    // → ③ 무엇을 바꿀까(AI 코치) → ④ 얼마나 썼나(규모·추이) → ⑤ 자세히(도구·역할). 배너의 '왜 그런지 보기'는 ①로
    const sec = (n, title, sub) => `<h3 class="ur-sec"${n === 1 ? ' id="ur-why"' : ''}><span>${n}</span>${E(title)}${sub ? `<small>${E(sub)}</small>` : ''}</h3>`;
    const pname = T(PERSONA[topKind(d)][0]);
    body.innerHTML = hero(d)
      + sec(1, T('왜 {p}일까?', { p: pname }), T('성향은 가장 많이 보낸 요청 유형으로 정해요'))
      + `<div class="ur-grid two">${card('요청 유형', T('키워드로 나눈 내 요청'), donut(d))}${card('언제 일하나', pc.peak, pc.svg)}</div>`
      + sec(2, T('요청을 얼마나 잘 하고 있을까?'), T('정해진 공식으로 센 지표 — 돌릴 때마다 같은 값'))
      + metricsCard()
      + `<div class="ur-grid two">${card('요청 길이', T('내가 보낸 요청이 몇 글자였나'), modelsAndLength(d))}${card('점검', T('규칙으로 찾은 좋은 점과 바꿔 볼 점'), insights(d))}</div>`
      + sec(3, T('무엇을 바꿔 볼까?'), T('Claude 가 내 요청 글과 지표를 읽고 주는 코칭'))
      + `<section class="ur-card wide ur-ai-card"><header><h4>${E(T('AI 코치 리포트'))}</h4><small>${E(T('Claude 가 내 요청 글을 읽고 주는 피드백'))}</small></header><div id="ur-ai">${(shownAi = aiBody())}</div></section>`
      + sec(4, T('얼마나 썼을까?'), T('요청·금액·시간 규모와 날짜별 흐름'))
      + kpis(d)
      + card('날짜별 활동', T('요청 수와 그날 쓴 금액'), timeline(d), 'wide')
      + sec(5, T('자세히'), T('Claude 가 쓴 도구와 역할별 사용'))
      + `<div class="ur-grid two">${card('Claude 가 쓴 도구', T('호출 수 · 비율'), toolBars(d))}${card('역할별', T('금액 순'), roleTable(d))}</div>`;
    [...body.children].forEach((c, i) => c.style.setProperty('--i', i)); // 펼칠 때 차례로 붙는 순서
    countUp(d);
  }

  // 여는 연출: 창은 처음부터 다 큰 크기, 카드가 위에서부터 차례로 떠오른다(배너 먼저). 기간을 바꿀 땐 연출 없이.
  // .ur-seq 는 다 떠오른 뒤에도 떼지 않는다 — 떼면 배너·넓은 카드의 animation 이 ur-attach → ur-rise 로 바뀌어
  // 처음부터 한 번 더 재생된다. 본문을 새로 그리기 직전(기간 바꾸기)이나 닫을 때만 뗀다
  const box = modal.querySelector('.ur-modal');
  async function open() {
    modal.hidden = false;
    box.classList.remove('ur-seq');
    data = null; render();
    try { data = await (await fetch('/api/user-profile')).json(); } catch { data = { sessions: [], since: Date.now() }; }
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
      box.classList.add('ur-seq');
    }
    render();
    loadAi();
  }
  function close() { box.classList.remove('ur-seq'); modal.hidden = true; }
  $u('#btn-ureport').addEventListener('click', open);
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-ur=close]')) return close();
    const r = e.target.closest('[data-range]');
    if (r) { range = Number(r.dataset.range); modal.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('on', b === r)); box.classList.remove('ur-seq'); render(); loadAi(); }
    if (e.target.closest('[data-ai=run]') && !ai.busy) runAi();
    if (e.target.closest('[data-ur=why]')) $u('#ur-why')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
})();
