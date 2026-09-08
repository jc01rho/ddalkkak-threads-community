// src/productRadar/draftMediaReview.ts
// 상품 레이더 Phase 12.5.3.8: 초안함(draft library)에서 "현재 이 초안이 쓰는 미디어"를
// 승인 전에 검토할 수 있게 하는 read-only 통합 read model. 이 파일은 조회만 담당하고
// attachment를 절대 바꾸지 않는다(요청서 3·11·13절).
//
// draft에는 서로 다른 3계층의 미디어 포인터가 있다(요청서 2절, database.ts 조사로 확정):
//   A. drafts.media_filename(+media_type/media_mime/media_original_name) - 쿠파스(제휴
//      마케팅) "내 사진·영상 첨부" 전용. source_type='affiliate_product' draft에서만 값이
//      있고, Product Radar draft와는 절대 동시에 값을 갖지 않는다(서로 다른 draft 생성
//      경로 - database.ts의 insertDraft 호출부가 서로 겹치지 않는다).
//   B. drafts.product_radar_media_job_id - Product Radar가 생성한(generated) media.
//   C. drafts.product_radar_library_asset_id - 사용자가 미디어 보관함에 업로드한(uploaded) asset.
// B/C는 database.ts의 attachProductRadarMediaJobToDraftIfNewer()/setProductRadarLibraryAssetAttachment()가
// 이미 상호배타로 관리한다(하나를 세팅하면 다른 하나는 항상 NULL) - 이 파일은 그 계약을
// 그대로 신뢰하고 재검증하지 않는다.
//
// 기존 getProductRadarCurrentMediaAttachmentForDraft()(mediaDraftAttachment.ts)는 B(generated)만
// 처리한다 - single-card attach 직후 preview 복원이라는 좁은 목적으로 만들어졌기 때문이다.
// 이 Phase는 A/B/C 전부를 다뤄야 하므로 그 함수를 확장하지 않고(다른 호출부의 기존 계약을
// 건드리지 않기 위해, 요청서 15절 "single-card attach regression 금지"와 동일 원칙) 이
// 새 파일에서 A/B/C를 전부 판정하는 별도 resolver를 둔다 - 복제가 아니라 A/C를 새로 추가한
// 것뿐이고, B 판정 로직(job/file 조회 + role/slideIndex 검증)은 여기서도 동일한 규칙을
// 그대로 다시 적용한다(다른 값을 허용하지 않는다).

import { mediaFileExists } from "../mediaUpload";
import { getProductRadarMediaJobById, listProductRadarMediaFilesByJobId, listProductRadarMediaFilesByJobIds, listProductRadarMediaJobsByIds } from "./mediaPersistence";
import {
  getProductRadarLibraryAssetById,
  listProductRadarLibraryAssetFilesByAssetId,
  listProductRadarLibraryAssetFilesByAssetIds,
  listProductRadarLibraryAssetsByIds,
  ProductRadarLibraryCategory,
} from "./libraryPersistence";

// drafts 테이블 row의 부분 shape만 필요로 한다(database.ts의 getDraft/listDrafts가 SELECT *로
// 이미 전부 반환하므로 그 raw row를 그대로 넘기면 된다 - 별도 재조회 없음).
export interface DraftMediaPointerRow {
  id: number;
  source_type: string | null;
  media_filename: string | null;
  media_type: string | null;
  media_mime: string | null;
  media_original_name: string | null;
  product_radar_media_job_id: number | null;
  product_radar_library_asset_id: number | null;
}

// 미디어 보관함 업로드 asset(product_radar_library_asset_id)을 초안함 화면에 보여줄 수 있는
// source_type. Product Radar 초안 외에 "직접 글 작성"(manual) 초안도 같은 컬럼으로 미디어를
// 붙이므로 함께 허용한다 - 발행 경로(threadsMediaAttachment.resolveDraftPublishMedia)는
// 애초에 source_type을 보지 않으므로, 이 화면 표시 게이트만 맞춰 주면 두 경로가 일치한다.
// 생성(job) 경로는 Product Radar 전용이라 그대로 둔다(manual 초안은 job을 가질 수 없다).
const MEDIA_LIBRARY_SOURCE_TYPES: ReadonlySet<string> = new Set(["product_radar", "manual"]);

