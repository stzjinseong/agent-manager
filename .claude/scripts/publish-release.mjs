// GitHub 릴리즈 만들기 — /release 마지막 단계. gh 가 없어도 되게 git 이 저장해 둔 GitHub 로그인(git credential)으로 API 를 부른다.
// 토큰은 이 프로세스 안에서만 쓰고 출력하지 않는다.
//   node .claude/scripts/publish-release.mjs <태그> <릴리즈 노트 txt>
// 본문은 노트 txt 에서 맨 위 제목 줄(과 그 뒤 빈 줄)을 뺀 것 — 앱의 릴리즈 노트 화면이 이 본문을 그대로 보여 준다.
// 출력: 성공이면 "201 <릴리즈 주소>", 이미 있으면 "exists <주소>", 실패면 상태 코드와 메시지(종료 코드 1)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [tag, notesPath] = process.argv.slice(2);
if (!tag || !notesPath) { console.error('사용법: publish-release.mjs <태그> <노트 txt>'); process.exit(1); }

const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
if (!m) { console.error(`GitHub 저장소가 아닙니다: ${remote}`); process.exit(1); }
const [, owner, repo] = m;

const cred = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
const token = cred.match(/^password=(.*)$/m)?.[1];
if (!token) { console.error('git 에 저장된 GitHub 로그인이 없습니다 — 한 번 git push 로 로그인한 뒤 다시 실행하세요'); process.exit(1); }

const lines = fs.readFileSync(notesPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
const body = lines.slice(lines[1]?.trim() === '' ? 2 : 1).join('\n').trim() + '\n';

const api = `https://api.github.com/repos/${owner}/${repo}/releases`;
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'agent-manager-release' };
const r = await fetch(api, { method: 'POST', headers, body: JSON.stringify({ tag_name: tag, name: tag, body, target_commitish: 'dev', draft: false, prerelease: false }) });
const j = await r.json().catch(() => ({}));
if (r.status === 201) { console.log(`201 ${j.html_url}`); process.exit(0); }
if (r.status === 422 && JSON.stringify(j.errors || '').includes('already_exists')) { console.log(`exists https://github.com/${owner}/${repo}/releases/tag/${tag}`); process.exit(0); }
console.error(`${r.status} ${j.message || ''} ${JSON.stringify(j.errors || '')}`);
process.exit(1);
