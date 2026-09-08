// src/threads-api.ts
// Meta 공식 Threads API(graph.threads.net)만 사용합니다.
// 브라우저 자동화/CDP/Playwright/Selenium/탐지회피/비공식 조작은 절대 사용하지 않습니다.
//
// 근거 문서(2026년 8월 기준, Meta for Developers 공식 문서):
// - https://developers.facebook.com/docs/threads/get-started
// - https://developers.facebook.com/docs/threads/posts
// - https://developers.facebook.com/docs/threads/get-started/long-lived-tokens
//
// 게시 절차(공식 문서 기준):
//   1) POST /{threads-user-id}/threads   (media_type=TEXT, text=..., access_token=...) -> { id: 컨테이너ID }
//   2) (권장) 서버 처리를 위해 잠시 대기
//   3) POST /{threads-user-id}/threads_publish (creation_id=컨테이너ID, access_token=...) -> { id: 게시물ID }
//
// v1은 텍스트 게시물만 지원합니다. 이미지/영상은 UI에 "추후 지원"으로 표시합니다.

import { config } from "./env";

export interface TokenValidation {
  valid: boolean;
  username?: string;
  userId?: string;
  error?: string;
}

// 후보 자격증명(사용자가 방금 입력한 값)을 저장하기 "전에" 검증하기 위한 선택적 인자입니다.
// 생략하면 기존과 완전히 동일하게 현재 config 값을 검증합니다(기존 호출부 무변경).
//
// 전역 config를 후보값으로 잠깐 바꿨다가 되돌리는 방식은 쓰지 않습니다 - 그 사이 다른 요청이나
// 스케줄러가 후보값으로 실제 게시를 시도할 수 있기 때문입니다(race). 후보값은 이 함수 안에서만
// 지역 변수로 쓰입니다.
export interface ThreadsCredentialCandidate {
  accessToken: string;
  userId: string;
}

export async function validateThreadsToken(candidate?: ThreadsCredentialCandidate): Promise<TokenValidation> {
  // 문서(설명서) 캡처 전용 모드: 실제 네트워크 호출 없이 고정된 가상 연결 상태만 반환합니다.
  if (config.DOCS_MODE) {
    return { valid: true, username: "EXAMPLE_THREADS_USER", userId: "EXAMPLE_THREADS_USER_ID" };
  }
  const accessToken = candidate ? candidate.accessToken : config.THREADS_ACCESS_TOKEN;
  const userId = candidate ? candidate.userId : config.THREADS_USER_ID;
  if (!accessToken || !userId) {
    return { valid: false, error: "액세스 토큰 또는 Threads 사용자 ID가 설정되지 않았습니다." };
  }
  try {
    const url = `${config.THREADS_GRAPH_BASE}/${encodeURIComponent(userId)}?fields=id,username&access_token=${encodeURIComponent(
      accessToken
    )}`;
    // 방어: 오류 메시지에 토큰 원문이 섞여 나가지 않도록 항상 한 번 걸러냅니다. 토큰은 위
    // URL의 쿼리스트링에 들어가므로, 런타임이 오류 메시지에 URL을 포함시키면 그대로 노출될 수
    // 있습니다(요청서: 전체 토큰은 응답/로그/오류 메시지 어디에도 남기지 않는다).
    const scrub = (msg: string): string => (accessToken ? msg.split(accessToken).join("***") : msg);

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { valid: false, error: scrub(String(data?.error?.message || `HTTP ${res.status}`)) };
    }
    return { valid: true, username: data.username, userId: data.id };
  } catch (e: any) {
    const raw = String(e?.message || e);
    return { valid: false, error: accessToken ? raw.split(accessToken).join("***") : raw };
  }
}

