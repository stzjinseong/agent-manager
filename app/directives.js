// 작업 지시 — 사용자가 적어 둔 상시 규칙("작업이 끝나면 커밋" 등)을 워커에 붙인다.
// 항목: { id, title, text, global, roles: [역할 이름], except: [역할 이름], createdAt }
// - global: 모든 워커(새로 띄우는 역할 포함)에 붙는다. except 에 든 역할만 뺀다
// - global 이 아니면 roles 에 든 역할에만. 둘 다 비어 있으면 아무 데도 안 붙은 '보관함' 항목
// 전달은 UserPromptSubmit 훅의 additionalContext 로 한다 — 대시보드 지시 · 대기열 · 예약 · 터미널 직접 입력이 모두 이 훅을 거치고,
// 사용자 메시지 원문은 그대로라 투입 확인(앞 20자 비교)에 걸리지 않는다. 대화 기록에 남으므로 세션마다 한 번,
// 내용이 바뀌었을 때 · 압축(/compact)으로 기록이 줄었을 때만 다시 넣는다

const MAX_ITEMS = 60, MAX_TITLE = 40, MAX_TEXT = 2000;

// 기본 추천 — 보관함에 없을 때 '추천'으로 보인다. 고르면 사본이 보관함에 들어간다(원본은 코드에 그대로)
export const PRESETS = [
  { key: 'commit', title: '작업 끝나면 커밋', text: '작업 단위가 끝나면 묻지 말고 그 단위로 바로 커밋한다. 커밋 메시지는 저장소의 기존 커밋 스타일을 따른다.' },
  { key: 'korean', title: '한국어로 답변', text: '진행 설명을 포함한 모든 답변은 한국어로 한다.' },
  { key: 'report', title: '완료 보고 3줄', text: '턴을 마칠 때 바뀐 파일 · 검증한 방법 · 남은 일을 3줄로 요약한다.' },
  { key: 'verify', title: '검증하고 끝내기', text: '수정한 뒤에는 빌드나 테스트를 돌려 확인한다. 실패하면 완료라고 하지 말고 실패 내용을 그대로 보고한다.' },
  { key: 'noask', title: '묻지 말고 진행', text: '애매한 결정은 합리적인 기본값으로 정해 진행하고, 정한 내용을 보고에 남긴다. 되돌리기 어려운 작업만 먼저 묻는다.' },
  { key: 'branch', title: '작업 브랜치에서', text: '기본 브랜치에 바로 커밋하지 않는다. 작업마다 새 브랜치를 만들어 거기서 커밋한다.' },
  { key: 'remain', title: '남은 일 알려주기', text: '할 일이 여러 개인 세션이면 매 응답 끝에 아직 남은 일을 목록으로 알려 준다. 남은 일이 없거나 한 번에 끝나는 단일 요청이면 생략한다.' },
  { key: 'review', title: '리뷰만 하기', text: '코드를 고치지 않는다. 문제를 찾아 파일:줄과 함께 보고만 한다.' },
];

const uniq = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 200);

export function cleanDirective(body, prev) {
  const title = String(body.title ?? prev?.title ?? '').trim().slice(0, MAX_TITLE);
  const text = String(body.text ?? prev?.text ?? '').trim().slice(0, MAX_TEXT);
  if (!text) return { error: '헤더 내용이 비었습니다' };
  return {
    d: {
      id: prev?.id || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      title: title || text.split('\n')[0].slice(0, MAX_TITLE),
      text,
      global: Boolean(body.global ?? prev?.global),
      roles: uniq(body.roles ?? prev?.roles),
      except: uniq(body.except ?? prev?.except),
      preset: String(body.preset ?? prev?.preset ?? '').slice(0, 20) || undefined, // 추천에서 왔으면 그 키 — 추천 목록에서 빼려고
      createdAt: prev?.createdAt || Date.now(),
    },
  };
}

export const appliesTo = (d, role) => (d.global ? !d.except.includes(role) : d.roles.includes(role));

// 한 역할에 붙이기/떼기 — 공용 항목은 except 로, 아니면 roles 로
export function setRole(d, role, on) {
  const drop = (a) => a.filter((x) => x !== role);
  if (d.global) d.except = on ? drop(d.except) : uniq([...d.except, role]);
  else d.roles = on ? uniq([...d.roles, role]) : drop(d.roles);
}

export function compose(list, role) {
  const mine = list.filter((d) => appliesTo(d, role));
  if (!mine.length) return '';
  return [
    HEAD,
    '사용자가 이 워커에 늘 적용하라고 정해 둔 규칙이다. 이 대화의 모든 요청에 따른다. 요청이 이 규칙과 다르게 말하면 그 요청을 따른다.',
    '앞서 받은 상시 작업 지시가 있으면 이것으로 바꾼다.',
    ...mine.map((d) => `\n## ${d.title}\n${d.text}`),
  ].join('\n');
}

const HEAD = '[클로드 키우기 · 상시 작업 지시]';

// 이 세션에 마지막으로 넣은 내용 — 세션이 바뀌었으면(/clear · 새로 띄움) 아무것도 안 넣은 것으로 본다
const sentOf = (w) => (w.dirSent && w.dirSent.session === w.sessionId ? w.dirSent : null);

// 다음 메시지에 넣을 내용이 남았나 (화면의 '다음 메시지에 전달' 표시)
export const pending = (list, w) => compose(list, w.name) !== (sentOf(w)?.sig || '');

// UserPromptSubmit 훅에서 — 넣을 글(없으면 null)을 돌려주고 보낸 것으로 기록한다.
// 뗀 지시는 이름을 들어 해제를 알린다 — '이것으로 바꾼다'만으로는 앞서 받은 규칙과 제 답의 버릇을 계속 따랐다(실측: 뗀 뒤에도 두 턴 더 따름)
export function takeContext(list, w) {
  const now = compose(list, w.name), before = sentOf(w);
  if (now === (before?.sig || '')) return null;
  const titles = list.filter((d) => appliesTo(d, w.name)).map((d) => d.title);
  const gone = (before?.titles || []).filter((t) => !titles.includes(t));
  w.dirSent = { sig: now, titles, session: w.sessionId, at: Date.now() };
  const release = gone.length ? `해제된 상시 작업 지시: ${gone.map((t) => `「${t}」`).join(', ')} — 이제부터 따르지 않는다. 앞선 답에서 그 지시 때문에 하던 것도 그만한다.` : '';
  if (!now) return `${HEAD}\n${release || '앞서 받은 상시 작업 지시는 모두 해제됐다. 더는 따르지 않는다.'}`;
  return release ? `${now}\n\n${release}` : now;
}

export function renameRole(list, from, to) {
  for (const d of list) {
    d.roles = uniq(d.roles.map((x) => (x === from ? to : x)));
    d.except = uniq(d.except.map((x) => (x === from ? to : x)));
  }
}

export const LIMIT = MAX_ITEMS;
