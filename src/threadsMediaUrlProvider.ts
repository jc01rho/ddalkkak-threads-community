// src/threadsMediaUrlProvider.ts
// Phase 12.5.4: "로컬 미디어 파일 -> Meta가 실제로 접근 가능한 public HTTPS URL" 한 가지만
// 책임지는 계층입니다. src/threads-api.ts(Threads publisher)는 이 계층이 돌려준 최종 public
// URL 문자열만 받습니다 - 그 URL이 어떻게 만들어졌는지(터널/리버스 프록시/CDN/signed URL 등)는
// 전혀 알지 못합니다. 그래서 향후 이 파일의 구현만 바꾸면(예: 실제 relay/CDN 연동을 추가하면)
// threads-api.ts나 threadsPublishDispatcher.ts는 손댈 필요가 없습니다.
//
// 이 앱은 127.0.0.1/::1에만 바인딩되는 로컬 전용 서버입니다(server.ts) - Meta 서버는 localhost/
// 127.0.0.1/file:///사설 LAN 주소에 절대 접근할 수 없습니다. 아직 이 저장소에는 영구적인 공개
// 미디어 relay가 없으므로(요청서 6절 - 이번 단계에서 임의로 외부 SaaS를 새로 도입하지 않음),
// 운영자가 THREADS_MEDIA_PUBLIC_BASE_URL(.env)에 스스로 마련한 공개 origin(예: 터널/리버스
// 프록시)을 설정하지 않는 한 이미지·영상 발행은 THREADS_MEDIA_PUBLIC_URL_REQUIRED로 명확히
// 실패합니다. 실패 시에도 TEXT로 조용히 강등하지 않습니다(호출자 threadsPublishDispatcher.ts
// 책임).
//
// 보안 감사 후 수정(같은 Phase 12.5.4 내 correction): 최초 구현은 기존
// GET /api/product-radar/media/:filename(딸깍 메인 서버, 대시보드/드래프트/예약/설정 등 전체
// /api가 함께 있는 포트)을 그대로 재사용했습니다. 감사 결과 이 방식은 위험합니다 - 운영자가
// THREADS_MEDIA_PUBLIC_BASE_URL을 그 메인 서버 포트로 향하는 터널에 설정하면, 그 터널이
// 열려있는 동안 미디어 파일만이 아니라 대시보드/DB/설정 API 전체가 함께 외부에 노출됩니다
// (요청 자체에 클라이언트별 인증이 없는 구조라서 - requireLicense는 "이 PC 라이선스가
// 유효한가"만 봅니다, 요청 주체를 구분하지 않습니다). 그래서 이제 두 가지를 조합합니다:
//   1) threadsMediaGateway.ts - 실제 파일명을 절대 노출하지 않는 짧은 수명의 opaque token
//      (파일명에서 파생/인코딩되지 않은 256비트 난수, 메모리에만 존재, 만료 후 재사용 불가)
//   2) threadsMediaListener.ts - 그 token 경로(GET /threads-media/:token) "하나만" 제공하는
//      완전히 별도의 HTTP listener/포트(대시보드/설정/DB API가 전혀 없음)
// THREADS_MEDIA_PUBLIC_BASE_URL은 이제 딸깍 메인 포트가 아니라 이 전용 listener 포트
// (config.THREADS_MEDIA_GATEWAY_PORT)를 가리켜야 합니다 - 운영자가 터널을 그 포트에만 걸면
// 메인 서버는 구조적으로 절대 노출되지 않습니다. 이 계층의 구현이 바뀌어도(예: 실제 relay/
// CDN/signed URL로 교체) threads-api.ts/threadsPublishDispatcher.ts는 여전히 손댈 필요가
// 없습니다 - 그쪽은 최종 URL 문자열만 받습니다.

import fs from "fs";
import { config } from "./env";
import { computeMachineHash } from "./deviceId";
import { getMimeForFilename, isSafeMediaFilename, resolveMediaPath } from "./mediaUpload";
import { issueThreadsMediaToken } from "./threadsMediaGateway";
import { RelayUploadItem, uploadViaRelay } from "./threadsMediaRelayClient";

export const THREADS_MEDIA_PUBLIC_URL_REQUIRED = "THREADS_MEDIA_PUBLIC_URL_REQUIRED";

// Phase 12.5.6C: relay 경로를 쓴 경우에만 release가 채워집니다(local gateway는 token TTL로
// 자연 만료되므로 명시적 release가 필요 없음 - undefined). 호출자(threadsPublishDispatcher.ts)는
// publish 시도가 끝난 뒤 release가 있으면 best-effort로 호출합니다.
export type ThreadsMediaPublicUrlResult =
  | { ok: true; url: string; release?: () => Promise<unknown> }
  | { ok: false; code: typeof THREADS_MEDIA_PUBLIC_URL_REQUIRED; reason: string };

export type ThreadsMediaPublicUrlsResult =
  | { ok: true; urls: readonly string[]; release?: () => Promise<unknown> }
  | { ok: false; code: typeof THREADS_MEDIA_PUBLIC_URL_REQUIRED; reason: string };

