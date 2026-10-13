---
description: 담당 개발자 모드 — 이 PC 에서 이슈 올리기 질문 끄기/켜기 · Maintainer mode: stop asking to file GitHub issues on this PC. e.g. /admin, /admin off
argument-hint: "[on | off | status] (생략 시 on)"
allowed-tools: Bash(node:*)
---

이 PC 를 담당 개발자 모드로 설정한다. 인자: `$ARGUMENTS`

`node .claude/scripts/admin-mode.mjs $ARGUMENTS` 를 저장소 루트에서 실행하고, 결과를 한 줄로 알린다.

- `on`(기본): `CLAUDE.local.md` 에 "이슈 올리기 묻지 않기" 설정을 넣는다. 이후 이슈 원인을 찾아도 GitHub 이슈 올리기를 묻지 않는다. `/report-issue` 를 직접 부르면 그때만 진행한다.
- `off`: 그 설정을 뺀다. 다시 묻게 된다.
- `status`: 지금 켜져 있는지 알려 준다.

`CLAUDE.local.md` 는 이 PC 에만 있는 개인 설정이라 git 에 올라가지 않는다. 다른 내용은 건드리지 않는다.
설정은 **다음 대화부터** 적용된다고 함께 알린다(지금 대화는 이미 읽은 설정으로 돈다). 이 대화에서도 바로 따르면 된다.
