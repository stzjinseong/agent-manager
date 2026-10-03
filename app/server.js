// 관제탑 P0 — 로컬 전용 Claude Code 세션 매니저
// 관제탑이 PTY 로 claude CLI 를 직접 띄우고, 세션별 --settings 로 주입한 command 훅이
// 상태 이벤트를 이 서버로 보낸다. 권한 요청(PermissionRequest)은 기본으로 터미널 선택창에 맡기고,
// AM_REMOTE_DECISIONS=1 이면 대시보드의 결정이 나올 때까지 훅 응답을 붙잡아 두는 방식으로 원격 승인한다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync, execFile, spawn as spawnProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { createProfile, readProfile, profileSummary, runningSubagents } from './profile.js';
import { createProgress, isCommit } from './progress.js';
const { Terminal: HeadlessTerminal } = createRequire(import.meta.url)('@xterm/headless');

const APP_DIR = path.dirname(fileURLToPath(import.meta.url)); // app/ — 코드
const ROOT = path.dirname(APP_DIR); // 프로젝트 최상위 — data/, node_modules/, 실행 파일
const PORT = Number(process.env.AM_PORT || 7788);
const HOST = '127.0.0.1'; // 외부 노출 금지 — 이 PC 에서만 접속
const DATA_DIR = process.env.AM_DATA || path.join(ROOT, 'data');
const DECISION_HOLD_MS = 590_000; // 훅 timeout(600s) 직전에 놓아 터미널 프롬프트로 폴백
// 권한 요청을 대시보드(페이지 상단 결정함)에서 허용/거부할지. 끄면 터미널 선택창에서 고르고 카드엔 '결정 대기'만 보인다
const REMOTE_DECISIONS = process.env.AM_REMOTE_DECISIONS === '1';
fs.mkdirSync(DATA_DIR, { recursive: true });

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// macOS 에서 Finder(.app)로 띄우면 PATH 가 /usr/bin:/bin 정도뿐이라 claude·node 를 못 찾는다.
// 흔한 설치 위치와 지금 node 의 위치를 PATH 에 보탠다 — 워커(claude)도 이 PATH 를 물려받는다.
if (!IS_WIN) {
  const home = process.env.HOME || '';
  const extra = [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.volta/bin`, `${home}/.bun/bin`];
  const cur = (process.env.PATH || '').split(':');
  process.env.PATH = [...cur, ...extra.filter((p) => p && !cur.includes(p) && fs.existsSync(p))].join(':');
}

const CLAUDE_BIN = resolveClaude();

/** @type {Map<string, any>} */
const workers = new Map();
/** @type {Map<string, any>} 대기 중인 결정: id → { workerId, kind, tool, input, res, timer, createdAt } */
const decisions = new Map();
let seq = 0;
let decisionSeq = 0;

// ---------- 저장된 역할 · 최근 경로 ----------

const CONFIG_PATH = path.join(DATA_DIR, 'profiles.json');
// 매니저 클로드 성장 — 작업 완료 시 그 작업에서 쌓인 점수를 지급 (progress.js). 단계가 오르면 화면에 연출 신호
const progress = createProgress(DATA_DIR, {
  onStageUp: (stage) => broadcast({ type: 'fx', kind: 'stage', stage }),
  onStageDown: (stage) => broadcast({ type: 'fx', kind: 'stage', stage, down: true }),
});
// 경험치 변화 연출: 얻으면 워커 카드에서 매니저로 날아가고, 잃으면 매니저 위에 빨갛게. reason·detail 은 문구용
function award(w, xp, reason, detail) {
  if (xp) broadcast({ type: 'fx', kind: 'xp', id: w.id, xp, reason, detail });
  return xp;
}
// 작업 완료 → 경험치 지급
function payout(w) { award(w, progress.payout(w)); }
// 턴이 끝나면(Stop) 트랜스크립트를 마저 읽고 그 턴의 캐시 적중률로 보너스·감점 (progress.cache)
// 캐시가 빌 수밖에 없는 턴은 뺀다: 세션 첫 턴, 압축 직후, 입력이 작은 턴(2만 토큰 미만)·도구 호출 없는 턴
function judgeCache(w) {
  const tx = w.tx;
  if (!tx) return;
  try { readProfile(tx); } catch { return; }
  const t = tx.turns.at(-1);
  const key = t && `${tx.path}#${t.n}`;
  if (!t || w.cacheJudged === key) return;
  w.cacheJudged = key;
  const all = t.input + t.cacheWrite + t.cacheRead;
  if (!t.hasPrev || !t.calls || all < 20_000) return;
  const prevEnd = tx.turns.at(-2)?.end ?? 0;
  if (tx.compactLog.some((c) => c.ts > prevEnd && c.ts <= t.end + 1000)) return;
  const hit = t.cacheRead / all;
  if (award(w, progress.cache(hit), 'cache', Math.round(hit * 100))) emitState();
}
setInterval(() => progress.sample(workers.values()), progress.SAMPLE_MS);
const config = loadConfig();

// ---------- 계정 사용량 (구독 5시간·주간 한도) ----------
// 워커의 상태줄 명령(statusline.mjs)이 Claude Code 가 준 rate_limits 를 보낸다. 계정 단위라 어느 워커에서 오든 같은 값 —
// 가장 최근 것만 들고 화면 상단에 보인다. 재시작해도 남게 data/usage.json 에 둔다
const USAGE_PATH = path.join(DATA_DIR, 'usage.json');
let usage = (() => { try { return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8')); } catch { return null; } })();
function onStatusLine(body) {
  const rl = body?.rate_limits;
  if (!rl || typeof rl !== 'object') return;
  const pick = (x) => (x && Number.isFinite(x.used_percentage) ? { pct: x.used_percentage, resetsAt: Number.isFinite(x.resets_at) ? x.resets_at * 1000 : null } : null);
  const next = { fiveHour: pick(rl.five_hour), sevenDay: pick(rl.seven_day), at: Date.now() };
  if (!next.fiveHour && !next.sevenDay) return;
  const changed = JSON.stringify([next.fiveHour, next.sevenDay]) !== JSON.stringify([usage?.fiveHour, usage?.sevenDay]);
  usage = next;
  if (!changed) return;
  try { fs.writeFileSync(USAGE_PATH, JSON.stringify(usage)); } catch {}
  emitState();
}

function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { profiles: c.profiles || [], recentCwds: c.recentCwds || [], order: c.order || [], memos: c.memos || {}, colors: c.colors || {} };
  } catch { return { profiles: [], recentCwds: [], order: [], memos: {}, colors: {} }; }
}

function saveConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  emitState();
}

function rememberCwd(cwd) {
  config.recentCwds = [cwd, ...config.recentCwds.filter((c) => c.toLowerCase() !== cwd.toLowerCase())].slice(0, 12);
  saveConfig();
}

function upsertProfile(p) {
  const profile = { name: String(p.name || '').trim(), cwd: p.cwd || '', permissionMode: p.permissionMode || 'default', args: p.args || '' };
  if (!profile.name) return;
  config.profiles = [...config.profiles.filter((x) => x.name !== profile.name), profile];
  saveConfig();
}

// 역할 이름 변경 — 워커 이름·저장된 역할·칩 순서를 함께 바꿔 슬롯과 워커의 연결이 끊기지 않게 한다
function renameRole(from, to, worker) {
  to = String(to || '').trim().slice(0, 40);
  if (!to) return { error: '이름이 비어 있습니다' };
  if (to === from) return { ok: true };
  const taken = config.profiles.some((x) => x.name === to) ||
    [...workers.values()].some((x) => x !== worker && x.status !== 'exited' && x.name === to);
  if (taken) return { error: `"${to}" 은(는) 이미 쓰는 이름입니다` };
  if (worker) { worker.name = to; pushLog(worker, 'status', `이름 변경: ${from} → ${to}`); }
  config.profiles = config.profiles.map((x) => (x.name === from ? { ...x, name: to } : x));
  config.order = (config.order || []).map((x) => (x === from ? to : x));
  if (config.colors?.[from] != null && config.colors[to] == null) { config.colors[to] = config.colors[from]; delete config.colors[from]; }
  if (config.memos?.[from]) { config.memos[to] = [...(config.memos[to] || []), ...config.memos[from]]; delete config.memos[from]; }
  saveConfig(); // emitState 포함
  return { ok: true };
}

// Windows 폴더 선택 창 — 서버가 이 PC 에서 돌기 때문에 가능한 방식
function pickFolder(start) {
  if (IS_MAC) {
    // macOS: AppleScript 폴더 선택 창 (취소하면 osascript 가 오류로 끝나 null)
    const def = start && fs.existsSync(start) ? ` default location (POSIX file "${String(start).replace(/"/g, '\\"')}")` : '';
    const script = `POSIX path of (choose folder with prompt "워커 작업 폴더 선택"${def})`;
    return new Promise((resolve) => {
      execFile('osascript', ['-e', script], { encoding: 'utf8' }, (err, out) => resolve(err ? null : out.trim().replace(/\/$/, '') || null));
    });
  }
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$f=New-Object System.Windows.Forms.FolderBrowserDialog',
    '$f.Description="워커 작업 폴더 선택"',
    start ? `$f.SelectedPath='${String(start).replace(/'/g, "''")}'` : '',
    '$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true}',
    'if($f.ShowDialog($o) -eq "OK"){ $f.SelectedPath }',
  ].filter(Boolean).join(';');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8', windowsHide: true }, (err, out) => resolve(err ? null : out.trim() || null));
  });
}