export interface PublishResult {
  success: boolean;
  postId?: string;
  error?: string;
  authError?: boolean; // 인증 오류(토큰/권한 문제)면 true - 이 경우 자동 재시도하지 않음
  // Phase 12.5.4/12.5.4.1: IMAGE/VIDEO/CAROUSEL 발행 실패의 구체 단계를 구분하는 안정적인
  // 코드(로그/분기용). TEXT 경로(publishTextToThreads)는 절대 채우지 않습니다(기존 동작
  // 무변경). 이 파일이 만드는 값은 단일 IMAGE/VIDEO용 THREADS_MEDIA_CONTAINER_FAILED |
  // THREADS_MEDIA_PROCESSING_FAILED | THREADS_MEDIA_PROCESSING_TIMEOUT |
  // THREADS_MEDIA_PUBLISH_FAILED, CAROUSEL 전용 THREADS_MEDIA_CAROUSEL_TOO_FEW_ITEMS |
  // _TOO_MANY_ITEMS | _ITEM_FAILED | _CONTAINER_FAILED | _PROCESSING_FAILED |
  // _PROCESSING_TIMEOUT(그리고 CAROUSEL도 최종 발행 실패는 공용 THREADS_MEDIA_PUBLISH_FAILED를
  // 그대로 재사용)이지만, 발행 이전 단계(threadsMediaAttachment.ts/threadsMediaUrlProvider.ts)의
  // 코드도 threadsPublishDispatcher.ts가 같은 필드에 그대로 실어 호출자가 코드 하나만 보면
  // 되게 합니다 - 그래서 타입을 string으로 둡니다.
  mediaErrorCode?: string;
}

function isAuthError(status: number, data: any): boolean {
  if (status === 401 || status === 403) return true;
  const code = data?.error?.code;
  // Meta Graph API의 대표적인 인증/권한 관련 오류 코드
  if (code === 190 || code === 10 || code === 200 || code === 4 || code === 100) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 텍스트 전용 Threads 게시물을 실제로 발행합니다. (v1: 텍스트만 지원)
export async function publishTextToThreads(text: string): Promise<PublishResult> {
  if (!config.THREADS_ACCESS_TOKEN || !config.THREADS_USER_ID) {
    return { success: false, error: "토큰/사용자 ID가 설정되지 않았습니다.", authError: true };
  }
  if (!text || !text.trim()) {
    return { success: false, error: "본문이 비어 있습니다." };
  }

  try {
    // 1단계: 미디어 컨테이너 생성
    const createUrl = `${config.THREADS_GRAPH_BASE}/${encodeURIComponent(config.THREADS_USER_ID)}/threads`;
    const createBody = new URLSearchParams({
      media_type: "TEXT",
      text,
      access_token: config.THREADS_ACCESS_TOKEN,
    });
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: createBody.toString(),
      signal: AbortSignal.timeout(30000),
    });
    const createData: any = await createRes.json().catch(() => ({}));
    if (!createRes.ok || createData.error || !createData.id) {
      return {
        success: false,
        error: createData?.error?.message || `컨테이너 생성 실패 (HTTP ${createRes.status})`,
        authError: isAuthError(createRes.status, createData),
      };
    }
    const creationId = createData.id as string;

    // 2단계: 서버가 업로드를 처리할 시간을 잠시 준다 (공식 문서 권장: 평균 약 30초)
    await sleep(config.THREADS_PUBLISH_WAIT_MS);

    // 3단계: 발행
    const publishUrl = `${config.THREADS_GRAPH_BASE}/${encodeURIComponent(config.THREADS_USER_ID)}/threads_publish`;
    const publishBody = new URLSearchParams({
      creation_id: creationId,
      access_token: config.THREADS_ACCESS_TOKEN,
    });
    const publishRes = await fetch(publishUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: publishBody.toString(),
      signal: AbortSignal.timeout(30000),
    });
    const publishData: any = await publishRes.json().catch(() => ({}));
    if (!publishRes.ok || publishData.error || !publishData.id) {
      return {
        success: false,
        error: publishData?.error?.message || `발행 실패 (HTTP ${publishRes.status})`,
        authError: isAuthError(publishRes.status, publishData),
      };
    }

    return { success: true, postId: publishData.id as string };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

