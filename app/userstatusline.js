// 관리 설정(managed settings)이 상태줄을 정한 PC 에서도 계정 사용량을 받기 위한 연결.
//
// 워커는 --settings 로 statusline.mjs 를 상태줄로 건다. 그런데 관리 설정(조직이 내려주는 서버 관리 설정, 또는
// PC 의 managed-settings.json)에 statusLine 이 있으면 그것이 우선이라 --settings 의 상태줄은 아예 실행되지 않는다
// (실측 v2.1.321: 워커 5개 · 디버그 세션 모두 statusline.mjs 미실행 → usage.json 이 멈춰 막대가 0%).
// 관리 상태줄 중에는 끝에서 사용자 설정(~/.claude/settings.json)의 statusLine 을 같은 입력으로 이어 실행하는 것이 있다 —
// 그 자리에 statusline.mjs 를 두고, 원래 사용자 상태줄은 기억해 두었다가 statusline.mjs 가 이어 실행한다.
// 관리 설정이 상태줄을 정하지 않으면 사용자 설정을 건드리지 않고, 예전에 바꿔 둔 것이 있으면 원래대로 돌린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const userSettingsPath = () => path.join(claudeHome(), 'settings.json');
// 바꾸기 전 사용자 상태줄 — statusline.mjs 가 이어 실행할 명령
export const savedPath = (dataDir) => path.join(dataDir, 'user-statusline.json');

function managedSettingsFiles() {
  const files = [path.join(claudeHome(), 'remote-settings.json')];
  if (process.platform === 'win32') files.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json'));
  else if (process.platform === 'darwin') files.push('/Library/Application Support/ClaudeCode/managed-settings.json');
  else files.push('/etc/claude-code/managed-settings.json');
  return files;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
export const managedStatusLine = () => managedSettingsFiles().some((f) => readJson(f)?.statusLine);
const isOurs = (cmd) => typeof cmd === 'string' && cmd.includes('statusline.mjs');

// 사용자 설정을 고쳐 쓴다 — 읽기 실패(깨진 JSON 등)면 손대지 않는다. 처음 바꿀 때 원본을 .agent-manager.bak 으로 남긴다
function writeUserSettings(mutate) {
  const p = userSettingsPath();
  let raw = '{}';
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return false; }
  let s;
  try { s = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return false; }
  if (!mutate(s)) return false;
  try {
    if (!fs.existsSync(`${p}.agent-manager.bak`) && fs.existsSync(p)) fs.copyFileSync(p, `${p}.agent-manager.bak`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
    return true;
  } catch { return false; }
}

// 서버 시작 때 부른다. command = 워커 --settings 에 넣는 것과 같은 statusline.mjs 실행 명령. 결과를 짧게 돌려준다(로그용)
export function linkUserStatusLine({ dataDir, command }) {
  const saved = savedPath(dataDir);
  if (!managedStatusLine()) {
    // 관리 상태줄이 없어졌다 — 우리가 바꿔 둔 것이면 원래 상태줄로 돌린다
    const prev = readJson(saved);
    if (!prev) return 'none';
    const ok = writeUserSettings((s) => {
      if (!isOurs(s.statusLine?.command)) return false;
      if (prev.statusLine) s.statusLine = prev.statusLine; else delete s.statusLine;
      return true;
    });
    try { fs.unlinkSync(saved); } catch {}
    return ok ? 'restored' : 'none';
  }
  let result = 'kept';
  writeUserSettings((s) => {
    const cur = s.statusLine;
    if (isOurs(cur?.command)) {
      if (cur.command === command) return false;
      s.statusLine = { ...cur, command }; // node · 앱 경로가 바뀌었다
      result = 'updated';
      return true;
    }
    fs.writeFileSync(saved, JSON.stringify({ statusLine: cur || null }, null, 2));
    s.statusLine = { ...(cur || {}), type: 'command', command };
    result = 'linked';
    return true;
  });
  return result;
}