function resolveClaude() {
  if (process.env.AM_CLAUDE) return process.env.AM_CLAUDE;
  if (!IS_WIN) {
    // macOS/Linux: PATH 의 claude (npm 전역 설치든 네이티브 설치든 실행 파일/심볼릭 링크를 그대로 실행)
    try { return execSync('command -v claude', { encoding: 'utf8', shell: '/bin/sh' }).trim() || 'claude'; } catch { return 'claude'; }
  }
  try {
    // Windows: npm 의 claude.cmd 셔임 대신 그 뒤의 claude.exe 를 직접 띄운다(cmd 한 겹 없이)
    const shim = execSync('where claude.cmd', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    const exe = path.join(path.dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(exe)) return exe;
  } catch {}
  return 'claude.exe';
}

// ---------- 워커 ----------

function hookSettings() {
  // http 타입 훅은 이 환경에서 서버에 도달하지 않아(실측) command 훅 + 전달 스크립트로 보낸다.
  // 워커 식별은 hook.mjs 가 상속받는 AGENT_MANAGER_WORKER 환경변수로 한다.
  // node 는 PATH 대신 지금 서버를 돌리는 node 의 절대 경로로 — macOS 에서 .app 으로 띄우면 PATH 에
  // Homebrew 경로가 없어 'node' 를 못 찾는다. 슬래시로 통일해 Git Bash/cmd/sh 어디서 실행돼도 같게.
  const slash = (p) => p.replace(/\\/g, '/');
  const command = `"${slash(process.execPath)}" "${slash(path.join(APP_DIR, 'hook.mjs'))}"`;
  const h = (timeout = 10) => [{ type: 'command', command, timeout }];
  const events = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd', 'SubagentStop'];
  const hooks = Object.fromEntries(events.map((e) => [e, [{ hooks: h() }]]));
  hooks.PreToolUse = [{ matcher: '*', hooks: h() }];
  hooks.PostToolUse = [{ matcher: '*', hooks: h() }];
  hooks.PermissionRequest = [{ matcher: '*', hooks: h(600) }];
  // 상태줄 명령으로 계정 사용량(5시간·주간 한도)을 받는다 — 사용자가 원래 쓰던 상태줄은 statusline.mjs 가 대신 실행해 그대로 보인다
  const statusLine = { type: 'command', command: `"${slash(process.execPath)}" "${slash(path.join(APP_DIR, 'statusline.mjs'))}"` };
  const theme = workerTheme();
  return theme ? { hooks, statusLine, theme } : { hooks, statusLine };
}

// 워커 터미널은 검정 배경이라, 전역 Claude 테마가 라이트 계열이면 짝이 맞는 다크 테마로 띄운다.
// 라이트 테마는 본문을 검정에 가깝게 그려 질문 창 문구 등이 배경에 묻혔다(실측: ~/.claude/settings.json theme=light-daltonized).
// --settings 의 theme 은 그 세션에만 적용된다(실측: 환영 화면 색이 다크 팔레트로 바뀜) — 평소 터미널 설정은 그대로.
// 테마는 사용자 설정(~/.claude/settings.json)에 있고, 예전 버전은 전역 설정(~/.claude.json)에 두었다
function workerTheme() {
  for (const f of [path.join(CLAUDE_HOME, 'settings.json'), path.join(os.homedir(), '.claude.json')]) {
    try {
      const t = JSON.parse(fs.readFileSync(f, 'utf8')).theme;
      if (typeof t === 'string') return t.startsWith('light') ? t.replace(/^light/, 'dark') : null;
    } catch {}
  }
  return null;
}

// 사용자가 중단(Esc)하면 Stop 훅이 오지 않아 '작업 중'으로 남는다. 트랜스크립트의 중단 기록이
// 이번 턴 시작 이후면 '중단됨'으로 바꾼다. 큐에 쌓인 지시는 자동 투입하지 않는다(사용자가 멈춘 것이므로).
function checkInterrupted(w) {
  if (w.status !== 'working' && w.status !== 'decision') return;
  // Stop 훅을 놓친 경우(서버가 꺼져 있던 사이 턴이 끝남 등) 트랜스크립트로 바로잡는다:
  // 마지막 기록이 정상 종료된 응답이고 5초 넘게 새 기록이 없으면 완료
  const tx = w.tx;
  if (w.status === 'working' && tx?.lastKind === 'assistant' && tx.lastStop === 'end_turn' && Date.now() - tx.lastTs > 5000 && !tx.seg) {
    if (tx.lastText) w.lastMessage = tx.lastText.slice(0, 2000);
    w.currentTool = null;
    w.doneAt = Date.now(); // 화면의 '확인 안 한 완료' 표시 기준
    payout(w);
    setStatus(w, 'done', '턴 완료 (기록으로 확인)');
    if (w.queue.length) setTimeout(() => dispatchQueued(w), 400);
    return;
  }
  const at = w.tx?.interruptedAt;
  if (!at || at < (w.turnStartedAt || 0) - 500) return;
  w.currentTool = null;
  for (const [did, d] of decisions) if (d.workerId === w.id) resolveDecision(did, null);
  progress.drop(w); // 중단된 작업은 점수 없음
  setStatus(w, 'interrupted', '사용자 중단');
}

// 서버 코드가 켜진 뒤 바뀌었는지 — 화면은 새로고침마다 새 코드를 받지만 서버는 재시작해야 바뀐다.
// 어긋나면 새 화면이 모르는 API 를 부르다 404 가 나므로, 화면에 "서버 재시작 필요"를 띄우게 알려 준다
const SERVER_FILES = ['server.js', 'profile.js', 'pricing.js', 'progress.js'].map((f) => path.join(APP_DIR, f));
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const BOOT_MTIMES = SERVER_FILES.map(mtimeOf);
let staleCache = { at: 0, value: false };
function serverStale() {
  if (Date.now() - staleCache.at > 5000) staleCache = { at: Date.now(), value: SERVER_FILES.some((f, i) => mtimeOf(f) > BOOT_MTIMES[i]) };
  return staleCache.value;
}

// 워커 이벤트가 없어도 띠가 뜨도록, 바뀐 순간 상태를 한 번 밀어 준다
setInterval(() => { const prev = staleCache.value; staleCache.at = 0; if (serverStale() !== prev) emitState(); }, 5000);

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

// 역할별 캐릭터 색(OKLCH 색상각). 이미 쓰는 색들과 색상 차이가 가장 큰 쪽을 골라 약간 무작위로 흔든다 —
// 워커끼리 잘 구분되면서 무작위처럼 보이게. 밝기·채도는 화면에서 고정(oklch L 0.76, C 0.15)이라 어둡지 않다.
function ensureRoleColor(name) {
  config.colors ||= {};
  if (!name || config.colors[name] != null) return;
  const used = Object.values(config.colors);
  const dist = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  let best = Math.floor(Math.random() * 360), bestGap = -1;
  for (let i = 0; i < 72; i++) {
    const h = (i * 5 + Math.random() * 5) % 360;
    const gap = used.length ? Math.min(...used.map((u) => dist(h, u))) : 180 + Math.random();
    if (gap > bestGap) { best = h; bestGap = gap; }
  }
  config.colors[name] = Math.round(best);
  saveConfig();
}

function spawnWorker({ name, cwd, args = '', permissionMode = 'default' }) {
  let id;
  do id = `W${++seq}`; while (workers.has(id)); // 복원된 워커·호스트 터미널과 id 가 겹치면 안 된다
  cwd = cwd && fs.existsSync(cwd) ? cwd : ROOT;
  fs.mkdirSync(DATA_DIR, { recursive: true }); // 실행 중에 data 폴더를 지워도 죽지 않게
  const settingsPath = path.join(DATA_DIR, `${id}.settings.json`);
  fs.writeFileSync(settingsPath, JSON.stringify(hookSettings(), null, 2));

  const env = { ...process.env, AGENT_MANAGER_WORKER: id, AGENT_MANAGER_PORT: String(PORT) };
  // 관제탑이 Claude 세션 안에서 실행된 경우 중첩 세션 표식이 새지 않게 한다
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT)$/.test(k)) delete env[k];
  // Claude Code 가 전체 화면 모드(대체 화면 ESC[?1049h)로 뜨면 터미널 기록(스크롤백)이 화면 한 장뿐이라
  // 타임라인 요청 → 터미널 위치 이동, 지난 대화 스크롤이 안 된다(실측 v2.1.288 macOS 기본값). 일반 모드로 띄운다
  env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';
  // macOS 에서 Finder 로 연 Launch.app 은 로케일 환경변수 없이 뜬다. 그대로 두면 워커 CLI 가 UTF-8 이 아닌
  // 로케일로 돈다 — Mac 에서 한글 완성 음절(가)만 안 보이던 문제(단독 자모 ㄱ·ㅏ 는 보임)의 유력 원인. 터미널이 주던 값과 맞춘다
  if (process.platform === 'darwin' && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8';

  const extra = args.trim() ? args.trim().split(/\s+/) : [];
  // 전역 설정이 bypassPermissions 여도 워커는 지정한 모드로 띄운다 — 그래야 권한 요청이 관제탑에 '결정 대기'로 보인다
  if (!PERMISSION_MODES.includes(permissionMode)) permissionMode = 'default';
  // 터미널은 PTY 호스트가 띄우고 붙잡는다 — 이 서버를 재시작해도 워커는 살아 있다
  hostSend({ op: 'spawn', id, file: CLAUDE_BIN, args: ['--settings', settingsPath, '--permission-mode', permissionMode, ...extra], cwd, env, cols: 120, rows: 34 });
  const term = hostTerm(id);

  const w = {
    id, name: name || id, cwd, args, permissionMode, pid: term.pid,
    status: 'starting', // starting | idle | working | decision | done | exited
    sessionId: null, model: null,
    currentTool: null, subTool: null, lastPrompt: null, lastMessage: null, notice: null,
    todos: [], queue: [], toolCount: 0, shots: [],
    startedAt: Date.now(), turnStartedAt: null, updatedAt: Date.now(),
    log: [], // 최근 이벤트 타임라인
    tx: null, // 트랜스크립트 프로파일러 상태 (profile.js)
    approvalWaits: [], // 결정함을 거친 권한 승인 대기 시간 [{ toolUseId, ms }] — 트랜스크립트엔 없어서 서버가 기록
    term,
  };
  workers.set(id, w);
  pushLog(w, 'spawn', `claude 실행 · ${permissionMode}${extra.length ? ` · ${extra.join(' ')}` : ''}`);
  ensureRoleColor(w.name);
  rememberCwd(cwd);
  return w;
}

