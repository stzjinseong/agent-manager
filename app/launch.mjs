// 실행기 — 최상위의 Launch.bat / Launch.vbs 가 부른다.
// 서버가 이미 떠 있으면 브라우저만 열고, 아니면 서버를 창 없이 백그라운드로 띄운 뒤 준비되면 브라우저를 연다.
// 서버 로그는 data/server.log (창이 없으니 문제가 생기면 여기를 본다).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { L, cliLocale } from './cli-lang.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(APP_DIR);
const DATA_DIR = process.env.AM_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.AM_PORT || 7788);
const URL = `http://127.0.0.1:${PORT}/`;
const LOG = path.join(DATA_DIR, 'server.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function isUp() {
  try { return (await fetch(`${URL}api/state`)).ok; } catch { return false; }
}

const IS_WIN = process.platform === 'win32';

function openBrowser() {
  if (IS_WIN) spawn('cmd.exe', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [URL], { detached: true, stdio: 'ignore' }).unref();
}

// 창 없이 실행됐을 때도 실패를 알 수 있게 메시지 상자로
function alertBox(text) {
  if (IS_WIN) {
    const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${text.replace(/'/g, "''")}', '${L('클로드 키우기', 'Clawdgotchi')}') | Out-Null`;
    spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  } else if (process.platform === 'darwin') {
    const as = `display dialog "${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with title "${L('클로드 키우기', 'Clawdgotchi')}" buttons {"${L('확인', 'OK')}"} default button 1`;
    spawn('osascript', ['-e', as], { stdio: 'ignore', detached: true }).unref();
  }
}

// 서버 재시작 요청으로 불린 경우: 기존 서버가 내려갈 때까지(최대 10초) 기다린 뒤 새로 띄운다
if (process.env.AM_WAIT_FREE) {
  for (let i = 0; i < 40 && (await isUp()); i++) await sleep(250);
}

if (!(await isUp())) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 로그가 5MB 를 넘으면 새로 시작
  try { if (fs.statSync(LOG).size > 5 * 1024 * 1024) fs.writeFileSync(LOG, ''); } catch {}
  const out = fs.openSync(LOG, 'a');
  fs.writeSync(out, `\n===== ${new Date().toLocaleString(cliLocale())} ${L('서버 시작', 'server start')} =====\n`);
  spawn(process.execPath, [path.join(APP_DIR, 'server.js')], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, out],
  }).unref();
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { await sleep(250); ok = await isUp(); }
  if (!ok) {
    alertBox(L(`서버를 시작하지 못했습니다.\n로그: ${LOG}`, `The server failed to start.\nLog: ${LOG}`));
    console.error(L(`서버 시작 실패 — 로그: ${LOG}`, `Server failed to start — log: ${LOG}`));
    process.exit(1);
  }
}
if (!process.env.AM_NO_BROWSER) openBrowser();
