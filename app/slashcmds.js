// 채팅 입력칸의 / 자동 완성 — 그 워커에서 쓸 수 있는 슬래시 명령 목록.
//  · 기본 명령: 설명을 붙여 적어 둔 것(아래 BUILTIN) + Claude Code 에 물어 받은 목록(liveCommands — 버전이 올라 새로 생긴 명령도 잡힌다.
//    설명이 없어 이름만). 받은 목록은 '화면 없이 쓸 수 있는 명령'이라 /btw · /resume · /rewind 같은 화면 전용 명령은 빠진다 → BUILTIN 에 적어 둔다
//  · 사용자 명령: <작업 폴더>/.claude/commands · ~/.claude/commands 의 *.md (하위 폴더는 이름에 ':' 로 이음)
//  · 스킬: <작업 폴더>/.claude/skills · ~/.claude/skills 의 <이름>/SKILL.md
//  · 플러그인: ~/.claude/plugins/installed_plugins.json 에서 켜진 것(settings.json enabledPlugins)의 commands · skills → '플러그인:이름'
// 설명은 각 파일 머리말(frontmatter)의 description, 인자 힌트는 argument-hint(입력칸에서 '/명령 ' 뒤에 보여 준다). 폴더를 매번 훑지 않게 작업 폴더마다 30초 담아 둔다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BUILTIN = [
  ['clear', '대화 기록을 지우고 새로 시작'],
  ['btw', '작업을 멈추지 않고 곁질문 — 답은 따로 뜨고 대화 기록에 안 남음', '<질문>'],
  ['compact', '대화를 요약해 컨텍스트 줄이기', '[요약에 남길 지시]'],
  ['context', '컨텍스트 사용량 보기'],
  ['cost', '이 세션의 토큰 · 비용'],
  ['usage', '요금제 사용량 한도'],
  ['model', '모델 바꾸기', '[모델 이름]'],
  ['fast', '빠른 모드 켜기/끄기'],
  ['resume', '지난 대화 이어 하기', '[세션 ID 또는 검색어]'],
  ['rewind', '대화 · 코드를 앞 시점으로 되돌리기'],
  ['memory', 'CLAUDE.md 메모리 고치기'],
  ['init', '이 프로젝트의 CLAUDE.md 만들기'],
  ['review', '코드 리뷰', '[PR 번호]'],
  ['security-review', '바뀐 코드 보안 검토'],
  ['config', '설정 열기'],
  ['permissions', '도구 권한 규칙 보기 · 고치기'],
  ['agents', '서브에이전트 관리'],
  ['mcp', 'MCP 서버 관리'],
  ['hooks', '훅 설정 보기'],
  ['plugin', '플러그인 관리'],
  ['add-dir', '작업 폴더 더하기', '<폴더 경로>'],
  ['todos', '할 일 목록 보기'],
  ['bashes', '백그라운드 셸 보기'],
  ['export', '대화를 파일 · 클립보드로 내보내기', '[파일 이름]'],
  ['status', '버전 · 모델 · 계정 상태'],
  ['doctor', '설치 상태 점검'],
  ['release-notes', '릴리즈 노트 보기'],
  ['statusline', '상태줄 설정'],
  ['output-style', '응답 스타일 바꾸기'],
  ['ide', 'IDE 연결'],
  ['feedback', '피드백 · 버그 보내기'],
  ['help', '도움말'],
  ['login', '로그인 · 계정 바꾸기'],
  ['logout', '로그아웃'],
  ['exit', 'Claude Code 끝내기'],
];

const HOME = path.join(os.homedir(), '.claude');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// 머리말의 description 한 줄 (따옴표 · 여러 줄 블록(|, >)은 첫 줄만) · argument-hint
function metaOf(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { return { desc: '', hint: '' }; }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const hint = (fm?.[1].match(/^argument-hint:\s*(.*)$/m)?.[1] || '').trim().replace(/^["']|["']$/g, '').slice(0, 120);
  return { desc: descOf(text), hint };
}
function descOf(text) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm?.[1].match(/^description:\s*(.*)$/m);
  // 머리말이 없으면 본문 첫 줄(제목 # 은 떼고) — Claude Code 도 그렇게 보여 준다
  if (!m) return (text.slice(fm ? fm[0].length : 0).split(/\r?\n/).find((l) => l.trim()) || '').replace(/^#+\s*/, '').trim().slice(0, 160);
  let v = m[1].trim();
  if (/^[|>]-?$/.test(v)) v = (fm[1].split(/\r?\n/)[fm[1].split(/\r?\n/).findIndex((l) => l.startsWith('description:')) + 1] || '').trim();
  return v.replace(/^["']|["']$/g, '').slice(0, 160);
}
// commands 폴더: a.md → a, sub/b.md → sub:b
function commandsIn(dir, prefix, src, out) {
  const walk = (d, ns) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name), [...ns, e.name]);
      else if (e.name.endsWith('.md')) out.push({ name: prefix + [...ns, e.name.slice(0, -3)].join(':'), ...metaOf(path.join(d, e.name)), src });
    }
  };
  walk(dir, []);
}
function skillsIn(dir, prefix, src, out) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) { // 링크(정션)로 걸린 스킬 폴더도 보게 isDirectory() 로 거르지 않는다
    const f = path.join(dir, e.name, 'SKILL.md');
    if (fs.existsSync(f)) out.push({ name: prefix + e.name, ...metaOf(f), src });
  }
}
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function pluginDirs(cwd) {
  const inst = readJson(path.join(HOME, 'plugins', 'installed_plugins.json'))?.plugins || {};
  const on = { ...(readJson(path.join(HOME, 'settings.json'))?.enabledPlugins || {}), ...(cwd ? readJson(path.join(cwd, '.claude', 'settings.json'))?.enabledPlugins || {} : {}) };
  const out = [];
  for (const [key, list] of Object.entries(inst)) {
    if (on[key] === false) continue;
    const hit = (list || []).find((x) => x.scope === 'user' || (cwd && x.projectPath && samePath(x.projectPath, cwd)));
    if (hit?.installPath) out.push({ name: key.split('@')[0], dir: hit.installPath });
  }
  return out;
}

