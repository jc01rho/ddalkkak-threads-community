// src/productRadar/mediaDraftAttachment.ts
// 상품 레이더 Phase 12.5.3.3: 기존 Product Radar Threads draft에 single-card PNG를
// 생성하고 그 media job을 exact draft에 연결한다. 이 파일의 책임은 "draft 자격 확인 +
// lineage derive + attach"뿐이다 - 카드 생성/다운로드/렌더/저장은 전부
// mediaOrchestration.ts의 generateAndPersistProductRadarSingleCard()를 그대로 재사용한다
// (복제 없음, productId 구성원 검증도 그 함수가 이미 한다).
//
// caller input은 정확히 draftId + productId 둘뿐이다. recommendationSnapshotId는 client가
// 보내지 않는다 - draft.product_radar_recommendation_snapshot_id에서 파생한다(요청서 2절).
//
// draft 자격(요청서 3절): source_type = 'product_radar' AND
// product_radar_recommendation_snapshot_id != null이어야 한다. 일반/쿠파스
// (source_type='affiliate_product') draft는 fail closed로 거부한다. 이 확인은 media job을
// 만들기 전(pre-job)에 이뤄진다 - mediaOrchestration.ts의 pre-job/post-job 분류 원칙과
// 동일하다(무엇을 만들지조차 확정할 수 없는 실패는 job을 만들지 않는다).
//
// stale race 방어(요청서 10절): 같은 draft에 대해 두 generation이 동시에 진행되면(A 시작
// -> B 시작 -> B 성공 -> A 성공), media job은 createProductRadarMediaJob()이 생성 순서대로
// 발급하는 AUTOINCREMENT id를 이미 갖고 있다(A가 먼저 시작했으므로 A.id < B.id) - 이 id
// 자체를 순번(sequence)으로 재사용한다(옵션 D, 새 revision/token 컬럼 추가 없음).
// attachProductRadarMediaJobToDraftIfNewer()가 "현재 attach된 job id보다 큰 job id일
// 때만 교체"하는 단일 UPDATE(compare-and-set)로 이를 강제한다 - 늦게 도착한 A(더 작은
// id)는 이미 attach된 B(더 큰 id)를 덮어쓰지 못한다.
//
// attachment 실패(요청서 8절): media job/file 생성 자체는 이미 성공한 뒤이므로, attach가
// 실패해도(stale 또는 예기치 못한 DB 오류) job을 failed로 되돌리지 않는다 - artifact는
// 정상 생성됐기 때문이다. 대신 attachment-specific 실패 코드를 반환한다. 그 job/file은
// unattached 상태로 남는다(known limitation - 향후 정리 정책 필요, 완료 보고에 명시).

import { attachProductRadarMediaJobToDraftIfNewer, getDraft } from "../database";
import {
  generateAndPersistProductRadarSingleCard,
  generateAndPersistProductRadarSingleCardComposition,
  ProductRadarSingleCardResult,
  ProductRadarSingleCardTestOverrides,
} from "./mediaOrchestration";
import { ProductRadarSingleCardComposition } from "./mediaCardRenderer";
import { getProductRadarMediaJobById, listProductRadarMediaFilesByJobId } from "./mediaPersistence";
import { getProductRadarRecommendationSnapshotById } from "./recommendationPersistence";
import { getProductRadarLibraryAssetById, listProductRadarLibraryAssetFilesByAssetId } from "./libraryPersistence";
import {
  generateProductRadarCarouselBatch,
  ProductRadarCarouselBatchResult,
  ProductRadarCarouselCandidateSet,
  ProductRadarCarouselTestOverrides,
} from "./mediaCarouselOrchestration";
import {
  generateProductRadarMotionBatch,
  ProductRadarMotionBatchResult,
  ProductRadarMotionOutputType,
  ProductRadarMotionTestOverrides,
} from "./motionOrchestration";

export type ProductRadarDraftMediaAttachmentResult =
  | {
      readonly ok: true;
      readonly draftId: number;
      readonly recommendationSnapshotId: number;
      readonly comparisonSnapshotId: number;
      readonly productId: number;
      readonly mediaJobId: number;
      readonly file: { readonly id: number; readonly filename: string; readonly width: number; readonly height: number };
      readonly errors: readonly [];
    }
  | {
      readonly ok: false;
      readonly mediaJobId: number | null;
      readonly errors: readonly string[];
    };