// ============================================================================
// Phase 12.5.4: IMAGE/VIDEO 실제 발행 (근거 문서, 2026-08 확인, Meta for Developers 공식):
// - https://developers.facebook.com/docs/threads/posts
//   media_type=IMAGE(image_url 필수, JPEG/PNG만) | media_type=VIDEO(video_url 필수, MOV/MP4·
//   H264/HEVC+AAC만) - text는 두 경우 모두 선택(caption).
// - https://developers.facebook.com/docs/threads/troubleshooting
//   컨테이너 상태 확인: GET /{container-id}?fields=status,error_message
//   status: EXPIRED | ERROR | FINISHED | IN_PROGRESS | PUBLISHED
//   권장: "1분마다, 최대 5분까지" 폴링 (config.THREADS_VIDEO_POLL_INTERVAL_MS/_MAX_ATTEMPTS)
// CAROUSEL(media_type=CAROUSEL, item container에 is_carousel_item=true + children)도 공식
// 지원되며, Phase 12.5.4.1부터 publishCarouselToThreads()로 실제 연결됩니다(src/
// threadsMediaAttachment.ts가 이 앱이 실제로 지원하는 carousel 범위(이미지 slide만, 2~20개)를
// 발행 시도 이전에 이미 확정해 넘겨줍니다). GIF는 own-media media_type으로 지원되지 않아
// (gif_attachment는 TEXT 전용 post에 외부 GIF provider의 gif_id를 붙이는 별도 기능 - Meta
// 공식 Threads API Postman 문서 예시는 provider=TENOR) 이 파일에서 다루지 않습니다 -
// src/threadsMediaAttachment.ts가 그 판단을 이미 발행 시도 이전에 끝냅니다.
// imageUrl/videoUrl은 반드시 Meta가 접근 가능한 public HTTPS URL이어야 합니다(로컬 경로 금지 -
// threadsMediaUrlProvider.ts가 만든 값만 여기로 들어옵니다).
// ============================================================================

// container 생성(POST .../threads) 공통 HTTP 처리 - IMAGE/VIDEO/carousel item/carousel
// parent 넷 다 "POST .../threads로 params를 보내고 { id }를 받는다"는 동일한 모양이라
// 이 부분만 공유합니다(요청서: "동일 endpoint 로직을 복붙하지 않는다"). contextLabel은
// 실패 메시지에만 쓰이는 표시용 문자열입니다.
async function postThreadsContainerCreate(params: Record<string, string>, contextLabel: string): Promise<{ ok: true; creationId: string } | { ok: false; result: PublishResult }> {
  const createUrl = `${config.THREADS_GRAPH_BASE}/${encodeURIComponent(config.THREADS_USER_ID)}/threads`;
  const createRes = await fetch(createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30000),
  });
  const createData: any = await createRes.json().catch(() => ({}));
  if (!createRes.ok || createData.error || !createData.id) {
    return {
      ok: false,
      result: {
        success: false,
        error: createData?.error?.message || `${contextLabel} 컨테이너 생성 실패 (HTTP ${createRes.status})`,
        authError: isAuthError(createRes.status, createData),
        mediaErrorCode: "THREADS_MEDIA_CONTAINER_FAILED",
      },
    };
  }
  return { ok: true, creationId: createData.id as string };
}

// extraParams는 carousel item container 생성 시 is_carousel_item=true를 얹기 위한
// 것입니다(Phase 12.5.4.1) - 기본값 undefined면 기존 IMAGE/VIDEO 단일 발행과 완전히 동일하게
// 동작합니다(하위호환).
async function createThreadsMediaContainer(
  mediaType: "IMAGE" | "VIDEO",
  mediaUrlParam: "image_url" | "video_url",
  mediaUrl: string,
  text: string,
  extraParams?: Record<string, string>
): Promise<{ ok: true; creationId: string } | { ok: false; result: PublishResult }> {
  const params: Record<string, string> = {
    media_type: mediaType,
    [mediaUrlParam]: mediaUrl,
    access_token: config.THREADS_ACCESS_TOKEN,
    ...extraParams,
  };
  if (text && text.trim()) params.text = text;
  return postThreadsContainerCreate(params, mediaType);
}

