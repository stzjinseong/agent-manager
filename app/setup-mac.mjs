// macOS 설치 — `npm run setup-mac` (Mac 에서 npm install 다음에 한 번)
//  1) Launch.command 에 실행 권한
//  2) 창 없이 실행하는 Launch.app 생성 (Windows 의 Launch.vbs 에 해당)
//     .app 은 이 Mac 의 node 절대 경로를 품기 때문에 저장소에 올리지 않고 Mac 마다 만든다(.gitignore)
//  3) 터미널 명령 `agent-manager` 를 ~/.zshrc 에 추가 (이미 있으면 건너뜀)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { L } from './cli-lang.js';

if (process.platform !== 'darwin') {
  console.log(L('macOS 전용 설치 스크립트입니다. Windows 는 Launch.vbs / Launch.bat 을 쓰세요.', 'This setup script is for macOS only. On Windows, use Launch.vbs / Launch.bat.'));
  process.exit(0);
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // sh 작은따옴표 인용

// 1) Launch.command 실행 권한
const cmd = path.join(ROOT, 'Launch.command');
fs.chmodSync(cmd, 0o755);
console.log(L('✓ Launch.command 실행 권한', '✓ Launch.command made executable'));

// 2) Launch.app — 앱 위치의 상위 폴더(프로젝트)에서 launch.mjs 를 백그라운드로 실행
//    Finder 로 띄운 앱은 PATH 가 최소한이라 흔한 node 위치를 PATH 에 보탠다. 절대 경로를 박지 않는 이유:
//    Homebrew 의 Cellar 경로는 node 를 업그레이드하면 사라진다 — /opt/homebrew/bin/node 같은 고정 링크로 찾게 한다
const appPath = path.join(ROOT, 'Launch.app');
const shell = `export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:${path.dirname(NODE)}"; ` +
  `cd "$PROJ" && node app/launch.mjs > /dev/null 2>&1 &`;
const appleScript = [
  'set appPath to POSIX path of (path to me)',
  'set projDir to do shell script "dirname " & quoted form of appPath',
  `do shell script "PROJ=" & quoted form of projDir & "; " & ${JSON.stringify(shell)}`,
].join('\n');
fs.rmSync(appPath, { recursive: true, force: true });
execFileSync('osacompile', ['-o', appPath, '-e', appleScript]);
console.log(L(`✓ Launch.app 생성 (node: ${NODE})`, `✓ Launch.app created (node: ${NODE})`));

// 3) agent-manager 명령 (Windows PowerShell 프로필과 같은 동작: 창 없는 실행기를 연다)
const rc = path.join(os.homedir(), '.zshrc');
const begin = '# >>> agent-manager >>>';
const block = `${begin}\nagent-manager() { open ${q(appPath)}; }\n# <<< agent-manager <<<\n`;
const cur = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
if (cur.includes(begin)) {
  // 경로가 바뀌었을 수 있으니 블록만 새로 쓴다
  fs.writeFileSync(rc, cur.replace(/# >>> agent-manager >>>[\s\S]*?# <<< agent-manager <<<\n?/, block));
  console.log(L('✓ ~/.zshrc 의 agent-manager 명령 갱신', '✓ Updated the agent-manager command in ~/.zshrc'));
} else {
  fs.appendFileSync(rc, `\n${block}`);
  console.log(L('✓ ~/.zshrc 에 agent-manager 명령 추가 (새 터미널부터 적용, 지금 창은 `source ~/.zshrc`)', '✓ Added the agent-manager command to ~/.zshrc (new terminals pick it up; in this one run `source ~/.zshrc`)'));
}

console.log(L('\n완료. Launch.app 을 처음 열 때 보안 경고가 뜨면 Finder 에서 우클릭 → 열기 를 한 번 하세요.', '\nDone. If a security warning appears the first time you open Launch.app, right-click → Open it once in Finder.'));
