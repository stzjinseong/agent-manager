// PTY 호스트 — Claude 프로세스(터미널)를 붙잡고 있는 상주 프로세스.
// 관제 서버(server.js)와 분리돼 있어서 서버를 재시작해도 워커가 죽지 않는다.
// 이 파일은 일부러 작게 유지한다 — 이걸 바꿔 재시작하면 워커가 모두 종료되기 때문.
//
// 프로토콜 (ws://127.0.0.1:7787, JSON 한 줄씩)
//   → { op: 'spawn', id, file, args, cwd, env, cols, rows }   ← 이미 있는 id 면 무시
//   → { op: 'write', id, data } / { op: 'resize', id, cols, rows } / { op: 'kill', id } / { op: 'forget', id }
//   → { op: 'snapshot', id, req }   현재 화면 상태 요청
//   → { op: 'shutdown' }   모든 워커 종료 후 호스트 종료
//   ← { ev: 'hello', version, ptys: [{ id, pid, exited, exitCode }] }   접속 직후
//   ← { ev: 'snapshot', id, req, data }
//   ← { ev: 'spawned', id, pid } / { ev: 'data', id, data } / { ev: 'exit', id, exitCode }
//
// 화면 복원: 원문 출력 로그를 다시 재생하면 Claude Code 의 fullscreen TUI(대체 화면 + 바뀐 칸만 다시 그리기)가
// 잘린 로그로는 복원되지 않는다. 그래서 워커마다 가상 터미널(@xterm/headless)에 출력을 그대로 흘려 두고,
// 붙을 때는 그 화면 상태를 직렬화한 스냅샷을 보낸다.
import http from 'node:http';
import pty from '@lydell/node-pty';
import { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';
import { L } from './cli-lang.js';
import { ensureToken, readToken, tokenOk, TOKEN_HEADER } from './auth.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { Unicode11Addon } = require('@xterm/addon-unicode11');

const VERSION = 4; // 2: clearScrollback · 3: 접속 토큰(auth.js) · 4: 종료된 터미널은 마지막 화면 문자열만 남기고 해제
const PORT = Number(process.env.AM_PTY_PORT || 7787);
const IDLE_EXIT_MS = 60_000; // 워커도 접속한 서버도 없으면 스스로 종료 (고아 방지)

// npm run stop-workers → 떠 있는 호스트에 종료 명령만 보내고 끝낸다 (모든 워커 종료)
if (process.argv.includes('--shutdown')) {
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { [TOKEN_HEADER]: readToken() || '' } });
  ws.on('open', () => { ws.send(JSON.stringify({ op: 'shutdown' })); console.log(L('워커 호스트 종료 요청 보냄', 'Sent shutdown request to the worker host')); setTimeout(() => process.exit(0), 500); });
  ws.on('error', () => { console.log(L('실행 중인 워커 호스트 없음', 'No worker host is running')); process.exit(0); });
  await new Promise(() => {});
}

const ptys = new Map(); // id → { id, term, pid, screen, serializer, exited, exitCode, final }

// 종료된 워커는 가상 터미널(기록이 꽉 차면 실측 약 18MB)을 해제하고 마지막 화면 직렬화 문자열(약 0.6MB)만 남긴다.
// 예전엔 forget(워커 삭제) 전까지 터미널을 통째로 들고 있어, 워커를 돌려 가며 며칠 쓰면 이 프로세스가 계속 커졌다.
// 남기는 마지막 화면도 최근 FINAL_KEEP 개까지만 — 더 오래된 건 빈 화면으로 답한다
const FINAL_KEEP = 10;
const FINAL_DELAY_MS = 1000; // 종료 직후 늦게 도착한 출력까지 반영한 뒤 직렬화
function retire(p) {
  if (!p.screen) return;
  p.screen.write('', () => {
    if (!p.screen) return;
    p.final = { cols: p.screen.cols, rows: p.screen.rows, data: p.serializer.serialize({ scrollback: SCROLLBACK }) };
    p.screen.dispose(); p.screen = null; p.serializer = null;
    const kept = [...ptys.values()].filter((x) => x.final?.data);
    for (const x of kept.slice(0, Math.max(0, kept.length - FINAL_KEEP))) x.final.data = '';
  });
}
function sendFinal(p, req) {
  const f = p.final || { cols: 120, rows: 34, data: '' };
  broadcast({ ev: 'snapshot', id: p.id, req, cols: f.cols, rows: f.rows, data: f.data });
}

