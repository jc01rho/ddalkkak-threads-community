// src/threadsMediaAttachment.ts
// Phase 12.5.4: 예약 발행 시점에 draft에 어떤 미디어가 붙어 있는지(있다면 정확히 무엇인지)를
// 로컬(DB/디스크)만 보고 판정합니다. 네트워크 호출은 전혀 하지 않습니다 - "Meta가 접근 가능한
// public URL을 구하는 일"은 threadsMediaUrlProvider.ts의 책임이고, 이 파일은 그 앞 단계
// (어떤 attachment 메커니즘이든 정확히 1개의 로컬 파일 또는 정렬된 slide 목록 + Threads
// media_type으로 정규화)만 담당합니다.
//
// draft가 미디어를 붙이는 방법은 3가지이고 서로 배타적입니다(database.ts 마이그레이션 주석
// 참고):
//   1) product_radar_media_job_id - 공장이 생성한 카드/캐러셀/영상/GIF(product_radar_media_jobs)
//   2) product_radar_library_asset_id - 미디어 보관함에 사용자가 업로드한 asset
//   3) media_filename/media_type - 쿠파스 "내 사진·영상 첨부"(mediaUpload.ts, 단일 파일만)
//
// Meta 공식 문서(2026-08 확인, developers.facebook.com/docs/threads/posts) 기준 정리:
// - media_type=IMAGE(JPEG/PNG만)와 media_type=VIDEO(MOV/MP4, H264/HEVC+AAC)는 이 파일이
//   직접 다룹니다.
// - media_type=CAROUSEL도 Threads API가 공식으로 지원하며(item container를
//   is_carousel_item=true로 먼저 만들고, 그 container id들을 children으로 묶어 CAROUSEL
//   container를 만든 뒤 publish, 2~20개), Phase 12.5.4.1부터 이 파일이 실제로 판정하고
//   threadsPublishDispatcher.ts/threads-api.ts가 발행까지 연결합니다. 단 이 앱이 실제로
//   생성/업로드하는 carousel(Product Radar 생성 + 미디어 보관함 업로드)은 전부 PNG/JPEG
//   이미지 slide만 다룹니다(app의 media 모델 자체가 image-only) - Meta API가 video/mixed
//   carousel도 지원한다는 사실만으로 이 앱의 지원 범위까지 넓히지 않습니다(video carousel
//   item은 다루지 않음).
// - GIF는 own-media(image_url/video_url) 업로드로는 지원되지 않습니다. gif_attachment
//   파라미터가 따로 있지만 그건 "TEXT 전용 post에 외부 GIF provider의 gif_id를 첨부"하는
//   완전히 다른 기능입니다(Meta 공식 Threads API Postman 문서의 gif_attachment 예시는
//   provider=TENOR - 특정 provider 이름은 여기서 판단에 쓰지 않습니다, 중요한 건 이 기능
//   자체가 "우리 로컬에 저장된 .gif 파일(생성/업로드된 실제 바이트)과 무관한 별도 경로"라는
//   점입니다). 즉 로컬 GIF를 그 GIF provider API로 "대신" 올릴 방법이 없습니다 - own-media
//   경로에서는 여전히 거부합니다(reasonCode=THREADS_MEDIA_UNSUPPORTED_GIF, 이건 실제 API
//   제약이지 미구현이 아닙니다). GIF를 MP4로 변환해 VIDEO로 발행하는 것은 별도 기능
//   후보이며 이 phase 범위 밖입니다.
//
// 그래서 여기서 나올 수 있는 kind는 "none"(첨부 없음, 기존 TEXT 그대로) / "image" / "video" /
// "carousel" / "unsupported"(GIF API 제약·미지원 포맷·개수 범위 초과·slide 손상 등 지금은
// 발행할 수 없는 조합) 뿐입니다. "unsupported"는 절대 "none"으로 취급하지 않습니다 -
// 호출자(threadsPublishDispatcher.ts)가 TEXT로 조용히 강등하지 않고 명확히 실패 처리하도록
// 구분을 유지합니다.

