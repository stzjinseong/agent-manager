// API 단가 ($ / 1M tokens) — claude-api 스킬 모델표(2026-09-25 캐시) 기준.
// 캐시 쓰기: 5분 = 입력 × 1.25, 1시간 = 입력 × 2. 캐시 읽기: 표에 명시된 값, 없으면 입력 × 0.1.
// 구독(Pro/Max/Team) 사용 시 실제 청구액이 아니라 "API 로 돌렸다면" 환산 추정치다.
const TABLE = [
  // [모델 id 접두사, 입력, 출력, 캐시 읽기]
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1.0],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4-6', 3, 15, 0.3],
  ['claude-haiku-4-5', 1, 5, 0.1],
];

export function priceFor(model) {
  if (!model) return null;
  const id = String(model).replace(/\[.*\]$/, '');
  // 긴 접두사부터 비교해야 claude-opus-5 가 claude-opus-5-5 를 가로채지 않는다
  const hit = TABLE.filter(([p]) => id === p || id.startsWith(`${p}-`)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? { input: hit[1], output: hit[2], read: hit[3] } : null;
}

// usage: { input, w5, w1h, cacheRead, output } → 달러
export function costOf(u, price) {
  if (!price) return 0;
  return (u.input * price.input + u.w5 * price.input * 1.25 + u.w1h * price.input * 2 + u.cacheRead * price.read + u.output * price.output) / 1e6;
}

// 컨텍스트 창: Haiku 4.5 는 200k, 4.6 이후 Opus/Sonnet 과 5세대·Fable 은 1M
export function windowFor(model) {
  const id = String(model || '');
  if (/haiku/.test(id)) return 200_000;
  if (/claude-(fable|mythos)-|claude-(opus|sonnet)-(5|4-6|4-7|4-8)/.test(id)) return 1_000_000;
  return 200_000;
}
