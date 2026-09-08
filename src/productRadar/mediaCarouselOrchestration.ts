// src/productRadar/mediaCarouselOrchestration.ts
// 상품 레이더 Phase 12.5.3.7: 비교 캐러셀 batch(기본 6개/다른 6개) 생성 흐름 조립. 이 파일의
// 책임은 "흐름 조립"뿐이다(mediaOrchestration.ts와 동일 원칙) - lineage read(comparisonPersistence.ts/
// recommendationPersistence.ts), SSRF-safe download(urlSafety.ts), 검증(imageValidation.ts),
// 렌더링(mediaCarouselRenderer.ts), 저장(mediaPersistence.ts)은 전부 기존 파일 재사용, 복제 없음.
//
// caller input은 정확히 recommendationSnapshotId + candidateSet 둘뿐이다(요청서 2·8절) -
// productIds/이미지 URL/가격/강점/slideCount/templateId 등 client가 보낼 방법이 없다 -
// 전부 persisted lineage(recommendation -> comparison -> frozen evidence)에서 파생한다.
//
// 상품 수 정책(요청서 3절): 2~4개, fail closed(1개/5개 이상은 job조차 만들지 않는다).
// slide 수 정책(요청서 4절): mediaCarouselRenderer.ts의 groupProductsCompact/Summary가
// 결정 - 이 파일은 그 규칙을 그대로 신뢰하고 복제하지 않는다.
//
// batch atomicity(요청서 16절, all-or-nothing 선택): source image는 batch 시작 시 이미 전부
// dedupe 다운로드+검증을 마친 뒤에만(§4단계) 실제 job 생성을 시작한다 - 즉 "무엇을 그릴 수
// 있는지"가 이미 확정된 뒤에만 6개를 만들기 시작하므로, 렌더링 자체(로컬 sharp 처리, 입력은
// 이미 다 검증됨)의 실패 확률은 사실상 0에 가깝다. 그럼에도 만에 하나 실패하면 이미 만든
// job들을 전부 failed로 되돌리고 파일을 지운다(rollback) - "5개는 성공, 1개는 실패"를 절대
// "6개 완료"로 보여주지 않는다.
//
// idempotency(요청서 20절): 같은 recommendation에서 같은 candidateSet(primary/secondary)의
// 12개 template 중 6개가 이미 status='rendered'로 존재하면 새로 렌더링하지 않고 그 기존
// job/file을 그대로 재사용해 반환한다 - 실수로 버튼을 두 번 눌러도 같은 6개가 계속 쌓이지
// 않는다. 이번 V1 UX 계약(요청서 21절 - primary/secondary 각 1회, 무한 재생성 없음)과
// 일치한다.

import fs from "fs";
import crypto from "crypto";
import { config } from "../env";
import { getProductRadarComparisonSnapshotById } from "./comparisonPersistence";
import { getProductRadarRecommendationSnapshotById } from "./recommendationPersistence";
import { safeFetchBinary, SafeFetchBinaryResult } from "../urlSafety";
import { validateSourceImageBuffer } from "./imageValidation";
import {
  PRODUCT_RADAR_CAROUSEL_SLIDE_HEIGHT,
  PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH,
  ProductRadarCarouselComposition,
  ProductRadarCarouselSlideProductInput,
  ProductRadarCarouselVariant,
  renderProductRadarCarousel,
} from "./mediaCarouselRenderer";
import { isSafeMediaFilename, resolveMediaPath, deleteMediaFileIfExists } from "../mediaUpload";
import {
  completeProductRadarMediaJobWithFiles,
  createProductRadarMediaJob,
  getLatestRenderedProductRadarMediaJobByRecommendationAndTemplate,
  listProductRadarMediaFilesByJobId,
  markProductRadarMediaJobFailed,
} from "./mediaPersistence";

export type ProductRadarCarouselCandidateSet = "primary" | "secondary";

// 공개 계약(요청서 8절): client는 candidateSet 하나만 보낸다 - variant/templateId는 절대
// 노출하지 않는다. primary -> a/b, secondary -> c/d(요청서 5·6절).
const CANDIDATE_SET_VARIANTS: Record<ProductRadarCarouselCandidateSet, readonly [ProductRadarCarouselVariant, ProductRadarCarouselVariant]> = {
  primary: ["a", "b"],
  secondary: ["c", "d"],
};
const COMPOSITIONS: readonly ProductRadarCarouselComposition[] = ["comparison_focus", "product_focus", "recommendation_focus"];
const TEMPLATE_VERSION = "1";
const MIN_PRODUCTS = 2;
const MAX_PRODUCTS = 4;

