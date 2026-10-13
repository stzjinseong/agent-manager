// GitHub 이슈 올리기 (/report-issue)
//   node .claude/scripts/open-issue.mjs <제목 파일> <본문 파일> [--check]
//  · gh(GitHub CLI)가 있고 로그인돼 있으면 바로 올리고 이슈 주소를 출력한다
//  · 아니면 제목·본문을 채운 '새 이슈' 페이지를 기본 브라우저로 연다(사용자가 Submit 만 누르면 됨)
//    주소 길이 한계로 본문이 길면 잘라 넣고, 전체 본문은 클립보드에 복사해 둔다
//  · --check: 올리지 않고 어느 방식으로 올라갈지만 출력 (gh | browser)
// 저장소는 git remote origin 에서 읽는다
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

const [titleFile, bodyFile, flag] = process.argv.slice(2);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });

const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
if (!m) { console.error(`GitHub 저장소가 아님: ${remote}`); process.exit(1); }
const repo = `${m[1]}/${m[2]}`;

const gh = run('gh', ['auth', 'status']);
const useGh = gh.status === 0;
if (flag === '--check') { console.log(useGh ? 'gh' : 'browser'); process.exit(0); }
if (!titleFile || !bodyFile) { console.error('사용법: open-issue.mjs <제목 파일> <본문 파일>'); process.exit(1); }

const title = fs.readFileSync(titleFile, 'utf8').trim();
const body = fs.readFileSync(bodyFile, 'utf8');

if (useGh) {
  const r = run('gh', ['issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyFile]);
  if (r.status === 0) { console.log(`gh: ${r.stdout.trim()}`); process.exit(0); }
  console.error(`gh 로 올리지 못해 브라우저로 엽니다: ${(r.stderr || '').trim()}`);
}

// 주소가 너무 길면 브라우저·GitHub 가 거절한다 — 본문을 잘라 넣고 전체는 클립보드로
const MAX_URL = 7000;
const base = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=`;
let shown = body, cut = false;
while (base.length + encodeURIComponent(shown).length > MAX_URL) { shown = shown.slice(0, Math.floor(shown.length * 0.9)); cut = true; }
if (cut) {
  shown += '\n\n…(본문이 길어 잘렸습니다 — 클립보드의 전체 본문으로 바꿔 붙여 넣으세요)';
  const clip = process.platform === 'win32' ? ['powershell', ['-NoProfile', '-Command', '$input | Set-Clipboard']]
    : process.platform === 'darwin' ? ['pbcopy', []] : ['xclip', ['-selection', 'clipboard']];
  run(clip[0], clip[1], { input: body });
}
const url = base + encodeURIComponent(shown);
if (process.platform === 'win32') run('rundll32', ['url.dll,FileProtocolHandler', url]);
else run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
console.log(`browser${cut ? ' (본문 잘림 · 전체는 클립보드)' : ''}: https://github.com/${repo}/issues/new`);