import { getMediaTypeForFilename, mediaFileExists } from "./mediaUpload";
import { getProductRadarMediaJobById } from "./productRadar/mediaPersistence";
import { validateProductRadarMediaJobFiles } from "./productRadar/mediaDraftAttachment";
import { getProductRadarLibraryAssetById, listProductRadarLibraryAssetFilesByAssetId } from "./productRadar/libraryPersistence";

export type ThreadsMediaKind = "none" | "image" | "video" | "carousel" | "unsupported";

// GIF는 실제 API 제약(own-media 불가)이고, FORMAT/NOT_READY/FILE_MISSING/CAROUSEL_* 는 전부
// "이 draft의 이 미디어는 지금 이 상태로는 발행할 수 없다"는 로컬 판정 사유입니다.
export const ThreadsMediaUnsupportedReason = {
  GIF: "THREADS_MEDIA_UNSUPPORTED_GIF",
  FORMAT: "THREADS_MEDIA_UNSUPPORTED_FORMAT",
  NOT_READY: "THREADS_MEDIA_JOB_NOT_READY",
  FILE_MISSING: "THREADS_MEDIA_FILE_MISSING",
  // Phase 12.5.4.1: Meta 공식 CAROUSEL 개수 제한(2~20)을 publisher 호출 전에 여기서 먼저
  // 검증합니다 - 1개짜리를 IMAGE로 자동 강등하지 않고, 21개 이상을 그대로 Meta에 보내지
  // 않습니다.
  CAROUSEL_TOO_FEW_ITEMS: "THREADS_MEDIA_CAROUSEL_TOO_FEW_ITEMS",
  CAROUSEL_TOO_MANY_ITEMS: "THREADS_MEDIA_CAROUSEL_TOO_MANY_ITEMS",
  // slide 파일이 로컬에 없거나(삭제/이동됨) Threads가 지원하지 않는 포맷(예: 미디어 보관함
  // 업로드 carousel의 .webp - 업로드 자체는 허용되지만 Threads IMAGE는 JPEG/PNG만 받음).
  CAROUSEL_ITEM_MISSING: "THREADS_MEDIA_CAROUSEL_ITEM_MISSING",
} as const;
export type ThreadsMediaUnsupportedReasonCode = (typeof ThreadsMediaUnsupportedReason)[keyof typeof ThreadsMediaUnsupportedReason];

// threadsPublishDispatcher.ts가 그대로 사용자/로그에 노출하는 사람이 읽을 문구입니다 - 코드별로
// "왜 안 되는지"가 다르므로 여기서 한 곳에 모아 관리합니다.
export function describeThreadsMediaUnsupportedReason(code: ThreadsMediaUnsupportedReasonCode): string {
  switch (code) {
    case ThreadsMediaUnsupportedReason.GIF:
      return "GIF는 Threads API가 own-media(직접 업로드)로는 지원하지 않습니다(텍스트 전용 글의 외부 GIF provider 첨부만 지원).";
    case ThreadsMediaUnsupportedReason.FORMAT:
      return "Threads API가 지원하지 않는 파일 형식입니다.";
    case ThreadsMediaUnsupportedReason.NOT_READY:
      return "미디어가 아직 준비되지 않았습니다.";
    case ThreadsMediaUnsupportedReason.FILE_MISSING:
      return "첨부된 미디어 파일을 로컬에서 찾을 수 없습니다.";
    case ThreadsMediaUnsupportedReason.CAROUSEL_TOO_FEW_ITEMS:
      return "캐러셀은 최소 2개의 이미지가 필요합니다.";
    case ThreadsMediaUnsupportedReason.CAROUSEL_TOO_MANY_ITEMS:
      return "캐러셀은 최대 20개까지만 지원합니다.";
    case ThreadsMediaUnsupportedReason.CAROUSEL_ITEM_MISSING:
      return "캐러셀의 일부 슬라이드 파일을 찾을 수 없거나 Threads가 지원하지 않는 형식입니다.";
    default:
      return "미디어를 발행할 수 없습니다.";
  }
}

