// src/threadsPublishDispatcher.ts
// Phase 12.5.4: scheduler.ts가 예약 발행 시점에 부르는 단일 진입점입니다. 기존
// publishTextToThreads() 직접 호출을 이 파일의 publishDraftToThreads(draft)로 교체합니다 -
// 세 계층(threadsMediaAttachment.ts의 로컬 판정, threadsMediaUrlProvider.ts의 public URL
// 획득, threads-api.ts의 실제 Graph API 호출)을 조립하는 것만 이 파일의 책임입니다.
//
// 요청서 4·7절 핵심 계약:
// - 미디어가 없는 기존 초안(kind='none')은 기존 그대로 publishTextToThreads()만 호출합니다
//   (동작 100% 무변경).
// - 미디어가 있는데 발행할 수 없는 경우(kind='unsupported' - GIF API 제약/미지원 포맷/파일
//   없음/아직 렌더 전/캐러셀 개수 범위 초과 등 - 정확한 사유는 threadsMediaAttachment.ts의
//   describeThreadsMediaUnsupportedReason() 참고) 또는 public URL을 구할 수 없는 경우, TEXT로
//   조용히 강등하지 않고 명확한 실패를 반환합니다. 사용자가 미디어 포함 게시물을 승인했다면
//   미디어까지 성공해야 published가 됩니다.
// - 재시도해도 결과가 달라지지 않는 실패(형식/파일누락/URL 미설정/처리 자체 오류)는
//   noRetry=true로 표시해 scheduler.ts가 즉시 failed로 마감하고 매 tick 헛수고하지 않게 합니다.
// - Phase 12.5.4.1: CAROUSEL은 Meta API 호출 횟수가 많은 다단계 발행(item N개 + parent 1개)이라
//   재시도 시 이미 만들어진 컨테이너 위에 중복으로 더 쌓일 위험이 TEXT/IMAGE/VIDEO보다 큽니다 -
//   그래서 CAROUSEL은 실패 사유와 무관하게 항상 noRetry=true입니다(단일 IMAGE/VIDEO처럼
//   "일시적 오류는 재시도" 세분화를 하지 않음, 아래 참고).

import { publishCarouselToThreads, publishImageToThreads, publishTextToThreads, publishVideoToThreads, PublishResult } from "./threads-api";
import { describeThreadsMediaUnsupportedReason, resolveDraftPublishMedia } from "./threadsMediaAttachment";
import { getThreadsMediaPublicUrl, getThreadsMediaPublicUrls, THREADS_MEDIA_PUBLIC_URL_REQUIRED } from "./threadsMediaUrlProvider";

export type ThreadsDispatchMediaType = "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL" | "UNSUPPORTED";

export interface ThreadsDispatchResult extends PublishResult {
  readonly mediaType: ThreadsDispatchMediaType;
  readonly mediaFilename?: string; // 단일 이미지/영상용
  readonly itemCount?: number; // 캐러셀용(로그/DRY_RUN 표시)
  readonly sourceMediaId?: string; // 로그 전용("job:12" | "library:5" | "legacy:<filename>")
  // true면 scheduler.ts가 재시도 없이 즉시 failed 처리합니다(authError와 동일한 취급 -
  // authError 자체가 아니므로 별도 필드로 둡니다).
  readonly noRetry?: boolean;
}

export interface DraftForThreadsPublish {
  body: string;
  product_radar_media_job_id?: number | null;
  product_radar_library_asset_id?: number | null;
  media_filename?: string | null;
}

export async function publishDraftToThreads(draft: DraftForThreadsPublish): Promise<ThreadsDispatchResult> {
  const resolution = resolveDraftPublishMedia(draft);

  if (resolution.kind === "none") {
    const result = await publishTextToThreads(draft.body);
    return { ...result, mediaType: "TEXT" };
  }

  if (resolution.kind === "unsupported") {
    return {
      success: false,
      error: resolution.reasonCode ? describeThreadsMediaUnsupportedReason(resolution.reasonCode) : "미디어를 발행할 수 없습니다.",
      mediaErrorCode: resolution.reasonCode,
      mediaType: "UNSUPPORTED",
      mediaFilename: resolution.filename,
      sourceMediaId: resolution.sourceMediaId,
      noRetry: true,
    };
  }

  if (resolution.kind === "carousel") {
    const items = resolution.items ?? [];
    // slideIndex 오름차순은 threadsMediaAttachment.ts가 이미 보장합니다(items는 정렬된
    // 상태로 넘어옵니다) - 여기서 다시 정렬하지 않고 순서를 그대로 URL 발급/발행에 씁니다.
    const urlsResult = await getThreadsMediaPublicUrls(items.map((item) => item.filename));
    if (!urlsResult.ok) {
      return {
        success: false,
        error: urlsResult.reason,
        mediaErrorCode: THREADS_MEDIA_PUBLIC_URL_REQUIRED,
        mediaType: "CAROUSEL",
        itemCount: items.length,
        sourceMediaId: resolution.sourceMediaId,
        noRetry: true,
      };
    }
    const result = await publishCarouselToThreads(draft.body, urlsResult.urls);
    await releaseMediaUrls(result, urlsResult.release);
    return {
      ...result,
      mediaType: "CAROUSEL",
      itemCount: items.length,
      sourceMediaId: resolution.sourceMediaId,
      noRetry: !result.success,
    };
  }

  // 여기서부터 resolution.kind는 'image' | 'video'이고 filename이 항상 채워져 있습니다.
  const filename = resolution.filename as string;
  const urlResult = await getThreadsMediaPublicUrl(filename, resolution.kind === "image" ? "IMAGE" : "VIDEO");
  if (!urlResult.ok) {
    return {
      success: false,
      error: urlResult.reason,
      mediaErrorCode: THREADS_MEDIA_PUBLIC_URL_REQUIRED,
      mediaType: resolution.kind === "image" ? "IMAGE" : "VIDEO",
      mediaFilename: filename,
      sourceMediaId: resolution.sourceMediaId,
      noRetry: true,
    };
  }

  if (resolution.kind === "image") {
    const result = await publishImageToThreads(draft.body, urlResult.url);
    await releaseMediaUrls(result, urlResult.release);
    return {
      ...result,
      mediaType: "IMAGE",
      mediaFilename: filename,
      sourceMediaId: resolution.sourceMediaId,
      noRetry: !result.success && (result.authError || result.mediaErrorCode === "THREADS_MEDIA_PROCESSING_FAILED"),
    };
  }

  const result = await publishVideoToThreads(draft.body, urlResult.url);
  await releaseMediaUrls(result, urlResult.release);
  return {
    ...result,
    mediaType: "VIDEO",
    mediaFilename: filename,
    sourceMediaId: resolution.sourceMediaId,
    noRetry: !result.success && (result.authError || result.mediaErrorCode === "THREADS_MEDIA_PROCESSING_FAILED"),
  };
}