function pushLog(w, kind, text) {
  w.log.push({ t: Date.now(), kind, text: String(text ?? '').slice(0, 300) });
  if (w.log.length > 200) w.log.shift();
}

function setStatus(w, status, note) {
  w.status = status;
  w.updatedAt = Date.now();
  if (note) pushLog(w, 'status', `${status}: ${note}`);
  emitState();
}

// 업무 지시: 입력 대기 상태면 즉시, 아니면 큐에 쌓았다가 Stop 시점에 투입.
// CLI 입력창에 사람이 쓰던 글이 있으면 그 뒤에 붙어 한 요청으로 나가 버리므로, 그때도 큐에 넣고 입력창이 빌 때까지 기다린다.
// 입력창이 아닌 화면(/resume·/model 선택창, ! 셸 모드 등)이면 지시가 검색칸·셸 명령으로 들어가 버리므로 그때도 기다린다
const isIdle = (w) => w.status === 'idle' || w.status === 'done' || w.status === 'interrupted';
async function assignTask(w, text) {
  text = String(text || '').trim();
  if (!text) return {};
  if (isIdle(w) && w.queue.length) {
    // 쉬는 중인데 대기열이 남아 있으면(중단됨·투입 실패로 보류) 새 지시를 뒤에 붙이고 맨 앞부터 이어서 투입
    w.queueHeld = false;
    w.queue.push(text); pushLog(w, 'queue', text); emitState();
    dispatchQueued(w);
    return {};
  }
  if (isIdle(w)) {
    w.queueHeld = false;
    const cli = await cliDraft(w);
    if (isIdle(w) && !w.queue.length && cli.state === 'empty') { sendPrompt(w, text); return {}; }
    if (isIdle(w) && cli.state !== 'empty') { w.queue.push(text); pushLog(w, 'queue', text); holdForDraft(w, cli.state); emitState(); return { held: true }; }
  }
  w.queue.push(text); pushLog(w, 'queue', text); emitState();
  return {};
}
// 큐 맨 앞 지시를 투입 — 턴이 끝났을 때. 입력창에 쓰던 글이 있거나 입력창이 아닌 화면이면 기다린다.
// 투입 실패로 보류된 대기열(queueHeld)은 새 지시나 ▶ 재개가 있을 때까지 자동으로 보내지 않는다(실제로는 들어갔을 수도 있어 중복 위험)
async function dispatchQueued(w) {
  if (!w.queue.length || !isIdle(w) || w.queueHeld) return;
  const cli = await cliDraft(w);
  if (cli.state !== 'empty') { holdForDraft(w, cli.state); emitState(); return; }
  if (!w.queue.length || !isIdle(w) || w.queueHeld) return;
  sendPrompt(w, w.queue.shift());
}
// 입력창이 빌 때까지 1.5초마다 다시 본다. 사람이 그 글을 보내 턴이 시작되면 그만 — 그 턴이 끝날 때(Stop) 큐가 이어진다.
// 타이머는 워커 객체 밖에 둔다 — 워커는 화면 상태·workers.json 으로 JSON 직렬화된다(Timeout 은 순환 참조라 서버가 죽었다)
const draftTimers = new Map(); // 워커 id → setInterval
function holdForDraft(w, state) {
  if (draftTimers.has(w.id)) return;
  pushLog(w, 'notice', state === 'blocked'
    ? 'CLI 가 입력 대기 화면이 아니어서(/resume 같은 선택창, ! 셸 모드 등) 업무 지시를 대기열에 두었습니다 — 입력창으로 돌아오면 이어서 투입'
    : 'CLI 입력창에 쓰던 글이 있어 업무 지시를 대기열에 두었습니다 — 그 글을 보내거나 지우면 이어서 투입');
  const stop = () => { clearInterval(draftTimers.get(w.id)); draftTimers.delete(w.id); };
  let busy = false; // 화면 읽기가 주기보다 오래 걸려도 두 번 투입하지 않게
  draftTimers.set(w.id, setInterval(async () => {
    if (busy) return;
    if (!workers.has(w.id) || !w.queue.length || !isIdle(w) || w.queueHeld) { stop(); return; }
    busy = true;
    const cli = await cliDraft(w);
    busy = false;
    if (cli.state !== 'empty' || !draftTimers.has(w.id)) return;
    stop();
    if (w.queue.length && isIdle(w) && !w.queueHeld) sendPrompt(w, w.queue.shift());
  }, 1500));
}
// 호스트 원본 화면에서 Claude 입력창(❯ 줄, 위아래 가로선 사이)을 찾아 상태를 본다.
//   empty   — 입력창이 비어 있음(바로 투입해도 됨). 화면을 못 읽으면(호스트 끊김 등) 예전처럼 empty 로 본다
//   draft   — 사람이 쓰던 글이 있음(text)
//   blocked — 화면 맨 아래에 ❯ 입력창이 없음: /resume·/model 같은 선택창, ! 셸 모드 등
// 비어 있을 때 보이는 안내 문구(Try "…")는 흐린 색이라 빼고, 기본 글자색 칸만 센다
function hostSnapshot(id, ms = 1500) {
  return new Promise((resolve) => {
    if (host?.readyState !== 1) return resolve(null);
    const req = ++snapSeq;
    const timer = setTimeout(() => { snapWaiters.delete(req); resolve(null); }, ms);
    snapWaiters.set(req, (msg) => { clearTimeout(timer); resolve(msg); });
    hostSend({ op: 'snapshot', id, req });
  });
}
// 입력창 아래에는 상태 줄 몇 줄(권한 모드, statusLine)만 온다. 그보다 위에 있는 가로선 쌍은 지난 화면의 흔적으로 본다
const BELOW_BOX_MAX = 8;
async function cliDraft(w) {
  const snap = await hostSnapshot(w.id);
  if (!snap?.data || !snap.cols) return { state: 'empty', text: '' };
  const t = new HeadlessTerminal({ cols: snap.cols, rows: snap.rows, scrollback: 0, allowProposedApi: true });
  try {
    await new Promise((r) => t.write(snap.data, r));
    const b = t.buffer.active, rows = [];
    for (let i = b.baseY; i < b.length; i++) rows.push(b.getLine(i));
    let last = rows.length - 1;
    while (last >= 0 && !rows[last].translateToString(true).trim()) last--;
    // 세션에 이름이 있으면 위쪽 선 끝에 이름이 붙는다("────── 메인 ─") — 선으로 시작하기만 하면 가로선으로 본다
    const rule = rows.map((l, i) => (/^\s*─{20,}/.test(l.translateToString(true)) ? i : -1)).filter((i) => i >= 0);
    for (let k = rule.length - 1; k > 0; k--) {
      const top = rule[k - 1], bottom = rule[k];
      if (bottom - top < 2) continue;
      if (last - bottom > BELOW_BOX_MAX) break;
      const first = rows[top + 1].translateToString(true);
      const at = first.indexOf('❯');
      // 입력창 자리인데 ❯ 가 아니면(! 셸 모드 등) 지시를 넣으면 안 되는 상태
      if (at < 0 || first.slice(0, at).trim()) return { state: 'blocked', text: first.trim() };
      let text = '';
      for (let i = top + 1; i < bottom; i++) {
        const line = rows[i];
        for (let x = i === top + 1 ? at + 1 : 0; x < line.length; x++) {
          const c = line.getCell(x);
          if (c && c.getChars().trim() && c.isFgDefault() && !c.isDim()) text += c.getChars();
        }
      }
      text = text.trim();
      // 턴이 돌고 있다는 표시: 입력창 아래 상태줄의 'esc to interrupt', 또는 입력창 바로 위 진행 줄("· Nebulizing…").
      // 끝나면 둘 다 사라지고 "✻ Baked for 6s · done …" 이 남는다(실측 v2.1.288)
      const line = (i) => (i >= 0 && i < rows.length ? rows[i].translateToString(true) : '');
      let busy = false;
      for (let i = bottom + 1; i <= last; i++) if (/esc to interrupt/i.test(line(i))) busy = true;
      for (let i = top - 1; i >= Math.max(0, top - 2); i--) if (/^\s*\S\s+\S.*…/.test(line(i))) busy = true;
      return { state: text ? 'draft' : 'empty', text, busy };
    }
    return { state: 'blocked', text: '' };
  } catch { return { state: 'empty', text: '' }; } finally { t.dispose(); }
}