// Phase 12.5.4.1: 이 앱이 생성/업로드하는 carousel은 전부 이미지 slide뿐이라 kind는 "image"
// 고정입니다 - Meta API 자체는 video carousel item도 지원하지만 이 앱의 media 모델에 없는
// 기능이라 여기 타입에도 넣지 않습니다(추측으로 확장하지 않음).
export interface ThreadsCarouselItem {
  readonly kind: "image";
  readonly filename: string;
  readonly slideIndex: number;
}

export interface ThreadsDraftMediaResolution {
  readonly kind: ThreadsMediaKind;
  // kind가 image/video면 항상 채워집니다. unsupported도 파일명을 특정할 수 있었으면 로그용으로 채웁니다.
  readonly filename?: string;
  // kind가 carousel일 때만 채워집니다 - slideIndex 오름차순으로 이미 정렬되어 있습니다.
  readonly items?: readonly ThreadsCarouselItem[];
  // 로그 전용 식별자("job:12" | "library:5" | "legacy:<filename>") - 토큰/민감정보 없음.
  readonly sourceMediaId?: string;
  readonly reasonCode?: ThreadsMediaUnsupportedReasonCode;
}

// Threads 공식 문서가 명시한 지원 포맷만 허용합니다(임의로 추정하지 않음).
const THREADS_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png"]);
const THREADS_VIDEO_EXTS = new Set([".mp4", ".mov"]);
// Meta 공식 CAROUSEL 개수 제한(developers.facebook.com/docs/threads/posts: "at least 2 and no
// more than 20"). 이 앱 자체의 carousel 생성/업로드는 2~3개로 더 좁게 제한되지만(mediaCarouselOrchestration.ts/
// routes/productRadar/library.ts), 이 검증 자체는 Meta 공식 범위를 기준으로 둡니다.
const MIN_CAROUSEL_ITEMS = 2;
const MAX_CAROUSEL_ITEMS = 20;

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

// carousel resolver 두 경로(생성/업로드)가 공유하는 마지막 관문 - "slideIndex 오름차순으로
// 이미 정렬된 slide 목록"을 받아 (1) Meta 공식 개수 범위(2~20)와 (2) 각 slide 파일의 실존/포맷을
// 검증합니다. 호출자는 반드시 정렬 + 0-based contiguous 검증을 먼저 마친 목록만 넘겨야 합니다
// (이 함수는 순서/연속성을 다시 확인하지 않습니다 - 그건 각 경로의 lineage 특성이 달라 호출자
// 책임으로 둡니다).
function buildCarouselItems(
  slides: readonly { slideIndex: number; filename: string }[]
): { items: ThreadsCarouselItem[] } | { reasonCode: ThreadsMediaUnsupportedReasonCode } {
  if (slides.length < MIN_CAROUSEL_ITEMS) return { reasonCode: ThreadsMediaUnsupportedReason.CAROUSEL_TOO_FEW_ITEMS };
  if (slides.length > MAX_CAROUSEL_ITEMS) return { reasonCode: ThreadsMediaUnsupportedReason.CAROUSEL_TOO_MANY_ITEMS };
  for (const slide of slides) {
    if (!mediaFileExists(slide.filename)) return { reasonCode: ThreadsMediaUnsupportedReason.CAROUSEL_ITEM_MISSING };
    if (!THREADS_IMAGE_EXTS.has(extOf(slide.filename))) return { reasonCode: ThreadsMediaUnsupportedReason.CAROUSEL_ITEM_MISSING };
  }
  return { items: slides.map((s) => ({ kind: "image" as const, filename: s.filename, slideIndex: s.slideIndex })) };
}