// 요청서 9절 naming 예시 그대로 - 하이픈 convention(기존 single-card template_id와 동일 스타일).
function templateIdFor(composition: ProductRadarCarouselComposition, variant: ProductRadarCarouselVariant): string {
  return `product-radar-carousel-${composition.replace(/_/g, "-")}-${variant}`;
}

export interface ProductRadarCarouselCandidateFile {
  readonly slideIndex: number;
  readonly filename: string;
  readonly width: number;
  readonly height: number;
}
export interface ProductRadarCarouselCandidate {
  readonly mediaJobId: number;
  readonly composition: ProductRadarCarouselComposition;
  readonly variant: ProductRadarCarouselVariant;
  readonly files: readonly ProductRadarCarouselCandidateFile[];
}

export type ProductRadarCarouselBatchResult =
  | {
      readonly ok: true;
      readonly recommendationSnapshotId: number;
      readonly comparisonSnapshotId: number;
      readonly candidateSet: ProductRadarCarouselCandidateSet;
      readonly candidates: readonly ProductRadarCarouselCandidate[];
      readonly errors: readonly [];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

// testOverrides는 오직 scripts/test-runner.js에서만 쓴다(production 호출부는 절대 넘기지
// 않는다 - mediaOrchestration.ts와 동일 원칙, 요청서 56절 "실 internet 금지").
export interface ProductRadarCarouselTestOverrides {
  fetchBinary?: (url: string, maxBytes: number) => Promise<SafeFetchBinaryResult>;
}

function ensureUploadDirExists(): void {
  if (!fs.existsSync(config.UPLOAD_DIR)) fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
}
// mediaOrchestration.ts의 writeFinalPngAtomic()과 동일한 패턴(temp -> final atomic rename,
// UUID 파일명) - 로직 복제가 아니라 같은 안전 원칙을 그대로 다시 구현(파일이 달라 import
// 재사용이 자연스럽지 않은 유일한 지점, 나머지는 전부 기존 함수를 그대로 가져다 쓴다).
function writeFinalPngAtomic(buffer: Buffer): { filename: string } {
  ensureUploadDirExists();
  const filename = `${crypto.randomUUID()}.png`;
  if (!isSafeMediaFilename(filename)) throw new Error("생성된 파일명이 안전 패턴과 일치하지 않습니다.");
  const finalPath = resolveMediaPath(filename);
  if (!finalPath) throw new Error("안전한 저장 경로 생성에 실패했습니다.");
  const tempPath = `${finalPath}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, finalPath);
  } catch (e) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      /* 이미 없거나 rename으로 이미 옮겨졌을 수 있음 */
    }
    throw e;
  }
  return { filename };
}

interface ProductMeta {
  displayLabel: string;
  priceValue: number | null;
  firstStrengthText: string | null;
  representativeImageUrl: string | null;
}

export async function generateProductRadarCarouselBatch(
  recommendationSnapshotId: number,
  candidateSet: ProductRadarCarouselCandidateSet,
  testOverrides?: ProductRadarCarouselTestOverrides
): Promise<ProductRadarCarouselBatchResult> {
  const fetchBinary = testOverrides?.fetchBinary ?? safeFetchBinary;

  // ---- 1. exact lineage(요청서 2절) - pre-job, 아무것도 못 만들 확실한 실패는 job 자체를 만들지 않는다 ----
  const recommendationResult = getProductRadarRecommendationSnapshotById(recommendationSnapshotId);
  if (!recommendationResult.ok || !recommendationResult.record) {
    return { ok: false, errors: recommendationResult.errors };
  }
  const recommendationRecord = recommendationResult.record;
  const comparisonResult = getProductRadarComparisonSnapshotById(recommendationRecord.comparisonSnapshotId);
  if (!comparisonResult.ok || !comparisonResult.snapshot) {
    return { ok: false, errors: comparisonResult.errors };
  }
  const comparisonSnapshot = comparisonResult.snapshot;

  if (recommendationRecord.outputLanguage !== "ko" && recommendationRecord.outputLanguage !== "en") {
    return { ok: false, errors: ["template_data_missing"] };
  }

  // ---- 2. 상품 수 정책(요청서 3절) - 2~4개, fail closed(1개/5개 이상 거부) ----
  const productRefs = comparisonSnapshot.productRefs;
  if (productRefs.length < MIN_PRODUCTS || productRefs.length > MAX_PRODUCTS) {
    return { ok: false, errors: ["product_radar_carousel_product_count_invalid"] };
  }

  // ---- 3. evidence/recommendation 매핑(exact productRefs 순서 - client가 재지정 불가) ----
  const productMetas: ProductMeta[] = [];
  for (const ref of productRefs) {
    const evidence = comparisonSnapshot.productEvidence.find((e) => e.productId === ref.productId);
    if (!evidence || !evidence.displayLabel) {
      return { ok: false, errors: ["product_data_missing"] };
    }
    const recommendationProduct = recommendationRecord.recommendation.products.find((p) => p.productId === ref.productId);
    const priceValue = evidence.comparisonFields && evidence.comparisonFields.price ? evidence.comparisonFields.price.value : null;
    const firstStrengthText = recommendationProduct && recommendationProduct.strengths.length > 0 ? recommendationProduct.strengths[0].text : null;
    productMetas.push({ displayLabel: evidence.displayLabel, priceValue, firstStrengthText, representativeImageUrl: evidence.representativeImageUrl });
  }

  // ---- 4. idempotency(요청서 20절) - 이 candidateSet의 6개 template 전부 이미 rendered면
  // 즉시 재사용하고 반환한다. dedupe 다운로드(5단계)보다 먼저 확인해 재호출 시 불필요한
  // 네트워크 요청 자체를 만들지 않는다(실수로 버튼을 여러 번 눌러도 매번 다시 다운로드하지 않음).
  const [variant1, variant2] = CANDIDATE_SET_VARIANTS[candidateSet];
  const combos = COMPOSITIONS.flatMap((composition) => [
    { composition, variant: variant1 },
    { composition, variant: variant2 },
  ]);
  const existing: ProductRadarCarouselCandidate[] = [];
  for (const combo of combos) {
    const templateId = templateIdFor(combo.composition, combo.variant);
    const job = getLatestRenderedProductRadarMediaJobByRecommendationAndTemplate(recommendationSnapshotId, templateId);
    if (!job) {
      existing.length = 0;
      break;
    }
    const files = listProductRadarMediaFilesByJobId(job.id).filter((f) => f.role === "slide");
    if (files.length < 2 || files.length > 3) {
      existing.length = 0;
      break;
    }
    existing.push({
      mediaJobId: job.id,
      composition: combo.composition,
      variant: combo.variant,
      files: files.map((f) => ({ slideIndex: f.slideIndex as number, filename: f.filename, width: f.width as number, height: f.height as number })),
    });
  }
  if (existing.length === combos.length) {
    return { ok: true, recommendationSnapshotId: recommendationRecord.id, comparisonSnapshotId: comparisonSnapshot.id, candidateSet, candidates: existing, errors: [] };
  }

  // ---- 5. batch source dedupe download(요청서 15절) - 고유 frozen URL별 1회만 fetch+검증 ----
  // URL이 null인 상품은 건너뛴다(요청서 13절 - text-centered layout으로 정상 생성). URL이
  // 있는데 다운로드/검증이 실패하면 "없는 것처럼 조용히 숨기지" 않고 batch 전체를 실패
  // 처리한다(요청서 13·16절) - 이 시점에는 아직 job을 하나도 만들지 않았다(pre-job 실패).
  const urlToBuffer = new Map<string, Buffer>();
  for (const meta of productMetas) {
    if (!meta.representativeImageUrl || urlToBuffer.has(meta.representativeImageUrl)) continue;
    const downloadResult = await fetchBinary(meta.representativeImageUrl, config.MAX_MEDIA_UPLOAD_BYTES);
    if (!downloadResult.ok) {
      return { ok: false, errors: ["image_download_failed"] };
    }
    const validated = await validateSourceImageBuffer(downloadResult.buffer, downloadResult.contentType);
    if (!validated.ok) {
      return { ok: false, errors: ["image_invalid"] };
    }
    urlToBuffer.set(meta.representativeImageUrl, downloadResult.buffer);
  }
  const productInputs: ProductRadarCarouselSlideProductInput[] = productMetas.map((m) => ({
    displayLabel: m.displayLabel,
    priceValue: m.priceValue,
    firstStrengthText: m.firstStrengthText,
    sourceImageBuffer: m.representativeImageUrl ? (urlToBuffer.get(m.representativeImageUrl) ?? null) : null,
  }));

  // ---- 6. all-or-nothing 6개 생성(요청서 16절) ----
  const createdJobIds: number[] = [];
  const createdFilenames: string[] = [];
  // adversarial 리뷰 발견: deleteMediaFileIfExists()는 ENOENT 외 에러(파일 잠금 등)를 그대로
  // throw한다 - try/catch 없이 두면 rollback 도중 예외가 전파돼 (1) 이후 job들이 failed로
  // 마킹되지 못한 채 status='rendered'로 영구히 남고 (2) idempotency 조회(status='rendered'
  // 기준)가 파일 없는 이 손상된 job을 계속 "재사용 가능"으로 반환하는 자가치유 불가 상태가
  // 된다. 파일 삭제 실패는 무시하고 job failed 마킹은 반드시 끝까지 수행한다 - 지우지 못한
  // 파일은 기존 orphan sweep(listActiveMediaFilenames가 status='rendered' JOIN만 active로
  // 봄)이 다음 주기에 정리한다.
  function rollback(): void {
    for (const filename of createdFilenames) {
      try {
        deleteMediaFileIfExists(filename);
      } catch {
        /* 아래 job failed 마킹을 반드시 진행하기 위해 무시 */
      }
    }
    for (const jobId of createdJobIds) markProductRadarMediaJobFailed(jobId, "carousel_render_failed");
  }

  const candidates: ProductRadarCarouselCandidate[] = [];
  for (const combo of combos) {
    const templateId = templateIdFor(combo.composition, combo.variant);
    const job = createProductRadarMediaJob({
      compareGroupId: comparisonSnapshot.compareGroupId,
      productId: null, // carousel은 단일 상품이 아니라 comparison 전체를 다룬다(column nullable)
      recommendationSnapshotId: recommendationRecord.id,
      mediaType: "carousel",
      templateId,
      templateVersion: TEMPLATE_VERSION,
    });
    createdJobIds.push(job.id);

    let slides: Buffer[];
    try {
      slides = await renderProductRadarCarousel({ products: productInputs, language: recommendationRecord.outputLanguage, composition: combo.composition, variant: combo.variant });
    } catch {
      rollback();
      return { ok: false, errors: ["carousel_render_failed"] };
    }

    let savedFilenames: string[];
    try {
      savedFilenames = slides.map((slide) => {
        const saved = writeFinalPngAtomic(slide);
        createdFilenames.push(saved.filename);
        return saved.filename;
      });
    } catch {
      rollback();
      return { ok: false, errors: ["local_save_failed"] };
    }

    let files: ProductRadarCarouselCandidateFile[];
    try {
      // atomic(요청서 16절) - 모든 slide 파일이 이미 디스크에 쓰인 뒤 한 트랜잭션으로만
      // rendered 전환한다. "파일 1개만 있는데 job이 이미 rendered" 반쪽 상태를 구조적으로 없앤다.
      const completeInput = slides.map((slide, slideIndex) => ({
        role: "slide" as const,
        slideIndex,
        filename: savedFilenames[slideIndex],
        byteSize: slide.length,
        width: PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH,
        height: PRODUCT_RADAR_CAROUSEL_SLIDE_HEIGHT,
      }));
      const completed = completeProductRadarMediaJobWithFiles(job.id, completeInput);
      files = completed.files.map((f) => ({ slideIndex: f.slideIndex as number, filename: f.filename, width: f.width as number, height: f.height as number }));
    } catch {
      rollback();
      return { ok: false, errors: ["local_save_failed"] };
    }

    candidates.push({ mediaJobId: job.id, composition: combo.composition, variant: combo.variant, files });
  }

  return { ok: true, recommendationSnapshotId: recommendationRecord.id, comparisonSnapshotId: comparisonSnapshot.id, candidateSet, candidates, errors: [] };
}