// 워커마다 들고 있는 터미널 기록 줄 수. 타임라인의 오래된 요청을 눌러 그 위치로 가려면 기록이 남아 있어야 한다
// (2000줄일 땐 diff·긴 출력 몇 턴이면 밀려났다). 한 줄 ≈ 110칸이라 워커당 메모리 약 10MB 안팎
const SCROLLBACK = 10000;
function makeScreen(cols, rows) {
  const screen = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serializer = new SerializeAddon();
  screen.loadAddon(serializer);
  screen.loadAddon(new Unicode11Addon()); // 브라우저와 같은 글자 폭 표
  screen.unicode.activeVersion = '11';
  return { screen, serializer };
}
const clients = new Set();

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const ws of clients) if (ws.readyState === 1) ws.send(s); };

function spawn({ id, file, args, cwd, env, cols = 120, rows = 34 }) {
  if (ptys.has(id)) return;
  let term;
  try {
    term = pty.spawn(file, args || [], { name: 'xterm-256color', cols, rows, cwd, env });
  } catch (e) {
    broadcast({ ev: 'exit', id, exitCode: -1, error: String(e.message || e) });
    return;
  }
  const p = { id, term, pid: term.pid, ...makeScreen(cols, rows), exited: false, exitCode: null };
  ptys.set(id, p);
  term.onData((data) => {
    if (p.screen) p.screen.write(data);
    broadcast({ ev: 'data', id, data });
  });
  term.onExit(({ exitCode }) => {
    p.exited = true;
    p.exitCode = exitCode;
    broadcast({ ev: 'exit', id, exitCode });
    setTimeout(() => retire(p), FINAL_DELAY_MS);
  });
  broadcast({ ev: 'spawned', id, pid: term.pid });
}

function handle(msg) {
  const p = ptys.get(msg.id);
  switch (msg.op) {
    case 'spawn': spawn(msg); break;
    case 'write': if (p && !p.exited) p.term.write(msg.data); break;
    case 'resize': if (p && !p.exited && p.screen && msg.cols > 10 && msg.rows > 5) { try { p.term.resize(msg.cols, msg.rows); p.screen.resize(msg.cols, msg.rows); } catch {} } break;
    case 'snapshot':
      if (!p) break;
      if (!p.screen) { sendFinal(p, msg.req); break; }
      // 아직 해석 대기 중인 출력까지 반영한 뒤 직렬화
      p.screen.write('', () => {
        if (!p.screen) { sendFinal(p, msg.req); return; }
        broadcast({ ev: 'snapshot', id: p.id, req: msg.req, cols: p.screen.cols, rows: p.screen.rows, data: p.serializer.serialize({ scrollback: SCROLLBACK }) });
      });
      break;
    // /clear 뒤 이전 대화 기록(스크롤백)만 지운다. Windows 에선 Claude 의 화면 지우기(ED3)가 ConPTY 를 거치며 사라져
    // 기록이 그대로 남는다(실측: /clear 후 지우기 제어 문자 0개, 스크롤백 1150줄 잔존). 화면(뷰포트)은 그대로 둔다
    case 'clearScrollback': if (p?.screen) p.screen.write('\x1b[3J'); break;
    case 'kill': if (p && !p.exited) { try { p.term.kill(); } catch {} } break;
    case 'forget': if (p) { if (!p.exited) { try { p.term.kill(); } catch {} } p.screen?.dispose(); ptys.delete(msg.id); } break;
    case 'shutdown':
      for (const x of ptys.values()) if (!x.exited) { try { x.term.kill(); } catch {} }
      setTimeout(() => process.exit(0), 300);
      break;
  }
}

const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
// 받는 건 토큰을 든 우리 서버(server.js)와 --shutdown 뿐 — 브라우저(Origin 이 붙는다)는 어떤 출처든 거절한다.
// 인증이 없을 땐 아무 웹사이트나 붙어 spawn 으로 임의 프로그램을 실행할 수 있었다. 토큰은 접속마다 파일에서 다시 읽는다(지워져 새로 만들어져도 통하게)
ensureToken();
const wss = new WebSocketServer({ server, verifyClient: ({ req }) => !req.headers.origin && tokenOk(req.headers[TOKEN_HEADER], readToken()) });
wss.on('connection', (ws) => {
  clients.add(ws);
  send(ws, {
    ev: 'hello', version: VERSION,
    ptys: [...ptys.values()].map(({ id, pid, exited, exitCode }) => ({ id, pid, exited, exitCode })),
  });
  ws.on('message', (raw) => { try { handle(JSON.parse(raw)); } catch {} });
  ws.on('close', () => clients.delete(ws));
});

// 이미 다른 호스트가 떠 있으면(EADDRINUSE) 조용히 종료
server.on('error', () => process.exit(0));
server.listen(PORT, '127.0.0.1');

setInterval(() => {
  const alive = [...ptys.values()].some((p) => !p.exited);
  if (!alive && clients.size === 0) {
    if (!handle.idleSince) handle.idleSince = Date.now();
    else if (Date.now() - handle.idleSince > IDLE_EXIT_MS) process.exit(0);
  } else handle.idleSince = 0;
}, 5000);