// 미디어 보관함 carousel 전용 - DB 조회 순서(id ASC)나 파일시스템 순서를 신뢰하지 않고, 반드시
// slideIndex를 기준으로 직접 재정렬 + 0-based contiguous(구멍/중복 없음)를 확인합니다. 하나라도
// slideIndex가 없거나(NULL) 연속되지 않으면 손상된 상태로 보고 거부합니다(missing/duplicate
// slide 허용 금지).
function sortSlidesIfContiguous(files: readonly { slideIndex: number | null; filename: string }[]): { slideIndex: number; filename: string }[] | null {
  if (files.length === 0 || files.some((f) => f.slideIndex === null)) return null;
  const sorted = [...files].sort((a, b) => (a.slideIndex as number) - (b.slideIndex as number)) as { slideIndex: number; filename: string }[];
  const isContiguousFromZero = sorted.every((f, i) => f.slideIndex === i);
  return isContiguousFromZero ? sorted : null;
}

export function resolveDraftPublishMedia(draft: {
  product_radar_media_job_id?: number | null;
  product_radar_library_asset_id?: number | null;
  media_filename?: string | null;
}): ThreadsDraftMediaResolution {
  if (draft.product_radar_media_job_id !== null && draft.product_radar_media_job_id !== undefined) {
    return resolveFromMediaJob(draft.product_radar_media_job_id);
  }
  if (draft.product_radar_library_asset_id !== null && draft.product_radar_library_asset_id !== undefined) {
    return resolveFromLibraryAsset(draft.product_radar_library_asset_id);
  }
  if (draft.media_filename) {
    return resolveFromLegacyAttachment(draft.media_filename);
  }
  return { kind: "none" };
}

function resolveFromMediaJob(mediaJobId: number): ThreadsDraftMediaResolution {
  const sourceMediaId = `job:${mediaJobId}`;
  const job = getProductRadarMediaJobById(mediaJobId);
  if (!job || job.status !== "rendered") {
    return { kind: "unsupported", sourceMediaId, reasonCode: ThreadsMediaUnsupportedReason.NOT_READY };
  }
  if (job.mediaType === "carousel") {
    // validateProductRadarMediaJobFiles가 이미 이 job(정확히 이 media_job_id)에 속한
    // role='slide' 파일만 조회하고(다른 job의 slide 혼입 구조적으로 불가능 - SQL이
    // media_job_id=? 로 scope됨), slideIndex 오름차순 정렬 + 0-based contiguous(2~3개)를
    // 검증합니다 - carousel lineage 검증을 여기서 새로 만들지 않고 그대로 재사용합니다.
    const validated = validateProductRadarMediaJobFiles(job, mediaJobId);
    if (!validated || validated.mediaType !== "carousel") {
      return { kind: "unsupported", sourceMediaId, reasonCode: ThreadsMediaUnsupportedReason.NOT_READY };
    }
    const built = buildCarouselItems(validated.files.map((f) => ({ slideIndex: f.slideIndex as number, filename: f.filename })));
    if ("reasonCode" in built) {
      return { kind: "unsupported", sourceMediaId, reasonCode: built.reasonCode };
    }
    return { kind: "carousel", items: built.items, sourceMediaId };
  }
  if (job.mediaType === "animation") {
    return { kind: "unsupported", sourceMediaId, reasonCode: ThreadsMediaUnsupportedReason.GIF };
  }
  // 여기서부터 job.mediaType은 'card' | 'video'만 남습니다.
  const validated = validateProductRadarMediaJobFiles(job, mediaJobId);
  if (!validated || validated.files.length !== 1) {
    return { kind: "unsupported", sourceMediaId, reasonCode: ThreadsMediaUnsupportedReason.NOT_READY };
  }
  const filename = validated.files[0].filename;
  if (!mediaFileExists(filename)) {
    return { kind: "unsupported", sourceMediaId, filename, reasonCode: ThreadsMediaUnsupportedReason.FILE_MISSING };
  }
  return { kind: job.mediaType === "card" ? "image" : "video", filename, sourceMediaId };
}

