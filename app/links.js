// 워커 연결(🔗) — 저장소가 다른 워커끼리 일을 주고받게 한다 (예: W1 수정 → W2 풀 · 빌드 · 테스트 → W1 로 결과).
// Claude 의 SendMessage 는 세션 이름으로 상대를 찾는데 이 앱은 세션 이름을 정하지 않아 쓸 수 없었다 — 대신 앱이 중계한다.
// 워커는 자기 번호(AGENT_MANAGER_WORKER)와 서버 포트를 이미 받으므로, send.mjs 가 상대 번호만으로 서버에 보내고
// 서버가 연결된 쌍인지 확인한 뒤 상대 CLI 에 넣는다(assignTask). 연결 정보는 UserPromptSubmit 훅으로 몇 줄만 알려 준다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 워커 셸이 Git Bash 든 PowerShell 이든 통하게 슬래시 경로로
export const SEND_PATH = path.join(HERE, 'send.mjs').replace(/\\/g, '/');

export const HEAD = '[클로드 키우기 · 연결된 워커]';
// 상대가 보낸 메시지 머리 — 화면(채팅 말풍선)과 훅(사람 입력인지 가르기)이 같은 모양을 쓴다
export const relayHead = (from, to) => `[${from} → ${to}]`;
export const RELAY_RE = /^\[(W\d+) → (W\d+)\]/;
// 사람이 끼지 않고 오간 횟수 상한 — 넘으면 멈추고 화면에 알린다(둘이 '확인했습니다'를 끝없이 주고받는 것 막기)
export const HOP_LIMIT = 12;
// 이보다 긴 글은 파일로 저장하고 경로만 넘긴다 — 상대 컨텍스트에 로그 원문이 통째로 들어가지 않게
export const INLINE_MAX = 4000;

const lineOf = (x) => `- ${x.id} · 역할 ${x.name}${x.status === 'exited' ? ' · (종료됨 — 보낼 수 없음)' : ''} · 폴더 ${x.cwd}`;

// 이 워커에 알릴 연결 블록 — 연결이 없으면 ''
export function compose(w, workers) {
  const peers = (w.links || []).map((id) => workers.get(id)).filter(Boolean);
  if (!peers.length) return '';
  const peerEx = peers[0].id; // 예시에 실제 상대 번호(W 포함)를 그대로 — '<워커번호>' 로 두었더니 번호만(3) 넣었다
  return [
    HEAD,
    `이 워커(${w.id})는 아래 워커와 연결돼 있다. 사용자가 연결 워커에게 일을 맡기라고 하면 Bash 로 보낸다:`,
    `  node "${SEND_PATH}" ${peerEx} "<내용>"`,
    `  내용이 길거나 따옴표가 많으면 파일로 써서: node "${SEND_PATH}" ${peerEx} --file <경로>`,
    ...peers.map(lineOf),
    `상대가 보낸 메시지는 "${relayHead('W?', w.id)}" 머리로 이 대화에 들어온다. 요청을 받았으면 일을 마친 뒤 결과를 같은 방법으로 보낸 워커에게 회신한다.`,
    '회신에는 결론을 담는다(성공/실패 · 실패 내용 · 고친 커밋 등). 회신에 대한 단순 확인(알겠습니다 · 고마워요)은 보내지 않는다 — 주고받기가 끝없이 이어진다.',
    '상대는 다른 저장소일 수 있다. 상대가 같은 PC 에서 읽을 파일은 절대 경로로 알려 준다.',
  ].join('\n');
}

// 이 세션에 마지막으로 넣은 블록과 다를 때만 넣는다(directives.takeContext 와 같은 방식). 연결을 끊었으면 해제를 알린다
export function takeContext(w, workers) {
  const now = compose(w, workers);
  const before = w.linkSent && w.linkSent.session === w.sessionId ? w.linkSent.sig : '';
  if (now === before) return null;
  w.linkSent = { sig: now, session: w.sessionId };
  return now || `${HEAD}\n연결된 워커가 모두 해제됐다. 앞서 알린 연결 워커에게는 더 이상 보내지 않는다.`;
}

const pairKey = (a, b) => [a, b].sort().join('|');
const hops = new Map(); // 'W1|W2' → 사람 입력 없이 오간 횟수
export const hopOf = (a, b) => hops.get(pairKey(a, b)) || 0;
export const bumpHop = (a, b) => { const k = pairKey(a, b); hops.set(k, (hops.get(k) || 0) + 1); return hops.get(k); };
// 사람이 이 워커에 직접 보냈다 → 이 워커가 낀 연결의 횟수를 다시 센다
export function resetHops(id) { for (const k of hops.keys()) if (k.split('|').includes(id)) hops.delete(k); }

export function link(a, b) {
  a.links = [...new Set([...(a.links || []), b.id])];
  b.links = [...new Set([...(b.links || []), a.id])];
}
export function unlink(a, b) {
  a.links = (a.links || []).filter((x) => x !== b.id);
  b.links = (b.links || []).filter((x) => x !== a.id);
  hops.delete(pairKey(a.id, b.id));
}
