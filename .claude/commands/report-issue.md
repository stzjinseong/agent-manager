---
description: 클로드 키우기 이슈(증상·원인·수정)를 GitHub 이슈로 올리기 · File a GitHub issue for an agent-manager bug. e.g. /report-issue
argument-hint: "[이슈 요약 (생략 시 지금 대화에서 정리)]"
allowed-tools: Bash(git:*), Bash(node:*), Bash(claude:*), Read, Write, AskUserQuestion
---

지금 대화에서 찾은 클로드 키우기(agent-manager) 이슈를 GitHub 이슈로 올린다. 인자: `$ARGUMENTS`

사용자에게 하는 안내는 **사용자가 쓰는 언어로** 한다. 이슈 본문은 한국어로 쓴다.

## 1. 내용 정리

인자가 있으면 그 내용을 중심으로, 없으면 지금 대화에서 확인된 사실만으로 정리한다. 추측은 추측이라고 적는다.

제목: 한 줄. 사용자가 본 증상 기준 (예: `바로가기로 띄운 서버에서 Tasks 전송이 늘 '입력 대기 화면 아님'으로 실패`)

본문 형식:

```
## 증상
<사용자가 본 것 — 화면 문구는 그대로 인용>

## 재현
1. …

## 원인
<무엇이 왜 그렇게 동작했는지. 근거는 file:line 과 실측 결과>

## 수정
<고친 내용(커밋 해시가 있으면 함께) 또는 제안하는 수정. 아직 안 고쳤으면 "미수정">

## 환경
- OS: <Windows 11 / macOS …>
- Claude Code: <claude --version>
- agent-manager: <git rev-parse --short HEAD> (<브랜치>)
- 서버 실행 방식: <Launch.vbs·Launch.command·터미널(npm start) 등, 알면>
```

환경 값은 직접 확인한다: `claude --version`, `git rev-parse --short HEAD`, `git branch --show-current`, `node -p "process.platform+' '+require('os').release()"`.

## 2. 민감 정보 빼기

본문에 아래가 있으면 지우거나 바꾼다.

- 사용자 홈 경로의 사용자 이름: `C:\Users\<이름>\…`, `/Users/<이름>/…` → `~\…`, `~/…`
- 토큰·키·비밀번호, 이메일 주소, 사내 호스트명·IP
- 워커가 다루던 다른 프로젝트의 코드나 내용 (이슈와 무관하면 통째로 뺀다)

## 3. 확인받기

제목과 본문 전체를 대화에 보여 주고 `AskUserQuestion` 으로 묻는다 (header `이슈 올리기`).

- 선택지: **"이대로 올리기"** / **"수정 후 올리기"**(무엇을 고칠지 Other 로 받음) / **"올리지 않기"**
- 올리지 않기면 거기서 끝낸다.

## 4. 올리기

1. 제목과 본문을 스크래치 폴더(없으면 OS 임시 폴더)에 `issue-title.txt`, `issue-body.md` 로 쓴다.
2. `node .claude/scripts/open-issue.mjs <제목 파일> <본문 파일>` 을 실행한다.
   - `gh` 가 설치돼 있고 로그인돼 있으면 바로 올라가고 이슈 주소가 출력된다.
   - 아니면 제목·본문을 채운 GitHub 새 이슈 페이지가 브라우저로 열린다. 사용자에게 **Submit new issue 를 눌러 달라고** 안내한다.
     - 본문이 길어 잘렸으면 전체 본문이 클립보드에 있으니 본문 칸에 바꿔 붙여 넣으라고 안내한다.
3. 결과(이슈 주소 또는 "브라우저에서 Submit 필요")만 짧게 알린다.

커밋·푸시는 하지 않는다.