export type DraftMediaOrigin = "generated" | "user_upload" | "legacy";

export interface DraftMediaFile {
  readonly filename: string;
  readonly slideIndex: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly available: boolean; // 요청서 14절: 로컬 파일이 실제로 존재하는지(mediaFileExists)
}

// 목록(N개 draft)에 실을 가벼운 요약 - 실제 파일 배열은 담지 않는다(요청서 4절, 상세를 열 때만
// files 전체를 조회). thumbnailFilename 1개만 목록 카드의 썸네일 <img>에 쓴다.
export interface DraftMediaSummary {
  readonly hasMedia: boolean;
  readonly origin: DraftMediaOrigin | null;
  readonly category: ProductRadarLibraryCategory | null;
  readonly slideCount: number; // carousel이 아니면 항상 1
  readonly thumbnailFilename: string | null;
  readonly thumbnailAvailable: boolean;
  // 초안 카드의 상시 미리보기(캐러셀 2~3장을 순서대로 보여줘야 함)가 쓰는 파일 목록.
  // 이 배열은 이미 위에서 batch 조회한 같은 rows를 그대로 담는 것이라 추가 쿼리가 없다
  // (N+1 없음). 정렬은 slideIndex 기준이므로 표시 순서 = 실제 slide 순서다.
  readonly files: readonly { readonly filename: string; readonly slideIndex: number | null; readonly available: boolean }[];
}

const NO_MEDIA_SUMMARY: DraftMediaSummary = { hasMedia: false, origin: null, category: null, slideCount: 0, thumbnailFilename: null, thumbnailAvailable: false, files: [] };

// generated job의 mediaType('card'|'carousel'|'video'|'animation')을 공개 category로 맞춘다.
function categoryForGeneratedMediaType(mediaType: string): ProductRadarLibraryCategory {
  if (mediaType === "carousel") return "carousel";
  if (mediaType === "video") return "video";
  if (mediaType === "animation") return "gif"; // Phase 12.5.3.9: 무음 GIF
  return "image";
}

// Phase 12.5.3.9: generated 파일의 mime - card/carousel은 항상 PNG(렌더러 계약, 별도 mime
// 컬럼 없음), video/animation은 각각 MP4/GIF로 고정이다(둘 다 renderer 계약상 다른 컨테이너를
// 만들지 않는다 - motionRenderer.ts 참고). category만으로 결정하며 별도 컬럼 조회가 필요 없다.
function mimeForGeneratedCategory(category: ProductRadarLibraryCategory): string | null {
  if (category === "video") return "video/mp4";
  if (category === "gif") return "image/gif";
  if (category === "image" || category === "carousel") return "image/png";
  return null;
}

// legacy(media_filename) 첨부의 category 판정 - mediaUpload.ts의 MediaType은 "image"|"video"
// 뿐이라 GIF도 "image"로 분류돼 있다(mime만 "image/gif") - mime을 봐야 GIF를 구분할 수 있다.
function categoryForLegacyAttachment(mediaType: string | null, mediaMime: string | null): ProductRadarLibraryCategory {
  if (mediaType === "video") return "video";
  if (mediaMime === "image/gif") return "gif";
  return "image";
}

