// src/productRadar/mediaOrchestration.ts
// 상품 레이더 Phase 12.5.3.2: 단일 상품 이미지 카드 생성 흐름 조립. 이 파일의 책임은 "흐름
// 조립"뿐이다(threadsCopyOrchestration.ts와 동일 원칙) - 실제 계산/검증 로직은 전부 기존
// 파일에 있다: recommendation/comparison exact read(recommendationPersistence.ts/
// comparisonPersistence.ts), SSRF-safe download(urlSafety.ts), 이미지 검증
// (imageValidation.ts), 렌더링(mediaCardRenderer.ts), 저장(mediaPersistence.ts). 아무것도
// 복제하지 않는다.
//
// caller input은 정확히 recommendationSnapshotId + productId 둘뿐이다(요청서 1절). live
// Product row/product_radar_images/latest 조회 전혀 없음 - representativeImageUrl은
// ComparisonSnapshot에 이미 freeze된 exact 값만 쓴다(Phase 12.5.3.1 계약).
//
// 실패 분류(요청서 13·14절): recommendation/comparison을 아예 못 찾거나 productId가 그
// lineage의 구성원이 아니면 job 자체를 만들지 않는다(무엇을 만들지 확정할 수조차 없으므로).
// 그 외(언어 미지원/표시 이름 없음/이미지 참조 없음/다운로드 실패/검증 실패/렌더 실패/저장
// 실패)는 전부 job을 이미 만든 뒤 실패로 기록한다(요청서 11절 - "attempt가 있었다"는 사실
// 자체가 media job 존재 이유이므로) - 실제 failure_reason vocabulary만 사용한다(새 문자열
// 발명 금지).

import fs from "fs";
import crypto from "crypto";
import { config } from "../env";
import { getProductRadarComparisonSnapshotById } from "./comparisonPersistence";
import { getProductRadarRecommendationSnapshotById } from "./recommendationPersistence";
import { safeFetchBinary, SafeFetchBinaryResult } from "../urlSafety";
import { validateSourceImageBuffer } from "./imageValidation";
import { PRODUCT_RADAR_CARD_HEIGHT, PRODUCT_RADAR_CARD_WIDTH, ProductRadarSingleCardComposition, renderProductRadarSingleCard } from "./mediaCardRenderer";
import { isSafeMediaFilename, resolveMediaPath, deleteMediaFileIfExists } from "../mediaUpload";
import { completeProductRadarMediaJob, createProductRadarMediaJob, markProductRadarMediaJobFailed } from "./mediaPersistence";
import { ProductRadarMediaFailureReason } from "./types";

// 이 template_id/version은 기존(Phase 12.5.3.2~4) generate+attach 경로 전용이다 - 절대
// 바꾸지 않는다(요청서 10절 하위호환 - 기존 media job row의 templateId 계약이 이 문자열을
// 그대로 기대한다). Phase 12.5.3.5의 candidate 경로는 별도 template_id를 쓴다(아래).
const TEMPLATE_ID = "product-radar-single-card";
const TEMPLATE_VERSION = "1";

// Phase 12.5.3.5: candidate(구성 선택) 경로 전용 template_id 매핑(요청서 6절 예시 naming
// 그대로) - client는 이 내부 문자열을 절대 보지 않는다. 공개 계약은 composition enum
// 하나뿐이고, 이 맵이 유일한 변환 지점이다(route가 임의 templateId를 만들 방법이 없음).
const CANDIDATE_TEMPLATE_ID_BY_COMPOSITION: Record<ProductRadarSingleCardComposition, string> = {
  product_focus: "product-radar-single-card-product-focus",
  price_focus: "product-radar-single-card-price-focus",
  recommendation_focus: "product-radar-single-card-recommendation-focus",
};
const CANDIDATE_TEMPLATE_VERSION = "1";

