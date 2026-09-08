// src/urlSafety.ts
// 사용자가 입력한 URL을 안전하게 가져오기 위한 최소한의 SSRF 방지 로직입니다.
// - http/https만 허용
// - localhost/사설 IP/루프백 등 내부 주소 차단 (리다이렉트로 이동한 주소도 매 hop마다 다시 검사)
// - 리다이렉트 횟수 제한, 요청 타임아웃, 응답 크기 제한

import dns from "dns";
import net from "net";
import http from "http";
import https from "https";

export const URL_FETCH_TIMEOUT_MS = 15000;
export const URL_MAX_REDIRECTS = 3;
export const URL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB

export function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true; // 판단 불가하면 안전하게 차단
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local (fc00::/7)
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.split(":").pop() || "";
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  // NAT64 well-known prefix(64:ff9b::/96)도 IPv4-mapped와 동일하게 내부 주소를 감싸 우회하는
  // 경로가 될 수 있어(어드버서리얼 리뷰 지적) ::ffff:와 같은 방식으로 마지막 32bit를 IPv4로
  // 풀어 재검사한다.
  if (lower.startsWith("64:ff9b::")) {
    const v4 = lower.split(":").pop() || "";
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  return false;
}

export function isPrivateOrLoopbackIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

const BLOCKED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localdomain"];

export interface HostCheckResult {
  blocked: boolean;
  reason?: string;
}

// hostname을 실제로 DNS 조회해서 사설/루프백 IP로 연결되는지 확인합니다.
// (문자열이 "example.com"처럼 보여도 내부망 DNS로 사설 IP를 가리키게 설정된 경우까지 최대한 막기 위함)
export async function checkHostSafety(hostname: string): Promise<HostCheckResult> {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") {
    return { blocked: true, reason: "localhost/내부 주소는 접근할 수 없습니다." };
  }
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suf) => h.endsWith(suf))) {
    return { blocked: true, reason: "내부망 주소는 접근할 수 없습니다." };
  }
  if (net.isIP(h)) {
    if (isPrivateOrLoopbackIp(h)) return { blocked: true, reason: "사설/루프백 IP는 접근할 수 없습니다." };
    return { blocked: false };
  }
  try {
    const addresses = await dns.promises.lookup(h, { all: true });
    if (addresses.length === 0) return { blocked: true, reason: "주소를 확인할 수 없습니다." };
    for (const a of addresses) {
      if (isPrivateOrLoopbackIp(a.address)) {
        return { blocked: true, reason: "내부/사설 네트워크 주소로 연결되어 차단되었습니다." };
      }
    }
    return { blocked: false };
  } catch {
    return { blocked: true, reason: "DNS 조회에 실패했습니다." };
  }
}

export type SafeFetchFailReason =
  | "invalid_url"
  | "blocked_host"
  | "timeout"
  | "network_error"
  | "http_error"
  | "too_many_redirects"
  | "response_too_large"
  | "unsupported_content_type";

export interface SafeFetchOk {
  ok: true;
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
}

export interface SafeFetchFail {
  ok: false;
  reason: SafeFetchFailReason;
  status?: number;
  message: string;
}

export type SafeFetchResult = SafeFetchOk | SafeFetchFail;

