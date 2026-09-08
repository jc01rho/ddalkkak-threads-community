// src/logging.ts
// 로그에 원본 identifier(license id/machine hash 전체)나 민감한 URL(presigned URL 전체,
// session token 전체)을 남기지 않기 위한 최소 sanitizer(요청서 11·32절).

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// actor 식별용 derived hash. 원본 license id/machine hash는 이 해시를 만드는 데만 쓰이고
// 결과 자체는 로그/session payload에 안전하게 남길 수 있는 값입니다.
export async function deriveActorHash(licenseId: string, machineHash: string): Promise<string> {
  return sha256Hex(`${licenseId}:${machineHash}`);
}

// rate limit pre-validation(license 검증 이전) 단계용 IP 파생 해시(Phase 12.5.6B.1).
// raw IP를 rate limiter key로 직접 쓰지 않기 위함 - 비가역 해시라 이 값만으로는 원본 IP를
// 복원할 수 없고, 로그에도 이 파생값만 남습니다(raw IP 자체는 로그에 남기지 않음).
export async function deriveIpRateLimitKey(ip: string): Promise<string> {
  return sha256Hex(`relay-ip:${ip}`);
}

// 로그에는 앞 8자리 prefix만 남깁니다(전체 값 노출 금지).
export function shortPrefix(value: string, length = 8): string {
  return value.slice(0, length) + "...";
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}(query redacted)`;
  } catch {
    return "(invalid url)";
  }
}

export function logInfo(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", message, ...fields }));
}

export function logWarn(message: string, fields: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "warn", message, ...fields }));
}

export function logError(message: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: "error", message, ...fields }));
}