export type ThreadsSingleMediaKind = "IMAGE" | "VIDEO";

const DISALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

// ponytail: 정식 IP 대역 판정 라이브러리 대신 흔한 사설/루프백 대역만 정규식으로 막는
// 최소 방어입니다(IPv6 ULA 등 예외는 다루지 않음) - 운영자가 스스로 설정하는 값이라
// 공격 표면이 아니라 "실수로 사설 주소를 넣는 것"만 막으면 충분합니다. 더 엄밀한 판정이
// 필요해지면(예: IPv6 지원) 이 함수만 교체하면 됩니다.
function isLocalOrPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (DISALLOWED_HOSTNAMES.has(h)) return true;
  if (h.endsWith(".local")) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function validatedPublicBaseUrl(): { ok: true; base: string } | { ok: false; reason: string } {
  const raw = config.THREADS_MEDIA_PUBLIC_BASE_URL.trim();
  if (!raw) {
    return { ok: false, reason: "THREADS_MEDIA_PUBLIC_BASE_URL이 .env에 설정되지 않았습니다." };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "THREADS_MEDIA_PUBLIC_BASE_URL이 올바른 URL 형식이 아닙니다." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "THREADS_MEDIA_PUBLIC_BASE_URL은 반드시 https:// 여야 합니다." };
  }
  if (isLocalOrPrivateHostname(parsed.hostname)) {
    return { ok: false, reason: "THREADS_MEDIA_PUBLIC_BASE_URL이 localhost/사설 주소를 가리킵니다(Meta 서버가 접근할 수 없습니다)." };
  }
  return { ok: true, base: raw.replace(/\/+$/, "") };
}

