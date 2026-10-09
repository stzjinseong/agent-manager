// ---------- 캐릭터 ----------
// 워커·매니저·헤더 로고·탭 아이콘에 그리는 캐릭터. 헤더의 👕 버튼으로 고르고 브라우저에 기억한다(am.char).
// 기본 클로드·흰 클로드에, 사용자가 올린 그림으로 만든 캐릭터(서버 data/characters)가 더해진다.
// 캐릭터마다 SVG 문자열을 돌려주는 함수 셋 — 화면 쪽 CSS·애니메이션이 기대하는 약속:
//  · 루트 <svg class="clawd" data-v="…"> — data-v 는 'full'(카드·매니저) | 'head'(칩·헤더·상세처럼 작은 자리) · 캐릭터를 바꾸면 이걸 보고 다시 그린다
//  · .body = 워커 색(--avatar)으로 칠할 부분 · .eye = 깜빡임·눈 감기(scaleY) · .legs-a/.legs-b = 걷기 두 프레임 — 없어도 된다
//  · 매니저는 .mgr 루트에 .mgr-lean > .mgr-act 로 감싼다(시선 기울기·끄덕임). 클로드는 성장 단계 액세서리(.acc-*)를 겹치고,
//    올린 캐릭터는 단계별 그림으로 바뀐다

// ---------- 클로드 (Claude Code 시작 화면의 픽셀 마스코트) ----------
// 터미널 반블록 비율을 따라 픽셀 하나 = 가로 1 × 세로 2
const clawdRect = (x, y, w, h, cls = 'body') => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
// 워커 그림 — cls 는 루트에 더할 클래스(흰 클로드는 'white': 워커 색 대신 흰 몸), defs 는 그림 앞에 넣을 정의(캐릭터 목록의 무지개 그라데이션)
const clawdWorker = (v, cls = '', defs = '') => {
  const R = clawdRect;
  return `<svg class="clawd${cls ? ` ${cls}` : ''}" data-v="${v}" viewBox="0 0 18 10" shape-rendering="crispEdges">${defs}
    ${R(3, 0, 12, 4)}${R(1, 4, 16, 2)}${R(3, 6, 12, 2)}
    <g class="legs-a">${R(4, 8, 1, 2)}${R(6, 8, 1, 2)}${R(11, 8, 1, 2)}${R(13, 8, 1, 2)}</g>
    <g class="legs-b">${R(5, 8, 1, 2)}${R(7, 8, 1, 2)}${R(10, 8, 1, 2)}${R(12, 8, 1, 2)}</g>
    ${R(5, 2, 1, 2, 'eye')}${R(12, 2, 1, 2, 'eye')}
  </svg>`;
};
// 캐릭터 목록의 클로드 미리보기 — 워커마다 색이 바뀌는 캐릭터라는 뜻으로 무지개색 몸(.rainbow, style.css)
const RAINBOW = ['#ff5f6d', '#ffa53b', '#ffe14d', '#5fd38a', '#4aa8ff', '#9b6bff'];
const rainbowDefs = `<defs><linearGradient id="clawd-rainbow" gradientUnits="userSpaceOnUse" x1="3" y1="1" x2="15" y2="9">${
  RAINBOW.map((c, i) => `<stop offset="${(i / (RAINBOW.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('')}</linearGradient></defs>`;
const CLAWD = {
  id: 'clawd',
  name: '클로드',
  worker: (v = 'full') => clawdWorker(v),
  preview: () => clawdWorker('logo', 'rainbow', rainbowDefs),
  // 매니저 — 같은 마스코트에 성장 단계별 액세서리 레이어를 겹친다 (왕 테마)
  //  1 볼터치(+눈 깜빡임) · 2 헤드셋 · 3 망토 · 4 왕관(헤드셋 대신) + 금빛 스파크 · 5 후광 + 별가루
  // 바깥 g(.mgr-lean)는 시선 기울기, 안쪽 g(.mgr-act)는 끄덕임·인사 같은 반응 동작용 — 서로 transform 이 겹치지 않게 나눈다
  manager() {
    const R = clawdRect;
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
  },
  // 브라우저 탭 아이콘 = 매니저와 같은 흰 캐릭터. 밝은 탭 바에서도 보이도록 어두운 둥근 사각형 바탕을 깐다. 결정 대기면 오른쪽 위에 주황 점
  favicon(alert) {
    const R = (x, y, w, h, c) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`;
    const body = '#f3f1ec', eye = '#14161c';
    // 18×10 캐릭터(픽셀 = 가로1×세로2)를 22×22 바탕 가운데에
    const g = R(3, 0, 12, 4, body) + R(1, 4, 16, 2, body) + R(3, 6, 12, 2, body) +
      [4, 6, 11, 13].map((x) => R(x, 8, 1, 2, body)).join('') + R(5, 2, 1, 2, eye) + R(12, 2, 1, 2, eye);
    const bg = '<rect x="0" y="0" width="22" height="22" rx="5" fill="#14161c"/>';
    const dot = alert ? '<circle cx="18.5" cy="3.5" r="3.5" fill="#f4b34a" stroke="#14161c" stroke-width="1"/>' : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" shape-rendering="crispEdges">${bg}<g transform="translate(2 6)">${g}</g>${dot}</svg>`;
  },
};

// ---------- 흰 클로드 ----------
// 같은 마스코트를 워커 색 없이 모두 흰 몸으로(.white, style.css). 매니저·탭 아이콘은 원래 흰 캐릭터라 클로드 것을 그대로 쓴다
const CLAWD_WHITE = {
  ...CLAWD,
  id: 'clawd-white',
  name: '흰 클로드',
  worker: (v = 'full') => clawdWorker(v, 'white'),
  preview: undefined,
};

