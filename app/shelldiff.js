// 셸 명령(Bash)으로 바뀐 파일 — 트랜스크립트엔 명령만 남고 바뀐 내용이 없어서, 명령 전후의 작업 폴더를 git 으로 찍어 비교한다.
//  · 찍기: 사용자 인덱스(.git/index)는 건드리지 않고 임시 인덱스에 `git add -A` → `git write-tree` (.gitignore 는 존중)
//    임시 인덱스는 처음에 사용자 인덱스를 복사해 시작한다 — 파일 시각 캐시를 물려받아 바뀐 파일만 다시 읽는다
//  · 비교: `git diff <전> <후>` 를 Edit 결과(structuredPatch)와 같은 모양의 hunk 로 바꾼다
//  · git 저장소가 아니거나 git 이 없으면 null — 그 폴더의 셸 수정은 추적하지 못한다
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const IDX_DIR = path.join(os.tmpdir(), 'agent-manager-idx');

function git(cwd, args, env, timeout = 8000) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd, env: { ...process.env, ...env }, maxBuffer: 64 << 20, timeout, windowsHide: true },
      (err, out) => resolve(err ? null : out));
  });
}

// 폴더 → 저장소 정보. 같은 저장소의 찍기는 한 줄로 세운다(임시 인덱스를 함께 쓰므로)
const repos = new Map();
async function repoOf(cwd) {
  if (repos.has(cwd)) return repos.get(cwd);
  const out = await git(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  let r = null;
  if (out) {
    const [root, gitDir] = out.trim().split('\n');
    const prev = [...repos.values()].find((x) => x?.root === root);
    r = prev || { root, gitDir, idx: path.join(IDX_DIR, crypto.createHash('sha1').update(root).digest('hex').slice(0, 16)), queue: Promise.resolve(), last: null };
  }
  if (r) repos.set(cwd, r); // 실패(저장소 아님·git 없음·시간 초과)는 기억하지 않는다 — 다음 명령 때 다시 확인(그사이 git init 한 폴더도 잡힌다)
  return r;
}

// 지금 작업 폴더 상태를 트리 하나로 → { repo, tree, t } | null
export async function snapshot(cwd) {
  const repo = cwd && await repoOf(cwd);
  if (!repo) return null;
  const run = repo.queue.then(async () => {
    try {
      fs.mkdirSync(IDX_DIR, { recursive: true });
      if (!fs.existsSync(repo.idx)) { try { fs.copyFileSync(path.join(repo.gitDir, 'index'), repo.idx); } catch {} }
      const env = { GIT_INDEX_FILE: repo.idx };
      if (await git(repo.root, ['add', '-A', '--', '.'], env) == null) return null;
      const tree = (await git(repo.root, ['write-tree'], env))?.trim();
      return tree ? { repo, tree, t: Date.now() } : null;
    } catch { return null; }
  });
  repo.queue = run.catch(() => {});
  return run;
}

// 파일을 쓸 수 없는 명령인가 — 그런 명령은 전후를 찍지 않는다. 찍는 사이에 다른 쪽(Unity 에디터 저장 · 같은 저장소의 다른 워커 ·
// 사람)이 바꾼 파일이 그 명령의 수정으로 잡혔다(실측: Explore 의 grep · git log 몇 초 사이에 에디터가 저장한 프리팹 +6/−438 이 diff 에 뜸).
// 확실할 때만 true — 모르는 명령 · 출력 돌리기(>) · 명령 치환($( ) · ``) · heredoc 이 하나라도 있으면 false(예전처럼 찍는다)
const READ_CMDS = new Set(['cd', 'pushd', 'popd', 'ls', 'dir', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'file',
  'stat', 'du', 'df', 'echo', 'printf', 'pwd', 'which', 'where', 'type', 'whoami', 'date', 'sort', 'uniq', 'cut', 'tr', 'jq', 'diff', 'cmp',
  'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'false', 'sleep', 'tree', 'nl', 'column', 'md5sum', 'sha1sum', 'sha256sum']);
const READ_GIT = new Set(['log', 'show', 'diff', 'status', 'grep', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'cat-file',
  'rev-list', 'shortlog', 'merge-base', 'name-rev', 'for-each-ref', 'whatchanged']);
const WRITE_OPTS = /^(-delete|-exec|-execdir|-ok|-okdir|-fprint\w*|-fls|--output(=.*)?)$/; // find · git diff --output
const OUT_FILE = new Set(['sort', 'tree']); // -o 파일 로 쓴다(grep -o 는 읽기라 이 둘만)
export function isReadOnlyCommand(cmd) {
  if (!cmd || /\$\(|`|<<|<\(|>\(/.test(cmd)) return false;
  // 버리는 출력 돌리기(2>/dev/null · >/dev/null · 2>&1 · &>/dev/null)만 지우고, 남은 > 가 있으면 쓰는 명령
  const s = cmd.replace(/(\d|&)?>>?\s*\/dev\/null\b|\d>&\d/g, ' ');
  if (s.includes('>')) return false;
  for (const seg of s.split(/&&|\|\||[;|&\n]/)) {
    const words = (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((x) => x.replace(/^(["'])(.*)\1$/, '$2')).filter((x) => !/^[(){}]$/.test(x));
    while (words.length && /^\w+=/.test(words[0])) words.shift(); // VAR=값 명령
    if (!words.length) continue;
    const [name, ...args] = words;
    if (!READ_CMDS.has(name) && name !== 'git') return false;
    if (args.some((a) => WRITE_OPTS.test(a) || (OUT_FILE.has(name) && /^-o/.test(a)))) return false;
    if (name === 'git') {
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1; // git -C 폴더 · -c 키=값 · --no-pager
      if (!READ_GIT.has(args[i])) return false;
    }
  }
  return true;
}

// 명령 전(pre) → 지금. 같은 저장소에서 그 사이 끝난 다른 명령이 있으면 그 명령 뒤부터 (같은 변경을 두 번 세지 않게)
// → [{ file(절대 경로), kind: 'create'|'edit'|'delete', binary, hunks }]
export async function changedSince(pre) {
  if (!pre) return [];
  const post = await snapshot(pre.repo.root);
  if (!post) return [];
  const repo = pre.repo;
  const base = repo.last && repo.last.t > pre.t ? repo.last.tree : pre.tree;
  repo.last = post;
  if (base === post.tree) return [];
  const out = await git(repo.root, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', base, post.tree]);
  const files = out ? parseDiff(out, repo.root) : [];
  // 그림은 diff 화면에서 전/후를 나란히 보여 준다 — 찍기(git add)로 저장소 오브젝트에 이미 들어간 blob 을 "트리:경로" 로 가리켜 둔다.
  // 트리는 어느 브랜치에도 안 걸린 오브젝트라 git gc 가 오래된 것(기본 2주)을 치우면 못 꺼낸다(화면은 빈 칸)
  for (const f of files) {
    if (!f.binary || !IMAGE_EXT.test(f.file)) continue;
    const rel = path.relative(repo.root, f.file).split(path.sep).join('/');
    f.img = { root: repo.root, before: f.kind === 'create' ? null : `${base}:${rel}`, after: f.kind === 'delete' ? null : `${post.tree}:${rel}` };
  }
  return files;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
// "트리:경로" 의 blob 내용 → Buffer | null (diff 화면 그림 비교)
export function readBlob(root, spec) {
  return new Promise((resolve) => {
    execFile('git', ['cat-file', 'blob', spec], { cwd: root, encoding: 'buffer', maxBuffer: 64 << 20, timeout: 8000, windowsHide: true },
      (err, out) => resolve(err ? null : out));
  });
}

function unquote(p) {
  p = p.replace(/\t$/, ''); // 이름에 공백이 있으면 git 이 ---/+++ 줄 끝에 탭을 붙인다
  if (!p.startsWith('"')) return p;
  try { return JSON.parse(p); } catch { return p.slice(1, -1); }
}

export function parseDiff(text, root) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split('\n');
    let a = null, b = null, kind = 'edit', binary = false, h = null;
    const hunks = [];
    for (const l of lines.slice(1)) {
      if (h) {
        if (l[0] === '+' || l[0] === '-' || l[0] === ' ' || l[0] === '\\') { h.lines.push(l); continue; }
        if (!l.startsWith('@@')) { h = null; continue; }
      }
      const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) { h = { oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], lines: [] }; hunks.push(h); continue; }
      if (l.startsWith('new file mode')) kind = 'create';
      else if (l.startsWith('deleted file mode')) kind = 'delete';
      else if (l.startsWith('--- ')) a = l.slice(4);
      else if (l.startsWith('+++ ')) b = l.slice(4);
      else if (l.startsWith('Binary files ')) {
        binary = true;
        const bm = l.match(/^Binary files (.+) and (.+) differ$/);
        if (bm) { a = bm[1]; b = bm[2]; }
      }
    }
    // 이름은 +++ b/… (지운 파일이면 --- a/…), 둘 다 없으면 첫 줄 "a/x b/x"
    let rel = b && b !== '/dev/null' ? unquote(b).replace(/^b\//, '') : a && a !== '/dev/null' ? unquote(a).replace(/^a\//, '') : null;
    if (!rel) { const m = lines[0].match(/^a\/(.+) b\/(.+)$/); rel = m ? m[2] : lines[0]; }
    for (const x of hunks) if (x.lines.at(-1) === '') x.lines.pop();
    files.push({ file: path.join(root, rel), kind, binary, hunks });
  }
  return files;
}