// ---------- '작업 중'에 갇힌 워커 바로잡기 ----------
// 응답이 오기 전에 Esc 로 취소하면 Claude Code 는 그 요청을 대화에서 지우고 글을 입력창에 되돌린다 — Stop 훅도,
// 트랜스크립트의 중단 기록도 남지 않아 '작업 중'에서 영영 안 풀리고 대기열도 멈췄다(실측 v2.1.288).
// 작업 중인데 화면에 턴 표시가 연달아 없고 기록도 조용하면 입력 대기로 바로잡고 대기열을 잇는다.
// 되돌아온 글이 입력창에 남아 있으면 dispatchQueued 가 그 글이 빌 때까지 기다리므로 섞이지 않는다
const STUCK_CHECK_MS = 4000, STUCK_QUIET_MS = 10_000, STUCK_MISSES = 2;
const stuckMisses = new Map(); // 워커 id → 연속으로 턴 표시가 없던 횟수
let stuckBusy = false;
setInterval(async () => {
  if (stuckBusy) return;
  stuckBusy = true;
  try {
    for (const w of workers.values()) {
      if (w.status !== 'working' || w.sentPrompt) { stuckMisses.delete(w.id); continue; }
      const quietSince = Math.max(w.turnStartedAt || 0, w.updatedAt || 0, w.tx?.lastTs || 0);
      if (Date.now() - quietSince < STUCK_QUIET_MS) { stuckMisses.delete(w.id); continue; }
      const cli = await cliDraft(w);
      if (w.status !== 'working') continue;
      // 화면을 못 읽었거나(busy 없음) 입력창이 아닌 화면(선택창 등)이면 판단하지 않는다
      if (cli.busy !== false) { stuckMisses.delete(w.id); continue; }
      const n = (stuckMisses.get(w.id) || 0) + 1;
      stuckMisses.set(w.id, n);
      if (n < STUCK_MISSES) continue;
      stuckMisses.delete(w.id);
      w.currentTool = null;
      setStatus(w, 'idle', '작업 표시가 없어 입력 대기로 바로잡음 (응답 전에 취소된 것으로 보임)');
      if (w.queue.length) setTimeout(() => dispatchQueued(w), 400);
    }
  } finally { stuckBusy = false; }
}, STUCK_CHECK_MS);

// 투입 확인: 보낸 뒤 이 시간 안에 UserPromptSubmit 훅도, 트랜스크립트 새 기록도 없으면 들어가지 않은 것으로 본다
const PROMPT_CONFIRM_MS = 8000;
const confirmTimers = new Map(); // 워커 id → setTimeout (draftTimers 와 같은 이유로 워커 밖에 둔다)
function sendPrompt(w, text) {
  // bracketed paste 로 넣어야 여러 줄 지시가 줄마다 전송되지 않는다
  w.term.write(`\x1b[200~${text}\x1b[201~`);
  setTimeout(() => w.term.write('\r'), 120);
  // UserPromptSubmit 훅이 오기 전에 다음 지시가 들어오면 바로 투입돼 버리므로 선제적으로 작업 중 처리
  w.status = 'working';
  w.turnStartedAt = Date.now();
  w.sentPrompt = { text, at: w.turnStartedAt }; // UserPromptSubmit 이 오면 지운다
  pushLog(w, 'assign', text);
  emitState();
  clearTimeout(confirmTimers.get(w.id));
  confirmTimers.set(w.id, setTimeout(() => confirmPrompt(w, w.turnStartedAt), PROMPT_CONFIRM_MS));
}
// 들어가지 않았으면(훅이 안 옴) '작업 중'에 영영 갇히고 뒤 대기열도 멈춘다 → 상태를 되돌리고 알린다.
// 다시 보내지는 않는다 — 훅만 놓치고 실제로는 들어갔을 수도 있어서. 지시는 대기열 맨 앞에 보류해 두고 사람이 재개한다
async function confirmPrompt(w, at) {
  confirmTimers.delete(w.id);
  const sent = w.sentPrompt;
  if (!workers.has(w.id) || !sent || sent.at !== at) return;
  if (w.status !== 'working') { w.sentPrompt = null; return; } // 다른 훅(권한 요청·Stop 등)이 왔다 = 들어갔다
  if (w.tx) { try { readProfile(w.tx); } catch {} }
  if (w.tx && w.tx.lastTs >= at) { w.sentPrompt = null; return; } // 트랜스크립트가 움직였다 = 들어갔다
  const cli = await cliDraft(w);
  if (w.sentPrompt !== sent || w.status !== 'working') return;
  w.sentPrompt = null;
  if (cli.state === 'draft' && cli.text.replace(/\s+/g, '').includes(sent.text.replace(/\s+/g, '').slice(0, 20))) {
    // Enter 만 먹히지 않아 지시가 입력창에 그대로 있다 — 그 글이 곧 '쓰던 글'이니 사람이 보내거나 지우면 된다
    setStatus(w, 'idle', '업무 지시가 CLI 입력창에 남아 있음 — Enter 로 보내거나 지우세요');
    return;
  }
  w.queue.unshift(sent.text);
  w.queueHeld = true;
  pushLog(w, 'notice', `업무 지시가 CLI 에 들어가지 않은 것 같습니다${cli.state === 'blocked' ? '(입력 대기 화면이 아님)' : ''} — 대기열 맨 앞에 보류했습니다. 터미널을 확인하고 ▶ 재개하거나 새 지시를 보내세요`);
  setStatus(w, 'idle', '업무 지시 투입 실패');
}

