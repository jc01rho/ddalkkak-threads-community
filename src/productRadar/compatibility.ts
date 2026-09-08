// src/productRadar/compatibility.ts
// 상품 레이더 Phase 9.3: AI 없이 동작하는 결정론적(deterministic) Comparison
// Compatibility 판정.
// docs/designs/product-radar-phase9-comparison-foundation-design.md 11절 대응.
//
// compareProductComparisonCompatibility()는 순수 함수입니다 - network 요청 없음, DOM
// 접근 없음, DB 접근 없음, AI 호출 없음, random/Date.now 없음. 같은 입력은 항상 같은
// 결과를 반환하고 left/right 순서를 바꿔도(relationResult를 그에 맞게 다시 계산해서
// 넘기면) compatibility/confidence/reasons(의미)가 동일합니다.
//
// Relation("두 상품이 어떤 관계인가")과 Compatibility("그 관계를 의미 있게 비교할 수
// 있는가")는 다른 질문이다(설계서 6절/11절) - 이 함수는 Phase 9.2에서 이미 계산된
// ProductRelationResult를 입력으로만 받고, compareProductRelation()이나
// classifyProductCategory()를 내부에서 다시 호출하지 않습니다. left/right에서는
// extractVariationFingerprint()(이미 Phase 9.2가 검증한 결정론적 파서)만 재사용해
// "실제로 양쪽 다 비교 근거가 있는 dimension"을 판단합니다.
//
// "비교 가능 여부"만 말합니다 - 어느 쪽이 더 좋다/싸다/추천 같은 판단은 만들지
// 않습니다(설계서 9절, Phase 9.3 비목표). 그건 미래 Phase(추천 엔진) 몫입니다.

import {
  ProductComparisonCompatibilityInput,
  ProductComparisonCompatibilityResult,
  ProductRelation,
  ProductRelationInput,
} from "./types";
import { extractVariationFingerprint } from "./relation";

const CONFIDENCE_COMPARABLE = 0.9;
const CONFIDENCE_PARTIALLY_COMPARABLE = 0.6;
const CONFIDENCE_NOT_COMPARABLE = 0.9;
const CONFIDENCE_INSUFFICIENT_DATA = 0;

// Phase 9.2와 동일한 5개 variation dimension만 다룬다 - 새 dimension이나 category별
// 스키마는 이번 Phase 범위 밖(설계서 10절).
const VARIATION_DIMENSIONS = ["capacity", "quantity", "volume", "weight", "optionName"] as const;

function insufficientData(reasons: string[]): ProductComparisonCompatibilityResult {
  return {
    compatibility: "INSUFFICIENT_DATA",
    confidence: CONFIDENCE_INSUFFICIENT_DATA,
    reasons,
    comparableDimensions: [],
    missingDimensions: [],
  };
}

// 각 dimension에서 "양쪽 다 값 있음"(comparable) / "한쪽만 값 있음"(missing, asymmetric)
// / "양쪽 다 값 없음"(그냥 그 dimension이 이 상품군에 해당하지 않을 뿐 - 부족으로
// 세지 않는다, 설계서 10절)을 가른다. same/different는 이미 Relation 단계에서
// 판정됐으므로 여기서 다시 비교하지 않는다 - Compatibility가 궁금한 건 "값이 있는가"뿐이다.
function classifyDimensionEvidence(
  left: ProductRelationInput | null | undefined,
  right: ProductRelationInput | null | undefined
): { comparableDimensions: string[]; missingDimensions: string[] } {
  const leftVariation = extractVariationFingerprint(left);
  const rightVariation = extractVariationFingerprint(right);

  const comparableDimensions: string[] = [];
  const missingDimensions: string[] = [];
  for (const dim of VARIATION_DIMENSIONS) {
    const leftValue = leftVariation[dim];
    const rightValue = rightVariation[dim];
    if (leftValue && rightValue) comparableDimensions.push(dim);
    else if (leftValue || rightValue) missingDimensions.push(dim);
  }
  return { comparableDimensions: comparableDimensions.sort(), missingDimensions: missingDimensions.sort() };
}

const RELATION_REASON: Partial<Record<ProductRelation, string>> = {
  EXACT: "relation_exact",
  VARIANT: "relation_variant",
  SIMILAR: "relation_similar",
};

