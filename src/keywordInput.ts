// src/keywordInput.ts
// 키워드·주제 입력란(쉼표/줄바꿈 구분)을 파싱하는 공용 로직입니다.
// 새 검색 API를 호출하지 않고, 단순히 사용자가 입력한 문자열을 정리하는 역할만 합니다.

export const MAX_KEYWORD_LEN = 50;
export const MAX_KEYWORD_COUNT = 30;

// 쉼표와 줄바꿈으로 여러 키워드를 입력할 수 있게 분리하고, 앞뒤 공백 제거/빈 값 제거/중복 제거/최대 글자수 검증을 적용합니다.
// 너무 긴 키워드는 건너뛰고(끊어서 억지로 포함하지 않음), 최대 개수를 넘으면 앞에서부터만 사용합니다.
export function parseKeywordList(raw: string): string[] {
  if (!raw) return [];
  const pieces = raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of pieces) {
    if (p.length > MAX_KEYWORD_LEN) continue; // 최대 글자수 초과 키워드는 제외
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(p);
    if (result.length >= MAX_KEYWORD_COUNT) break;
  }
  return result;
}