function summarizeTool(name, input = {}) {
  const pick = input.command || input.file_path || input.pattern || input.url || input.description || input.prompt || '';
  return `${name}${pick ? ` · ${String(pick).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
}

// ---------- 훅 수신 ----------

function onHook(w, ev, res) {
  const name = ev.hook_event_name;
  const reply = (obj = {}) => { if (!res.writableEnded) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); } };
  if (ev.session_id) w.sessionId = ev.session_id;
  const prevTx = w.tx; // /clear 직전 세션 — 그 세션의 컨텍스트 크기로 /clear 경험치를 정한다
  if (ev.transcript_path) {
    if (!w.tx || w.tx.path !== ev.transcript_path) w.tx = createProfile(ev.transcript_path);
    scheduleProfile(w);
  }

  switch (name) {
    case 'SessionStart':
      w.model = ev.model || w.model;
      if (ev.source === 'clear') {
        w.todos = [];
        // 새 세션이니 타임라인(로그·캡처·결과물)도 비운다
        w.log = [];
        for (const s of w.shots || []) fs.rmSync(path.join(SHOT_DIR, w.id, s.name), { force: true });
        w.shots = []; w.docs = [];
        // 터미널의 이전 대화 기록(스크롤백)도 지운다 — 호스트 원본 화면과 브라우저 터미널 둘 다.
        // Claude 가 새 화면을 그릴 틈을 조금 준 뒤에(화면 자체는 건드리지 않고 기록만 지운다)
        setTimeout(() => { hostSend({ op: 'clearScrollback', id: w.id }); broadcast({ type: 'clearScrollback', id: w.id }); }, 300);
        if (prevTx) { try { readProfile(prevTx); } catch {} }
        award(w, progress.clear(w, prevTx?.context), 'clear');
      }
      setStatus(w, 'idle', `세션 시작 (${ev.source || 'startup'})`);
      break;
    case 'UserPromptSubmit':
      w.lastPrompt = ev.prompt ?? ev.prompt_text ?? w.lastPrompt;
      w.turnStartedAt = Date.now();
      w.notice = null;
      w.sentPrompt = null; // 투입 확인
      progress.open(w);
      setStatus(w, 'working', w.lastPrompt);
      break;
    case 'PreToolUse':
      // 서브에이전트(agent_id 있음)의 도구 사용은 메인 상태를 바꾸지 않는다 — 백그라운드면 메인 턴은 이미 끝났을 수 있다
      if (ev.agent_id) {
        w.subTool = `${ev.agent_type || 'subagent'} · ${summarizeTool(ev.tool_name, ev.tool_input)}`;
        pushLog(w, 'tool', `🤖 ${w.subTool}`);
        emitState();
        break;
      }
      w.currentTool = summarizeTool(ev.tool_name, ev.tool_input);
      w.toolCount++;
      progress.tool(w);
      if (w.status !== 'decision') w.status = 'working';
      pushLog(w, 'tool', w.currentTool);
      emitState();
      break;
    case 'PostToolUse':
      // 서브에이전트가 쓴 문서도 결과물이다
      if (ev.agent_id) { scheduleProfile(w); if (trackDoc(w, ev)) emitState(); break; }
      trackDoc(w, ev);
      trackTasks(w, ev);
      if (isCommit(ev)) { progress.commit(w); broadcast({ type: 'fx', kind: 'commit', id: w.id }); }
      // 터미널에서 직접 승인한 경우 등, 도구가 실행됐으면 해당 도구의 대기 결정은 무효
      for (const [did, d] of decisions) if (d.workerId === w.id && (d.toolUseId ? d.toolUseId === ev.tool_use_id : d.tool === ev.tool_name)) resolveDecision(did, null);
      if (w.status === 'decision' && !hasPending(w.id)) w.status = 'working';
      emitState();
      break;
    case 'PermissionRequest': {
      // 권한 선택은 터미널(CLI 의 원래 선택창)에서 한다 — 페이지 상단에 허용/거부 알림을 띄우지 않는다.
      // 훅을 붙잡지 않고 빈 응답으로 바로 넘겨야 CLI 가 선택창을 띄운다(붙잡으면 결정이 올 때까지 최대 590초 멈춘다).
      // 카드에는 '결정 대기'로 보이고, 선택하면 다음 훅(PreToolUse·Stop 등)으로 상태가 이어진다
      if (!REMOTE_DECISIONS) {
        const summary = summarizeTool(ev.tool_name, ev.tool_input);
        w.notice = `권한 요청 ${summary} — 터미널에서 선택하세요`;
        setStatus(w, 'decision', `권한 요청 ${summary}`);
        break;
      }
      const did = `D${++decisionSeq}`;
      const d = {
        id: did, workerId: w.id, kind: 'permission', tool: ev.tool_name, input: ev.tool_input,
        toolUseId: ev.tool_use_id, summary: summarizeTool(ev.tool_name, ev.tool_input), createdAt: Date.now(), res,
      };
      d.timer = setTimeout(() => resolveDecision(did, null), DECISION_HOLD_MS);
      res.on('close', () => { if (decisions.has(did)) { clearTimeout(d.timer); decisions.delete(did); refreshDecisionStatus(w); } });
      decisions.set(did, d);
      setStatus(w, 'decision', `권한 요청 ${d.summary}`);
      return; // 응답 보류 — 대시보드 결정 시 resolveDecision 이 응답한다
    }
    case 'Notification':
      w.notice = ev.message || ev.notification_type;
      if (ev.notification_type === 'idle_prompt') setStatus(w, w.status === 'done' || w.status === 'interrupted' ? w.status : 'idle', w.notice);
      else if (['permission_prompt', 'elicitation_dialog', 'agent_needs_input'].includes(ev.notification_type)) setStatus(w, 'decision', w.notice);
      else { pushLog(w, 'notice', w.notice); emitState(); }
      break;
    case 'Stop':
      w.lastMessage = ev.last_assistant_message ?? w.lastMessage;
      w.currentTool = null;
      w.doneAt = Date.now(); // 화면의 '확인 안 한 완료' 표시 기준
      payout(w);
      setTimeout(() => judgeCache(w), 1500); // 마지막 응답이 트랜스크립트에 다 쓰일 시간을 준다
      setStatus(w, 'done', '턴 완료');
      if (w.queue.length) setTimeout(() => dispatchQueued(w), 400);
      break;
    case 'SubagentStop':
      if (ev.agent_id && w.tx) w.tx.doneAgents.add(ev.agent_id);
      progress.subagent(w); // 작업(턴) 도중 끝난 것만 — 턴이 끝난 뒤의 백그라운드 완료는 주머니가 없어 무시
      pushLog(w, 'status', `서브에이전트 종료 (${ev.agent_type || ev.agent_id || ''})`);
      emitState();
      break;
    case 'SessionEnd':
      pushLog(w, 'status', `세션 종료 (${ev.reason || ''})`);
      emitState();
      break;
  }
  reply();
}

// 진행도: 현재 CLI 는 TaskCreate/TaskUpdate(실측 v2.1.284), 구버전은 TodoWrite 로 할 일을 관리한다
function trackTasks(w, ev) {
  const i = ev.tool_input || {}, r = ev.tool_response || {};
  if (ev.tool_name === 'TodoWrite' && Array.isArray(i.todos)) { w.todos = i.todos; return; }
  if (ev.tool_name === 'TaskCreate' && r.task?.id) {
    w.todos = [...w.todos.filter((t) => t.id !== r.task.id), { id: r.task.id, content: i.subject, activeForm: i.activeForm, status: 'pending' }];
  }
  if (ev.tool_name === 'TaskUpdate' && i.taskId) {
    if (i.status === 'deleted') { w.todos = w.todos.filter((t) => t.id !== i.taskId); return; }
    w.todos = w.todos.map((t) => t.id !== i.taskId ? t : {
      ...t, ...(i.status && { status: i.status }), ...(i.subject && { content: i.subject }), ...(i.activeForm && { activeForm: i.activeForm }),
    });
  }
}

// 트랜스크립트는 훅 이벤트마다 증분으로 읽고, 작업 중에는 2초마다 한 번 더 읽는다 (스트리밍 중 토큰 반영)
function scheduleProfile(w) {
  if (!w.tx || w.tx.timer) return;
  w.tx.timer = setTimeout(() => {
    w.tx.timer = null;
    if (readProfile(w.tx)) { drainShots(w); checkInterrupted(w); emitState(); }
  }, 300);
}
// 작업 중이거나, 턴은 끝났어도 백그라운드 서브에이전트가 돌고 있으면 계속 읽는다
setInterval(() => { for (const w of workers.values()) if (w.status === 'working' || w.status === 'decision' || (w.status !== 'exited' && w.tx && runningSubagents(w.tx))) scheduleProfile(w); }, 2000);

function hasPending(workerId) {
  for (const d of decisions.values()) if (d.workerId === workerId) return true;
  return false;
}

function refreshDecisionStatus(w) {
  if (w.status === 'decision' && !hasPending(w.id)) setStatus(w, 'working');
  else emitState();
}

// decision: null → 훅 응답 없이 놓아 터미널 프롬프트로 폴백 / { behavior, message }
function resolveDecision(did, decision) {
  const d = decisions.get(did);
  if (!d) return false;
  clearTimeout(d.timer);
  decisions.delete(did);
  const w = workers.get(d.workerId);
  if (w) { w.approvalWaits.push({ toolUseId: d.toolUseId, start: d.createdAt, ms: Date.now() - d.createdAt }); if (w.approvalWaits.length > 500) w.approvalWaits.shift(); }
  if (!d.res.writableEnded) {
    const body = decision
      ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: decision.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: decision.message || '관리자가 거부함' } } }
      : {};
    d.res.writeHead(200, { 'content-type': 'application/json' });
    d.res.end(JSON.stringify(body));
  }
  if (w) {
    pushLog(w, 'decision', `${d.summary} → ${decision ? decision.behavior : '터미널로 넘김'}${decision?.message ? ` (${decision.message})` : ''}`);
    refreshDecisionStatus(w);
  }
  return true;
}

// ---------- 상태 브로드캐스트 ----------

