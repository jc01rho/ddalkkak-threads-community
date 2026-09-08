// src/time.ts
// 시간대 관련 유틸. 서버가 실행되는 PC의 시스템 시간대가 무엇이든 상관없이
// 이 프로그램의 예약 시간은 항상 "Asia/Seoul(KST, UTC+9, 서머타임 없음)" 기준으로 해석합니다.
//
// 배경: 브라우저의 <input type="datetime-local">에서 넘어오는 값(예: "2026-08-03T18:35")은
// 시간대 정보가 없는 문자열입니다. 이런 문자열을 그냥 new Date(str)로 변환하면
// "서버 프로세스가 인식하는 로컬 시간대"로 해석되는데, 이는 서버가 실행되는 PC/환경 설정에
// 따라 달라질 수 있어 신뢰할 수 없습니다. 그래서 항상 Asia/Seoul로 명시적으로 계산합니다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// "YYYY-MM-DDTHH:mm" 또는 "YYYY-MM-DDTHH:mm:ss" 형태의, 시간대 정보가 없는 문자열을
// "그 시각이 Asia/Seoul 기준이다"라고 가정하고 UTC ISO 문자열로 변환합니다.
// 이미 'Z'나 +09:00 같은 시간대 정보가 포함된 문자열이면 그대로 표준 파싱을 사용합니다.
export function seoulLocalToUtcIso(input: string): string {
  const trimmed = (input || "").trim();
  if (!trimmed) throw new Error("빈 날짜 문자열입니다.");

  // 이미 시간대 정보(Z 또는 +hh:mm/-hh:mm)가 있으면 표준 Date 파싱을 그대로 사용
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) throw new Error("올바르지 않은 날짜 형식입니다: " + input);
    return d.toISOString();
  }

  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error("올바르지 않은 날짜 형식입니다: " + input);
  const [, y, mo, d, h, mi, s] = m;

  // Date.UTC로 "숫자 그대로의" UTC 타임스탬프를 만든 뒤, KST(UTC+9)만큼 빼면
  // 그 숫자가 실제로 나타내려던 Asia/Seoul 시각의 진짜 UTC 순간이 됩니다.
  const asIfUtcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || "0"));
  const realUtcMs = asIfUtcMs - KST_OFFSET_MS;
  return new Date(realUtcMs).toISOString();
}
