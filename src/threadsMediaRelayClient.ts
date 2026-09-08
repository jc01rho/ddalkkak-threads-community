// src/threadsMediaRelayClient.ts
// Phase 12.5.6C: workers/threads-media-relay/의 production relay control API(session/ready/
// cleanup)를 호출하는 HTTP client입니다. R2 access key/secret, Worker HMAC signing secret은
// 이 파일에도, 이 앱 어디에도 존재하지 않습니다 - Worker가 발급한 presigned URL만 받아서
// 그대로 씁니다(요청서 4.4/4.5/8절).
//
// 재시도 정책: src/license/client.ts의 기존 패턴을 그대로 재사용합니다 - 5xx/네트워크
// 오류/JSON 파싱 실패만 "통신 실패"로 보고 최대 1회 재시도하고, 구조화된 거부 응답
// (ok:false, 즉 4xx 업무 오류 - 예: LICENSE_INVALID/SESSION_EXPIRED/MEDIA_TOO_LARGE)은
// 재시도해도 결과가 같으므로 즉시 그대로 반환합니다. 이 파일만의 새 재시도 타이밍/횟수
// 규칙을 발명하지 않습니다.
//
// 로그 규칙(요청서 6절): license_id/machine_hash 원문, session token, presigned URL 전체를
// 어디에도 console.log/warn/error로 남기지 않습니다. 유일한 로그(cleanup 실패 시 경고)는
// 에러 메시지 문자열만 남기며, 이 문자열에는 위 민감값이 포함되지 않습니다(threadsPublishDispatcher.ts
// 참고).

import { config } from "./env";

const RELAY_REQUEST_TIMEOUT_MS = 15000;
const RELAY_UPLOAD_TIMEOUT_MS = 60000; // VIDEO 등 큰 파일 업로드 여유
const RELAY_MAX_RETRIES = 1;

export type FetchLike = typeof fetch;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function relayBase(): string {
  return config.THREADS_MEDIA_RELAY_BASE_URL.trim().replace(/\/+$/, "");
}