interface ProductRadarEligibleDraft {
  readonly draftId: number;
  readonly recommendationSnapshotId: number;
}

// draft 자격 검증(요청서 3절, 아래 파일 헤더 코멘트) - 이 파일의 모든 진입점(기존
// generate+attach / Phase 12.5.3.5의 candidate 생성 / job attach / current 조회)이 공유한다.
// source_type='product_radar' AND product_radar_recommendation_snapshot_id != null이어야
// 하고, recommendationSnapshotId는 client가 보내지 않고 여기서만 파생한다(요청서 2절).
function getEligibleProductRadarDraft(draftId: number): { ok: true; draft: ProductRadarEligibleDraft } | { ok: false; errors: readonly string[] } {
  const draft = getDraft(draftId);
  if (!draft) {
    return { ok: false, errors: ["product_radar_media_draft_not_found"] };
  }
  if (draft.source_type !== "product_radar" || typeof draft.product_radar_recommendation_snapshot_id !== "number") {
    return { ok: false, errors: ["product_radar_media_draft_invalid"] };
  }
  return { ok: true, draft: { draftId, recommendationSnapshotId: draft.product_radar_recommendation_snapshot_id } };
}

export async function generateAndAttachProductRadarSingleCardToDraft(
  draftId: number,
  productId: number,
  testOverrides?: ProductRadarSingleCardTestOverrides
): Promise<ProductRadarDraftMediaAttachmentResult> {
  // ---- 1. draft exact read + 자격 검증(pre-job) ----
  const eligible = getEligibleProductRadarDraft(draftId);
  if (!eligible.ok) {
    return { ok: false, mediaJobId: null, errors: eligible.errors };
  }

  // ---- 2. 기존 카드 생성기 재사용(latest fallback 없음 - exact recommendationSnapshotId만) ----
  const generated: ProductRadarSingleCardResult = await generateAndPersistProductRadarSingleCard(
    eligible.draft.recommendationSnapshotId,
    productId,
    testOverrides
  );
  if (!generated.ok) {
    return generated;
  }

  // ---- 3. 짧은 DB transaction(단일 UPDATE) - draft attachment switch ----
  let attached: boolean;
  try {
    attached = attachProductRadarMediaJobToDraftIfNewer(draftId, generated.mediaJobId);
  } catch {
    return { ok: false, mediaJobId: generated.mediaJobId, errors: ["product_radar_media_attachment_failed"] };
  }
  if (!attached) {
    return { ok: false, mediaJobId: generated.mediaJobId, errors: ["product_radar_media_attachment_stale"] };
  }

  return {
    ok: true,
    draftId,
    recommendationSnapshotId: generated.recommendationSnapshotId,
    comparisonSnapshotId: generated.comparisonSnapshotId,
    productId: generated.productId,
    mediaJobId: generated.mediaJobId,
    file: generated.file,
    errors: [],
  };
}

// ==================================================================================
// Phase 12.5.3.5: candidate(구성 선택) 생성 - draft attachment는 절대 바꾸지 않는다(요청서
// 2절 핵심 계약). generateAndPersistProductRadarSingleCardComposition()이 media job/file만
// 만들 뿐 draft를 전혀 건드리지 않으므로, 이 함수는 draft 자격 확인 + lineage derive만 얹는다
// (attach 3단계가 구조적으로 아예 없음 - "다른 구성으로 만들기"를 여러 번 눌러도 현재
// attachment는 오직 attachProductRadarMediaJobToDraft()를 명시로 호출할 때만 바뀐다).
// ==================================================================================
export async function generateProductRadarSingleCardCandidateForDraft(
  draftId: number,
  productId: number,
  composition: ProductRadarSingleCardComposition,
  testOverrides?: ProductRadarSingleCardTestOverrides
): Promise<ProductRadarSingleCardResult> {
  const eligible = getEligibleProductRadarDraft(draftId);
  if (!eligible.ok) {
    return { ok: false, mediaJobId: null, errors: eligible.errors };
  }
  return generateAndPersistProductRadarSingleCardComposition(eligible.draft.recommendationSnapshotId, productId, composition, testOverrides);
}

export interface ProductRadarMediaAttachFile {
  readonly id: number;
  readonly slideIndex: number | null; // card는 항상 null, carousel은 0-based
  readonly filename: string;
  readonly width: number;
  readonly height: number;
}

