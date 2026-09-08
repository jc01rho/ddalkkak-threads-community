// src/pollToken.ts
// /oauth/start가 발급하고 /oauth/poll이 검증하는 HMAC-signed 토큰(media relay의 sessionToken과
// 같은 구조). 역할: "이 state를 poll할 자격"의 증명.
//
// 왜 state 하나로 poll을 허용하지 않는가: state는 Meta 인가 URL과 redirect를 거치며 사용자
// 브라우저의 주소창·히스토리·확장프로그램에 노출될 수 있는 값입니다. code를 꺼내는 열쇠가
// 그 값 하나뿐이면 브라우저 환경을 읽을 수 있는 누군가가 code를 가로챌 수 있습니다. pollToken은
// 로컬 딸깍 프로세스 메모리 밖으로 나가지 않으므로 두 열쇠가 모두 있어야 code가 나옵니다.
//
// 왜 poll마다 license 서버를 다시 부르지 않는가: media relay의 ready/cleanup과 같은 이유 -
// 폴링은 수 초 간격으로 반복되는데 매번 Apps Script를 호출하면 quota만 소모됩니다. license는
// /start에서 1회 fail-closed로 검증하고, 그 결과를 이 토큰이 운반합니다.

import { PollTokenPayload } from "./types.js";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signPollToken(payload: PollTokenPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export type PollTokenVerifyResult = { ok: true; payload: PollTokenPayload } | { ok: false; reason: "malformed" | "signature" | "expired" };

export async function verifyPollToken(token: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<PollTokenVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(sig), new TextEncoder().encode(body));
    if (!valid) return { ok: false, reason: "signature" };
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as PollTokenPayload;
    if (!payload || payload.v !== 1 || typeof payload.state !== "string" || typeof payload.actor !== "string" || typeof payload.exp !== "number") {
      return { ok: false, reason: "malformed" };
    }
    if (payload.exp <= nowSec) return { ok: false, reason: "expired" };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

// state 생성: 32바이트(256-bit) CSPRNG → base64url(43자). Worker가 생성하므로 클라이언트가
// 짧거나 예측 가능한 state를 등록하는 경로 자체가 없습니다.
export function generateState(randomBytes: number): string {
  const buf = new Uint8Array(randomBytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}