// ---------- 올린 그림 캐릭터 ----------
// meta = 서버 data/characters/<id>.json: { id, name, icon, stages: { 0: { file, w, h, pixel }, 3: …, w: … } }
// 0~5 는 매니저(0 = 기본, 1~5 = 성장 단계), w 는 워커 그림 — 없으면 워커도 0 을 쓴다.
// 헤더 로고·확인 창·종료 화면(v = 'logo' | 'logo-full')은 앱의 얼굴이라 매니저 기본 그림으로
// 그림은 원본 그대로(워커 색 칠하기·눈 깜빡임 없음). 도트 그림(pixel)은 키워도 흐려지지 않게 픽셀 그대로 키운다(단계마다 따로)
// 작은 자리(head)는 세로로 긴 그림이면 위쪽 정사각형(대개 머리)만, 아니면 전체를 줄여서
function imageChar(meta) {
  const at = (n) => { for (let k = n; k > 0; k--) if (meta.stages[k]) return meta.stages[k]; return meta.stages[0]; };
  const img = (s) => `<image href="/characters/${s.file}" width="${s.w}" height="${s.h}" preserveAspectRatio="none"${s.pixel ? ' style="image-rendering:pixelated"' : ''}/>`;
  const headH = (s) => (s.h > s.w * 1.15 ? s.w : s.h);
  return {
    id: meta.id,
    name: meta.name,
    custom: true,
    // 매니저 그림이 단계마다 다른지 — 단계가 바뀌면 다시 그릴지 정할 때 쓴다
    stageKey: (n) => at(n).file,
    worker(v = 'full') {
      const logo = v.startsWith('logo'), s = (!logo && meta.stages.w) || at(0);
      if (logo) v = v === 'logo' ? 'head' : 'full';
      if (v === 'head') return `<svg class="clawd img" data-v="head" viewBox="0 0 ${s.w} ${headH(s)}" style="overflow:hidden">${img(s)}</svg>`;
      return `<svg class="clawd img" data-v="${v}" viewBox="0 0 ${s.w} ${s.h}" preserveAspectRatio="xMidYMax meet">${img(s)}</svg>`;
    },
    manager(stage = 0) {
      const s = at(stage);
      return `<svg class="clawd mgr img" viewBox="0 0 ${s.w} ${s.h}" preserveAspectRatio="xMidYMax meet"><g class="mgr-lean"><g class="mgr-act">${img(s)}</g></g></svg>`;
    },
    // 탭 아이콘은 SVG 안에서 바깥 파일을 못 불러오므로, 올릴 때 만든 머리 그림(data URL)을 쓴다
    favicon(alert) {
      const dot = alert ? '<circle cx="54" cy="10" r="9" fill="#f4b34a" stroke="#14161c" stroke-width="2"/>' : '';
      return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><image href="${meta.icon}" xlink:href="${meta.icon}" width="64" height="64"${meta.stages[0].pixel ? ' style="image-rendering:pixelated"' : ''}/>${dot}</svg>`;
    },
    // 자리별 크기를 정하는 CSS 변수 — 카드 높이 66px 기준, 도트 그림은 정수배로 맞춰 픽셀 크기가 고르게. 워커·매니저 그림이 다르면 각자 크기로
    sizes() {
      const fit = ({ h, pixel }) => (pixel && h <= 66 ? Math.floor(66 / h) * h : 66);
      return { '--ch-card': `${fit(meta.stages.w || at(0))}px`, '--ch-logo': `${fit(at(0))}px`, '--ch-mgr': `${Math.round(fit(at(0)) * 1.5)}px` };
    },
  };
}

// 목록은 서버가 원본이고, 첫 화면부터 그 캐릭터로 그리도록 브라우저에도 기억해 둔다(am.chars). app.js 가 서버 목록을 받으면 갱신
const CHAR_KEY = 'am.char', CHARS_KEY = 'am.chars';
let CHARS = [CLAWD, CLAWD_WHITE];
function setCharList(metas) {
  CHARS = [CLAWD, CLAWD_WHITE, ...metas.filter((m) => m?.id && m.stages?.[0]).map(imageChar)];
  try { localStorage.setItem(CHARS_KEY, JSON.stringify(metas)); } catch {}
}
try { setCharList(JSON.parse(localStorage.getItem(CHARS_KEY) || '[]')); } catch {}
let charId = 'clawd';
try { const v = localStorage.getItem(CHAR_KEY); if (CHARS.some((c) => c.id === v)) charId = v; } catch {}
const curChar = () => CHARS.find((c) => c.id === charId) || CLAWD;
// <html> 에 지금 캐릭터 종류(올린 그림이면 .char-img)와 자리별 크기 변수를 단다 — style.css 가 이걸로 자리 크기를 정한다
function markChar() {
  const c = curChar(), root = document.documentElement;
  root.dataset.char = c.id;
  root.classList.toggle('char-img', !!c.custom);
  for (const k of ['--ch-card', '--ch-logo', '--ch-mgr']) root.style.removeProperty(k);
  for (const [k, v] of Object.entries(c.sizes?.() || {})) root.style.setProperty(k, v);
}
markChar();
const clawdSVG = (v) => curChar().worker(v);
const managerSVG = (stage) => curChar().manager(stage);
const faviconSVG = (alert) => curChar().favicon(alert);