// 판정 절차(결정론적, 순서 고정 - 설계서 11절/Phase 9.3 지시서 7~8절):
// 1. relationResult가 없거나 relation을 알 수 없으면 INSUFFICIENT_DATA(안전한 기본값).
// 2. relation = UNRELATED -> NOT_COMPARABLE(충분한 정보로 확인된 무관함이므로 확정
//    가능 - relation의 근거를 그대로 옮긴다).
// 3. relation = INDETERMINATE -> INSUFFICIENT_DATA("모르면 NOT_COMPARABLE로 밀지
//    않는다" - relation의 근거를 그대로 옮긴다).
// 4. relation = EXACT/VARIANT -> 이미 같은 identity가 확인된 상태이므로, 한쪽에만
//    값이 있는 dimension(asymmetric missing)이 있을 때만 PARTIALLY_COMPARABLE로
//    내린다. 그런 asymmetric이 없으면(dimension 증거가 아예 없어도) COMPARABLE -
//    "EXACT인데 variation 정보가 둘 다 없다고 비교 불가로 만들지 않는다"(지시서 17절 P).
// 5. relation = SIMILAR -> 같은 category라는 이유만으로 자동 COMPARABLE 금지. 양쪽
//    다 비교 가능한 dimension이 하나도 없으면 PARTIALLY_COMPARABLE, 있어도 asymmetric
//    missing이 있으면 PARTIALLY_COMPARABLE, 둘 다 없어야(비교 가능 dimension 존재 +
//    asymmetric 없음) COMPARABLE.
export function compareProductComparisonCompatibility(
  input: ProductComparisonCompatibilityInput | null | undefined
): ProductComparisonCompatibilityResult {
  const relationResult = input?.relationResult;
  const relation = relationResult?.relation;

  if (!relation) {
    return insufficientData(["missing_comparison_evidence"]);
  }

  if (relation === "UNRELATED") {
    return {
      compatibility: "NOT_COMPARABLE",
      confidence: CONFIDENCE_NOT_COMPARABLE,
      reasons: ["relation_unrelated", ...relationResult.reasons],
      comparableDimensions: [],
      missingDimensions: [],
    };
  }

  if (relation === "INDETERMINATE") {
    return insufficientData(["relation_indeterminate", ...relationResult.reasons]);
  }

  const relationReason = RELATION_REASON[relation];
  if (!relationReason) {
    // 알 수 없는/미래에 추가될 relation 값 - 억지로 판정하지 않는다.
    return insufficientData(["missing_comparison_evidence"]);
  }

  // 검수 보정 2건-1: "variation 정보가 없음"과 "비교 대상 product 자체가 없음"은 다르다.
  // relationResult가 EXACT/VARIANT/SIMILAR라고 해도 left/right 자체가 null/undefined면
  // (예: 상위 계층이 한쪽 상품 조회에 실패) evidence를 아예 평가할 수 없으므로
  // COMPARABLE/PARTIALLY_COMPARABLE로 과장하지 않는다. left/right가 실제 객체로 존재하되
  // 그 안의 optional variation 필드만 없는 경우(P 테스트)는 기존 정책 그대로 유지한다.
  if (input?.left == null || input?.right == null) {
    return insufficientData(["missing_product_input"]);
  }

  const { comparableDimensions, missingDimensions } = classifyDimensionEvidence(input?.left, input?.right);

  if (relation === "SIMILAR") {
    // 검수 보정 2건-2: optionName은 opaque normalized string일 뿐 semantic이 같다는
    // 보장이 없다("블랙/정품" vs "일반형"도 둘 다 non-null) - SIMILAR를 COMPARABLE로
    // 올리는 근거로는 구조화된 수치 dimension(capacity/quantity/volume/weight)만
    // 인정한다. optionName은 asymmetric missing 판단(missingDimensions)에는 계속
    // 참여하되, COMPARABLE 승격의 유일한 근거가 될 수 없다.
    const structuredComparableDimensions = comparableDimensions.filter((d) => d !== "optionName");
    if (structuredComparableDimensions.length === 0) {
      return {
        compatibility: "PARTIALLY_COMPARABLE",
        confidence: CONFIDENCE_PARTIALLY_COMPARABLE,
        reasons: [relationReason, "same_category", "missing_comparison_evidence"],
        comparableDimensions,
        missingDimensions,
      };
    }
    if (missingDimensions.length > 0) {
      return {
        compatibility: "PARTIALLY_COMPARABLE",
        confidence: CONFIDENCE_PARTIALLY_COMPARABLE,
        reasons: [relationReason, "same_category", "partial_comparison_evidence", ...missingDimensions.map((d) => `missing_${d}`)],
        comparableDimensions,
        missingDimensions,
      };
    }
    return {
      compatibility: "COMPARABLE",
      confidence: CONFIDENCE_COMPARABLE,
      reasons: [relationReason, "same_category", "comparison_evidence_available"],
      comparableDimensions,
      missingDimensions,
    };
  }

  // EXACT / VARIANT
  if (missingDimensions.length > 0) {
    return {
      compatibility: "PARTIALLY_COMPARABLE",
      confidence: CONFIDENCE_PARTIALLY_COMPARABLE,
      reasons: [relationReason, "partial_comparison_evidence", ...missingDimensions.map((d) => `missing_${d}`)],
      comparableDimensions,
      missingDimensions,
    };
  }
  return {
    compatibility: "COMPARABLE",
    confidence: CONFIDENCE_COMPARABLE,
    reasons: comparableDimensions.length > 0 ? [relationReason, "comparison_evidence_available"] : [relationReason],
    comparableDimensions,
    missingDimensions,
  };
}