export interface RelayUploadItem {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface RelaySessionUpload {
  index: number;
  filename: string; // 로컬 대응 파일명 - client 내부 매핑용. 서버로는 전송하지 않고, 서버 응답에도 없음.
  putUrl: string;
  contentType: string;
}

export interface RelayReadyMedia {
  index: number;
  getUrl: string;
}

type RelayFailure = { ok: false; reason: string };

async function postOnce(path: string, body: unknown, fetchImpl: FetchLike): Promise<{ ok: true; data: any } | RelayFailure> {
  const res = await fetchImpl(`${relayBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RELAY_REQUEST_TIMEOUT_MS),
  });
  if (res.status >= 500) {
    throw new Error(`relay 서버에서 일시적인 오류가 발생했습니다(HTTP ${res.status}).`);
  }
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("relay 응답을 해석할 수 없습니다(JSON 아님).");
  }
  if (!data || typeof data.ok !== "boolean") {
    throw new Error("relay 응답 형식이 올바르지 않습니다.");
  }
  if (!data.ok) {
    return { ok: false, reason: typeof data.message === "string" ? data.message : "relay 요청이 거부되었습니다." };
  }
  return { ok: true, data };
}

async function postWithRetry(path: string, body: unknown, fetchImpl: FetchLike): Promise<{ ok: true; data: any } | RelayFailure> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RELAY_MAX_RETRIES; attempt++) {
    try {
      return await postOnce(path, body, fetchImpl);
    } catch (e) {
      lastErr = e;
      if (attempt < RELAY_MAX_RETRIES) await sleep(500 * (attempt + 1));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return { ok: false, reason: `relay 서버에 연결할 수 없습니다: ${msg}` };
}

export interface CreateRelaySessionParams {
  licenseId: string;
  machineHash: string;
  mediaType: "IMAGE" | "VIDEO" | "CAROUSEL";
  items: readonly RelayUploadItem[]; // 순서 = 원하는 index 순서(CAROUSEL은 slideIndex 오름차순) 그대로
}

export type CreateRelaySessionResult = { ok: true; sessionToken: string; uploads: RelaySessionUpload[] } | RelayFailure;

// uploads는 항상 index 오름차순으로 정렬해 반환합니다(서버 응답 배열 순서를 신뢰하지 않고
// 각 item의 index 필드로 다시 정렬 - 요청서 11절 "CAROUSEL ordering" 원칙).
export async function createRelaySession(params: CreateRelaySessionParams, fetchImpl: FetchLike = fetch): Promise<CreateRelaySessionResult> {
  const result = await postWithRetry(
    "/v1/threads-media/session",
    {
      licenseId: params.licenseId,
      machineHash: params.machineHash,
      mediaType: params.mediaType,
      items: params.items.map((i) => ({ contentType: i.contentType, sizeBytes: i.sizeBytes })),
    },
    fetchImpl
  );
  if (!result.ok) return result;
  const data = result.data;
  if (typeof data.sessionToken !== "string" || !data.sessionToken || !Array.isArray(data.uploads)) {
    return { ok: false, reason: "relay 세션 응답 형식이 올바르지 않습니다." };
  }
  const uploads: RelaySessionUpload[] = [];
  for (const u of data.uploads) {
    if (typeof u?.index !== "number" || typeof u?.putUrl !== "string" || typeof u?.contentType !== "string") {
      return { ok: false, reason: "relay 세션 uploads 응답 형식이 올바르지 않습니다." };
    }
    const filename = params.items[u.index]?.filename;
    if (!filename) {
      return { ok: false, reason: "relay 세션 uploads의 index가 요청 item과 일치하지 않습니다." };
    }
    uploads.push({ index: u.index, filename, putUrl: u.putUrl, contentType: u.contentType });
  }
  if (uploads.length !== params.items.length) {
    return { ok: false, reason: "relay 세션 uploads 개수가 요청 item 수와 일치하지 않습니다." };
  }
  uploads.sort((a, b) => a.index - b.index);
  return { ok: true, sessionToken: data.sessionToken, uploads };
}

// PUT은 재시도해도 안전합니다(presigned URL은 동일 key를 다시 덮어쓸 뿐 - Buffer는 스트림이
// 아니라 재전송 가능). signature mismatch(4xx)는 재시도하지 않고, 5xx/네트워크 오류만
// postOnce와 동일하게 1회 재시도합니다.
export async function putRelayUpload(putUrl: string, contentType: string, fileBuffer: Buffer, fetchImpl: FetchLike = fetch): Promise<{ ok: true } | RelayFailure> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RELAY_MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(putUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: fileBuffer,
        signal: AbortSignal.timeout(RELAY_UPLOAD_TIMEOUT_MS),
      });
      if (res.status >= 500) {
        throw new Error(`업로드 서버 오류(HTTP ${res.status}).`);
      }
      if (!res.ok) {
        return { ok: false, reason: `업로드가 거부되었습니다(HTTP ${res.status}) - 형식/서명이 요청과 일치하지 않을 수 있습니다.` };
      }
      return { ok: true };
    } catch (e) {
      lastErr = e;
      if (attempt < RELAY_MAX_RETRIES) await sleep(500 * (attempt + 1));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return { ok: false, reason: `업로드 중 오류: ${msg}` };
}

export type MarkRelaySessionReadyResult = { ok: true; media: RelayReadyMedia[] } | RelayFailure;

export async function markRelaySessionReady(sessionToken: string, fetchImpl: FetchLike = fetch): Promise<MarkRelaySessionReadyResult> {
  const result = await postWithRetry("/v1/threads-media/ready", { sessionToken }, fetchImpl);
  if (!result.ok) return result;
  const data = result.data;
  if (!Array.isArray(data.media)) {
    return { ok: false, reason: "relay ready 응답 형식이 올바르지 않습니다." };
  }
  const media: RelayReadyMedia[] = [];
  for (const m of data.media) {
    if (typeof m?.index !== "number" || typeof m?.getUrl !== "string") {
      return { ok: false, reason: "relay ready media 응답 형식이 올바르지 않습니다." };
    }
    media.push({ index: m.index, getUrl: m.getUrl });
  }
  media.sort((a, b) => a.index - b.index);
  return { ok: true, media };
}

// best-effort입니다 - 실패해도 예외를 던지지 않습니다. cleanup 실패는 발행 성공/실패 결과에
// 영향을 주지 않으며, 최종적으로는 R2 lifecycle 규칙(design doc 7/13절)이 정리합니다.
export async function cleanupRelaySession(sessionToken: string, fetchImpl: FetchLike = fetch): Promise<{ ok: true } | RelayFailure> {
  return postWithRetry("/v1/threads-media/cleanup", { sessionToken }, fetchImpl).then(
    (r) => (r.ok ? { ok: true } : r),
    (e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) })
  );
}

export interface RelayMediaResult {
  ok: true;
  urls: string[]; // index 오름차순
  release: () => Promise<{ ok: true } | RelayFailure>;
}
export type RelayMediaFailure = { ok: false; reason: string };

// threadsMediaUrlProvider.ts가 부르는 단일 진입점입니다: session 발급 -> 순서대로 PUT 업로드
// -> ready(HEAD 검증 + GET URL 발급)까지 한 번에 처리합니다. 중간에 실패하면 그때까지 만든
// session을 best-effort로 cleanup한 뒤 실패를 반환합니다(요청서 24절 "일부 PUT 실패 시
// publish 진행 안 됨" - 부분 성공 상태로 URL을 돌려주지 않습니다).
export async function uploadViaRelay(
  identity: { licenseId: string; machineHash: string },
  mediaType: "IMAGE" | "VIDEO" | "CAROUSEL",
  items: readonly RelayUploadItem[],
  readFile: (filename: string) => Buffer,
  fetchImpl: FetchLike = fetch
): Promise<RelayMediaResult | RelayMediaFailure> {
  const session = await createRelaySession({ licenseId: identity.licenseId, machineHash: identity.machineHash, mediaType, items }, fetchImpl);
  if (!session.ok) return session;

  for (const upload of session.uploads) {
    let buf: Buffer;
    try {
      buf = readFile(upload.filename);
    } catch (e) {
      await cleanupRelaySession(session.sessionToken, fetchImpl);
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    const putResult = await putRelayUpload(upload.putUrl, upload.contentType, buf, fetchImpl);
    if (!putResult.ok) {
      await cleanupRelaySession(session.sessionToken, fetchImpl);
      return putResult;
    }
  }

  const ready = await markRelaySessionReady(session.sessionToken, fetchImpl);
  if (!ready.ok) {
    await cleanupRelaySession(session.sessionToken, fetchImpl);
    return ready;
  }
  if (ready.media.length !== items.length) {
    await cleanupRelaySession(session.sessionToken, fetchImpl);
    return { ok: false, reason: "relay ready 응답의 media 개수가 요청 item 수와 일치하지 않습니다." };
  }

  return {
    ok: true,
    urls: ready.media.map((m) => m.getUrl),
    release: () => cleanupRelaySession(session.sessionToken, fetchImpl),
  };
}