// CAROUSEL parent container 생성(media_type=CAROUSEL, children=child container id들을 콤마로
// 연결). children 순서는 호출자(publishCarouselToThreads)가 이미 slideIndex 순서 그대로
// 보존한 배열을 넘긴다고 신뢰합니다 - 여기서 재정렬하지 않습니다(정렬 실수를 이 함수가 아니라
// "원본 slide 순서를 아는" 호출자 책임으로 명확히 둠).
async function createThreadsCarouselParentContainer(text: string, childCreationIds: readonly string[]): Promise<{ ok: true; creationId: string } | { ok: false; result: PublishResult }> {
  const params: Record<string, string> = {
    media_type: "CAROUSEL",
    children: childCreationIds.join(","),
    access_token: config.THREADS_ACCESS_TOKEN,
  };
  if (text && text.trim()) params.text = text;
  return postThreadsContainerCreate(params, "CAROUSEL");
}

async function getThreadsContainerStatus(
  containerId: string
): Promise<{ ok: true; status: string; errorMessage?: string } | { ok: false; error: string; authError: boolean }> {
  try {
    const url = `${config.THREADS_GRAPH_BASE}/${encodeURIComponent(containerId)}?fields=status,error_message&access_token=${encodeURIComponent(
      config.THREADS_ACCESS_TOKEN
    )}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}`, authError: isAuthError(res.status, data) };
    }
    return { ok: true, status: data.status, errorMessage: data.error_message };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e), authError: false };
  }
}

// 공식 문서 권장대로 평균 대기(THREADS_PUBLISH_WAIT_MS) 후, 최대 THREADS_VIDEO_POLL_MAX_ATTEMPTS회까지
// THREADS_VIDEO_POLL_INTERVAL_MS 간격으로 상태를 확인합니다. 무한 폴링은 하지 않습니다.
async function waitForThreadsContainerFinished(containerId: string): Promise<{ ok: true } | { ok: false; result: PublishResult }> {
  await sleep(config.THREADS_PUBLISH_WAIT_MS);
  for (let attempt = 1; attempt <= config.THREADS_VIDEO_POLL_MAX_ATTEMPTS; attempt++) {
    const statusRes = await getThreadsContainerStatus(containerId);
    if (!statusRes.ok) {
      return {
        ok: false,
        result: {
          success: false,
          error: `상태 확인 실패: ${statusRes.error}`,
          authError: statusRes.authError,
          mediaErrorCode: "THREADS_MEDIA_CONTAINER_FAILED",
        },
      };
    }
    if (statusRes.status === "FINISHED" || statusRes.status === "PUBLISHED") {
      return { ok: true };
    }
    if (statusRes.status === "ERROR") {
      return {
        ok: false,
        result: {
          success: false,
          error: statusRes.errorMessage || "미디어 처리 중 오류가 발생했습니다.",
          mediaErrorCode: "THREADS_MEDIA_PROCESSING_FAILED",
        },
      };
    }
    if (statusRes.status === "EXPIRED") {
      return {
        ok: false,
        result: {
          success: false,
          error: "컨테이너가 만료되었습니다(24시간 이내 발행되지 않음).",
          mediaErrorCode: "THREADS_MEDIA_PROCESSING_FAILED",
        },
      };
    }
    // IN_PROGRESS 등 - 다음 폴링까지 대기(마지막 시도 뒤에는 대기하지 않음)
    if (attempt < config.THREADS_VIDEO_POLL_MAX_ATTEMPTS) {
      await sleep(config.THREADS_VIDEO_POLL_INTERVAL_MS);
    }
  }
  return {
    ok: false,
    result: {
      success: false,
      error: `제한 시간 내 처리 완료를 확인하지 못했습니다(최대 ${config.THREADS_VIDEO_POLL_MAX_ATTEMPTS}회 확인).`,
      mediaErrorCode: "THREADS_MEDIA_PROCESSING_TIMEOUT",
    },
  };
}

