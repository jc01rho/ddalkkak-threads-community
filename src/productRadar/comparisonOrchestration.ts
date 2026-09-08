// src/productRadar/comparisonOrchestration.ts
// 상품 레이더 Phase 9.7: Product Comparison Orchestration.
// docs/designs/product-radar-phase9-comparison-foundation-design.md 16절("v1은 비교
// 요청 시점에 즉석 계산 - pairwise identity/similarity 캐시 테이블을 따로 만들지 않는다")
// / 17절("Relation/Compatibility/필드 값은 서버만 계산해서 저장한다. 클라이언트가 계산
// 결과를 실어 보내는 요청 바디를 받지 않는다" / "ComparisonSnapshot은 서버 생성 시각
// 기준으로만 기록") 대응.
//
// 이 파일의 책임은 "계산 흐름 조립"뿐입니다 - 실제 계산 로직은 전부 기존 Phase 9.1~9.5
// 함수를 그대로 호출합니다(category.ts/relation.ts/compatibility.ts/comparisonPersistence.ts
// 전부 미수정). 새 relation 알고리즘이나 similarity 점수 체계를 만들지 않습니다. group
// 생성(단순 CRUD 성격 - 상품 존재/active 확인 후 저장)은 이 파일에 넣지 않고
// routes/productRadar/comparisons.ts + database.ts repository에 둡니다 - 이 파일은
// "이미 만들어진 group을 실행(run)"하는 것만 담당합니다.

import {
  getLatestProductRadarProductSnapshot,
  getProductRadarCompareGroup,
  getProductRadarProduct,
  listProductRadarCompareItemsByGroupId,
  nowIso,
} from "../database";
import { classifyProductCategory } from "./category";
import { compareProductComparisonCompatibility } from "./compatibility";
import { buildFactualComparisonEvidence, FactualComparisonEvidenceBuildResult } from "./comparisonEvidence";
import { insertProductRadarComparisonSnapshotForGroup } from "./comparisonPersistence";
import { compareProductRelation, extractIdentityFingerprint, extractVariationFingerprint } from "./relation";
import {
  ComparisonSnapshotBuildResult,
  ComparisonSnapshotPairResult,
  ComparisonSnapshotProductEvidence,
  ComparisonSnapshotProductRef,
  NormalizedMeasurements,
  ProductRadarProduct,
  ProductRelationInput,
  ProductVariationDimensionValue,
  ProductVariationFingerprint,
} from "./types";
import { NormalizedMeasurement, normalizeMeasurement } from "./unitNormalization";

const MIN_GROUP_PRODUCTS = 2;
const MAX_GROUP_PRODUCTS = 4;

// 상품 레이더 Phase 11.3: live master product row(이미 위 루프에서 조회된 값, 추가 DB
// 조회 없음)에서 comparisonFields를 조립한다 - price만 실제로 PATCH 경로가 있어
// userOverriddenFields에 "price"가 있으면 manual_override, 그 외(자동 수집/PATCH
// 대상 아님)는 collected(Phase 11.0 3~4절에서 확정한 field별 source 정책 그대로).
// originalPrice/shippingFee는 PATCH 대상 필드가 아니므로 항상 collected다. 조립한
// raw object는 반드시 buildFactualComparisonEvidence()를 통과시킨 canonical 결과만
// 쓴다 - raw object를 그대로 snapshot에 넣지 않는다(요청서 8절).
//
// Phase 12.5.6D.5.1: conditionalPrice도 PATCH 대상 필드가 아니므로 항상 collected다
// (originalPrice/shippingFee와 동일 원칙). conditionalPriceLabel은 사이트 원문을 그대로
// 넘긴다 - 여기서 값을 만들거나 재해석하지 않는다.
//
// Phase 12.5.6D.5.2: shippingType/shippingText도 사이트 원문을 그대로 넘긴다 - 재파싱/
// 의미 재해석 없음. 새로 생성하는 orchestration output은(comparisonEvidence.ts의
// backward-compat 예외 대상인 과거 저장 snapshot과 달리) 매번 이 함수가 직접 조립하므로
// 이 파일이 다루는 모든 key를 항상 명시적으로 포함한다(생략하지 않음).
//
// Phase 12.5.6D.5.3: rating/reviewCount도 PATCH 대상 필드가 아니므로(database.ts의
// PRODUCT_PATCH_COLUMN_MAP에 없음 - originalPrice/shippingFee와 동일하게 확인) monetary
// field가 아닌 단순 값 그대로 넘긴다 - {value, source} wrapper를 만들지 않는다
// (comparisonEvidence.ts가 이미 이 둘을 optional 문자열 descriptor와 같은 급으로
// 다룬다).
function buildComparisonFieldsForProduct(product: ProductRadarProduct): FactualComparisonEvidenceBuildResult {
  const priceInput =
    product.price === null
      ? null
      : { value: product.price, source: product.userOverriddenFields.includes("price") ? "manual_override" : "collected" };
  const originalPriceInput = product.originalPrice === null ? null : { value: product.originalPrice, source: "collected" };
  const conditionalPriceInput = product.conditionalPrice === null ? null : { value: product.conditionalPrice, source: "collected" };
  const shippingFeeInput = product.shippingFee === null ? null : { value: product.shippingFee, source: "collected" };

  return buildFactualComparisonEvidence({
    price: priceInput,
    originalPrice: originalPriceInput,
    conditionalPrice: conditionalPriceInput,
    conditionalPriceLabel: product.conditionalPriceLabel,
    shippingFee: shippingFeeInput,
    shippingType: product.shippingType,
    shippingText: product.shippingText,
    rating: product.rating,
    reviewCount: product.reviewCount,
  });
}

