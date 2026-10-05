// Windows 설치 — `npm run setup-win` (npm install 다음에 한 번)
//  PowerShell 프로필에 `agent-manager` 명령을 등록한다: 창 없는 실행기(Launch.vbs)를 연다 (macOS 의 setup-mac 3단계와 같은 동작)
//  - Windows PowerShell 5.1 과, 설치돼 있으면 PowerShell 7(pwsh) 프로필 모두
//  - 표식 블록(# >>> agent-manager >>>)으로 넣어 다시 실행하면 경로만 갱신. 표식 없이 직접 적어 둔 `function agent-manager` 줄은 블록으로 바꾼다
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { L } from './cli-lang.js';

if (process.platform !== 'win32') {
  console.log(L('Windows 전용 설치 스크립트입니다. macOS 는 npm run setup-mac 을 쓰세요.', 'This setup script is for Windows only. On macOS, use npm run setup-mac.'));
  process.exit(0);
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vbs = path.join(ROOT, 'Launch.vbs');
if (!fs.existsSync(vbs)) { console.error(L(`✗ ${vbs} 가 없습니다`, `✗ ${vbs} not found`)); process.exit(1); }

const sq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell 작은따옴표 인용
const BEGIN = '# >>> agent-manager >>>', END = '# <<< agent-manager <<<';
const block = `${BEGIN}\r\nfunction agent-manager { Start-Process wscript.exe -ArgumentList ${sq(`"${vbs}"`)} -WorkingDirectory ${sq(ROOT)} }\r\n${END}\r\n`;

// 문서 폴더가 OneDrive 로 옮겨졌을 수 있어 경로는 PowerShell 에게 직접 묻는다
function ask(exe, cmd) {
  try { return execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return null; }
}
const shells = [['powershell.exe', 'Windows PowerShell 5.1'], ['pwsh.exe', 'PowerShell 7']]
  .map(([exe, label]) => ({ exe, label, profile: ask(exe, '$PROFILE.CurrentUserCurrentHost'), policy: ask(exe, 'Get-ExecutionPolicy') }))
  .filter((s) => s.profile);

let ok = 0;
for (const s of shells) {
  const file = s.profile;
  let cur = '', bom = true;
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    try { cur = new TextDecoder('utf-8', { fatal: true }).decode(bom ? buf.subarray(3) : buf); } catch {
      // ANSI(cp949 등) 프로필을 UTF-8 로 다시 쓰면 기존 한글이 깨진다 → 건드리지 않고 직접 넣을 줄을 알려 준다
      console.log(L(`! ${s.label}: 프로필이 UTF-8 이 아니라 건드리지 않았습니다 — ${file} 에 아래 줄을 직접 추가하세요`, `! ${s.label}: the profile is not UTF-8, so it was left untouched — add this line to ${file} yourself`) + `\n  ${block.split('\r\n')[1]}`);
      continue;
    }
  }
  const hasBlock = cur.includes(BEGIN);
  const loose = /^[ \t]*function[ \t]+agent-manager\b.*(\r?\n|$)/m;
  let next;
  if (hasBlock) next = cur.replace(/# >>> agent-manager >>>[\s\S]*?# <<< agent-manager <<<\r?\n?/, block);
  else if (loose.test(cur)) next = cur.replace(loose, block);
  else next = `${cur}${cur && !/\n$/.test(cur) ? '\r\n' : ''}${cur ? '\r\n' : ''}${block}`;
  if (next === cur) { console.log(L(`✓ ${s.label}: 이미 등록됨 (${file})`, `✓ ${s.label}: already registered (${file})`)); ok++; continue; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 5.1 은 BOM 없는 UTF-8 을 ANSI 로 읽어 한글 경로가 깨질 수 있다 → 새 파일이거나 원래 BOM 이 있었으면 BOM 을 붙인다.
  // 원래 BOM 없는 UTF-8 이었는데 이번에 비 ASCII 가 들어가면 그때도 붙인다
  const needBom = bom || /[^\x00-\x7f]/.test(next);
  fs.writeFileSync(file, Buffer.concat([needBom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(next, 'utf8')]));
  const how = hasBlock ? L('갱신', 'updated') : loose.test(cur) ? L('교체(직접 적어 둔 줄 → 표식 블록)', 'replaced (hand-written line → marked block)') : L('추가', 'added');
  console.log(L(`✓ ${s.label}: agent-manager 명령 ${how} (${file})`, `✓ ${s.label}: agent-manager command ${how} (${file})`));
  ok++;
  // 프로필이 아예 안 읽히는 실행 정책이면 알려 준다 (정책은 바꾸지 않는다 — 사용자가 결정)
  if (/^(Restricted|AllSigned|Undefined)$/i.test(s.policy || '') && s.policy !== null) {
    console.log(L(`  ! 실행 정책이 ${s.policy} 라 프로필이 로드되지 않을 수 있습니다. 쓰려면 한 번:`, `  ! The execution policy is ${s.policy}, so the profile may not load. To use it, run once:`) + '\n    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned');
  }
}

if (!shells.length) { console.error(L('✗ PowerShell 을 찾지 못했습니다', '✗ PowerShell not found')); process.exit(1); }
console.log(ok ? L('\n완료. 새 PowerShell 창에서 agent-manager 를 입력하면 대시보드가 열립니다 (지금 창은 . $PROFILE 후).', '\nDone. Type agent-manager in a new PowerShell window to open the dashboard (in this one, run . $PROFILE first).')
  : L('\n프로필을 바꾸지 못했습니다. 위 안내대로 직접 추가하세요.', '\nCould not update the profile. Add the line yourself as described above.'));
