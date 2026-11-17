// 상태줄 고아 정리 — statusline.mjs 가 사용자 상태줄 명령(예: claude-hud)을 띄운 셸 pid 를 data/statusline-pids/<pid> 로 남긴다.
// 정상 종료면 그 파일을 지우므로, 남아 있는 파일은 statusline.mjs 가 강제 종료됐거나 트리 종료에 실패한 경우다.
// Windows 는 부모가 죽어도 자식을 같이 죽이지 않아 그 셸이 띄운 node 가 영구히 남는다(실측: 4시간 고아 9개 · 개당 35MB).
// 남은 파일마다 그 셸과 셸의 자식을 찾아 트리째 종료한다. pid 재사용에 걸리지 않게 생성 시각이 기록 시각 근처인 것만 죽인다.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const GRACE_MS = 15_000; // 상태줄 명령 제한(3초)보다 넉넉히 — 아직 도는 정상 실행은 건드리지 않는다
const DROP_MS = 24 * 3600_000; // 이보다 오래된 기록은 확인 없이 지운다
const NEAR_MS = 10_000; // 셸·자식 생성 시각이 기록 시각에서 이만큼 안이면 같은 실행으로 본다

const ps = (script) => new Promise((resolve) => {
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 }, (err, out) => resolve(err ? '' : out));
});

export async function sweepStatuslineOrphans(dataDir) {
  if (process.platform !== 'win32') return 0;
  const dir = path.join(dataDir, 'statusline-pids');
  let names; try { names = fs.readdirSync(dir); } catch { return 0; }
  const now = Date.now(), marks = new Map();
  for (const n of names) {
    const f = path.join(dir, n);
    let at; try { at = Number(fs.readFileSync(f, 'utf8')) || fs.statSync(f).mtimeMs; } catch { continue; }
    if (now - at < GRACE_MS) continue;
    if (!/^\d+$/.test(n) || now - at > DROP_MS) { try { fs.unlinkSync(f); } catch {} continue; }
    marks.set(Number(n), { at, f });
  }
  if (!marks.size) return 0;
  // Claude Code 는 상태줄을 다시 그릴 때 이전 실행을 강제 종료하는 일이 잦아 기록이 많이 남는다(실측: 20분에 150개).
  // pid 마다 조건을 붙이면 조회식이 끝없이 길어지므로 전체 목록을 한 번 받아 여기서 맞춘다
  const out = await ps(`Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }`);
  if (!out) return 0; // 조회 실패 — 기록은 남겨 다음에 다시
  const kill = new Set();
  for (const line of out.split(/\r?\n/)) {
    const [pid, ppid, born] = line.trim().split(' ').map(Number);
    if (!pid) continue;
    const m = marks.get(pid) || marks.get(ppid);
    if (m && Math.abs(born - m.at) < NEAR_MS) kill.add(pid);
  }
  await Promise.all([...kill].map((pid) => new Promise((r) => execFile('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () => r()))));
  for (const { f } of marks.values()) { try { fs.unlinkSync(f); } catch {} }
  return kill.size;
}
