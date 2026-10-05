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
  repos.set(cwd, r);
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
  return out ? parseDiff(out, repo.root) : [];
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
