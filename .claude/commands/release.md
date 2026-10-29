---
description: 새 버전 릴리즈 — 릴리즈 노트 만들기 · dev 푸시 · release 브랜치 반영 · release-N 태그 · GitHub 릴리즈까지 한 번에. "새 버전 릴리즈해줘" 같은 요청에 쓴다 · Cut a new release end to end (notes, push dev, fast-forward release, tag, GitHub release). e.g. /release
argument-hint: "(인자 없음)"
allowed-tools: Bash(git:*), Bash(node:*), Read, Write
---

새 버전을 릴리즈한다. 사용자가 "새 버전 릴리즈해줘"라고 하거나 `/release` 를 부르면 아래를 **처음부터 끝까지 묻지 않고** 진행한다.
중간에 조건이 맞지 않으면 그 자리에서 멈추고 이유를 알린다 — 멈춘 뒤 다른 방법으로 우회하지 않는다.

이 저장소의 릴리즈 관례: 버전은 `release-N` 태그(lightweight)뿐이고 package.json version 은 올리지 않는다.
release 브랜치는 dev 로 fast-forward 한다(merge 커밋 없음). 앱은 origin 의 `release-N` 태그 번호로 새 버전을 알아채고,
앱 안의 릴리즈 노트 화면은 GitHub 릴리즈 본문을 보여 준다.

## 1. 사전 확인 (저장소 루트에서)

```bash
git fetch origin --tags --quiet
git branch --show-current          # dev 여야 한다
git status --porcelain             # 비어 있어야 한다
git rev-list --count dev..origin/dev   # 0 이어야 한다 (원격에 받지 않은 커밋이 없음)
git merge-base --is-ancestor origin/release dev && echo ff-ok   # release 가 dev 로 fast-forward 가능해야 한다
```

- 하나라도 맞지 않으면 멈춘다(커밋 안 된 변경이 있으면 그 목록을 보여 준다).
- 기준 태그 `T=$(git describe --tags --abbrev=0 --match "release-*" HEAD)`, 커밋 수 `git rev-list --count --no-merges $T..HEAD`.
  0 이면 릴리즈할 것이 없다고 알리고 멈춘다.
- 다음 태그는 기준 태그 번호 + 1 (`release-12` → `release-13`). 그 태그가 이미 로컬·원격에 있으면 멈춘다.

## 2. 릴리즈 노트

`.claude/commands/release-notes.md` 를 Read 하고 그 절차(범위 · 분류 · 형식 · 저장 위치 · CRLF)를 그대로 따라
`agent-manager-<다음 태그>-release-notes.txt` 를 다운로드 폴더에 만든다. 그 문서의 "커밋·태그·푸시는 하지 않는다"는
릴리즈 노트만 만들 때의 규칙이다 — 이 명령에서는 아래 단계를 이어서 한다.

## 3. 푸시 · release 반영 · 태그

```bash
git push -q origin dev
git push -q origin dev:release      # fast-forward 만 된다. 거절되면 멈춘다(강제 푸시 금지)
git branch -f release dev           # 로컬 release 도 맞춘다 (지금 브랜치가 dev 이므로 안전)
git tag <다음 태그> dev
git push -q origin <다음 태그>
git ls-remote origin refs/heads/dev refs/heads/release refs/tags/<다음 태그>   # 셋이 같은 커밋인지 확인
```

## 4. GitHub 릴리즈

```bash
node .claude/scripts/publish-release.mjs <다음 태그> "<노트 txt 경로>"
```

- gh 없이 git 에 저장된 GitHub 로그인으로 API 를 부른다. 본문은 노트에서 맨 위 제목 줄을 뺀 것, 제목은 태그명, 대상은 dev.
- `201 <주소>` 나 `exists <주소>` 면 성공. 그 밖이면 출력 그대로 알리고 멈춘다 — 태그는 이미 올라갔으므로
  "릴리즈 페이지만 다시 만들면 된다(이 단계만 다시 실행)"고 안내한다.
- 토큰을 출력하거나 명령줄 · 파일에 쓰지 않는다.

## 5. 보고

짧게: 태그(`release-N`, 커밋 해시), 포함 커밋 수와 섹션별 항목 수, 노트 파일 경로, 릴리즈 주소.
노트 전문은 대화에 다시 붙이지 않는다.
