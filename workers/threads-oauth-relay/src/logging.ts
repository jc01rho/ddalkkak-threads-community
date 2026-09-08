// src/logging.ts
// 로그 최소화 원칙. 이 Worker의 로그에는 authorization code, state 원문, pollToken, raw IP,
// raw license id/machine hash 중 어느 것도 남기지 않습니다. 남길 수 있는 값은 파생 해시와
// 상태명(pending/ready/...)뿐입니다. 아래 logInfo/logWarn의 fields에 위 값을 넣는 코드가
// 있으면 test/noCodeLeak.test.ts가 실패합니다.

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// actor 식별용 파생 해시(media relay와 동일 규칙). 원본 license id/machine hash는 이 해시를
// 만드는 데만 쓰이고 저장/로그에는 이 값만 남습니다.
export async function deriveActorHash(licenseId: string, machineHash: string): Promise<string> {
  return sha256Hex(`${licenseId}:${machineHash}`);
}

// license 검증 이전 단계(/start)와 Meta callback(/callback)의 burst limiter key용 IP 파생 해시.
export async function deriveIpRateLimitKey(ip: string): Promise<string> {
  return sha256Hex(`oauth-relay-ip:${ip}`);
}

export function logInfo(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", message, ...fields }));
}

export function logWarn(message: string, fields: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: "warn", message, ...fields }));
}