// Phase 12.5.6C: THREADS_MEDIA_RELAY_BASE_URL이 https://로 설정돼 있으면 relay 경로를 씁니다.
// 비어 있으면(기본값) 아래 local gateway 경로를 그대로 씁니다(dev/QA 기본값 - design doc
// 16~17절). 이 판정 하나로 함수 전체 분기를 결정합니다 - 별도 모드 플래그를 추가하지 않습니다.
function relayBaseConfigured(): boolean {
  const raw = config.THREADS_MEDIA_RELAY_BASE_URL.trim();
  if (!raw) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

// relay session 요청에 필요한 신원을 만듭니다. wire 필드명(licenseId/machineHash)과 이후
// 호출 흐름은 그대로이고, licenseId의 출처만 self-host relay client key로 바뀌었습니다.
// key가 없으면 relay를 쓸 수 없으므로 null을 돌려주고, 호출부가 기존과 동일하게
// THREADS_MEDIA_PUBLIC_URL_REQUIRED로 실패시킵니다(대체값을 만들지 않습니다).
function getRelayIdentity(): { licenseId: string; machineHash: string } | null {
  const clientKey = config.THREADS_RELAY_CLIENT_KEY.trim();
  if (!clientKey) return null;
  try {
    return { licenseId: clientKey, machineHash: computeMachineHash() };
  } catch {
    return null;
  }
}

function buildRelayItem(filename: string): RelayUploadItem | null {
  const mime = getMimeForFilename(filename);
  const fullPath = resolveMediaPath(filename);
  if (!mime || !fullPath) return null;
  try {
    return { filename, contentType: mime, sizeBytes: fs.statSync(fullPath).size };
  } catch {
    return null;
  }
}

function readMediaFileBuffer(filename: string): Buffer {
  const fullPath = resolveMediaPath(filename);
  if (!fullPath) throw new Error("파일 경로를 확인할 수 없습니다.");
  return fs.readFileSync(fullPath);
}

async function getThreadsMediaPublicUrlViaRelay(filename: string, mediaType: ThreadsSingleMediaKind): Promise<ThreadsMediaPublicUrlResult> {
  const identity = getRelayIdentity();
  if (!identity) {
    return { ok: false, code: THREADS_MEDIA_PUBLIC_URL_REQUIRED, reason: "relay 접속 키(THREADS_RELAY_CLIENT_KEY)를 확인할 수 없어 relay 세션을 발급받을 수 없습니다." };
  }
  const item = buildRelayItem(filename);
  if (!item) {
    return { ok: false, code: THREADS_MEDIA_PUBLIC_URL_REQUIRED, reason: "미디어 파일 정보를 확인할 수 없습니다." };
  }
  const relayResult = await uploadViaRelay(identity, mediaType, [item], readMediaFileBuffer);
  if (!relayResult.ok) {
    return { ok: false, code: THREADS_MEDIA_PUBLIC_URL_REQUIRED, reason: relayResult.reason };
  }
  return { ok: true, url: relayResult.urls[0], release: relayResult.release };
}

async function getThreadsMediaPublicUrlsViaRelay(filenames: readonly string[]): Promise<ThreadsMediaPublicUrlsResult> {
  const identity = getRelayIdentity();
  if (!identity) {
    return { ok: false, code: THREADS_MEDIA_PUBLIC_URL_REQUIRED, reason: "relay 접속 키(THREADS_RELAY_CLIENT_KEY)를 확인할 수 없어 relay 세션을 발급받을 수 없습니다." };
  }
  const items: RelayUploadItem[] = [];
  for (const filename of filenames) {
    const item = buildRelayItem(filename);
    if (!item) {
      return { ok: false, code: THREADS_MEDIA_PUBLIC_URL_REQUIRED, reason: "미디어 파일 정보를 확인할 수 없습니다." };
    }
    items.push(item);
  }
  // CAROUSEL은 단일 session에 2~3개 슬롯을 담습니다(design doc 12절 B안 - child별 독립
  // session을 만들지 않음). items 순서는 호출자(threadsPublishDispatcher.ts)가 이미
  // slideIndex 오름차순으로 보장한 상태로 넘겨줍니다.
  const relayResult = await uploadViaRelay(identity, "CAROUSEL", items, readMediaFileBuffer);
  if (!relayResult.ok) {
    return { ok: false, code: THREADS_MEDIA_PUBLIC_URL_REQUIRED, reason: relayResult.reason };
  }
  return { ok: true, urls: relayResult.urls, release: relayResult.release };
}

// P1.6(AUD-P1-003): "이 설치본이 IMAGE/VIDEO/CAROUSEL을 실제로 발행할 수 있는 구성인가"를
// 한 곳에서 판정한다. 실제 발급 경로(getThreadsMediaPublicUrl*)가 쓰는 판정과 정확히 같은
// 함수(relayBaseConfigured/validatedPublicBaseUrl)만 재사용한다 - 별도 기준을 발명하지 않는다.
// /api/status가 이 값을 내려주고, 화면은 미구성일 때만 "미디어 발행 서비스 미연결" 안내를
// 표시한다(TEXT 발행과는 무관 - TEXT는 이 값과 상관없이 항상 가능).
export function isThreadsMediaPublishConfigured(): boolean {
  return relayBaseConfigured() || validatedPublicBaseUrl().ok;
}

// filename은 반드시 mediaUpload.ts의 SAFE_FILENAME_PATTERN(UUID+허용 확장자)을 통과해야
// 합니다 - 호출자가 이미 threadsMediaAttachment.ts에서 검증한 파일명만 넘기지만, 이 함수도
// 한 번 더 확인해 잘못된 값이 새어나가지 않게 합니다. 호출할 때마다 새 token/session을
// 발급합니다(멱등하지 않음) - 매 발행 시도가 자기만의 짧은 수명 URL을 갖습니다. mediaType은
// relay 경로에서 세션 요청에 필요합니다(local gateway 경로에서는 쓰이지 않습니다).
export async function getThreadsMediaPublicUrl(filename: string, mediaType: ThreadsSingleMediaKind): Promise<ThreadsMediaPublicUrlResult> {
  if (!isSafeMediaFilename(filename)) {
    return { ok: false, code: THREADS_MEDIA_PUBLIC_URL_REQUIRED, reason: "내부 파일명이 안전한 형식이 아닙니다." };
  }
  if (relayBaseConfigured()) {
    return getThreadsMediaPublicUrlViaRelay(filename, mediaType);
  }
  const baseResult = validatedPublicBaseUrl();
  if (!baseResult.ok) {
    return { ok: false, code: THREADS_MEDIA_PUBLIC_URL_REQUIRED, reason: baseResult.reason };
  }
  const token = issueThreadsMediaToken(filename);
  return { ok: true, url: `${baseResult.base}/threads-media/${token}` };
}

// Phase 12.5.4.1/12.5.6C: CAROUSEL은 child마다 별도 public URL이 필요합니다.
// - relay 경로: 단일 session(2~3개 슬롯)으로 한 번에 처리합니다(getThreadsMediaPublicUrlsViaRelay).
// - local gateway 경로(기본값): 새 구현을 만들지 않고 getThreadsMediaPublicUrl()을 파일마다
//   그대로 재사용합니다(each child = "특정 파일 1개에만 묶인 token" 원칙을 그대로 따름).
// 두 경로 모두 하나라도 실패하면 즉시 전체를 실패로 반환합니다 - 일부 slide만 public URL을
// 가진 채 발행을 시도하지 않습니다(child atomicity는 threadsPublishDispatcher.ts/threads-api.ts가
// 이어서 보장 - 이 함수는 "URL 발급 단계"의 all-or-nothing만 담당).
export async function getThreadsMediaPublicUrls(filenames: readonly string[]): Promise<ThreadsMediaPublicUrlsResult> {
  if (relayBaseConfigured()) {
    return getThreadsMediaPublicUrlsViaRelay(filenames);
  }
  const urls: string[] = [];
  for (const filename of filenames) {
    const result = await getThreadsMediaPublicUrl(filename, "IMAGE");
    if (!result.ok) return result;
    urls.push(result.url);
  }
  return { ok: true, urls };
}
