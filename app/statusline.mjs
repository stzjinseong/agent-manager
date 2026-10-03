// Claude Code statusLine 명령 → 관제탑 서버 전달기.
// Claude Code 는 상태줄을 그릴 때마다 세션 정보 JSON 을 stdin 으로 준다. 그 안의 rate_limits(구독 계정의 5시간·주간 한도
// 사용률과 초기화 시각)를 서버로 보내 상단 막대에 보여 준다(실측 v2.1.288: rate_limits.five_hour/seven_day.{used_percentage, resets_at}).
// 워커는 --settings 로 이 명령을 상태줄로 쓰므로 사용자가 원래 쓰던 상태줄을 가린다 → 그 명령을 같은 입력으로 실행해 출력을 그대로 낸다.
// 서버가 꺼져 있거나 늦어도 상태줄 표시를 막지 않게 짧게 기다리고 넘어간다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const worker = process.env.AGENT_MANAGER_WORKER;
const port = process.env.AGENT_MANAGER_PORT || '7788';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', async () => {
  let data = {};
  try { data = JSON.parse(input); } catch {}
  if (worker && data.rate_limits) {
    try {
      await fetch(`http://127.0.0.1:${port}/statusline?w=${worker}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rate_limits: data.rate_limits, session_id: data.session_id }),
        signal: AbortSignal.timeout(500),
      });
    } catch {}
  }
  // 사용자가 원래 쓰던 상태줄: 프로젝트 로컬 > 프로젝트 > 사용자 설정 순으로 처음 찾은 것
  const cwd = data.workspace?.current_dir || data.cwd || process.cwd();
  const files = [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'), path.join(os.homedir(), '.claude', 'settings.json')];
  for (const f of files) {
    let cmd;
    try { cmd = JSON.parse(fs.readFileSync(f, 'utf8')).statusLine?.command; } catch { continue; }
    if (!cmd || cmd.includes('statusline.mjs')) continue;
    try { process.stdout.write(execSync(cmd, { input, encoding: 'utf8', timeout: 3000, cwd, stdio: ['pipe', 'pipe', 'ignore'] })); } catch {}
    break;
  }
});