function resolveFromLibraryAsset(libraryAssetId: number): ThreadsDraftMediaResolution {
  const sourceMediaId = `library:${libraryAssetId}`;
  const asset = getProductRadarLibraryAssetById(libraryAssetId);
  if (!asset) {
    return { kind: "unsupported", sourceMediaId, reasonCode: ThreadsMediaUnsupportedReason.NOT_READY };
  }
  if (asset.category === "carousel") {
    // listProductRadarLibraryAssetFilesByAssetId는 이미 asset_id=? 로 scope되어 있어(다른
    // asset의 slide 혼입 구조적으로 불가능) 이 asset에 속한 파일만 돌아옵니다. 그래도 반환
    // 순서(slide_index ASC)를 그대로 믿지 않고 직접 재정렬 + contiguous 검증을 거칩니다.
    const files = listProductRadarLibraryAssetFilesByAssetId(libraryAssetId);
    const sorted = sortSlidesIfContiguous(files);
    if (!sorted) {
      return { kind: "unsupported", sourceMediaId, reasonCode: ThreadsMediaUnsupportedReason.NOT_READY };
    }
    const built = buildCarouselItems(sorted);
    if ("reasonCode" in built) {
      return { kind: "unsupported", sourceMediaId, reasonCode: built.reasonCode };
    }
    return { kind: "carousel", items: built.items, sourceMediaId };
  }
  if (asset.category === "gif") {
    return { kind: "unsupported", sourceMediaId, reasonCode: ThreadsMediaUnsupportedReason.GIF };
  }
  const files = listProductRadarLibraryAssetFilesByAssetId(libraryAssetId);
  if (files.length !== 1) {
    return { kind: "unsupported", sourceMediaId, reasonCode: ThreadsMediaUnsupportedReason.NOT_READY };
  }
  const filename = files[0].filename;
  if (!mediaFileExists(filename)) {
    return { kind: "unsupported", sourceMediaId, filename, reasonCode: ThreadsMediaUnsupportedReason.FILE_MISSING };
  }
  if (asset.category === "image") {
    if (!THREADS_IMAGE_EXTS.has(extOf(filename))) {
      return { kind: "unsupported", sourceMediaId, filename, reasonCode: ThreadsMediaUnsupportedReason.FORMAT };
    }
    return { kind: "image", filename, sourceMediaId };
  }
  // asset.category === "video"
  if (!THREADS_VIDEO_EXTS.has(extOf(filename))) {
    return { kind: "unsupported", sourceMediaId, filename, reasonCode: ThreadsMediaUnsupportedReason.FORMAT };
  }
  return { kind: "video", filename, sourceMediaId };
}

function resolveFromLegacyAttachment(filename: string): ThreadsDraftMediaResolution {
  const sourceMediaId = `legacy:${filename}`;
  if (!mediaFileExists(filename)) {
    return { kind: "unsupported", sourceMediaId, filename, reasonCode: ThreadsMediaUnsupportedReason.FILE_MISSING };
  }
  // 저장된 draft.media_type을 그대로 믿지 않고, mediaUpload.ts와 동일하게 실제 파일 확장자에서
  // 다시 도출합니다(다른 attach 경로들과 신뢰 모델을 통일). 쿠파스 첨부는 파일 1개뿐이라
  // carousel이 될 수 없습니다(mediaUpload.ts MediaType은 image|video만 존재).
  const detectedKind = getMediaTypeForFilename(filename); // "image" | "video" | null
  if (detectedKind === "image") {
    if (!THREADS_IMAGE_EXTS.has(extOf(filename))) {
      return { kind: "unsupported", sourceMediaId, filename, reasonCode: ThreadsMediaUnsupportedReason.FORMAT };
    }
    return { kind: "image", filename, sourceMediaId };
  }
  if (detectedKind === "video") {
    if (!THREADS_VIDEO_EXTS.has(extOf(filename))) {
      return { kind: "unsupported", sourceMediaId, filename, reasonCode: ThreadsMediaUnsupportedReason.FORMAT };
    }
    return { kind: "video", filename, sourceMediaId };
  }
  return { kind: "unsupported", sourceMediaId, filename, reasonCode: ThreadsMediaUnsupportedReason.FORMAT };
}
