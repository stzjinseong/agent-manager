// 업데이트 확인 — 서버가 시작할 때 한 번, 화면의 업데이트 아이콘을 누를 때마다. 알려 주기만 하고 설치는 사용자가 한다.
//  · 클로드 키우기: 릴리즈는 release-N 태그. 지금 코드(HEAD)가 품은 가장 높은 release-N 과, 원격(origin)의 가장 높은 release-N 을 비교
//    (git ls-remote — 로컬 저장소는 바꾸지 않는다). dev 처럼 최신 릴리즈보다 앞선 코드면 새 릴리즈 없음
//  · Claude Code: 설치된 `claude --version` 과 npm 레지스트리의 최신 버전(@anthropic-ai/claude-code)을 비교
//  · Claude Code 릴리즈 노트: 화면에서 노트를 열 때만 GitHub 의 CHANGELOG.md(raw)를 앞부분만 받는다(아래 claudeNotes)
// 외부 접속은 이 세 곳뿐(GitHub 저장소·npm 레지스트리·raw.githubusercontent.com)이고, 실패하면 그 항목만 오류로 둔다
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// ---------- Claude Code 릴리즈 노트 ----------
// 출처: github.com/anthropics/claude-code 의 CHANGELOG.md — 최신 버전이 맨 위, '## x.y.z' 아래 '- 항목' 목록.
// 전체가 1MB 를 넘고(버전 430개, 2026-10 실측) 거의 매일 한 버전씩 붙는다 → Range 로 앞에서부터 128KB 씩 받다가
// 지금 설치된 버전의 머리줄이 나오면 멈춘다(최대 1MB). raw 는 GitHub API 한도(시간당 60회)와 상관없다.
// 받은 결과는 1시간 캐시. 인터넷이 안 되면 Claude Code 가 스스로 받아 둔 ~/.claude/cache/changelog.md 로(설치된 버전까지만 있음)
const CC_LOG = 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';
const CC_LOG_PAGE = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';
const CC_TTL = 60 * 60_000, CC_CHUNK = 128 << 10, CC_MAX_BYTES = 1 << 20, CC_MAX_VERSIONS = 20;
function parseChangelog(text, complete) {
  const out = [];
  const parts = String(text).split(/\n(?=## )/);
  // 끝까지 받지 않았으면 마지막 섹션은 중간에 잘렸을 수 있다 — 버린다
  for (const sec of complete ? parts : parts.slice(0, -1)) {
    const m = sec.match(/^## (\d+\.\d+\.\d+)[^\n]*\n([\s\S]*)$/);
    if (m) out.push({ v: m[1], md: m[2].trim() });
  }
  return out;
}
async function fetchChangelog(stopAt) {
  // 앞에서부터 이어 받는다(받은 데까지는 다시 받지 않음). 글자가 조각 경계에서 잘리지 않게 바이트로 모아 매번 통째로 푼다.
  // 지금 버전을 모르면(stopAt 없음) 첫 조각만 — 최신 몇 버전이면 충분하다
  const bufs = []; let got = 0;
  for (let size = CC_CHUNK; ; size *= 2) {
    const end = Math.min(got + size, CC_MAX_BYTES);
    const r = await fetch(CC_LOG, { headers: { range: `bytes=${got}-${end - 1}`, 'user-agent': 'clawdgotchi' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    const buf = Buffer.from(await r.arrayBuffer());
    if (r.status === 200) { bufs.length = 0; got = 0; } // Range 를 무시하고 통째로 줬다
    bufs.push(buf); got += buf.length;
    const complete = r.status === 200 || buf.length < end - (got - buf.length);
    const secs = parseChangelog(Buffer.concat(bufs).toString('utf8'), complete);
    if (complete || got >= CC_MAX_BYTES || !stopAt || secs.some((x) => !newer(ver(x.v), stopAt))) return secs;
  }
}
function localChangelog() {
  try { return parseChangelog(fs.readFileSync(path.join(os.homedir(), '.claude', 'cache', 'changelog.md'), 'utf8'), true); } catch { return null; }
}
// 설치된 버전 다음 ~ 최신(새 버전이 없으면 지금 버전 하나). 많으면 최신 CC_MAX_VERSIONS 개만 — 나머지는 개수만 알리고 GitHub 링크로
function pickNotes(all, current, latest) {
  const cur = ver(current), lat = ver(latest);
  let list = cur && lat && newer(cur, lat) ? all.filter((x) => newer(cur, ver(x.v)) && !newer(lat, ver(x.v))) : all.filter((x) => x.v === (current || latest));
  if (!list.length) list = all.slice(0, 1);
  return { versions: list.slice(0, CC_MAX_VERSIONS), more: Math.max(0, list.length - CC_MAX_VERSIONS) };
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
  let cc = null; // { at, all } — CHANGELOG 에서 받은 버전들(최신 → 과거)
  async function claudeNotes() {
    const current = state.claude?.current ?? null, latest = state.claude?.latest ?? null;
    let all = cc && Date.now() - cc.at < CC_TTL && (!current || cc.all.some((x) => !newer(ver(x.v), ver(current)))) ? cc.all : null;
    let source = 'github';
    if (!all) {
      try { all = await fetchChangelog(ver(current)); cc = { at: Date.now(), all }; }
      catch { all = localChangelog(); source = 'local'; }
    }
    if (!all?.length) return { error: 'network', url: CC_LOG_PAGE, current, latest };
    return { ...pickNotes(all, current, latest), source, url: CC_LOG_PAGE, current, latest };
  }
  return { check, releases, claudeNotes, public: () => ({ ...state }) };
}
