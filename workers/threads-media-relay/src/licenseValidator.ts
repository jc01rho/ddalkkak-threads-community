// src/licenseValidator.ts
// self-host relay의 client 인증.
//
// 이 Worker는 외부 라이선스 서버를 호출하지 않습니다. relay를 배포한 사람이
// `wrangler secret put THREADS_RELAY_CLIENT_KEY` 로 등록해 둔 client key 하나와,
// 요청 본문의 licenseId 값이 일치하는지만 확인합니다.
//
// wire 계약(licenseId/machineHash 두 문자열)·route·request/response schema는 그대로입니다.
// 바뀐 것은 "licenseId를 무엇과 비교하는가" 하나뿐입니다.
//
// machineHash는 여기서 검증하지 않습니다 - 기존과 동일하게 deriveActorHash()의 actor
// 구분(rate limit)에만 쓰입니다.
//
// fail-closed 정책도 그대로입니다: key가 설정되지 않은 Worker는 어떤 요청도 통과시키지
// 않습니다(설정 누락을 조용히 통과시키지 않기 위함).

export type LicenseValidationResult = { valid: true } | { valid: false; reason: "invalid" | "server_unavailable" };

export interface LicenseValidator {
  validate(licenseId: string, machineHash: string): Promise<LicenseValidationResult>;
}

// 비교 시간이 "몇 글자가 일치했는가"에 의존하지 않도록 항상 끝까지 훑고 누적 XOR만 봅니다.
// (Workers 런타임에는 node의 timingSafeEqual이 없어 동등한 상수시간 비교를 직접 씁니다.
//  길이 차이는 별도 XOR로 함께 접어 넣습니다.)
export function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length, 1);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export interface ClientKeyLicenseValidatorOptions {
  clientKey: string;
}

export class ClientKeyLicenseValidator implements LicenseValidator {
  constructor(private readonly opts: ClientKeyLicenseValidatorOptions) {}

  // machineHash는 검증에 쓰지 않습니다(기존과 동일하게 actor/rate-limit 구분 전용).
  // LicenseValidator 계약을 그대로 지키기 위해 인자는 받습니다.
  async validate(licenseId: string, _machineHash?: string): Promise<LicenseValidationResult> {
    const expected = (this.opts.clientKey ?? "").trim();
    if (!expected) return { valid: false, reason: "server_unavailable" };
    return timingSafeEqualString(licenseId, expected) ? { valid: true } : { valid: false, reason: "invalid" };
  }
}
