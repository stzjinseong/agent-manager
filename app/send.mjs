// 연결된 워커에게 메시지 보내기 (links.js) — 워커 안의 클로드가 Bash 로 부른다.
//   node send.mjs W2 "내용"
//   node send.mjs W2 --file 경로      (긴 글 · 따옴표가 많은 글)
//   echo 내용 | node send.mjs W2 -
// 보내는 쪽 번호는 환경 변수(AGENT_MANAGER_WORKER)에서 — 클로드 키우기가 띄운 워커 안에서만 통한다.
import fs from 'node:fs';
import { readToken, TOKEN_HEADER } from './auth.js';

const from = process.env.AGENT_MANAGER_WORKER;
const port = process.env.AGENT_MANAGER_PORT || '7788';
const [rawTo = '', ...rest] = process.argv.slice(2);
// '3' · 'w3' 도 W3 로 — 실측: 클로드가 번호만(3) 넣어 거부된 적이 있다
const to = /^w?\d+$/i.test(rawTo) ? `W${rawTo.replace(/^w/i, '')}` : rawTo;
const fail = (msg) => { console.error(msg); process.exit(1); };

if (!from) fail('클로드 키우기가 띄운 워커 안에서만 보낼 수 있습니다 (AGENT_MANAGER_WORKER 없음)');
if (!/^W\d+$/.test(to || '')) fail('사용법: node send.mjs <워커번호 예: W2> "<내용>" | --file <경로> | -');

let text;
if (rest[0] === '--file') {
  if (!rest[1]) fail('--file 뒤에 경로가 필요합니다');
  try { text = fs.readFileSync(rest[1], 'utf8'); } catch (e) { fail(`파일을 읽지 못했습니다: ${e.message}`); }
} else if (rest[0] === '-') text = fs.readFileSync(0, 'utf8');
else text = rest.join(' ');
if (!text.trim()) fail('보낼 내용이 비었습니다');

try {
  const r = await fetch(`http://127.0.0.1:${port}/api/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [TOKEN_HEADER]: readToken() || '' },
    body: JSON.stringify({ from, to, text }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) fail(`보내지 못했습니다: ${body.error || r.status}`);
  console.log(body.note || `${to} 에게 보냈습니다`);
} catch (e) {
  fail(`클로드 키우기 서버에 닿지 못했습니다: ${e.message}`);
}