// script를 실행하지 않고, 리다이렉트를 직접 제한된 횟수만 따라가며, 매 hop마다 내부 주소 여부를 재검사합니다.
export async function safeFetchText(inputUrl: string): Promise<SafeFetchResult> {
  if (!isValidHttpUrl(inputUrl)) {
    return { ok: false, reason: "invalid_url", message: "http 또는 https URL만 지원합니다." };
  }

  let currentUrl = inputUrl;

  for (let hop = 0; hop <= URL_MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { ok: false, reason: "invalid_url", message: "올바르지 않은 URL입니다." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "invalid_url", message: "http 또는 https URL만 지원합니다." };
    }

    const hostCheck = await checkHostSafety(parsed.hostname);
    if (hostCheck.blocked) {
      return { ok: false, reason: "blocked_host", message: hostCheck.reason || "접근이 차단된 주소입니다." };
    }

    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        headers: { "User-Agent": "Mozilla/5.0 (ddalkkak-threads-factory)" },
        redirect: "manual",
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
      });
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.name === "AbortError") {
        return { ok: false, reason: "timeout", message: "요청 시간이 초과되었습니다." };
      }
      return { ok: false, reason: "network_error", message: e?.message || "접속에 실패했습니다." };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { ok: false, reason: "network_error", message: "리다이렉트 대상이 없습니다." };
      if (hop >= URL_MAX_REDIRECTS) {
        return { ok: false, reason: "too_many_redirects", message: "리다이렉트 횟수가 너무 많습니다." };
      }
      currentUrl = new URL(location, parsed).toString();
      continue;
    }

    if (res.status === 401) {
      return { ok: false, reason: "http_error", status: res.status, message: "로그인이 필요한 페이지입니다." };
    }
    if (res.status === 403 || res.status === 429) {
      return { ok: false, reason: "http_error", status: res.status, message: "접근이 거부되었습니다." };
    }
    if (!res.ok) {
      return { ok: false, reason: "http_error", status: res.status, message: `페이지를 가져오지 못했습니다 (HTTP ${res.status})` };
    }

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml") && !contentType.includes("text/plain")) {
      return { ok: false, reason: "unsupported_content_type", message: "지원하지 않는 콘텐츠 형식입니다 (HTML만 지원)." };
    }

    const contentLengthHeader = res.headers.get("content-length");
    if (contentLengthHeader && parseInt(contentLengthHeader, 10) > URL_MAX_RESPONSE_BYTES) {
      return { ok: false, reason: "response_too_large", message: "응답 크기가 너무 큽니다." };
    }

    if (!res.body) {
      return { ok: false, reason: "network_error", message: "응답 본문이 없습니다." };
    }

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > URL_MAX_RESPONSE_BYTES) {
            try { await reader.cancel(); } catch { /* ignore */ }
            return { ok: false, reason: "response_too_large", message: "응답 크기가 너무 큽니다." };
          }
          chunks.push(value);
        }
      }
    } catch {
      return { ok: false, reason: "network_error", message: "응답을 읽는 중 오류가 발생했습니다." };
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { ok: true, finalUrl: parsed.toString(), status: res.status, contentType, text: buf.toString("utf-8") };
  }

  return { ok: false, reason: "too_many_redirects", message: "리다이렉트 횟수가 너무 많습니다." };
}

// ---- Phase 12.5.3.2: DNS rebinding까지 막는 pinned binary fetch(원격 이미지 다운로드용) ----
//
// safeFetchText()의 checkHostSafety()는 "DNS를 조회해서 검사"와 "fetch()가 내부적으로 다시
// DNS를 조회해 연결"이 서로 다른 시점에 별도로 일어난다 - 그 사이 공격자가 DNS 응답을
// 바꾸면(DNS rebinding) 검사는 통과하고 실제 연결은 사설 주소로 갈 수 있다. 이 함수는 그
// 틈을 없앤다: dns.lookup()으로 딱 한 번 조회해 안전한 주소를 직접 고른 뒤, http(s).request()의
// lookup 옵션을 그 고정된 주소만 돌려주도록 덮어써서 실제 TCP 연결이 검사한 그 주소로만
// 가도록 강제한다(hostname/SNI/Host 헤더는 원래 hostname을 그대로 쓴다 - lookup만 가로챈다).
export type SafeFetchBinaryFailReason = SafeFetchFailReason | "userinfo_not_allowed";

export interface SafeFetchBinaryOk {
  ok: true;
  finalUrl: string;
  status: number;
  contentType: string;
  buffer: Buffer;
}

export interface SafeFetchBinaryFail {
  ok: false;
  reason: SafeFetchBinaryFailReason;
  status?: number;
  message: string;
}