// Phase 12.5.6C.audit: threads-api.ts의 waitForThreadsContainerFinished()가 상태 확인
// 자체에 실패했거나(네트워크 오류로 지금 상태를 알 수 없음) 최대 polling 횟수 내에
// FINISHED/ERROR/EXPIRED에 도달하지 못한 채(timeout) 끝난 경우, 이 시점에 Meta가 실제로
// media를 이미 가져갔는지(ingest 완료) 확정할 수 없습니다(여전히 IN_PROGRESS였을 수 있음).
// 이런 mediaErrorCode에서는 cleanup을 바로 호출하지 않고 presigned URL TTL(기본 30분)/R2
// lifecycle 규칙(design doc 7·13절 - 원래도 이런 orphan을 위한 backstop으로 존재)에
// 맡깁니다. 반대로 ERROR/EXPIRED(Meta가 처리를 명확히 끝냄)나 create/publish 자체가
// 거부된 경우(Meta가 media fetch를 아직 시도하지 않은 시점)는 즉시 cleanup해도 안전합니다.
// CAROUSEL의 THREADS_MEDIA_CAROUSEL_ITEM_FAILED/_PROCESSING_FAILED는 threads-api.ts가
// 여러 하위 원인(생성 거부/상태 확인 실패/ERROR/EXPIRED/timeout)을 하나의 code로
// 묶어버려 이 지점에서 세분화할 수 없으므로(새 polling architecture 없이 최소 수정만
// 한다는 원칙상 threads-api.ts의 code 체계 자체는 바꾸지 않음), 안전한 쪽으로 보수적으로
// 판단해 전부 "확정 안 됨"으로 취급합니다. THREADS_MEDIA_CAROUSEL_CONTAINER_FAILED(parent
// container 생성 자체가 거부된 경우)는 안전합니다 - 이 시점 이전에 모든 child가 이미
// waitForThreadsContainerFinished로 FINISHED 확인을 마친 뒤이기 때문입니다.
const AMBIGUOUS_MEDIA_INGEST_ERROR_CODES = new Set([
  "THREADS_MEDIA_CONTAINER_FAILED",
  "THREADS_MEDIA_PROCESSING_TIMEOUT",
  "THREADS_MEDIA_CAROUSEL_ITEM_FAILED",
  "THREADS_MEDIA_CAROUSEL_PROCESSING_TIMEOUT",
  "THREADS_MEDIA_CAROUSEL_PROCESSING_FAILED",
]);

function isMediaIngestConfirmed(result: PublishResult): boolean {
  if (result.success) return true;
  if (!result.mediaErrorCode) return true; // 이 코드가 없으면 Meta를 호출하기도 전에 실패한 경우(예: authError)
  return !AMBIGUOUS_MEDIA_INGEST_ERROR_CODES.has(result.mediaErrorCode);
}

// Phase 12.5.6C: relay 경로를 쓴 경우에만 release가 존재합니다(local gateway는 token TTL로
// 자연 만료되므로 release가 없음 - undefined면 아무 것도 하지 않습니다). design doc 7/13절:
// "threads_publish 성공 확인 -> 즉시 explicit DELETE" / "Meta fetch/container 실패 ->
// 클라이언트가 실패를 인지한 시점에 cleanup 호출" - Meta의 media ingest 완료 여부가
// 확정된 경우(성공 또는 확정적 실패)에만 즉시 cleanup합니다. cleanup 실패가 발행 결과
// (published 여부)에 영향을 주면 안 되므로 예외는 로그만 남기고 삼킵니다 - 최종적으로는
// R2 lifecycle 규칙이 정리합니다.
async function releaseMediaUrls(result: PublishResult, release?: () => Promise<unknown>): Promise<void> {
  if (!release) return;
  if (!isMediaIngestConfirmed(result)) return;
  try {
    await release();
  } catch (e) {
    console.warn(`[threadsPublishDispatcher] relay cleanup 호출 실패(무시 - TTL/lifecycle backstop): ${e instanceof Error ? e.message : String(e)}`);
  }
}
