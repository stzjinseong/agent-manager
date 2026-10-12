// OS 다운로드 폴더 경로를 출력한다 (/release-notes 저장 위치)
//  · Windows: 다운로드 폴더를 다른 곳으로 옮겨 둔 경우까지 레지스트리(User Shell Folders)에서 읽는다
//  · macOS·기타: ~/Downloads
//  · 폴더가 없으면 홈 폴더
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

let dir = path.join(os.homedir(), 'Downloads');
if (process.platform === 'win32') {
  try {
    const out = execFileSync('reg', ['query', String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`, '/v', '{374DE290-123F-4565-9164-39C4925E467B}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
    if (m) dir = m[1].trim().replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? '');
  } catch {}
}
if (!fs.existsSync(dir)) dir = os.homedir();
console.log(dir);