// ==================================================================================
// 목록(list) N+1 방지 - 여러 draft의 job_id/asset_id를 모아 각각 IN절 1회로 배치 조회한다
// (요청서 4절). 반환은 draftId -> summary Map이라 호출부는 draft를 순회하며 O(1) 조회만 한다.
// ==================================================================================
export function resolveDraftMediaSummaries(drafts: readonly DraftMediaPointerRow[]): Map<number, DraftMediaSummary> {
  const jobIds = drafts.map((d) => d.product_radar_media_job_id).filter((v): v is number => typeof v === "number");
  const assetIds = drafts.map((d) => d.product_radar_library_asset_id).filter((v): v is number => typeof v === "number");

  const jobs = new Map(listProductRadarMediaJobsByIds(jobIds).map((j) => [j.id, j]));
  const jobFilesByJobId = new Map<number, { filename: string; slideIndex: number | null; role: string }[]>();
  for (const f of listProductRadarMediaFilesByJobIds(jobIds)) {
    const list = jobFilesByJobId.get(f.mediaJobId) ?? [];
    list.push({ filename: f.filename, slideIndex: f.slideIndex, role: f.role });
    jobFilesByJobId.set(f.mediaJobId, list);
  }

  const assets = new Map(listProductRadarLibraryAssetsByIds(assetIds).map((a) => [a.id, a]));
  const assetFilesByAssetId = new Map<number, { filename: string; slideIndex: number | null }[]>();
  for (const f of listProductRadarLibraryAssetFilesByAssetIds(assetIds)) {
    const list = assetFilesByAssetId.get(f.assetId) ?? [];
    list.push({ filename: f.filename, slideIndex: f.slideIndex });
    assetFilesByAssetId.set(f.assetId, list);
  }

  const result = new Map<number, DraftMediaSummary>();
  for (const draft of drafts) {
    result.set(draft.id, summarizeOne(draft, jobs, jobFilesByJobId, assets, assetFilesByAssetId));
  }
  return result;
}

function summarizeOne(
  draft: DraftMediaPointerRow,
  jobs: Map<number, { mediaType: string; status: string }>,
  jobFilesByJobId: Map<number, { filename: string; slideIndex: number | null; role: string }[]>,
  assets: Map<number, { category: ProductRadarLibraryCategory }>,
  assetFilesByAssetId: Map<number, { filename: string; slideIndex: number | null }[]>
): DraftMediaSummary {
  if (draft.source_type === "product_radar" && draft.product_radar_media_job_id !== null) {
    const job = jobs.get(draft.product_radar_media_job_id);
    if (!job || job.status !== "rendered") return NO_MEDIA_SUMMARY;
    const files = (jobFilesByJobId.get(draft.product_radar_media_job_id) ?? [])
      .filter((f) => f.role === "card" || f.role === "slide" || f.role === "video" || f.role === "animation")
      .sort((a, b) => (a.slideIndex ?? 0) - (b.slideIndex ?? 0));
    if (files.length === 0) return NO_MEDIA_SUMMARY;
    return {
      hasMedia: true,
      origin: "generated",
      category: categoryForGeneratedMediaType(job.mediaType),
      slideCount: files.length,
      thumbnailFilename: files[0].filename,
      thumbnailAvailable: mediaFileExists(files[0].filename),
      files: files.map((f) => ({ filename: f.filename, slideIndex: f.slideIndex, available: mediaFileExists(f.filename) })),
    };
  }
  if (MEDIA_LIBRARY_SOURCE_TYPES.has(draft.source_type ?? "") && draft.product_radar_library_asset_id !== null) {
    const asset = assets.get(draft.product_radar_library_asset_id);
    if (!asset) return NO_MEDIA_SUMMARY;
    const files = assetFilesByAssetId.get(draft.product_radar_library_asset_id) ?? [];
    if (files.length === 0) return NO_MEDIA_SUMMARY;
    return {
      hasMedia: true,
      origin: "user_upload",
      category: asset.category,
      slideCount: files.length,
      thumbnailFilename: files[0].filename,
      thumbnailAvailable: mediaFileExists(files[0].filename),
      files: files.map((f) => ({ filename: f.filename, slideIndex: f.slideIndex, available: mediaFileExists(f.filename) })),
    };
  }
  if (draft.media_filename) {
    return {
      hasMedia: true,
      origin: "legacy",
      category: categoryForLegacyAttachment(draft.media_type, draft.media_mime),
      slideCount: 1,
      thumbnailFilename: draft.media_filename,
      thumbnailAvailable: mediaFileExists(draft.media_filename),
      files: [{ filename: draft.media_filename, slideIndex: 0, available: mediaFileExists(draft.media_filename) }],
    };
  }
  return NO_MEDIA_SUMMARY;
}

