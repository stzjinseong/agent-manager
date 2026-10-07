# 사용자 테마

클로드 키우기의 색과 배경을 직접 만든 테마로 바꿀 수 있어요. 이 폴더(`themes/`) 안에 **테마 폴더 하나 = 테마 하나**를 넣으면
헤더의 👕 **꾸미기 → 테마** 목록에 나타나요. 서버를 다시 켤 필요는 없고, 메뉴를 다시 열면 새 폴더를 읽어요.

> 이 폴더에 넣은 테마는 **이 컴퓨터에만** 있어요. `.gitignore` 에서 빠져 있어 커밋·푸시되지 않고, 업데이트(`git pull`)를 받아도 그대로 남아요.
> 저장소에는 이 안내서와 예시(`_example/`)만 들어 있어요.

## 빠르게 시작하기

가장 쉬운 방법은 앱 안에서 시작하는 거예요. 👕 **꾸미기 → 테마 → + 테마 만들기**를 누르면:

- **새 테마 만들기** — 이름만 적으면 예시를 복사해 `themes/<이름>/` 을 만들고 바로 적용해요. 그 뒤 `theme.css` 를 고치면 돼요.
- **themes 폴더 열기** — 이 폴더를 Finder·탐색기로 열어요.
- **Claude 에게 맡기기** — 원하는 느낌(예: "벚꽃 핑크 파스텔")을 적으면 워커에게 줄 요청문을 만들어 줘요. 복사하거나 지금 열린 워커 입력칸에 바로 넣을 수 있어요.

손으로 만들려면:

1. `themes/_example` 폴더를 복사해 이름을 바꿔요. 예: `themes/my-theme` (영문·숫자·`-`·`_`, `_` 나 `.` 로 시작하면 목록에서 빠져요)
2. `theme.json` 의 `name` 을 바꾸고, `theme.css` 를 고쳐요.
3. 👕 꾸미기 → 테마에서 골라요. 이후 `theme.css` 를 고치면 메뉴를 한 번 열거나 새로고침하면 반영돼요.

## 폴더 구성

```
themes/
  my-theme/
    theme.css    ← 필수. 고르면 기본 style.css 뒤에 붙어 같은 규칙을 덮어써요
    theme.json   ← 선택. 이름·견본·모드·터미널 색
    bg.png …     ← 선택. 그림(png/jpg/gif/webp/svg)·글꼴(woff2/woff/ttf/otf). CSS 에서 상대 경로로 url(bg.png)
```

### theme.json

| 항목 | 뜻 |
|---|---|
| `name` | 메뉴에 보일 이름 (없으면 폴더 이름) |
| `swatch` | 메뉴의 작은 견본 — CSS `background` 값 (예: `"linear-gradient(135deg, #111, #4f8cff)"`) |
| `mode` | `"dark"` 또는 `"light"` — 고를 때 그 모드로 바꿔요. 없으면 지금 모드 그대로 |
| `terminal.dark` / `terminal.light` | 그 모드일 때 터미널(xterm) 색. `background` `foreground` `cursor` `selectionBackground` `red` `brightBlue` … |

## theme.css 쓰는 법

### 1. 색 토큰 바꾸기 (가장 쉬움)

화면 색은 대부분 CSS 변수로 되어 있어서, 변수만 바꿔도 전체 분위기가 바뀌어요.

```css
/* 다크 모드일 때만 */
:root:not([data-theme="light"]) { --bg: #0b1424; --accent: #4f8cff; }
/* 라이트 모드일 때만 */
:root[data-theme="light"] { --bg: #fdf6ee; --accent: #e0703f; }
```

| 변수 | 쓰이는 곳 |
|---|---|
| `--bg` | 페이지 바탕 |
| `--floor` | 워커 카드가 놓이는 보드 바탕 |
| `--surface` `--surface-2` `--surface-3` | 패널·카드 면 (숫자가 클수록 위에 쌓인 면) |
| `--btn-hover` | 버튼에 마우스를 올렸을 때 |
| `--sel-a` `--sel-b` | 고른 워커 카드의 위→아래 그라데이션 |
| `--term-bg` | 터미널 상자 바탕 (터미널 글자 영역은 theme.json `terminal` 로) |
| `--tip-bg` | 툴팁 바탕 |
| `--ink` | 선·격자·테두리에 쓰는 반투명 색의 RGB (예: `255 255 255`) |
| `--line` `--line-2` | 얇은 구분선 (보통 `--ink` 에서 자동으로) |
| `--text` `--text-2` `--dim` `--faint` | 글자 — 진한 순서 |
| `--accent` `--accent-hi` | 강조색(주 버튼·선택 표시)과 그 밝은 쪽 |
| `--copper` | 워커 카드 위 핀 |
| `--working` `--decision` `--done` `--checked` `--idle` `--waiting` `--exited` | 상태색 — 서로 구분되게 유지하는 걸 추천해요 |
| `--radius` | 카드 모서리 둥글기 |

### 2. 배경 꾸미기

모든 내용 뒤에 화면에 고정된 빈 층 `.theme-bg` 가 있어요. 그라데이션·그림·애니메이션을 여기에 그리면 돼요.
`::before` `::after` 도 쓸 수 있어요.

```css
.theme-bg { background: url(bg.png) center / cover; opacity: .35; }
.theme-bg::after { content: ""; position: absolute; inset: 0; animation: my-glow 8s ease-in-out infinite alternate; }
```

### 3. 개별 요소 바꾸기

그 밖의 요소는 브라우저 개발자 도구(요소 검사)로 클래스 이름을 찾아 덮어써요. 자주 쓰는 것:
`.topbar`(헤더) · `.brand h1`(제목) · `.floor`(보드) · `.node`(워커 카드, 고르면 `.sel`, 상태는 `.s-working` 등) ·
`.panel` · `.btn.primary` · `.term-wrap`(터미널 상자) · `.stat`(헤더 상태 칩)

### 팁

- 테마만의 규칙을 다른 테마와 섞이지 않게 하고 싶으면 `:root[data-skin="my-theme"]` 처럼 폴더 이름으로 범위를 좁혀요.
- 움직임이 있는 배경은 `transform` 과 `opacity` 만 움직이면 가벼워요. `@media (prefers-reduced-motion: reduce)` 에서 꺼 주면 좋아요.
- 앱 업데이트로 클래스 이름이 바뀔 수 있어요. 색 토큰 위주로 만들면 오래 그대로 써요.