function publicState() {
  return {
    now: Date.now(),
    workers: [...workers.values()].map(({ term, tx, approvalWaits, pot, ...w }) => ({ ...w, profile: tx && profileSummary(tx, approvalWaits) })),
    decisions: [...decisions.values()].map(({ res, timer, ...d }) => d),
    profiles: config.profiles,
    order: config.order,
    memos: config.memos,
    colors: config.colors,
    serverStale: serverStale(),
    recentCwds: config.recentCwds,
    progress: progress.public(),
    shotKeep: SHOT_KEEP, // 화면 안내 문구용 (워커당 캡처 보관 장수)
    usage, // 계정 사용량 { fiveHour: { pct, resetsAt }, sevenDay, at }
  };
}

let stateTimer = null;
function emitState() {
  saveWorkersSoon();
  if (stateTimer) return;
  stateTimer = setTimeout(() => { stateTimer = null; broadcast({ type: 'state', state: publicState() }); }, 50);
}

const sockets = new Set();
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const ws of sockets) if (ws.readyState === 1) ws.send(s);
}

// ---------- PTY 호스트 연결 ----------
// ptyhost.js 는 별도 상주 프로세스. 없으면 띄우고(detached — 이 서버가 꺼져도 남는다), 접속해서 워커 터미널을 다룬다.
const PTY_PORT = Number(process.env.AM_PTY_PORT || 7787);
let host = null;
let snapSeq = 0;
const snapWaiters = new Map(); // 스냅샷 요청 번호 → 요청한 브라우저 소켓

function hostSend(msg) { if (host?.readyState === 1) host.send(JSON.stringify(msg)); }

function hostTerm(id) {
  // 같은 크기 resize 는 보내지 않는다 — ConPTY 는 같은 크기여도 화면 전체를 다시 그려 보낸다.
  // 탭이 여럿이어도 여기서 한 번 걸러진다
  let size = null;
  return {
    write: (data) => hostSend({ op: 'write', id, data }),
    resize: (cols, rows) => {
      if (size === `${cols}x${rows}` || host?.readyState !== 1) return;
      size = `${cols}x${rows}`;
      hostSend({ op: 'resize', id, cols, rows });
    },
    kill: () => hostSend({ op: 'kill', id }),
  };
}

function startHost() {
  spawnProcess(process.execPath, [path.join(APP_DIR, 'ptyhost.js')], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT,
    env: { ...process.env, AM_PTY_PORT: String(PTY_PORT) },
  }).unref();
}

