// 설치된 Chrome 으로 대시보드 열기 — 다른 브라우저로 열었을 때 헤더 ⚠ 를 누르면 쓴다.
// 여는 주소는 서버가 정한다(이 대시보드 주소만, 화면이 보낸 주소는 받지 않음). 설치 위치는 OS 별 기본 경로로 찾는다
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

function findChrome() {
  if (process.platform === 'darwin') {
    const apps = ['/Applications/Google Chrome.app', path.join(os.homedir(), 'Applications/Google Chrome.app')];
    return apps.find((a) => fs.existsSync(a)) || null;
  }
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    return roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((f) => fs.existsSync(f)) || null;
  }
  for (const bin of ['google-chrome', 'google-chrome-stable']) {
    try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || null; } catch {}
  }
  return null;
}

let found; // 처음 물을 때 한 번 찾는다
export const chromePath = () => (found === undefined ? (found = findChrome()) : found);

export function openInChrome(url) {
  const app = chromePath();
  if (!app) return false;
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  if (process.platform === 'darwin') spawn('open', ['-a', app, url], opts).unref();
  else spawn(app, [url], opts).unref();
  return true;
}