async function publishThreadsContainer(creationId: string): Promise<{ ok: true; postId: string } | { ok: false; result: PublishResult }> {
  const publishUrl = `${config.THREADS_GRAPH_BASE}/${encodeURIComponent(config.THREADS_USER_ID)}/threads_publish`;
  const publishBody = new URLSearchParams({ creation_id: creationId, access_token: config.THREADS_ACCESS_TOKEN });
  const publishRes = await fetch(publishUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: publishBody.toString(),
    signal: AbortSignal.timeout(30000),
  });
  const publishData: any = await publishRes.json().catch(() => ({}));
  if (!publishRes.ok || publishData.error || !publishData.id) {
    return {
      ok: false,
      result: {
        success: false,
        error: publishData?.error?.message || `발행 실패 (HTTP ${publishRes.status})`,
        authError: isAuthError(publishRes.status, publishData),
        mediaErrorCode: "THREADS_MEDIA_PUBLISH_FAILED",
      },
    };
  }
  return { ok: true, postId: publishData.id as string };
}

async function publishMediaToThreads(mediaType: "IMAGE" | "VIDEO", text: string, mediaUrl: string): Promise<PublishResult> {
  if (!config.THREADS_ACCESS_TOKEN || !config.THREADS_USER_ID) {
    return { success: false, error: "토큰/사용자 ID가 설정되지 않았습니다.", authError: true };
  }
  if (!mediaUrl || !mediaUrl.trim()) {
    return { success: false, error: "미디어 URL이 없습니다.", mediaErrorCode: "THREADS_MEDIA_CONTAINER_FAILED" };
  }
  try {
    const created = await createThreadsMediaContainer(mediaType, mediaType === "IMAGE" ? "image_url" : "video_url", mediaUrl, text);
    if (!created.ok) return created.result;

    const finished = await waitForThreadsContainerFinished(created.creationId);
    if (!finished.ok) return finished.result;

    const published = await publishThreadsContainer(created.creationId);
    if (!published.ok) return published.result;

    return { success: true, postId: published.postId };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

// 실제 IMAGE Threads 게시물을 발행합니다(JPEG/PNG만 - Meta 공식 문서 기준). imageUrl은
// threadsMediaUrlProvider.ts가 만든 public HTTPS URL이어야 합니다.
export async function publishImageToThreads(text: string, imageUrl: string): Promise<PublishResult> {
  return publishMediaToThreads("IMAGE", text, imageUrl);
}

// 실제 VIDEO(MP4/MOV) Threads 게시물을 발행합니다. 컨테이너 생성 직후 바로 발행 가능하다고
// 가정하지 않고, 공식 문서 권장대로 status가 FINISHED가 될 때까지 폴링합니다(무한 폴링 없음).
export async function publishVideoToThreads(text: string, videoUrl: string): Promise<PublishResult> {
  return publishMediaToThreads("VIDEO", text, videoUrl);
}

// ============================================================================
// Phase 12.5.4.1: CAROUSEL 실제 발행. 공식 절차(developers.facebook.com/docs/threads/posts):
//   1) 각 item을 media_type=IMAGE(or VIDEO) + is_carousel_item=true로 개별 container 생성
//   2) 각 item container가 FINISHED 될 때까지 확인(무한 폴링 없음 - waitForThreadsContainerFinished 재사용)
//   3) 전부 준비되면 media_type=CAROUSEL + children=<item id들, 순서 보존>으로 parent container 생성
//   4) parent container도 FINISHED 확인 후 publish
// 이 앱이 실제로 만드는 carousel(Product Radar 생성 + 미디어 보관함 업로드)은 이미지 slide만
// 있으므로 itemUrls는 전부 IMAGE item으로 생성합니다 - Meta API 자체는 video/mixed carousel도
// 지원하지만 이 함수는 그 범위까지 구현하지 않습니다(호출자 threadsMediaAttachment.ts가 애초에
// 이미지 slide만 있는 carousel만 kind='carousel'로 넘겨줍니다).
//
// child atomicity(요청서 9절): item 하나라도 생성/처리에 실패하면 그 즉시 중단하고 parent
// container 자체를 만들지 않습니다 - 이미 Meta에 만들어진 이전 item container들은 그대로
// 남을 수 있지만(Threads API에 컨테이너 삭제 API가 없어 임의로 지우지 않습니다 - 24시간 뒤
// 자동 EXPIRED), 최종 게시물(publish)까지는 절대 진행하지 않습니다.
// ============================================================================
const MIN_CAROUSEL_ITEMS = 2;
const MAX_CAROUSEL_ITEMS = 20;

// 실제 CAROUSEL Threads 게시물을 발행합니다. itemUrls는 slideIndex 오름차순으로 이미 정렬된
// public HTTPS URL 목록이어야 합니다(threadsMediaUrlProvider.ts가 만든 값, 순서는 호출자
// threadsPublishDispatcher.ts가 보존).
export async function publishCarouselToThreads(text: string, itemUrls: readonly string[]): Promise<PublishResult> {
  if (!config.THREADS_ACCESS_TOKEN || !config.THREADS_USER_ID) {
    return { success: false, error: "토큰/사용자 ID가 설정되지 않았습니다.", authError: true };
  }
  // 여기까지 오는 값은 threadsMediaAttachment.ts가 이미 2~20 범위를 확인한 뒤지만, publisher
  // 호출 직전에 한 번 더 확인합니다(defense in depth - 이 파일의 다른 publish 함수들과 동일한
  // "호출자를 신뢰하되 재검증" 원칙).
  if (itemUrls.length < MIN_CAROUSEL_ITEMS) {
    return { success: false, error: "캐러셀은 최소 2개의 항목이 필요합니다.", mediaErrorCode: "THREADS_MEDIA_CAROUSEL_TOO_FEW_ITEMS" };
  }
  if (itemUrls.length > MAX_CAROUSEL_ITEMS) {
    return { success: false, error: "캐러셀은 최대 20개까지만 지원합니다.", mediaErrorCode: "THREADS_MEDIA_CAROUSEL_TOO_MANY_ITEMS" };
  }

  try {
    // ---- 1~2단계: item container 순서대로 생성 + 각각 FINISHED까지 확인 ----
    const childCreationIds: string[] = [];
    for (const itemUrl of itemUrls) {
      const created = await createThreadsMediaContainer("IMAGE", "image_url", itemUrl, "", { is_carousel_item: "true" });
      if (!created.ok) {
        return { ...created.result, mediaErrorCode: "THREADS_MEDIA_CAROUSEL_ITEM_FAILED" };
      }
      const finished = await waitForThreadsContainerFinished(created.creationId);
      if (!finished.ok) {
        return { ...finished.result, mediaErrorCode: "THREADS_MEDIA_CAROUSEL_ITEM_FAILED" };
      }
      childCreationIds.push(created.creationId);
    }

    // ---- 3단계: 모든 item이 준비된 뒤에만 parent CAROUSEL container 생성(child atomicity) ----
    const parentCreated = await createThreadsCarouselParentContainer(text, childCreationIds);
    if (!parentCreated.ok) {
      return { ...parentCreated.result, mediaErrorCode: "THREADS_MEDIA_CAROUSEL_CONTAINER_FAILED" };
    }

    // ---- 4단계: parent container FINISHED 확인 후 발행 ----
    const parentFinished = await waitForThreadsContainerFinished(parentCreated.creationId);
    if (!parentFinished.ok) {
      const isTimeout = parentFinished.result.mediaErrorCode === "THREADS_MEDIA_PROCESSING_TIMEOUT";
      return { ...parentFinished.result, mediaErrorCode: isTimeout ? "THREADS_MEDIA_CAROUSEL_PROCESSING_TIMEOUT" : "THREADS_MEDIA_CAROUSEL_PROCESSING_FAILED" };
    }

    const published = await publishThreadsContainer(parentCreated.creationId);
    if (!published.ok) return published.result; // THREADS_MEDIA_PUBLISH_FAILED 그대로 재사용(TEXT/IMAGE/VIDEO와 동일 코드)

    return { success: true, postId: published.postId };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}
