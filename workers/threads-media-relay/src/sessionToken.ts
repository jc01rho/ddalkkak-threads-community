// src/sessionToken.ts
// HMAC-SHA256으로 서명된 stateless session token(요청서 17절). 별도 DB/Durable Object
// 없이, "이 payload는 서버가 발급했고 변조되지 않았다"를 서명 하나로 보장합니다. Web Crypto
// API만 사용합니다(외부 JWT 라이브러리 도입 없음 - 요청서: "필요하지 않으면 도입하지 않는다").
//
// 형식: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
// JWT와 유사하지만 header가 없습니다 - 이 프로젝트 전용 최소 포맷이라 JWT 표준을 자처하지
// 않습니다(alg confusion 등 JWT 특유의 함정도 구조적으로 없음 - 알고리즘은 항상 HMAC-SHA256
// 고정).

import { SessionTokenPayload } from "./types.js";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(input: string): Uint8Array {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signSessionToken(payload: SessionTokenPayload, hmacSecret: string): Promise<string> {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = toBase64Url(new TextEncoder().encode(payloadJson));
  const key = await importHmacKey(hmacSecret);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = toBase64Url(new Uint8Array(sigBuf));
  return `${payloadB64}.${sigB64}`;
}

export type SessionTokenVerifyResult = { ok: true; payload: SessionTokenPayload } | { ok: false; reason: "malformed" | "signature_invalid" | "expired" | "version_mismatch" };

export async function verifySessionToken(token: string, hmacSecret: string, nowMs: number = Date.now()): Promise<SessionTokenVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payloadB64, sigB64] = parts;

  let key: CryptoKey;
  try {
    key = await importHmacKey(hmacSecret);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  let sigValid: boolean;
  try {
    sigValid = await crypto.subtle.verify("HMAC", key, fromBase64Url(sigB64), new TextEncoder().encode(payloadB64));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!sigValid) return { ok: false, reason: "signature_invalid" };

  let payload: SessionTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload.v !== 1) return { ok: false, reason: "version_mismatch" };
  if (typeof payload.exp !== "number" || nowMs > payload.exp * 1000) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}