// 이미 얼려진 variation(capacity/quantity/volume/weight)의 raw {value, unit}를 그대로
// normalizeMeasurement()에 넘긴다 - raw measurement를 별도로 중복 저장하지 않는다
// (요청서 11절). 슬롯 하나가 정규화에 실패해도(예: 정규식이 "0kg"처럼 0을 캡처한 극히
// 드문 경우) 그 슬롯만 null로 두고 snapshot 전체를 실패시키지 않는다 - raw variation은
// 이미 productEvidence.variation에 그대로 보존돼 있으므로 별도 실패 사유를 여기서
// 저장하지 않는다(요청서 13절).
function normalizeVariationSlot(dim: ProductVariationDimensionValue | null): NormalizedMeasurement | null {
  if (dim === null) return null;
  const result = normalizeMeasurement({ value: dim.value, unit: dim.unit });
  return result.ok ? result.measurement : null;
}

function buildNormalizedMeasurementsForVariation(variation: ProductVariationFingerprint): NormalizedMeasurements {
  return {
    capacity: normalizeVariationSlot(variation.capacity),
    quantity: normalizeVariationSlot(variation.quantity),
    volume: normalizeVariationSlot(variation.volume),
    weight: normalizeVariationSlot(variation.weight),
  };
}

// 실행 순서(요청서 5절 22단계 그대로):
// 1~2. group + compare items 조회
// 3. productId canonical(오름차순) 정렬 - compare_items가 이미 그 순서로 저장돼 있어도
//    (database.ts의 listProductRadarCompareItemsByGroupId 참고) 여기서 다시 한번
//    명시적으로 정렬해 저장 순서에 의존하지 않는다.
// 4. 상품 수 2~4 재검증(group 생성 시점에도 강제되지만 run 시점에도 다시 확인 - 그
//    사이 compare_items가 바뀔 방법은 없지만 방어적으로 재확인).
// 5~9. 상품별 조회 -> active 확인 -> 최신 product_radar_product_snapshots 확인 ->
//    category 즉석 계산(캐시 없음, 설계서 16절)
// 10~12. ProductRelationInput 구성 + identity/variation fingerprint 계산
// 13~15. 모든 i<j 쌍에 대해 relation -> compatibility
// 16~19. productRefs/productEvidence/pairs/infoAsOf 조립
// 20~21. persistence 계층(insertProductRadarComparisonSnapshotForGroup)에 위임 - id/revision
//    확정과 INSERT는 그 함수의 단일 transaction 안에서 원자적으로 처리된다(이 함수는
//    MAX(id)/MAX(revision)을 직접 계산하지 않는다 - 요청서 2-C절 금지 패턴).
// 22. 결과 반환.
export function runProductRadarComparisonGroup(compareGroupId: number): ComparisonSnapshotBuildResult {
  const group = getProductRadarCompareGroup(compareGroupId);
  if (!group) {
    return { ok: false, snapshot: null, errors: ["compare_group_not_found"] };
  }

  const items = listProductRadarCompareItemsByGroupId(compareGroupId);
  const productIds = items.map((item) => item.productId).sort((a, b) => a - b);

  if (productIds.length < MIN_GROUP_PRODUCTS || productIds.length > MAX_GROUP_PRODUCTS) {
    return { ok: false, snapshot: null, errors: ["invalid_product_count"] };
  }

  const products = [];
  for (const productId of productIds) {
    const product = getProductRadarProduct(productId);
    if (!product) {
      return { ok: false, snapshot: null, errors: ["product_not_found"] };
    }
    if (product.status !== "active") {
      return { ok: false, snapshot: null, errors: ["product_not_active"] };
    }
    products.push(product);
  }

  const refs: ComparisonSnapshotProductRef[] = [];
  const evidenceList: ComparisonSnapshotProductEvidence[] = [];
  const relationInputById = new Map<number, ProductRelationInput>();

  for (const product of products) {
    // 수동 등록 상품처럼 snapshot 행이 아예 없으면 여기서 만들어내지 않고 명확히
    // 실패한다(요청서 8절) - 수동 등록 pipeline 개선은 별도 Phase.
    const latestSnapshot = getLatestProductRadarProductSnapshot(product.id);
    if (!latestSnapshot) {
      return { ok: false, snapshot: null, errors: ["product_snapshot_missing"] };
    }

    const categoryResult = classifyProductCategory({
      siteId: product.siteId,
      canonicalUrl: product.canonicalUrl,
      productName: product.productName,
      optionName: product.optionName,
      sellerName: product.sellerName,
    });

    const relationInput: ProductRelationInput = {
      productName: product.productName,
      optionName: product.optionName,
      categoryKey: categoryResult.categoryKey,
    };
    relationInputById.set(product.id, relationInput);

    // Phase 11.3: live master row에서 만든 factual input이 buildFactualComparisonEvidence()를
    // 통과하지 못하면 snapshot을 부분 생성하지 않는다 - fail closed(요청서 9절). 정상
    // 구성이라면 항상 통과해야 하므로(이 함수가 스스로 만든 shape이기 때문), 실패는
    // 방어적 상황으로만 취급한다 - 기존 stable error 목록(compare_group_not_found 등)과
    // 같은 snake_case 관례를 그대로 따르는 신규 code 하나만 추가한다.
    const comparisonFieldsResult = buildComparisonFieldsForProduct(product);
    if (!comparisonFieldsResult.ok) {
      return { ok: false, snapshot: null, errors: ["comparison_evidence_invalid"] };
    }

    const variation = extractVariationFingerprint(relationInput);

    refs.push({ productId: product.id, productSnapshotId: latestSnapshot.id, capturedAt: latestSnapshot.capturedAt });
    // Phase 12.5.2.2.1: displayLabel은 latestSnapshot(정확히 productSnapshotId가 가리키는
    // 그 행)에서만 가져온다 - product.productName(live row, 위에서 category/identity
    // 계산에만 쓰임)을 여기서 함께 쓰면 "productSnapshotId=X인데 이름은 live"라는
    // 금지된 조합이 생긴다(설계서 5절). 사용자가 PATCH로 이름만 고치고 재수집하지 않은
    // 경우에도 latestSnapshot.displayLabel은 그 snapshot이 얼려진 시점의 이름을
    // 그대로 유지한다.
    evidenceList.push({
      productId: product.id,
      productSnapshotId: latestSnapshot.id,
      displayLabel: latestSnapshot.displayLabel,
      // Phase 12.5.3.1: displayLabel과 동일한 same-row 원칙 - 이 evidence가 참조하는
      // exact productSnapshotId(=latestSnapshot.id)와 같은 행에서 나온 값만 쓴다. live
      // product row나 product_radar_images를 별도로 조회하지 않는다.
      representativeImageUrl: latestSnapshot.representativeImageUrl,
      categoryKey: categoryResult.categoryKey,
      identity: extractIdentityFingerprint(relationInput),
      variation,
      comparisonFields: comparisonFieldsResult.evidence,
      normalizedMeasurements: buildNormalizedMeasurementsForVariation(variation),
    });
  }

  const refByProductId = new Map(refs.map((ref) => [ref.productId, ref]));
  const pairs: ComparisonSnapshotPairResult[] = [];
  for (let i = 0; i < productIds.length; i++) {
    for (let j = i + 1; j < productIds.length; j++) {
      const idA = productIds[i];
      const idB = productIds[j];
      const inputA = relationInputById.get(idA)!;
      const inputB = relationInputById.get(idB)!;
      const relationResult = compareProductRelation(inputA, inputB);
      const compatibilityResult = compareProductComparisonCompatibility({ relationResult, left: inputA, right: inputB });
      pairs.push({
        productIdA: idA,
        productIdB: idB,
        productSnapshotIdA: refByProductId.get(idA)!.productSnapshotId,
        productSnapshotIdB: refByProductId.get(idB)!.productSnapshotId,
        relation: relationResult,
        compatibility: compatibilityResult,
      });
    }
  }

  // 설계서 14절 정의 그대로: 비교에 포함된 상품 중 가장 오래된 last_checked_at.
  // Date.now/client 값/추측 없음 - products는 이미 위에서 실제 조회한 값이다.
  const infoAsOf = products.reduce((min, p) => (p.lastCheckedAt < min ? p.lastCheckedAt : min), products[0].lastCheckedAt);
  const createdAt = nowIso();

  return insertProductRadarComparisonSnapshotForGroup({
    compareGroupId,
    createdAt,
    infoAsOf,
    productRefs: refs,
    productEvidence: evidenceList,
    pairs,
  });
}