export type ProductRadarSingleCardResult =
  | {
      readonly ok: true;
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

function ensureUploadDirExists(): void {
  if (!fs.existsSync(config.UPLOAD_DIR)) fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
}

// temp -> final atomic rename(요청서 10·13절). 파일명은 항상 crypto.randomUUID() 기반이라
// 사용자/상품명/URL이 파일명에 절대 들어가지 않는다(path traversal 여지 자체가 없음) -
// isSafeMediaFilename()/resolveMediaPath()는 mediaUpload.ts의 기존 안전 검증을 그대로
// 재사용한다(새 path 검증 로직 복붙 금지).
function writeFinalPngAtomic(buffer: Buffer): { filename: string } {
  ensureUploadDirExists();
  const filename = `${crypto.randomUUID()}.png`;
  if (!isSafeMediaFilename(filename)) throw new Error("생성된 파일명이 안전 패턴과 일치하지 않습니다."); // randomUUID()+".png"는 항상 통과하므로 사실상 발생하지 않음
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

// testOverrides는 오직 scripts/test-runner.js에서만 쓴다(production 호출부는 절대 넘기지
// 않는다 - grep으로 검증됨, 요청서 26절) - safeFetchBinary()는 사설/루프백 주소를 항상
// 거부하므로, 실 인터넷 없이 "다운로드 성공" 경로까지 실제로 통과시키려면 로컬 테스트
// 서버로 향하는 fetchBinary 구현체를 테스트가 주입해야 한다(요청서 22절 "실 internet 사용
// 금지" - 로컬 서버는 인터넷이 아니다). 이 매개변수를 넘기지 않으면 항상 진짜
// safeFetchBinary()가 쓰인다 - 즉 이 매개변수 자체가 SSRF 방어를 약화시키지 않는다(기본
// 동작은 그대로, 호출부가 명시적으로 다른 구현체를 넘길 때만 달라진다).
export interface ProductRadarSingleCardTestOverrides {
  fetchBinary?: (url: string, maxBytes: number) => Promise<SafeFetchBinaryResult>;
}

// 기존(2-arg 호환) 경로와 Phase 12.5.3.5 candidate(composition 지정) 경로가 공유하는 본문 -
// template_id/version과 renderer에 넘길 composition만 caller가 결정한다(요청서 1절 caller
// input 계약은 그대로: recommendationSnapshotId + productId + [composition] 뿐).
async function generateAndPersistProductRadarSingleCardCore(
  recommendationSnapshotId: number,
  productId: number,
  templateId: string,
  templateVersion: string,
  composition: ProductRadarSingleCardComposition | undefined,
  testOverrides?: ProductRadarSingleCardTestOverrides
): Promise<ProductRadarSingleCardResult> {
  const fetchBinary = testOverrides?.fetchBinary ?? safeFetchBinary;
  // ---- 1. exact lineage validate(요청서 1절) - job을 만들기 전 단계 ----
  const recommendationResult = getProductRadarRecommendationSnapshotById(recommendationSnapshotId);
  if (!recommendationResult.ok || !recommendationResult.record) {
    return { ok: false, mediaJobId: null, errors: recommendationResult.errors };
  }
  const recommendationRecord = recommendationResult.record;

  // latest comparison이 아니라 이 exact recommendation record가 가리키는 그 comparisonSnapshotId만
  // 쓴다(threadsCopyOrchestration.ts와 동일 원칙).
  const comparisonResult = getProductRadarComparisonSnapshotById(recommendationRecord.comparisonSnapshotId);
  if (!comparisonResult.ok || !comparisonResult.snapshot) {
    return { ok: false, mediaJobId: null, errors: comparisonResult.errors };
  }
  const comparisonSnapshot = comparisonResult.snapshot;

  const evidence = comparisonSnapshot.productEvidence.find((e) => e.productId === productId);
  if (!evidence) {
    return { ok: false, mediaJobId: null, errors: ["product_radar_media_product_not_in_comparison"] };
  }
  const recommendationProduct = recommendationRecord.recommendation.products.find((p) => p.productId === productId);
  if (!recommendationProduct) {
    return { ok: false, mediaJobId: null, errors: ["product_radar_media_product_not_in_recommendation"] };
  }

  // ---- 2. media job 생성(요청서 13절) - 이 시점부터의 실패는 전부 job에 기록된다 ----
  const job = createProductRadarMediaJob({
    compareGroupId: comparisonSnapshot.compareGroupId,
    productId,
    recommendationSnapshotId: recommendationRecord.id,
    mediaType: "card",
    templateId,
    templateVersion,
  });

  function fail(reason: ProductRadarMediaFailureReason): ProductRadarSingleCardResult {
    markProductRadarMediaJobFailed(job.id, reason);
    return { ok: false, mediaJobId: job.id, errors: [reason] };
  }

  // host label(가격/추천 접두어 등)은 recommendationRecord.outputLanguage(ko/en)만 쓴다 -
  // caller가 language를 넘기지 않는다(요청서 5절). legacy(null)는 표시할 언어를 추측하지
  // 않고 fail closed한다 - template_data_missing이 가장 근접한 기존 실패 사유다.
  if (recommendationRecord.outputLanguage !== "ko" && recommendationRecord.outputLanguage !== "en") {
    return fail("template_data_missing");
  }
  if (!evidence.displayLabel) {
    return fail("product_data_missing");
  }
  if (!evidence.representativeImageUrl) {
    return fail("image_missing");
  }

  // ---- 3. network download(요청서 13절) - DB transaction 밖에서 수행 ----
  const downloadResult = await fetchBinary(evidence.representativeImageUrl, config.MAX_MEDIA_UPLOAD_BYTES);
  if (!downloadResult.ok) {
    return fail("image_download_failed");
  }

  // ---- 4. decode/validate ----
  const validated = await validateSourceImageBuffer(downloadResult.buffer, downloadResult.contentType);
  if (!validated.ok) {
    return fail("image_invalid");
  }

  const priceValue = evidence.comparisonFields && evidence.comparisonFields.price ? evidence.comparisonFields.price.value : null;
  const firstStrengthText = recommendationProduct.strengths.length > 0 ? recommendationProduct.strengths[0].text : null;

  let renderedPng: Buffer;
  try {
    renderedPng = await renderProductRadarSingleCard({
      displayLabel: evidence.displayLabel,
      language: recommendationRecord.outputLanguage,
      priceValue,
      firstStrengthText,
      sourceImageBuffer: downloadResult.buffer,
      composition,
    });
  } catch {
    return fail("card_render_failed");
  }
  // downloadResult.buffer는 디스크에 전혀 쓰지 않았다 - "temp source 삭제"는 이 함수가
  // 반환하는 순간 buffer가 GC 대상이 되는 것으로 이미 충족된다(요청서 7·13절, 별도 파일
  // 삭제 코드가 필요 없다).

  // ---- 5. atomic final rename ----
  let saved: { filename: string };
  try {
    saved = writeFinalPngAtomic(renderedPng);
  } catch {
    return fail("local_save_failed");
  }

  // ---- 6. 짧은 DB transaction: media file insert + job success ----
  try {
    const completed = completeProductRadarMediaJob(job.id, {
      role: "card",
      slideIndex: null,
      filename: saved.filename,
      byteSize: renderedPng.length,
      width: PRODUCT_RADAR_CARD_WIDTH,
      height: PRODUCT_RADAR_CARD_HEIGHT,
    });
    return {
      ok: true,
      recommendationSnapshotId: recommendationRecord.id,
      comparisonSnapshotId: comparisonSnapshot.id,
      productId,
      mediaJobId: job.id,
      file: { id: completed.file.id, filename: completed.file.filename, width: completed.file.width as number, height: completed.file.height as number },
      errors: [],
    };
  } catch {
    // DB finalization 실패 -> 이미 디스크에 있는 최종 파일을 best-effort로 지운다(orphan 방지,
    // 요청서 13·요청서 AY절) - "성공인데 media_file row가 없음"과 "실패인데 최종 PNG가
    // 남아있음" 두 절반 상태를 모두 막는다.
    deleteMediaFileIfExists(saved.filename);
    return fail("local_save_failed");
  }
}

// 기존(Phase 12.5.3.2~4) 2-arg 호환 경로 - 시그니처/동작/template_id 전부 그대로 유지한다
// (요청서 10절). composition을 core에 넘기지 않으므로(undefined) renderer가 기본값
// "product_focus"로 처리해 기존 V1 레이아웃과 완전히 동일한 PNG를 만든다.
export async function generateAndPersistProductRadarSingleCard(
  recommendationSnapshotId: number,
  productId: number,
  testOverrides?: ProductRadarSingleCardTestOverrides
): Promise<ProductRadarSingleCardResult> {
  return generateAndPersistProductRadarSingleCardCore(recommendationSnapshotId, productId, TEMPLATE_ID, TEMPLATE_VERSION, undefined, testOverrides);
}

// Phase 12.5.3.5: candidate(구성 선택) 경로 전용. caller input은 정확히
// recommendationSnapshotId + productId + composition 셋뿐이다(요청서 1·7절) - client가
// templateId/templateVersion을 직접 넘길 방법이 없다(이 함수 자체가 그 변환 지점).
export async function generateAndPersistProductRadarSingleCardComposition(
  recommendationSnapshotId: number,
  productId: number,
  composition: ProductRadarSingleCardComposition,
  testOverrides?: ProductRadarSingleCardTestOverrides
): Promise<ProductRadarSingleCardResult> {
  return generateAndPersistProductRadarSingleCardCore(
    recommendationSnapshotId,
    productId,
    CANDIDATE_TEMPLATE_ID_BY_COMPOSITION[composition],
    CANDIDATE_TEMPLATE_VERSION,
    composition,
    testOverrides
  );
}