// Phase 12.5.3.7/12.5.3.9: job.mediaType('card'|'carousel'|'video'|'animation')에 따라 유효한
// 파일 목록을 검증/정규화하는 공통 헬퍼(요청서 27절) - attach/current 조회 둘 다 이 하나의
// 함수만 신뢰한다(검증 로직이 두 곳에서 갈라지지 않게). carousel은 role='slide' 파일이 정확히
// 2~3개이고 slide_index가 0-based contiguous/unique해야 한다(요청서 17절 convention) -
// 하나라도 어긋나면(1개/4개 이상/구멍난 인덱스) 통째로 무효로 취급한다(요청서 27절 AT/AU/AV).
// video/animation은 Phase 12.5.3.9부터 실제로 생성된다 - 각각 role='video'|'animation' 파일이
// 정확히 1개(slideIndex는 항상 null, card와 동일한 단일 파일 계약)여야 한다.
export function validateProductRadarMediaJobFiles(
  job: { mediaType: string },
  mediaJobId: number
): { mediaType: "card" | "carousel" | "video" | "animation"; files: readonly ProductRadarMediaAttachFile[] } | null {
  const rows = listProductRadarMediaFilesByJobId(mediaJobId);
  if (job.mediaType === "card") {
    const row = rows.find((f) => f.role === "card");
    if (!row || row.width === null || row.height === null) return null;
    return { mediaType: "card", files: [{ id: row.id, slideIndex: null, filename: row.filename, width: row.width, height: row.height }] };
  }
  if (job.mediaType === "carousel") {
    const slides = rows
      .filter((f) => f.role === "slide" && f.width !== null && f.height !== null && f.slideIndex !== null)
      .sort((a, b) => (a.slideIndex as number) - (b.slideIndex as number));
    if (slides.length < 2 || slides.length > 3) return null;
    const isContiguousFromZero = slides.every((f, i) => f.slideIndex === i);
    if (!isContiguousFromZero) return null;
    return { mediaType: "carousel", files: slides.map((f) => ({ id: f.id, slideIndex: f.slideIndex as number, filename: f.filename, width: f.width as number, height: f.height as number })) };
  }
  if (job.mediaType === "video" || job.mediaType === "animation") {
    const row = rows.find((f) => f.role === job.mediaType);
    if (!row || row.width === null || row.height === null) return null;
    return { mediaType: job.mediaType, files: [{ id: row.id, slideIndex: null, filename: row.filename, width: row.width, height: row.height }] };
  }
  return null;
}

export type ProductRadarMediaAttachByJobResult =
  | {
      readonly ok: true;
      readonly draftId: number;
      readonly recommendationSnapshotId: number;
      readonly comparisonSnapshotId: number;
      readonly productId: number | null; // carousel은 단일 상품이 아니므로 null
      readonly mediaJobId: number;
      readonly mediaType: "card" | "carousel" | "video" | "animation";
      readonly file: { readonly id: number; readonly filename: string; readonly width: number; readonly height: number }; // 하위호환(요청서 28절) - card는 그 파일, carousel은 첫 slide
      readonly files: readonly ProductRadarMediaAttachFile[];
      readonly errors: readonly [];
    }
  | {
      readonly ok: false;
      readonly mediaJobId: number | null;
      readonly errors: readonly string[];
    };

