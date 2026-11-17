// Claude Code statusLine 명령 → 관제탑 서버 전달기.
// Claude Code 는 상태줄을 그릴 때마다 세션 정보 JSON 을 stdin 으로 준다. 그 안의 rate_limits(구독 계정의 5시간·주간 한도
// 사용률과 초기화 시각)를 서버로 보내 상단 막대에 보여 준다(실측 v2.1.288: rate_limits.five_hour/seven_day.{used_percentage, resets_at}).
// 워커는 --settings 로 이 명령을 상태줄로 쓰므로 사용자가 원래 쓰던 상태줄을 가린다 → 그 명령을 같은 입력으로 실행해 출력을 그대로 낸다.
// 서버가 꺼져 있거나 늦어도 상태줄 표시를 막지 않게 짧게 기다리고 넘어간다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readToken, TOKEN_HEADER } from './auth.js';
import { savedPath, claudeHome } from './userstatusline.js';

const DATA_DIR = process.env.AM_DATA || path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'data');

// 사용자 상태줄 명령을 띄운 셸 pid 를 여기 파일로 남긴다(정상 종료 시 지움). 이 프로세스가 Claude Code 에 강제 종료되면
// 파일이 남고, 서버가 주기적으로 그 셸의 자식(남은 상태줄 프로세스)을 정리한다 — server.js sweepStatuslineOrphans
const PIDS_DIR = path.join(DATA_DIR, 'statusline-pids');
const USER_LINE_MS = 3000;

const worker = process.env.AGENT_MANAGER_WORKER;
const port = process.env.AGENT_MANAGER_PORT || '7788';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  let data = {};
  try { data = JSON.parse(input); } catch {}
  // 모델도 같이 보낸다 — /model 로 바꾸면 훅은 오지 않지만 상태줄은 다시 그려지므로, 화면의 모델명을 바로 바꿀 수 있다
  const model = data.model?.id;
  if (worker && (data.rate_limits || model)) {
    try {
      await fetch(`http://127.0.0.1:${port}/statusline?w=${worker}`, {
        method: 'POST', headers: { 'content-type': 'application/json', [TOKEN_HEADER]: readToken() || '' },
        body: JSON.stringify({ rate_limits: data.rate_limits, session_id: data.session_id, model }),
        signal: AbortSignal.timeout(500),
      });
    } catch {}
  }
  // 사용자가 원래 쓰던 상태줄: 프로젝트 로컬 > 프로젝트 > 사용자 설정 순으로 처음 찾은 것
  const cwd = data.workspace?.current_dir || data.cwd || process.cwd();
  const files = [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'), path.join(claudeHome(), 'settings.json')];
  for (const f of files) {
    let cmd;
    try { cmd = JSON.parse(fs.readFileSync(f, 'utf8')).statusLine?.command; } catch { continue; }
    // 사용자 설정의 상태줄이 이 명령이면(관리 설정 연결, userstatusline.js) 바꾸기 전에 기억해 둔 원래 명령을 쓴다
    if (cmd?.includes('statusline.mjs')) { try { cmd = JSON.parse(fs.readFileSync(savedPath(DATA_DIR), 'utf8')).statusLine?.command; } catch { cmd = null; } }
    if (!cmd || cmd.includes('statusline.mjs')) continue;
    // Claude Code 는 Windows 에서도 상태줄 명령을 bash 로 돌린다 — 기본(cmd.exe)으로 돌리면 $(…) 같은 sh 문법 명령이 깨진다
    const shell = process.platform === 'win32' ? process.env.CLAUDE_CODE_GIT_BASH_PATH || 'bash' : undefined;
    process.stdout.write(await runUserLine(cmd, cwd, shell));
    break;
  }
});

// 자식 트리 전체 종료. Windows 에선 셸만 죽이면 셸이 띄운 node(예: claude-hud)가 부모 없이 영구히 남는다
// (실측 2026-11-17: 4시간에 고아 9개 · 개당 35MB). execSync 의 timeout 은 셸만 죽이고, 손자가 출력 통로를 쥐고 있으면 반환도 안 했다
function killTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL'); // detached 로 띄워 프로세스 그룹 전체
    return true;
  } catch { return false; }
}

let running = null; // 실행 중인 사용자 상태줄 셸 — 이 프로세스가 신호로 끝날 때 함께 정리
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { if (running) killTree(running.pid); process.exit(0); });

function runUserLine(cmd, cwd, shell) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, { cwd, shell, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' }); }
    catch { return resolve(''); }
    running = child;
    const mark = child.pid ? path.join(PIDS_DIR, String(child.pid)) : null;
    if (mark) { try { fs.mkdirSync(PIDS_DIR, { recursive: true }); fs.writeFileSync(mark, String(Date.now())); } catch {} }
    let out = '', done = false;
    const finish = (text, killed) => {
      if (done) return; done = true;
      clearTimeout(timer); running = null;
      // 죽이기에 실패했으면(셸이 이미 없음) 표시 파일을 남겨 서버 정리에 맡긴다
      if (mark && (!killed || killed === 'ok')) { try { fs.unlinkSync(mark); } catch {} }
      resolve(text);
    };
    const timer = setTimeout(() => finish('', killTree(child.pid) ? 'ok' : 'fail'), USER_LINE_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => finish('', false));
    child.on('close', () => finish(out, false));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