export type SafeFetchBinaryResult = SafeFetchBinaryOk | SafeFetchBinaryFail;

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

// export 이유: literal IP hostname("8.8.8.8"/"127.0.0.1" 등)에 대한 dns.lookup()은 실제
// 네트워크 조회 없이 즉시 반환되므로(Node 내장 동작), 테스트가 실 인터넷/실 DNS 없이도
// public-허용/private-거부 판정만 직접 검증할 수 있다(요청서 22절 "실 internet 사용 금지").
export async function resolvePinnedAddress(hostname: string): Promise<{ ok: true; pinned: PinnedAddress } | { ok: false; reason: string }> {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0") {
    return { ok: false, reason: "localhost/내부 주소는 접근할 수 없습니다." };
  }
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suf) => h.endsWith(suf))) {
    return { ok: false, reason: "내부망 주소는 접근할 수 없습니다." };
  }
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (addresses.length === 0) return { ok: false, reason: "주소를 확인할 수 없습니다." };
    const first = addresses[0];
    if (isPrivateOrLoopbackIp(first.address)) {
      return { ok: false, reason: "내부/사설 네트워크 주소로 연결되어 차단되었습니다." };
    }
    return { ok: true, pinned: { address: first.address, family: first.family === 6 ? 6 : 4 } };
  } catch {
    return { ok: false, reason: "DNS 조회에 실패했습니다." };
  }
}

// Node의 net.connect()는 상황에 따라 lookup()을 "단일 주소" 콜백 형태(err, address, family)
// 또는 "여러 주소" 형태(err, addresses: {address, family}[], options.all===true일 때) 둘 중
// 하나로 호출한다 - 실측 확인 결과 http.request()는 항상 { all: true }로 호출하므로 이 분기를
// 빠뜨리면 Node가 배열이 와야 할 자리에 문자열을 받아 "Invalid IP address: undefined"로
// 죽는다. 어느 쪽으로 불려도 항상 같은 고정 주소 하나만 돌려주므로 실제 연결은 항상 이
// 주소로만 간다(핵심 pinning 보장은 동일).
function makePinnedLookup(pinned: PinnedAddress): NonNullable<http.RequestOptions["lookup"]> {
  return (_hostname, options, callback) => {
    if (options && typeof options === "object" && "all" in options && (options as { all?: boolean }).all) {
      (callback as (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void)(null, [
        { address: pinned.address, family: pinned.family },
      ]);
    } else {
      (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, pinned.address, pinned.family);
    }
  };
}

// 한 hop만 요청한다(redirect는 safeFetchBinary()의 바깥 루프가 매 hop마다 이 함수를 다시
// 호출해 새 hostname을 처음부터 재검증한다 - 이 함수 자체는 redirect를 따라가지 않는다).
// export 이유: pinning 메커니즘 자체(주어진 주소로 실제 연결하는지)를 127.0.0.1의 로컬 테스트
// 서버로 직접 검증하기 위함 - public/private 판정은 resolvePinnedAddress()의 책임이라 이
// 함수 자체에는 없다(요청서 22절, 로컬 서버는 "실 인터넷"이 아니다).
export function requestPinnedOnce(
  parsed: URL,
  pinned: PinnedAddress,
  maxBytes: number
): Promise<
  | { kind: "ok"; status: number; contentType: string; buffer: Buffer }
  | { kind: "redirect"; location: string }
  | { kind: "fail"; reason: SafeFetchBinaryFailReason; status?: number; message: string }
> {
  return new Promise((resolve) => {
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      parsed,
      {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (ddalkkak-threads-factory)" },
        lookup: makePinnedLookup(pinned),
        // https일 때 SNI/인증서 검증은 원래 hostname 기준으로 그대로 진행된다(parsed를 그대로
        // 넘겼으므로 servername이 자동으로 parsed.hostname이 된다 - IP로 바꿔치기하지 않는다).
        timeout: URL_FETCH_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          const location = res.headers.location;
          res.resume(); // body 버림
          if (!location) {
            resolve({ kind: "fail", reason: "network_error", message: "리다이렉트 대상이 없습니다." });
          } else {
            resolve({ kind: "redirect", location });
          }
          return;
        }
        if (status === 401) {
          res.resume();
          resolve({ kind: "fail", reason: "http_error", status, message: "로그인이 필요한 페이지입니다." });
          return;
        }
        if (status === 403 || status === 429) {
          res.resume();
          resolve({ kind: "fail", reason: "http_error", status, message: "접근이 거부되었습니다." });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve({ kind: "fail", reason: "http_error", status, message: `파일을 가져오지 못했습니다 (HTTP ${status})` });
          return;
        }

        const contentType = (res.headers["content-type"] || "").toLowerCase();
        const contentLengthHeader = res.headers["content-length"];
        if (contentLengthHeader && parseInt(contentLengthHeader, 10) > maxBytes) {
          res.resume();
          resolve({ kind: "fail", reason: "response_too_large", message: "응답 크기가 너무 큽니다." });
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        let settled = false;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            settled = true;
            res.destroy();
            resolve({ kind: "fail", reason: "response_too_large", message: "응답 크기가 너무 큽니다." });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ kind: "ok", status, contentType, buffer: Buffer.concat(chunks) });
        });
        res.on("error", () => {
          if (settled) return;
          settled = true;
          resolve({ kind: "fail", reason: "network_error", message: "응답을 읽는 중 오류가 발생했습니다." });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ECONNRESET" || (e as any).name === "TimeoutError") {
        resolve({ kind: "fail", reason: "timeout", message: "요청 시간이 초과되었습니다." });
      } else {
        resolve({ kind: "fail", reason: "network_error", message: e.message || "접속에 실패했습니다." });
      }
    });
    req.end();
  });
}

