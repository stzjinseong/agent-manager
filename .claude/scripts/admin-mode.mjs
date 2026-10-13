// 담당 개발자 모드 (/admin) — CLAUDE.local.md 에 '이슈 올리기 묻지 않기' 줄을 넣거나 뺀다
//   node .claude/scripts/admin-mode.mjs [on | off | status]   (기본 on)
// CLAUDE.local.md 는 PC 마다 따로 두는 개인 설정이라 git 에 올라가지 않는다(.gitignore). 다른 내용은 건드리지 않는다
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const file = path.join(root, 'CLAUDE.local.md');
const BEGIN = '<!-- admin:begin -->', END = '<!-- admin:end -->';
const BLOCK = [
  BEGIN,
  '- 나는 agent-manager 담당 개발자다. 이슈 원인을 찾아도 GitHub 이슈 올리기를 묻지 않는다(CLAUDE.md 의 \'이슈 올리기\' 규칙 끔).',
  '  내가 `/report-issue` 를 직접 부르면 그때만 진행한다.',
  END,
].join('\n');
const HEAD = '# 이 PC 개인 설정 (git 에 올라가지 않음)\n';

const mode = process.argv[2] || 'on';
let s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
const re = new RegExp(`\\n?${BEGIN}[\\s\\S]*?${END}\\n?`);
// 예전에 손으로 넣은 같은 문장(표시 주석 없이)도 같은 설정으로 본다
const legacy = /^- 나는 agent-manager 담당 개발자다\..*\n(?: {2}.*\n?)*/m;
const isOn = re.test(s) || legacy.test(s);

if (mode === 'status') { console.log(isOn ? 'on' : 'off'); process.exit(0); }
if (mode === 'on') {
  if (isOn) { console.log(`이미 켜져 있음: ${file}`); process.exit(0); }
  s = (s.trim() ? s.trimEnd() + '\n\n' : HEAD + '\n') + BLOCK + '\n';
  fs.writeFileSync(file, s);
  console.log(`켬: ${file}`);
} else if (mode === 'off') {
  if (!isOn) { console.log('이미 꺼져 있음'); process.exit(0); }
  s = s.replace(re, '\n').replace(legacy, '').replace(/\n{3,}/g, '\n\n');
  if (!s.replace(HEAD, '').trim()) { fs.unlinkSync(file); console.log(`끔: ${file} 삭제(다른 내용 없음)`); }
  else { fs.writeFileSync(file, s.trimEnd() + '\n'); console.log(`끔: ${file}`); }
} else { console.error('사용법: admin-mode.mjs [on | off | status]'); process.exit(1); }