// ==================================================================================
// 상세(detail) - "크게 보기"/승인 전 최종 검토 화면에서만 파일 배열 전체를 조회한다(요청서
// 4절 "상세 files 2~3장은 초안 상세를 열 때만"). draftId 하나에 대해서만 동작하므로 단건
// 조회(N+1 우려 없음 - 사용자가 명시적으로 이 draft 하나를 열었을 때만 호출된다).
// ==================================================================================
export type DraftMediaDetailResult =
  | { readonly ok: true; readonly hasMedia: false }
  | {
      readonly ok: true;
      readonly hasMedia: true;
      readonly origin: DraftMediaOrigin;
      readonly category: ProductRadarLibraryCategory;
      readonly mime: string | null;
      readonly originalName: string | null;
      // 요청서 8절: carousel ZIP 다운로드는 새로 만들지 않고 기존 GET
      // /product-radar/library/assets/:assetKey/zip을 그대로 재사용한다 - 프론트가 그 URL을
      // 만들 수 있도록 동일한 "job:<id>"|"upload:<id>" 포맷을 그대로 내려준다. legacy(media_filename)는
      // 이 asset key 체계에 속하지 않으므로 null(항상 파일 1개라 ZIP 자체가 필요 없다).
      readonly assetKey: string | null;
      readonly files: readonly DraftMediaFile[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

export function resolveDraftMediaDetail(draft: DraftMediaPointerRow): DraftMediaDetailResult {
  if (draft.source_type === "product_radar" && draft.product_radar_media_job_id !== null) {
    const job = getProductRadarMediaJobById(draft.product_radar_media_job_id);
    if (!job || job.status !== "rendered") return { ok: true, hasMedia: false };
    const rows = listProductRadarMediaFilesByJobId(draft.product_radar_media_job_id)
      .filter((f) => f.role === "card" || f.role === "slide" || f.role === "video" || f.role === "animation")
      .sort((a, b) => (a.slideIndex ?? 0) - (b.slideIndex ?? 0));
    if (rows.length === 0) return { ok: true, hasMedia: false };
    const generatedCategory = categoryForGeneratedMediaType(job.mediaType);
    return {
      ok: true,
      hasMedia: true,
      origin: "generated",
      category: generatedCategory,
      mime: mimeForGeneratedCategory(generatedCategory),
      originalName: null,
      assetKey: `job:${draft.product_radar_media_job_id}`,
      files: rows.map((f) => ({ filename: f.filename, slideIndex: f.slideIndex, width: f.width, height: f.height, available: mediaFileExists(f.filename) })),
    };
  }
  if (MEDIA_LIBRARY_SOURCE_TYPES.has(draft.source_type ?? "") && draft.product_radar_library_asset_id !== null) {
    const asset = getProductRadarLibraryAssetById(draft.product_radar_library_asset_id);
    if (!asset) return { ok: true, hasMedia: false };
    const rows = listProductRadarLibraryAssetFilesByAssetId(draft.product_radar_library_asset_id);
    if (rows.length === 0) return { ok: true, hasMedia: false };
    return {
      ok: true,
      hasMedia: true,
      origin: "user_upload",
      category: asset.category,
      mime: rows[0].mime,
      originalName: asset.originalName,
      assetKey: `upload:${draft.product_radar_library_asset_id}`,
      files: rows.map((f) => ({ filename: f.filename, slideIndex: f.slideIndex, width: f.width, height: f.height, available: mediaFileExists(f.filename) })),
    };
  }
  if (draft.media_filename) {
    return {
      ok: true,
      hasMedia: true,
      origin: "legacy",
      category: categoryForLegacyAttachment(draft.media_type, draft.media_mime),
      mime: draft.media_mime,
      originalName: draft.media_original_name,
      assetKey: null,
      files: [{ filename: draft.media_filename, slideIndex: null, width: null, height: null, available: mediaFileExists(draft.media_filename) }],
    };
  }
  return { ok: true, hasMedia: false };
}
