---
description: 지난 릴리즈 이후 커밋으로 릴리즈 노트(txt)를 만들어 다운로드 폴더에 저장 · Draft release notes since the last release. e.g. /release-notes release-7
argument-hint: "[기준 태그 (생략 시 최신 release-*)]"
allowed-tools: Bash(git:*), Bash(node:*), Read, Write
---

지난 릴리즈 이후 커밋된 내용으로 **사용자용 릴리즈 노트**를 만들어 txt 파일로 저장한다. 인자: `$ARGUMENTS`

## 1. 범위 정하기 (저장소 루트에서)

1. `git fetch --tags --quiet` (실패해도 계속 — 로컬 태그로 진행)
2. 기준 태그
   - 인자가 있으면 그 태그.
   - 없으면 `git describe --tags --abbrev=0 --match "release-*" HEAD` 로 가장 가까운 릴리즈 태그.
   - 태그가 없으면 진행하지 말고 그 사실만 알린다.
3. 커밋 목록: `git log --reverse --no-merges --format="%h %s%n%b%n----" <기준태그>..HEAD`
   - 커밋이 0개면 "지난 릴리즈 이후 변경 없음"만 알리고 끝낸다.
4. 다음 버전 이름: 기준 태그 번호 + 1 (예: `release-7` → `release-8`). 숫자가 아니면 `next` 로.

커밋 메시지만으로 사용자에게 어떻게 보이는지 모호하면 `git show --stat <해시>` 로 바뀐 파일을 확인한다.
코드 전문을 읽지는 않는다.

## 2. 쓰는 원칙

- **사용자 기준**: 화면에서 무엇이 생겼고, 무엇을 하면 되고, 무엇이 달라졌는지를 쓴다.
  내부 구현(함수명·변수명·파일명·정규식·색 코드·실측 수치·원인 분석)은 쓰지 않는다.
- **짧게**: 항목당 한 줄이 기본이다. 꼭 필요할 때만 하위 줄(`  - `)을 하나 둔다.
- **묶기**: 같은 기능을 여러 커밋에 걸쳐 만들거나 손봤으면 한 항목으로 합친다.
  이번 범위 안에서 만들고 고친 것은 버그 수정이 아니라 새 기능 한 줄로만 쓴다.
- **빼기**: 리팩터링, 주석·문서·테스트, 개발 도구, 되돌린 커밋, 사용자가 느낄 수 없는 변경은 뺀다.
- **용어**: 지금 화면에 쓰이는 이름 그대로 쓴다(예: Tasks, Backlog, 투입, 대기실, 최소화 칩, 타임라인, 결과물, diff).
- 조작 키는 `Ctrl/⌘+클릭`, `Alt(⌘)+Enter` 처럼 Windows/맥을 함께 적는다.
- 문장은 "~합니다 / ~됩니다" 체. 버그 수정 항목은 "~하던 문제" 로 끝낸다.

## 3. 형식 (지난 릴리즈 노트와 같은 모양)

```
### 새 기능
<기능 이름>
- <무엇을 하면 어떻게 되는지>

기타
- <작은 새 기능 한 줄씩>

### 개선
- <달라진 점>

### 버그 수정
- <~하던 문제>
```

- 큰 기능은 제목 줄 + 항목, 작은 것은 `기타` 아래 한 줄씩.
- 해당 내용이 없는 섹션은 통째로 뺀다.
- 맨 위에 제목 줄을 둔다: `agent-manager <다음 버전> 릴리즈 노트 (<기준 태그> 이후 · <YYYY-MM-DD>)` 다음 빈 줄.

## 4. 저장 위치 (OS 의 다운로드 폴더)

경로는 `node .claude/scripts/downloads-dir.mjs` 로 구한다.
Windows 는 다운로드 폴더를 다른 곳으로 옮겨 둔 경우까지 레지스트리에서 읽고, 맥은 `~/Downloads` 를 쓴다.

- 파일 이름: `agent-manager-<다음 버전>-release-notes.txt` (예: `agent-manager-release-8-release-notes.txt`)
- 같은 이름이 있으면 덮어쓴다(같은 릴리즈의 다시 만들기).
- 인코딩: UTF-8. Windows 메모장에서도 줄바꿈이 맞도록 Windows 에서는 줄 끝을 CRLF 로 쓴다.
  Write 로 쓴 뒤 Windows 면 `node -e "const f=process.argv[1],fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\r?\n/g,'\r\n'))" "<경로>"` 로 바꾼다.

## 5. 보고

- 저장한 파일 경로, 범위(`<기준 태그>..HEAD`, 커밋 수)와 섹션별 항목 수만 짧게 알린다.
- 노트 전문은 대화에 다시 붙이지 않는다.
- 커밋·태그·푸시·GitHub 릴리즈 게시는 하지 않는다. 사용자가 따로 요청할 때만 한다.
