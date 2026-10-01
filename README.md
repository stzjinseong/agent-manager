# 클로드 키우기 (agent-manager)

이 PC 에서 띄운 Claude Code 세션(워커)들을 한 화면에서 관리하는 로컬 대시보드.
업무 지시 · 상태/결정함 · 세션 프로파일(토큰·비용·시간) · 서버를 재시작해도 워커 유지.

## 설치

```
npm install
```

macOS 는 이어서 한 번:

```
npm run setup-mac
```
→ `Launch.command` 실행 권한, 창 없는 `Launch.app` 생성, 터미널 명령 `agent-manager` 를 `~/.zshrc` 에 추가.
`Launch.app` 을 처음 열 때 보안 경고가 뜨면 Finder 에서 우클릭 → 열기.

## 실행

| | 창 없이 | 콘솔 창과 함께 |
|---|---|---|
| Windows | `Launch.vbs` | `Launch.bat` |
| macOS | `Launch.app` | `Launch.command` |

서버가 이미 떠 있으면 브라우저만 연다. 주소: http://127.0.0.1:7788
서버 로그: `data/server.log`

## 종료

브라우저 오른쪽 위 ⏻
- **서버만 종료** — 워커(Claude 세션)는 계속 돈다. 다시 실행하면 그대로 붙는다.
- **서버 + 워커 모두 종료**

워커만 모두 끄기: `npm run stop-workers`

## 구조

```
Launch.*        실행기 (app/launch.mjs 호출)
app/server.js   대시보드 서버 · 훅 수신 · 프로파일
app/ptyhost.js  Claude 프로세스를 붙잡는 상주 프로세스 (서버 재시작과 무관하게 유지)
app/hook.mjs    워커 훅 → 서버 전달
app/profile.js  트랜스크립트 → 토큰·비용·시간 집계 (pricing.js 단가)
app/public/     화면
data/           워커 기록 · 저장된 역할 · 설정 · 로그 (git 제외)
```
