// 로컬 서버 접근 제한 — 이 PC 의 대시보드 화면과 우리 프로세스(훅 · 상태줄 · PTY 호스트)만 받는다.
// 127.0.0.1 에만 열어도 브라우저는 아무 웹사이트에서나 localhost 로 요청(CSRF)·웹소켓 접속을 보낼 수 있고, 공격자 도메인을
// 127.0.0.1 로 다시 가리키면(DNS rebinding) 같은 출처로 응답까지 읽는다. 그래서
//   · Host 는 127.0.0.1 / localhost / [::1] (+ AM_ALLOWED_HOSTS) 만 — rebinding 차단
//   · 쓰기 요청 · 웹소켓은 Origin 이 대시보드 자신이거나, 비밀 토큰(data/auth-token)을 들고 온 것만 — CSRF 차단
// 토큰은 파일로 둔다: 서버를 재시작해도 그대로라 이미 떠 있는 워커의 훅(매번 이 파일을 읽음)과 PTY 호스트가 계속 통한다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.AM_DATA || path.join(ROOT, 'data');
const TOKEN_PATH = path.join(DATA_DIR, 'auth-token');
export const TOKEN_HEADER = 'x-am-token';

export function readToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf8').trim() || null; } catch { return null; }
}
// 없으면 만든다. 서버와 PTY 호스트가 동시에 만들어도 먼저 쓴 쪽(wx)을 함께 쓴다
export function ensureToken() {
  const t = readToken();
  if (t) return t;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.writeFileSync(TOKEN_PATH, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch {}
  return readToken();
}

export function tokenOk(got, token) {
  if (!got || !token) return false;
  const a = Buffer.from(String(got)), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const EXTRA_HOSTS = (process.env.AM_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
export function hostOk(host, port) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return ['127.0.0.1', 'localhost', '[::1]'].some((n) => h === `${n}:${port}`) || EXTRA_HOSTS.includes(h);
}
export function originOk(origin, port) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && hostOk(u.host, port);
  } catch { return false; }
}
// 쓰기 요청 · 웹소켓을 받아도 되는 호출자: 대시보드(Origin) 또는 토큰을 든 우리 프로세스
export function callerOk(req, port, token) {
  return originOk(req.headers.origin, port) || tokenOk(req.headers[TOKEN_HEADER], token);
}