function openHost() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PTY_PORT}`);
    ws.once('error', reject);
    ws.once('message', (raw) => {
      const hello = JSON.parse(raw);
      host = ws;
      ws.on('message', (r) => { try { onHostMessage(JSON.parse(r)); } catch (e) { console.error('host msg', e); } });
      ws.on('close', () => { host = null; console.log('PTY 호스트 연결 끊김 — 재접속 시도'); setTimeout(() => connectHost().catch(() => {}), 1000); });
      resolve(hello);
    });
  });
}

async function connectHost() {
  for (let i = 0; i < 40; i++) {
    try { const hello = await openHost(); onHostHello(hello); return; }
    catch { if (i === 0) startHost(); await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error('PTY 호스트에 접속할 수 없습니다');
}

// 호스트가 가진 터미널 목록으로 워커를 복원한다. 저장된 기록(workers.json)이 있으면 그 상태로.
function onHostHello({ ptys }) {
  const alive = new Map(ptys.map((p) => [p.id, p]));
  const saved = loadSavedWorkers();
  for (const rec of saved) {
    if (workers.has(rec.id)) continue;
    const p = alive.get(rec.id);
    const w = { ...rec, term: hostTerm(rec.id), tx: rec.txPath ? createProfile(rec.txPath) : null };
    delete w.txPath;
    if (!p || p.exited) w.status = 'exited';
    else { w.pid = p.pid; pushLog(w, 'status', '관제 서버 재시작 — 워커 다시 연결'); }
    // 완료 시각 기록(doneAt) 이전에 끝난 워커도 '확인 안 한 완료'로 보이게 마지막 갱신 시각으로 채운다
    if (w.status === 'done' && !w.doneAt) w.doneAt = w.updatedAt || Date.now();
    if (w.docs) w.docs = w.docs.filter((d) => isDocCandidate(d.path)); // 규칙이 바뀌기 전에 잡힌 이 앱 자체 파일 등을 정리
    ensureRoleColor(w.name);
    workers.set(w.id, w);
    if (w.tx) scheduleProfile(w);
  }
  for (const id of [...workers.keys(), ...alive.keys()]) seq = Math.max(seq, Number(String(id).replace(/\D/g, '')) || 0);
  emitState();
}

function onHostMessage(msg) {
  const w = workers.get(msg.id);
  if (msg.ev === 'data') { broadcast({ type: 'pty', id: msg.id, data: msg.data }); return; }
  if (msg.ev === 'snapshot') {
    const ws = snapWaiters.get(msg.req);
    snapWaiters.delete(msg.req);
    if (typeof ws === 'function') return ws(msg); // 서버가 직접 요청한 것(cliDraft)
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'scrollback', id: msg.id, data: msg.data }));
    return;
  }
  if (!w) return;
  if (msg.ev === 'spawned') { w.pid = msg.pid; emitState(); }
  if (msg.ev === 'exit') {
    progress.drop(w);
    setStatus(w, 'exited', `프로세스 종료 (code ${msg.exitCode})${msg.error ? ` · ${msg.error}` : ''}`);
    for (const [did, d] of decisions) if (d.workerId === w.id) resolveDecision(did, null);
  }
}

// ---------- 도구 결과 이미지(캡처) 보관 ----------
// 터미널은 그림을 못 그리지만 트랜스크립트에는 도구 결과 이미지가 base64 로 남는다 → 파일로 꺼내 화면(타임라인·카드)에 보여 준다.
// 워커별 data/shots/<id>/ 에 최근 SHOT_KEEP 장만 둔다. 파일 이름이 tool_use id 라 처음부터 다시 읽어도 중복 저장되지 않는다
const SHOT_DIR = path.join(DATA_DIR, 'shots');
const SHOT_KEEP = 50;
const SHOT_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function drainShots(w) {
  const list = w.tx?.shots;
  if (!list?.length) return;
  w.tx.shots = [];
  const dir = path.join(SHOT_DIR, w.id);
  w.shots ||= [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const s of list.slice(-SHOT_KEEP)) {
      const ext = SHOT_EXT[s.media];
      if (!ext) continue;
      const name = `${s.key.replace(/[^\w-]/g, '')}.${ext}`;
      if (w.shots.some((x) => x.name === name)) continue;
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) fs.writeFileSync(full, Buffer.from(s.data, 'base64'));
      w.shots.push({ name, url: `/shots/${w.id}/${name}`, t: s.ts, tool: s.tool, arg: s.arg });
    }
    w.shots.sort((a, b) => a.t - b.t);
    for (const d of w.shots.splice(0, Math.max(0, w.shots.length - SHOT_KEEP))) fs.rmSync(path.join(dir, d.name), { force: true });
    saveWorkersSoon();
  } catch (e) { console.error('[shots]', e.message); }
}

// ---------- 첨부 이미지 보관 ----------
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// ---------- 결과물 문서 ----------
// 워커가 Write/Edit 로 쓴 문서(html·md·pdf·svg)를 타임라인에 카드로 보여 주고, 누르면 새 탭으로 연다.
// 열어 주는 것은 워커가 직접 쓴 바로 그 파일뿐이다 — w.docs 에 기록된 경로를 문서 id 로만 찾는다.
// Bash 로 만든 파일은 알 수 없다
const DOC_TYPES = { html: 'text/html', htm: 'text/html', md: 'text/plain', markdown: 'text/plain', svg: 'image/svg+xml', pdf: 'application/pdf' };
const DOC_KEEP = 50;
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const docExt = (file) => path.extname(file).slice(1).toLowerCase();
// 카드에 보일 제목: html 은 <title>/<h1>, md 는 첫 # 제목
function docTitle(full) {
  try {
    const head = fs.readFileSync(full, { encoding: 'utf8' }).slice(0, 65536);
    const m = head.match(/<title[^>]*>([^<]{1,200})<\/title>/i) || head.match(/<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i) || head.match(/^#\s+(.{1,200})$/m);
    return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  } catch { return ''; }
}
// 결과물로 칠 수 없는 곳: Claude 설정·메모리(~/.claude 아래), 규칙 파일, 이 앱(agent-manager) 자체의 파일(화면 소스 등)
const underDir = (full, dir) => full.toLowerCase().startsWith(dir.toLowerCase() + path.sep);
const isDocCandidate = (full) => !underDir(full, CLAUDE_HOME) && !underDir(full, ROOT) && !/^(CLAUDE|MEMORY)\.md$/i.test(path.basename(full));
function trackDoc(w, ev) {
  if (!['Write', 'Edit', 'MultiEdit'].includes(ev.tool_name)) return false;
  const file = ev.tool_input?.file_path;
  if (typeof file !== 'string' || !DOC_TYPES[docExt(file)]) return false;
  const full = path.resolve(w.cwd || ROOT, file);
  if (!isDocCandidate(full)) return false;
  const id = crypto.createHash('sha1').update(full).digest('hex').slice(0, 12);
  // 결과물은 Write 로 새로 만든 문서에서 시작한다. 원래 있던 파일을 Edit 로 고친 것(웹 프로젝트의 html 소스 등)은
  // 결과물이 아니다 — Write 로 만든 문서를 나중에 Edit 로 고친 건 계속 반영
  if (ev.tool_name !== 'Write' && !(w.docs || []).some((d) => d.id === id)) return false;
  w.docs = (w.docs || []).filter((d) => d.id !== id); // 같은 파일을 다시 고치면 최신 시각으로 옮긴다
  w.docs.push({ id, url: `/docs/${w.id}/${id}`, path: full, name: path.basename(full), title: docExt(full) === 'pdf' || docExt(full) === 'svg' ? '' : docTitle(full), t: Date.now(), tool: ev.tool_name });
  if (w.docs.length > DOC_KEEP) w.docs.splice(0, w.docs.length - DOC_KEEP);
  saveWorkersSoon();
  return true;
}
const UPLOAD_LIMIT = 20 * 1024 * 1024;
// 7일 지난 첨부는 정리 (Claude 가 이미 읽어 트랜스크립트에 담겼으므로 원본은 오래 둘 필요 없음)
function cleanupUploads() {
  try {
    // '나중에 할 작업'은 며칠 묵힐 수 있으니, 거기 적힌 이미지는 기간이 지나도 지우지 않는다
    const kept = JSON.stringify(config.memos || {});
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const full = path.join(UPLOAD_DIR, f);
      if (kept.includes(f)) continue;
      if (Date.now() - fs.statSync(full).mtimeMs > 7 * 86400_000) fs.unlinkSync(full);
    }
  } catch {}
}
cleanupUploads();
setInterval(cleanupUploads, 6 * 3600_000);

// ---------- 호환용 훅 파일 정리 ----------
// 폴더 정리 전에 띄운 워커는 최상위 hook.mjs 를 훅으로 쓴다. 그런 워커가 하나도 안 남으면 지운다.
const LEGACY_HOOK = path.join(ROOT, 'hook.mjs');
function cleanupLegacyHook() {
  // 다른 data 폴더로 띄운 서버(테스트 등)는 실제 워커 목록을 모르니 건드리지 않는다
  if (process.env.AM_DATA || !fs.existsSync(LEGACY_HOOK)) return;
  const needle = LEGACY_HOOK.replace(/\\/g, '/');
  const inUse = [...workers.values()].some((w) => {
    if (w.status === 'exited') return false;
    try { return fs.readFileSync(path.join(DATA_DIR, `${w.id}.settings.json`), 'utf8').includes(needle); } catch { return false; }
  });
  if (!inUse) { try { fs.unlinkSync(LEGACY_HOOK); console.log('호환용 hook.mjs 정리'); } catch {} }
}
setInterval(cleanupLegacyHook, 60_000);

// ---------- 워커 기록 저장 ----------
// 서버 재시작 후 이름·상태·타임라인·큐 등을 되살리기 위해 data/workers.json 에 저장 (상태가 바뀔 때마다, 1초 묶음)
const WORKERS_PATH = path.join(DATA_DIR, 'workers.json');
let saveTimer = null;

function loadSavedWorkers() {
  try { return JSON.parse(fs.readFileSync(WORKERS_PATH, 'utf8')); } catch { return []; }
}

function saveWorkersNow() {
  clearTimeout(saveTimer); saveTimer = null;
  const list = [...workers.values()].map(({ term, tx, ...w }) => ({ ...w, txPath: tx?.path || null }));
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(WORKERS_PATH, JSON.stringify(list)); } catch {}
}

function saveWorkersSoon() { if (!saveTimer) saveTimer = setTimeout(saveWorkersNow, 1000); }

// ---------- HTTP ----------

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
  '/vendor/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/vendor/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/vendor/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
  '/vendor/addon-unicode11.js': ['node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js', 'text/javascript'],
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && STATIC[p]) {
    const [file, type] = STATIC[p];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(file.startsWith('node_modules/') ? ROOT : APP_DIR, file)).pipe(res);
  }

  // 사람이 지시에 첨부한 파일 원본(data/uploads) — 입력칸·대기열·나중에 할 작업·타임라인의 첨부 타일용. 따로 복사하지 않고
  // 원본을 그대로 보여 주며, 보관은 기존 정리 규칙(cleanupUploads: 7일, 나중에 할 작업에 적힌 것은 유지)을 따른다.
  // 이름은 /api/upload 가 지은 규칙(시각-난수.확장자 / 시각-난수-원래이름)만 받는다 — 폴더 밖으로 나갈 수 없게
  if (req.method === 'GET' && p.startsWith('/uploads/')) {
    let name = '';
    try { name = decodeURIComponent(p.slice('/uploads/'.length)); } catch {}
    if (!/^\d{14}-[a-z0-9]{1,8}(?:\.[a-z0-9]+|-[\p{L}\p{N}._-]+)$/iu.test(name) && !/^[\w.-]+\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return json(res, 404, {});
    const full = path.join(UPLOAD_DIR, name);
    if (path.dirname(full) !== UPLOAD_DIR || !fs.existsSync(full)) return json(res, 404, {});
    const ext = docExt(name);
    const img = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext];
    const textLike = /^(txt|log|csv|tsv|json|jsonl|ya?ml|toml|ini|xml|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|cs|sh|ps1|bat|sql|css|scss|diff|patch)$/.test(ext);
    const type = img || DOC_TYPES[ext] || (textLike ? 'text/plain' : null);
    // 이미지가 아닌 것: html·svg 의 스크립트가 관제 화면과 같은 출처로 돌지 않게 샌드박스(결과물 문서와 같은 방식, pdf 는 뷰어 때문에 제외).
    // 브라우저가 못 보여 주는 형식은 내려받기로
    const orig = name.replace(/^\d{14}-[a-z0-9]{1,8}-/i, '');
    res.writeHead(200, {
      'content-type': type ? (type.startsWith('text/') || ext === 'svg' ? `${type}; charset=utf-8` : type) : 'application/octet-stream',
      'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff',
      ...(img || ext === 'pdf' ? {} : { 'content-security-policy': 'sandbox allow-scripts allow-popups allow-modals allow-downloads' }),
      ...(type ? {} : { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(orig)}` }),
    });
    return fs.createReadStream(full).pipe(res);
  }

  // 도구 결과 캡처 (drainShots 가 저장한 파일). 이름 규칙 밖의 경로는 받지 않는다
  if (req.method === 'GET' && p.startsWith('/shots/')) {
    const [, , id, name] = p.split('/');
    if (!/^[\w-]+$/.test(id || '') || !/^[\w-]+\.(png|jpg|gif|webp)$/.test(name || '')) return json(res, 404, {});
    const full = path.join(SHOT_DIR, id, name);
    if (!fs.existsSync(full)) return json(res, 404, {});
    const ext = name.split('.').pop();
    res.writeHead(200, { 'content-type': `image/${ext === 'jpg' ? 'jpeg' : ext}`, 'cache-control': 'max-age=86400' });
    return fs.createReadStream(full).pipe(res);
  }

  // 워커가 쓴 결과물 문서 (trackDoc 이 기록한 파일만). html·svg 는 스크립트가 관제 화면과 같은 출처로 돌지 않게
  // 샌드박스(고유 출처 없음)로 연다. pdf 는 샌드박스면 브라우저 뷰어가 막혀서 그대로
  if (req.method === 'GET' && p.startsWith('/docs/')) {
    const [, , wid, id] = p.split('/');
    const d = workers.get(wid)?.docs?.find((x) => x.id === id);
    let ok = false;
    try { ok = !!d && fs.statSync(d.path).isFile(); } catch {}
    if (!ok) return json(res, 404, { error: '문서가 없습니다 (지워졌거나 옮겨짐)' });
    const ext = docExt(d.path), type = DOC_TYPES[ext];
    res.writeHead(200, {
      'content-type': type.startsWith('text/') || ext === 'svg' ? `${type}; charset=utf-8` : type,
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      ...(ext === 'pdf' ? {} : { 'content-security-policy': 'sandbox allow-scripts allow-popups allow-modals allow-downloads' }),
    });
    return fs.createReadStream(d.path).pipe(res);
  }

  if (req.method === 'POST' && p === '/statusline') {
    onStatusLine(await readBody(req));
    return json(res, 200, {});
  }

  if (req.method === 'POST' && p === '/hook') {
    const w = workers.get(url.searchParams.get('w'));
    const ev = await readBody(req);
    if (process.env.AM_DEBUG) fs.appendFileSync(path.join(DATA_DIR, 'hook-debug.jsonl'), JSON.stringify({ w: url.searchParams.get('w'), ...ev }) + '\n');
    if (!w) return json(res, 200, {});
    return onHook(w, ev, res);
  }

  if (req.method === 'GET' && p === '/api/state') return json(res, 200, publicState());

  if (req.method === 'POST' && p === '/api/workers') {
    const body = await readBody(req);
    const w = spawnWorker(body);
    if (body.save) upsertProfile({ ...body, cwd: w.cwd });
    return json(res, 200, { id: w.id });
  }

  if (req.method === 'POST' && p === '/api/profiles/rename') {
    const { from, name } = await readBody(req);
    const r = renameRole(from, name, null);
    return json(res, r.error ? 409 : 200, r);
  }

  // 기판 칩 순서 — 역할 이름 기준이라 서버를 다시 켜도, 대기실 슬롯↔워커 전환에도 자리가 유지된다
  // 메모: 역할별로 적어 두는 할 일 목록. 자동 실행되지 않고, ▶ 지시를 누른 항목만 업무 지시(즉시 또는 대기열)로 넘어간다
  if (req.method === 'POST' && p === '/api/memos') {
    const { role, op, text, id, workerId, to } = await readBody(req);
    if (!role) return json(res, 400, { error: 'role 필요' });
    const list = (config.memos[role] ||= []);
    if (op === 'add' && String(text || '').trim()) list.push({ id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: String(text).trim(), createdAt: Date.now() });
    if (op === 'remove') config.memos[role] = list.filter((m) => m.id !== id);
    if (op === 'edit') {
      const m = list.find((x) => x.id === id);
      if (!m) return json(res, 404, { error: '수정할 작업이 없습니다' });
      if (!String(text || '').trim()) return json(res, 400, { error: '내용이 비었습니다 (지우려면 ✕)' });
      m.text = String(text).trim();
    }
    if (op === 'send') {
      const m = list.find((x) => x.id === id), w = workers.get(workerId);
      if (!m || !w) return json(res, 404, { error: '메모나 워커가 없습니다' });
      if (w.status === 'exited') return json(res, 409, { error: '종료된 워커에는 지시할 수 없습니다' });
      assignTask(w, m.text);
      config.memos[role] = list.filter((x) => x.id !== id);
    }
    // 다른 역할로 옮기기: 워커 카드(대기실 슬롯 포함)에 끌어다 놓으면 그 역할 목록 끝으로 간다
    if (op === 'move') {
      const m = list.find((x) => x.id === id);
      if (!m || !to || to === role) return json(res, 404, { error: '옮길 작업이 없습니다' });
      config.memos[role] = list.filter((x) => x.id !== id);
      (config.memos[to] ||= []).push(m);
    }
    if (!config.memos[role]?.length) delete config.memos[role];
    saveConfig();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/order') {
    const { order } = await readBody(req);
    if (Array.isArray(order)) { config.order = [...new Set(order.map(String))].slice(0, 200); saveConfig(); }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/profiles/delete') {
    const { name } = await readBody(req);
    config.profiles = config.profiles.filter((x) => x.name !== name);
    saveConfig();
    return json(res, 200, { ok: true });
  }

  // 파일 첨부: 브라우저는 보안상 드롭한 파일의 원래 경로를 모르므로, 받은 내용을 data/uploads 에 저장하고
  // 그 절대 경로를 돌려준다. 이 경로를 프롬프트에 넣으면 Claude Code 가 이미지는 이미지로 첨부하고(터미널에 파일을 끌어다 놓은 것과 같음),
  // 그 밖의 파일은 경로로 받아 Read 로 읽는다. 이미지가 아닌 파일은 Claude 가 알아보게 원래 이름을 살려 둔다
  if (req.method === 'POST' && p === '/api/upload') {
    const type = String(req.headers['content-type'] || '').split(';')[0];
    let orig = '';
    try { orig = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch {}
    const imgExt = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type];
    // 경로에 띄어쓰기·따옴표가 들어가면 프롬프트에서 경로가 끊기므로 글자·숫자·. - _ 만 남긴다(한글 포함)
    const safe = path.basename(orig).normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(-80);
    const chunks = []; let size = 0, tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > UPLOAD_LIMIT) tooBig = true; else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return json(res, 413, { error: '20MB 를 넘는 파일은 첨부할 수 없습니다' });
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const base = `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
      // 이미지는 기존 이름 규칙 그대로(타임라인 썸네일 /uploads/ 가 이 규칙으로 찾는다)
      const file = path.join(UPLOAD_DIR, imgExt ? `${base}.${imgExt}` : `${base}-${safe || 'file'}`);
      fs.writeFileSync(file, Buffer.concat(chunks));
      json(res, 200, { path: file });
    });
    return;
  }

  // ↻ 서버 재시작: 실행기(launch.mjs)를 '포트가 빌 때까지 기다렸다 띄우기' 모드로 남겨 두고 이 서버는 내려간다.
  // 워커는 PTY 호스트에서 계속 돌고, 새 서버가 뜨면 다시 붙는다. 화면은 서버가 돌아오면 스스로 새로고침
  if (req.method === 'POST' && p === '/api/restart') {
    json(res, 200, { ok: true });
    console.log('브라우저에서 서버 재시작 요청');
    spawnProcess(process.execPath, [path.join(APP_DIR, 'launch.mjs')], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, AM_NO_BROWSER: '1', AM_WAIT_FREE: '1' },
    }).unref();
    setTimeout(shutdown, 300);
    return;
  }

  // 브라우저의 ⏻ 버튼: 서버만 끄거나(워커는 호스트에서 계속 돎) 워커까지 모두 끈다
  if (req.method === 'POST' && p === '/api/shutdown') {
    const { workers: alsoWorkers } = await readBody(req);
    json(res, 200, { ok: true });
    console.log(`브라우저에서 종료 요청 (${alsoWorkers ? '워커 포함' : '서버만'})`);
    if (alsoWorkers) hostSend({ op: 'shutdown' });
    setTimeout(shutdown, 300);
    return;
  }

  if (req.method === 'POST' && p === '/api/pick-folder') {
    const { start } = await readBody(req);
    return json(res, 200, { path: await pickFolder(start) });
  }

  let m;
  if (req.method === 'POST' && (m = p.match(/^\/api\/workers\/(W\d+)\/(task|kill|remove|interrupt|unqueue|resume|rename)$/))) {
    const w = workers.get(m[1]);
    if (!w) return json(res, 404, { error: 'no worker' });
    const body = await readBody(req);
    if (m[2] === 'task') return json(res, 200, { ok: true, ...(await assignTask(w, body.text)) });
    if (m[2] === 'interrupt' && w.status !== 'exited') { w.term.write('\x1b'); pushLog(w, 'status', '관리자가 중단(Esc)'); emitState(); setTimeout(() => scheduleProfile(w), 700); }
    if (m[2] === 'unqueue') { w.queue.splice(Number(body.index), 1); emitState(); }
    if (m[2] === 'resume') { w.queueHeld = false; emitState(); dispatchQueued(w); }
    if (m[2] === 'rename') {
      const r = renameRole(w.name, body.name, w);
      if (r.error) return json(res, 409, r);
    }
    if (m[2] === 'kill') { try { w.term.kill(); } catch {} }
    if (m[2] === 'remove') { hostSend({ op: 'forget', id: w.id }); workers.delete(w.id); fs.rmSync(path.join(SHOT_DIR, w.id), { recursive: true, force: true }); emitState(); }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/decisions\/(D\d+)$/))) {
    const body = await readBody(req);
    const ok = resolveDecision(m[1], body.behavior === 'pass' ? null : { behavior: body.behavior === 'allow' ? 'allow' : 'deny', message: body.message });
    return json(res, ok ? 200 : 404, { ok });
  }

  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.send(JSON.stringify({ type: 'state', state: publicState() }));
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const w = workers.get(msg.id);
    if (!w) return;
    if (msg.type === 'input' && w.status !== 'exited') w.term.write(msg.data);
    if (msg.type === 'resize' && msg.cols > 10 && msg.rows > 5) w.term.resize(msg.cols, msg.rows);
    if (msg.type === 'attach') { const req = ++snapSeq; snapWaiters.set(req, ws); hostSend({ op: 'snapshot', id: w.id, req }); }
  });
  ws.on('close', () => sockets.delete(ws));
});

await connectHost();
server.listen(PORT, HOST, () => {
  console.log(`클로드 키우기 http://${HOST}:${PORT}  (claude: ${CLAUDE_BIN})`);
  setTimeout(cleanupLegacyHook, 5000);
});

// 서버만 내린다. 워커(Claude 프로세스)는 PTY 호스트에서 계속 돈다 — 다음에 서버를 켜면 다시 붙는다
function shutdown() {
  saveWorkersNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