// Claude Code 에 직접 물어 받는 명령 목록 — 헤드리스(-p)로 '/cost' 를 보내면 시작 알림(init)에 그 작업 폴더에서 쓸 수 있는 명령 이름이
// 모두 온다(기본 · 스킬 · 플러그인 · MCP 프롬프트). /cost 는 모델을 부르지 않아 비용 0, 약 10초(실측 v2.1.317 · 82개). 세션 파일은 남기지 않는다.
// 작업 폴더마다 12시간 담아 두고, 처음 묻는 동안은 파일에서 찾은 목록만 돌려준다(받으면 다음 요청부터 합쳐짐)
const LIVE_TTL = 12 * 3600_000;
const live = new Map(); // cwd → { at, names } | { pending: true }
function fetchLive(bin, cwd) {
  const key = cwd || '';
  const cur = live.get(key);
  if (!bin || cur?.pending || (cur && Date.now() - cur.at < LIVE_TTL)) return;
  live.set(key, { ...cur, pending: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|AGENT_MANAGER_.*)$/.test(k)) delete env[k];
  let done = false, buf = '';
  const finish = (names) => {
    if (done) return; done = true;
    clearTimeout(timer);
    try { p.kill(); } catch {}
    live.set(key, names ? { at: Date.now(), names } : { at: Date.now() - LIVE_TTL + 600_000, names: cur?.names || [] }); // 실패면 10분 뒤 다시
    cache.delete(key);
  };
  let p;
  try {
    p = spawn(bin, ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '/cost'], { cwd: cwd || undefined, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch { finish(null); return; }
  const timer = setTimeout(() => finish(null), 60_000);
  p.on('error', () => finish(null));
  p.on('exit', () => finish(null));
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      try { const j = JSON.parse(l); if (j.type === 'system' && j.subtype === 'init' && Array.isArray(j.slash_commands)) return finish(j.slash_commands.filter((n) => typeof n === 'string' && /^[\w][\w:.-]*$/.test(n))); } catch {}
    }
  });
}

const cache = new Map(); // cwd → { at, list }
export function slashCommands(cwd, bin) {
  fetchLive(bin, cwd);
  const c = cache.get(cwd || '');
  if (c && Date.now() - c.at < 30_000) return c.list;
  const out = [];
  if (cwd) { commandsIn(path.join(cwd, '.claude', 'commands'), '', 'project', out); skillsIn(path.join(cwd, '.claude', 'skills'), '', 'project', out); }
  commandsIn(path.join(HOME, 'commands'), '', 'user', out);
  skillsIn(path.join(HOME, 'skills'), '', 'user', out);
  for (const p of pluginDirs(cwd)) { commandsIn(path.join(p.dir, 'commands'), `${p.name}:`, 'plugin', out); skillsIn(path.join(p.dir, 'skills'), `${p.name}:`, 'plugin', out); }
  // 같은 이름은 먼저 찾은 것(프로젝트 > 사용자 > 플러그인)만, 기본 명령은 맨 뒤 — 사용자가 만든 같은 이름 명령이 기본보다 먼저 보이게
  const seen = new Set(), list = [];
  const got = (live.get(cwd || '')?.names || []).map((name) => ({ name, desc: '', hint: '', src: name.startsWith('mcp__') ? 'mcp' : 'builtin' }));
  for (const x of [...out, ...BUILTIN.map(([name, desc, hint = '']) => ({ name, desc, hint, src: 'builtin' })), ...got]) if (!seen.has(x.name)) { seen.add(x.name); list.push(x); }
  cache.set(cwd || '', { at: Date.now(), list });
  return list;
}
