// 워커 작업 폴더의 지금 git 브랜치 — .git/HEAD 를 직접 읽는다(git 명령을 띄우지 않아 5초마다 읽어도 가볍다).
// 하위 폴더에서 띄운 워커도 위로 올라가며 저장소를 찾고, worktree·submodule 처럼 .git 이 'gitdir: …' 파일인 경우도 따라간다.
// 브랜치가 아니면(분리된 HEAD) 커밋 앞 7자리, 저장소가 아니면 null
import fs from 'node:fs';
import path from 'node:path';

function headFile(cwd) {
  for (let dir = path.resolve(cwd); ; ) {
    const dotgit = path.join(dir, '.git');
    try {
      const st = fs.statSync(dotgit);
      if (st.isDirectory()) return path.join(dotgit, 'HEAD');
      const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (m) return path.join(path.resolve(dir, m[1].trim()), 'HEAD');
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function gitBranch(cwd) {
  if (!cwd) return null;
  const f = headFile(cwd);
  if (!f) return null;
  try {
    const head = fs.readFileSync(f, 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return { name: ref[1], detached: false };
    return /^[0-9a-f]{7,}$/i.test(head) ? { name: head.slice(0, 7), detached: true } : null;
  } catch { return null; }
}
