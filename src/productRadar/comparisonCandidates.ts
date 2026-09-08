// src/productRadar/comparisonCandidates.ts
// 상품 레이더 Phase 9.8: Comparison Candidates(읽기 전용 탐색).
// docs/designs/product-radar-phase9-comparison-foundation-design.md 17절
// ("GET .../comparisons/candidates?productId= - 그 상품과 relation이 EXACT/VARIANT/
// SIMILAR인 후보 목록, 서버가 즉석 계산") 대응.
//
// 이 파일의 책임은 "기준 상품 하나로 비교 가능한 저장 상품 후보를 찾는 것"뿐이다.
// comparisonOrchestration.ts(run - group을 실제로 계산해 immutable snapshot으로
// 저장)와는 완전히 분리한다 - 이 파일은 DB에 아무것도 쓰지 않고, compare group도
// 만들지 않는다. category/relation/compatibility 계산은 Phase 9.1~9.3 함수를
// 그대로 재사용한다(새 similarity score/threshold 없음).

import { getLatestProductRadarProductSnapshot, getProductRadarProduct, listProductRadarProducts } from "../database";
import { classifyProductCategory } from "./category";
import { compareProductComparisonCompatibility } from "./compatibility";
import { compareProductRelation } from "./relation";
import {
  ProductComparisonCompatibilityResult,
  ProductRadarProduct,
  ProductRelation,
  ProductRelationInput,
  ProductRelationResult,
} from "./types";

// 후보로 인정하는 relation(요청서 8절) - UNRELATED/INDETERMINATE는 제외. 새 relation
// 종류를 추가하지 않는다.
const CANDIDATE_RELATIONS: ReadonlySet<ProductRelation> = new Set(["EXACT", "VARIANT", "SIMILAR"]);

export interface ProductRadarComparisonCandidate {
  productId: number;
  relation: ProductRelationResult;
  compatibility: ProductComparisonCompatibilityResult;
}

export interface ComparisonCandidateSearchResult {
  ok: boolean;
  baseProductId: number;
  candidates: ProductRadarComparisonCandidate[];
  errors: string[];
}

// comparisonOrchestration.ts의 category -> ProductRelationInput 조립 패턴(83-104행)과
// 동일 - category는 저장하지 않고 매번 즉석 계산한다(persistent cache 없음).
function toRelationInput(product: ProductRadarProduct): ProductRelationInput {
  const categoryResult = classifyProductCategory({
    siteId: product.siteId,
    canonicalUrl: product.canonicalUrl,
    productName: product.productName,
    optionName: product.optionName,
    sellerName: product.sellerName,
  });
  return { productName: product.productName, optionName: product.optionName, categoryKey: categoryResult.categoryKey };
}

// 기준 상품(baseProductId) 하나로 비교 가능한 저장 상품 후보를 찾는다(요청서 2절 순서
// 그대로): pool 조회 -> 자신 제외 -> snapshot 존재 확인 -> category 즉석 계산 ->
// relation 즉석 계산 -> EXACT/VARIANT/SIMILAR만 채택 -> compatibility 즉석 계산 ->
// productId 오름차순 반환. DB에 아무것도 쓰지 않는다.
export function findProductRadarComparisonCandidates(baseProductId: number): ComparisonCandidateSearchResult {
  const base = getProductRadarProduct(baseProductId);
  if (!base) {
    return { ok: false, baseProductId, candidates: [], errors: ["product_not_found"] };
  }
  if (base.status !== "active") {
    return { ok: false, baseProductId, candidates: [], errors: ["product_not_active"] };
  }
  // 실행 불가능한(snapshot 없는) 기준 상품으로는 후보를 제공하지 않는다(요청서 5절) -
  // Phase 9.7 run()이 snapshot 없는 상품을 실행할 수 없는 것과 동일 이유.
  if (!getLatestProductRadarProductSnapshot(baseProductId)) {
    return { ok: false, baseProductId, candidates: [], errors: ["product_snapshot_missing"] };
  }

  const baseInput = toRelationInput(base);
  const pool = listProductRadarProducts({ status: "active" }).filter((product) => product.id !== baseProductId);

  const candidates: ProductRadarComparisonCandidate[] = [];
  for (const candidateProduct of pool) {
    // snapshot 없는 후보는 조용히 제외한다(요청서 6절) - 자동 snapshot 생성 없음.
    if (!getLatestProductRadarProductSnapshot(candidateProduct.id)) continue;

    const candidateInput = toRelationInput(candidateProduct);
    // category mismatch/unavailable 판정은 compareProductRelation() 자체 책임(요청서
    // 7절) - 여기서 category로 미리 pre-filter하지 않는다.
    const relationResult = compareProductRelation(baseInput, candidateInput);
    if (!CANDIDATE_RELATIONS.has(relationResult.relation)) continue;

    // compatibility는 candidate 포함/제외에 쓰지 않는다(요청서 9절) - metadata로만 반환.
    const compatibilityResult = compareProductComparisonCompatibility({
      relationResult,
      left: baseInput,
      right: candidateInput,
    });

    candidates.push({ productId: candidateProduct.id, relation: relationResult, compatibility: compatibilityResult });
  }

  candidates.sort((a, b) => a.productId - b.productId);

  return { ok: true, baseProductId, candidates, errors: [] };
}
