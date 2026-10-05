// 실행 창·설치 스크립트·서버 로그의 언어 — 브라우저 선택(am.lang)은 여기서 읽을 수 없어 OS 언어를 따른다.
//  1) AM_LANG=ko|en 이면 그것 (직접 고정)
//  2) macOS: 시스템 언어(AppleLanguages 첫 항목) — Launch.app 으로 띄우면 LANG 같은 환경 변수가 없다
//  3) LC_ALL · LC_MESSAGES · LANG (C/POSIX 는 정보가 없는 것으로 본다)
//  4) OS 지역 설정(Intl) — Windows 는 여기서 정해진다
// 한국어면 ko, 그 밖엔 en. 문구는 L('한국어', 'English') 로 나란히 적는다
import { execFileSync } from 'node:child_process';

function detect() {
  const fixed = String(process.env.AM_LANG || '').toLowerCase();
  if (fixed === 'ko' || fixed === 'en') return fixed;
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      const first = out.match(/[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*/);
      if (first) return /^ko/i.test(first[0]) ? 'ko' : 'en';
    } catch {}
  }
  const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
  if (env && !/^(C|POSIX)([.@]|$)/i.test(env)) return /^ko/i.test(env) ? 'ko' : 'en';
  try { return /^ko/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'ko' : 'en'; } catch { return 'en'; }
}

export const CLI_LANG = detect();
export const L = (ko, en) => (CLI_LANG === 'ko' ? ko : en);
export const cliLocale = () => (CLI_LANG === 'ko' ? 'ko-KR' : 'en-US');
