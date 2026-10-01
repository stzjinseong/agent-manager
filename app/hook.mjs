// Claude Code command 훅 → 관제탑 서버 전달기.
// stdin 의 훅 이벤트 JSON 을 서버로 POST 하고, 서버 응답(JSON)을 그대로 stdout 으로 돌려준다.
// 서버가 꺼져 있으면 아무것도 출력하지 않고 exit 0 — 세션 동작에 영향을 주지 않는다.
const worker = process.env.AGENT_MANAGER_WORKER;
const port = process.env.AGENT_MANAGER_PORT || '7788';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  if (!worker) return;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/hook?w=${worker}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: input });
    const body = await r.text();
    if (body && body !== '{}') process.stdout.write(body);
  } catch {}
});
