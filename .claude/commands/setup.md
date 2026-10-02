---
description: agent-manager 설치 (의존성 + OS별 실행기). 예) /setup --mac
argument-hint: "[--mac | --windows]"
allowed-tools: Bash(node:*), Bash(npm:*), Bash(claude:*), Bash(uname:*), Bash(ls:*), Bash(test:*)
---

agent-manager 를 이 컴퓨터에 설치한다. 인자: `$ARGUMENTS`

## 대상 OS 정하기

- `--mac` → macOS 설치
- `--windows` → Windows 설치
- 인자 없음 → `node -p process.platform` 으로 판별 (`darwin` = macOS, `win32` = Windows)
- 지정한 OS 와 실제 OS 가 다르면 진행하지 말고 그 사실만 알린다 (예: Windows 에서 `--mac`).
  `setup-mac.mjs` 는 macOS 가 아니면 아무것도 하지 않고 끝나므로 돌려도 의미가 없다.

## 순서 (저장소 루트에서)

1. **준비물 확인** — 하나라도 없으면 멈추고 무엇을 설치해야 하는지 알린다.
   - `node -v` 가 20 이상
   - `claude --version` 이 실행됨 (Claude Code CLI)
2. **의존성** — `npm install`. 실패하면 출력 마지막 부분을 그대로 보여주고 멈춘다.
   macOS 에서 `node-pty` 빌드 오류면 `xcode-select --install` 이 필요할 수 있다고 덧붙인다.
3. **OS별**
   - macOS: `npm run setup-mac` — Launch.command 실행 권한, 창 없는 `Launch.app` 생성,
     `~/.zshrc` 에 `agent-manager` 명령 등록. 각 단계의 `✓` 줄이 다 나왔는지 확인한다.
   - Windows: `npm run setup-win` — PowerShell 프로필에 `agent-manager` 명령(창 없는 `Launch.vbs` 실행) 등록.
     Windows PowerShell 5.1 과 설치돼 있으면 PowerShell 7 프로필 모두. 이미 있으면 경로만 갱신하고, 직접 적어 둔
     `function agent-manager` 줄은 표식 블록으로 바꾼다. `✓` 줄과 `!` 경고(실행 정책·인코딩)를 그대로 보여 준다.
4. **결과 확인**
   - macOS: `Launch.app` 폴더가 생겼는지 `ls` 로 확인한다.
   - Windows: `powershell -Command "Get-Command agent-manager"` 로 새 셸에서 명령이 잡히는지 확인한다.

## 마치며 알릴 것

- 실행 방법: 주소 http://127.0.0.1:7788
  - macOS: `Launch.app` 더블클릭 또는 새 터미널에서 `agent-manager` (지금 창은 `source ~/.zshrc` 후)
  - Windows: `Launch.vbs` 더블클릭 또는 새 PowerShell 창에서 `agent-manager` (지금 창은 `. $PROFILE` 후)
- Windows 에서 실행 정책 경고가 나왔으면 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 를 안내한다
  (정책은 대신 바꾸지 않는다).
- macOS 는 `Launch.app` 을 처음 열 때 보안 경고가 뜨면 Finder 에서 **우클릭 → 열기** 를 한 번 해야 한다.
- 서버를 직접 띄우지는 않는다 — 실행은 사용자가 한다.