// Phase 12.5.3.5/12.5.3.7: 사용자가 candidate를 "이 이미지/캐러셀 사용"으로 확정할 때만
// 호출된다(요청서 9·15·27절) - candidate 생성 자체는 draft attachment를 바꾸지 않으므로,
// 실제 attach는 반드시 이 함수를 거친다. mediaJobId가 (1) 이 draft의 정확한 recommendation
// lineage에서 나온 것인지, (2) card 또는 carousel이고 렌더링이 끝난(status='rendered')
// job인지, (3) 그 job의 파일이 mediaType에 맞게 실제로 존재하는지까지 전부 검증한 뒤에만
// 기존 attachProductRadarMediaJobToDraftIfNewer()(atomic compare-and-set, 늦게 도착한
// 요청이 최신 attach를 덮어쓰지 못함)를 호출한다 - single-card 흐름은 완전히 그대로다
// (mediaType 분기만 추가됐을 뿐 카드 경로 자체는 무변경, 요청서 27절 "single-card attach
// regression 금지").
export function attachProductRadarMediaJobToDraft(draftId: number, mediaJobId: number): ProductRadarMediaAttachByJobResult {
  const eligible = getEligibleProductRadarDraft(draftId);
  if (!eligible.ok) {
    return { ok: false, mediaJobId: null, errors: eligible.errors };
  }

  const job = getProductRadarMediaJobById(mediaJobId);
  if (!job) {
    return { ok: false, mediaJobId: null, errors: ["product_radar_media_job_not_found"] };
  }
  // 다른 draft/recommendation에서 만든 job은 "존재하지 않음"과 동일하게 취급한다 - 다른
  // draft에 그런 job이 있는지 여부조차 이 응답으로 드러내지 않는다.
  if (job.recommendationSnapshotId !== eligible.draft.recommendationSnapshotId) {
    return { ok: false, mediaJobId, errors: ["product_radar_media_job_lineage_mismatch"] };
  }
  if ((job.mediaType !== "card" && job.mediaType !== "carousel" && job.mediaType !== "video" && job.mediaType !== "animation") || job.status !== "rendered") {
    return { ok: false, mediaJobId, errors: ["product_radar_media_job_not_ready"] };
  }
  const validated = validateProductRadarMediaJobFiles(job, mediaJobId);
  if (!validated) {
    return { ok: false, mediaJobId, errors: ["product_radar_media_job_file_missing"] };
  }

  let attached: boolean;
  try {
    attached = attachProductRadarMediaJobToDraftIfNewer(draftId, mediaJobId);
  } catch {
    return { ok: false, mediaJobId, errors: ["product_radar_media_attachment_failed"] };
  }
  if (!attached) {
    return { ok: false, mediaJobId, errors: ["product_radar_media_attachment_stale"] };
  }

  const recommendationResult = getProductRadarRecommendationSnapshotById(eligible.draft.recommendationSnapshotId);
  if (!recommendationResult.ok || !recommendationResult.record) {
    // attach 자체(위 UPDATE)는 이미 성공했다 - 응답 조립을 위한 재조회만 실패한 극히 예외적인
    // 경우이므로 내부 corrupt로 분류한다(요청서 새 문자열 최소화 - 기존 코드 재사용).
    return { ok: false, mediaJobId, errors: ["recommendation_snapshot_corrupt"] };
  }

  const firstFile = validated.files[0];
  return {
    ok: true,
    draftId,
    recommendationSnapshotId: eligible.draft.recommendationSnapshotId,
    comparisonSnapshotId: recommendationResult.record.comparisonSnapshotId,
    productId: job.productId,
    mediaJobId,
    mediaType: validated.mediaType,
    file: { id: firstFile.id, filename: firstFile.filename, width: firstFile.width, height: firstFile.height },
    files: validated.files,
    errors: [],
  };
}