export async function safeFetchBinary(inputUrl: string, maxBytes: number): Promise<SafeFetchBinaryResult> {
  if (!isValidHttpUrl(inputUrl)) {
    return { ok: false, reason: "invalid_url", message: "http 또는 https URL만 지원합니다." };
  }

  let currentUrl = inputUrl;

  for (let hop = 0; hop <= URL_MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return { ok: false, reason: "invalid_url", message: "올바르지 않은 URL입니다." };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "invalid_url", message: "http 또는 https URL만 지원합니다." };
    }
    // username:password@host 형태는 자격 증명이 의도치 않게 서버로 전달되거나, 파싱기마다
    // host 판정이 갈리는 well-known 우회 트릭이라 거부한다(요청서 8절).
    if (parsed.username || parsed.password) {
      return { ok: false, reason: "userinfo_not_allowed", message: "인증 정보가 포함된 URL은 지원하지 않습니다." };
    }

    // redirect마다(첫 hop 포함) 이 hop의 실제 hostname을 처음부터 다시 검사+고정한다 -
    // public host가 private host로 redirect하는 경로를 이 재검사가 막는다.
    const resolved = await resolvePinnedAddress(parsed.hostname);
    if (!resolved.ok) {
      return { ok: false, reason: "blocked_host", message: resolved.reason };
    }

    const result = await requestPinnedOnce(parsed, resolved.pinned, maxBytes);
    if (result.kind === "fail") {
      return { ok: false, reason: result.reason, status: result.status, message: result.message };
    }
    if (result.kind === "redirect") {
      if (hop >= URL_MAX_REDIRECTS) {
        return { ok: false, reason: "too_many_redirects", message: "리다이렉트 횟수가 너무 많습니다." };
      }
      currentUrl = new URL(result.location, parsed).toString();
      continue;
    }
    return { ok: true, finalUrl: parsed.toString(), status: result.status, contentType: result.contentType, buffer: result.buffer };
  }

  return { ok: false, reason: "too_many_redirects", message: "리다이렉트 횟수가 너무 많습니다." };
}
