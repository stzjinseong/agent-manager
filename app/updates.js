// 업데이트 확인 — 서버가 시작할 때 한 번, 화면의 업데이트 아이콘을 누를 때마다. 알려 주기만 하고 설치는 사용자가 한다.
//  · 클로드 키우기: 릴리즈는 release-N 태그. 지금 코드(HEAD)가 품은 가장 높은 release-N 과, 원격(origin)의 가장 높은 release-N 을 비교
//    (git ls-remote — 로컬 저장소는 바꾸지 않는다). dev 처럼 최신 릴리즈보다 앞선 코드면 새 릴리즈 없음
//  · Claude Code: 설치된 `claude --version` 과 npm 레지스트리의 최신 버전(@anthropic-ai/claude-code)을 비교
// 외부 접속은 이 두 곳뿐(GitHub 저장소·npm 레지스트리)이고, 실패하면 그 항목만 오류로 둔다
import { execFile } from 'node:child_process';

// 로그인·암호 물음을 띄우지 않게(서버를 띄운 터미널에 물음이 뜨고 10초를 기다렸다) — 물어야 하면 그냥 실패(network)로 둔다
const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' };
const run = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout: 10_000, windowsHide: true, maxBuffer: 4 << 20, env: NO_PROMPT }, (err, out) => resolve(err ? null : String(out)));
});
const relNum = (tag) => Number(String(tag).match(/release-(\d+)$/)?.[1] ?? NaN);
const maxRelease = (tags) => {
  const nums = tags.map(relNum).filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : null;
};
// "2.1.290 (Claude Code)" → [2,1,290]
const ver = (s) => String(s || '').match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) || null;
const newer = (a, b) => { // b 가 a 보다 높은가
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (b[i] !== a[i]) return b[i] > a[i];
  return false;
};

async function checkApp(root) {
  const local = await run('git', ['tag', '--merged', 'HEAD', '--list', 'release-*'], root);
  if (local == null) return { error: 'git' };
  const remote = await run('git', ['ls-remote', '--tags', '--refs', 'origin', 'release-*'], root);
  if (remote == null) return { current: maxRelease(local.split('\n')), error: 'network' };
  const url = (await run('git', ['remote', 'get-url', 'origin'], root))?.trim().replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/') || null;
  const current = maxRelease(local.split('\n')), latest = maxRelease(remote.split('\n').map((l) => l.split('refs/tags/')[1] || ''));
  const gh = url && /^https:\/\/github\.com\//.test(url) ? url : null;
  // 원격엔 릴리즈가 있는데 이 설치본에서 태그를 못 찾으면(얕은 클론·태그를 안 받은 경우) 지금 버전을 모른다 — '최신'이라 하지 않는다
  if (current == null && latest != null) return { latest, url: gh, error: 'version' };
  return { current, latest, newer: current != null && latest != null && latest > current, url: gh };
}

async function checkClaude(bin) {
  const installed = ver(await run(bin, ['--version']));
  let latest = null;
  try {
    const r = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-code/latest', { signal: AbortSignal.timeout(8000) });
    if (r.ok) latest = ver((await r.json()).version);
  } catch {}
  if (!installed) return { latest: latest?.join('.') ?? null, error: 'claude' };
  if (!latest) return { current: installed.join('.'), error: 'network' };
  return { current: installed.join('.'), latest: latest.join('.'), newer: newer(installed, latest) };
}

// 릴리즈 노트 전체 — 화면의 '릴리즈 노트 보기'를 누를 때만. GitHub 이 마크다운을 HTML 로 바꿔 준 본문(body_html)을 받는다
// (화면이 허용한 태그만 남겨 넣는다). 인증 없는 GitHub API 는 시간당 60회라 10분 캐시하고, 실패는 캐시하지 않는다
const REL_TTL = 10 * 60_000;
async function fetchReleases(root) {
  const url = (await run('git', ['remote', 'get-url', 'origin'], root))?.trim().replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/') || null;
  const m = url?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (!m) return { error: 'git', url: null };
  try {
    const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/releases?per_page=100`, {
      headers: { accept: 'application/vnd.github.html+json', 'user-agent': 'clawdgotchi' }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return { error: r.status === 403 || r.status === 429 ? 'limit' : 'network', url };
    const releases = (await r.json()).filter((x) => !x.draft).map((x) => ({
      tag: x.tag_name, name: x.name || x.tag_name, at: x.published_at, html: x.body_html || '', pre: !!x.prerelease, link: x.html_url,
    }));
    // 최신 → 과거. release-N 이면 번호로, 아니면 날짜로
    releases.sort((a, b) => (relNum(b.tag) - relNum(a.tag)) || String(b.at).localeCompare(String(a.at)));
    return { url, releases };
  } catch { return { error: 'network', url }; }
}

export function createUpdates({ root, claudeBin, onChange }) {
  const state = { checking: false, checkedAt: null, app: null, claude: null };
  let running = null;
  async function check() {
    if (running) return running;
    state.checking = true; onChange();
    running = Promise.all([checkApp(root), checkClaude(claudeBin)]).then(([app, claude]) => {
      Object.assign(state, { app, claude, checkedAt: Date.now(), checking: false });
    }).catch(() => { state.checking = false; }).finally(() => { running = null; onChange(); });
    return running;
  }
  let rel = null; // { at, data }
  async function releases() {
    if (!rel || Date.now() - rel.at > REL_TTL) {
      const data = await fetchReleases(root);
      if (data.error) return { ...data, current: state.app?.current ?? null };
      rel = { at: Date.now(), data };
    }
    return { ...rel.data, current: state.app?.current ?? null, latest: state.app?.latest ?? null };
  }
  return { check, releases, public: () => ({ ...state }) };
}