export type ProductRadarCurrentMediaAttachmentResult =
  | { readonly ok: true; readonly attached: false }
  | {
      readonly ok: true;
      readonly attached: true;
      readonly draftId: number;
      readonly mediaJobId: number;
      readonly productId: number | null;
      readonly mediaType: "card" | "carousel" | "video" | "animation";
      readonly file: { readonly id: number; readonly filename: string; readonly width: number; readonly height: number }; // 하위호환(요청서 28절)
      readonly files: readonly ProductRadarMediaAttachFile[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

// Phase 12.5.3.5/12.5.3.7(요청서 19·28절): 페이지/Recommendation view를 다시 열어도 현재
// draft에 붙은 미디어가 있으면 preview를 복원할 수 있게 하는 최소 exact-read.
// draft.product_radar_media_job_id 하나만 읽고 그 job/file(들)을 그대로 돌려준다 - single
// image는 기존 그대로 file 1개, carousel은 mediaType='carousel' + files 2~3개(요청서 28절
// "current가 carousel이면 mediaType + 2~3 files 반환") - 목록/검색/페이지네이션 없음(요청서
// 15·19절, 초안함 전체 media preview 확장은 이번 Phase 범위 밖).
export function getProductRadarCurrentMediaAttachmentForDraft(draftId: number): ProductRadarCurrentMediaAttachmentResult {
  const draft = getDraft(draftId);
  if (!draft) {
    return { ok: false, errors: ["product_radar_media_draft_not_found"] };
  }
  if (draft.source_type !== "product_radar") {
    return { ok: false, errors: ["product_radar_media_draft_invalid"] };
  }
  const mediaJobId: number | null = draft.product_radar_media_job_id;
  if (mediaJobId === null || mediaJobId === undefined) {
    return { ok: true, attached: false };
  }
  const job = getProductRadarMediaJobById(mediaJobId);
  if (!job) {
    return { ok: true, attached: false }; // 데이터 불일치보다 "아직 없음"으로 안전하게 취급
  }
  const validated = validateProductRadarMediaJobFiles(job, mediaJobId);
  if (!validated) {
    return { ok: true, attached: false };
  }
  const firstFile = validated.files[0];
  return {
    ok: true,
    attached: true,
    draftId,
    mediaJobId,
    productId: job.productId,
    mediaType: validated.mediaType,
    file: { id: firstFile.id, filename: firstFile.filename, width: firstFile.width, height: firstFile.height },
    files: validated.files,
  };
}

// ==================================================================================
// Phase 12.5.3.7: carousel candidate batch(primary/secondary) 생성 - draft attachment는
// candidate 생성만으로는 절대 바뀌지 않는다(요청서 17절, single-card candidate와 동일 계약).
// draftId -> eligible draft 확인 -> recommendationSnapshotId derive만 이 함수가 얹고,
// 실제 batch 조립(lineage/상품 수/dedupe download/all-or-nothing 생성/idempotency)은
// 전부 mediaCarouselOrchestration.generateProductRadarCarouselBatch()가 담당한다(복제 없음).
// ==================================================================================
export async function generateProductRadarCarouselBatchForDraft(
  draftId: number,
  candidateSet: ProductRadarCarouselCandidateSet,
  testOverrides?: ProductRadarCarouselTestOverrides
): Promise<ProductRadarCarouselBatchResult> {
  const eligible = getEligibleProductRadarDraft(draftId);
  if (!eligible.ok) {
    return { ok: false, errors: eligible.errors };
  }
  return generateProductRadarCarouselBatch(eligible.draft.recommendationSnapshotId, candidateSet, testOverrides);
}

// ==================================================================================
// Phase 12.5.3.9: 짧은 영상/GIF candidate batch 생성 - draft attachment는 candidate 생성만
// 으로는 바뀌지 않는다(carousel/single-card candidate와 동일 계약). draftId -> eligible draft
// 확인 -> recommendationSnapshotId derive에 더해, 이 함수만 in-process keyed lock을 추가로
// 건다(요청서 확정본 10절 "concurrency" - carousel/card candidate에는 없던 요구사항).
//
// lock key는 sourceMediaJobId+outputType만 쓴다(draftId는 넣지 않는다) - adversarial 리뷰
// 발견: 같은 recommendationSnapshotId를 여러 draft가 공유할 수 있다는 사실이 이미 이 저장소
// 다른 곳(threadsCopyOrchestration.ts)에 명시된 기존 설계이므로, draftId를 lock key에 넣으면
// 서로 다른 draft가 정확히 같은 source+outputType으로 "거의 동시에" 요청할 때 lock이 전혀
// 충돌하지 않아 motionOrchestration.ts의 idempotency 계약(같은 source+outputType은 재인코딩
// 없이 재사용)이 깨지고 FFmpeg가 중복 실행된다. source+outputType 단위로만 잠그면 어느
// draft에서 요청했든 동일 원본에 대한 중복 인코딩을 구조적으로 막을 수 있다 - "동일 draft의
// 중복 클릭 방지"라는 원래 목적도 당연히 그대로 포함된다(부분집합).
// try/finally로 반드시 해제한다(예외가 나도 영구 lock을 남기지 않는다).
// ==================================================================================
const activeMotionBatchLocks = new Set<string>();

export async function generateProductRadarMotionBatchForDraft(
  draftId: number,
  sourceMediaJobId: number,
  outputType: ProductRadarMotionOutputType,
  testOverrides?: ProductRadarMotionTestOverrides
): Promise<ProductRadarMotionBatchResult> {
  const eligible = getEligibleProductRadarDraft(draftId);
  if (!eligible.ok) {
    return { ok: false, errors: eligible.errors };
  }
  const lockKey = `${sourceMediaJobId}:${outputType}`;
  if (activeMotionBatchLocks.has(lockKey)) {
    return { ok: false, errors: ["product_radar_media_busy"] };
  }
  activeMotionBatchLocks.add(lockKey);
  try {
    return await generateProductRadarMotionBatch(eligible.draft.recommendationSnapshotId, sourceMediaJobId, outputType, testOverrides);
  } finally {
    activeMotionBatchLocks.delete(lockKey);
  }
}
