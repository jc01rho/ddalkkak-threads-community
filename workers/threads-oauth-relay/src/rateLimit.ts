// src/rateLimit.ts
// Cloudflare Rate Limiting binding은 burst 남용에 대한 부가 방어선일 뿐입니다(요청서 27절) -
// 정확한 "일일 quota 집행" 수단이 아닙니다(공식 문서 기준 근사치/best-effort 특성이며, 이
// Worker는 그렇다고 주장하지 않습니다). binding이 없는 환경(로컬/테스트)이나 limiter 자체
// 오류 시에는 정상 요청을 막지 않고 통과시킵니다 - 이 Worker의 핵심 보안 경계는 license
// 검증(fail-closed)과 HMAC session token이며, rate limit은 그 위에 얹는 추가 계층입니다.

export async function checkRateLimit(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    const result = await limiter.limit({ key });
    return result.success;
  } catch {
    return true;
  }
}
