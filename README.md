# 클로드 키우기 (agent-manager)

내 PC 의 **여러 Claude Code 세션(워커)을 브라우저 한 화면에서 관리**하는 로컬 대시보드입니다.
일을 나눠 주고, 진행을 지켜보고, 승인 요청에 답합니다. 워커는 평소 쓰는 `claude` CLI 그대로라 슬래시 명령·스킬·MCP·설정이 같습니다.

- `127.0.0.1` 에서만 열리는 **내 PC 전용** 도구입니다 (외부 통신·원격 접속 없음)
- 대시보드를 재시작해도 **워커는 끊기지 않고** 다시 붙습니다

## 준비물

- **Node.js 20 이상**
- **Claude Code CLI** — 터미널에서 `claude` 가 실행되고 로그인되어 있어야 합니다
- Windows 10/11 또는 macOS

## 설치

**Claude 에서 셋업하는 것을 권장합니다.**

```bash
git clone https://github.com/stzjinseong/agent-manager.git
```

클론한 폴더에서 `claude` 를 열고 `/setup --mac` (Windows 는 `/setup --windows`) — 확인부터 설치까지 대신 해 줍니다.
macOS 에서 `Launch.app` 을 처음 열 때 보안 경고가 뜨면 Finder 에서 **우클릭 → 열기**.
