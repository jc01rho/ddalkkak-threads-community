// src/productRadar/relation.ts
// 상품 레이더 Phase 9.2: AI 없이 동작하는 결정론적(deterministic) Product Identity/
// Variation/Relation 판정.
// docs/designs/product-radar-phase9-comparison-foundation-design.md 6~10절 대응.
//
// compareProductRelation()은 순수 함수입니다 - network 요청 없음, DOM 접근 없음, DB
// 접근 없음, AI 호출 없음, random/Date.now 없음. 같은 입력은 항상 같은 결과를 반환하고
// compareProductRelation(A, B)와 compareProductRelation(B, A)는 relation/confidence/
// reasons(의미)가 동일합니다. 이 파일은 아직 save/update pipeline, DB, dedup 어디에도
// 연결되지 않았습니다 - 지금은 함수와 그 unit test만 존재합니다.
//
// 기존 dedup(canonicalUrl → siteId+externalId)과는 완전히 분리된 계층입니다 - dedup은
// "같은 리스팅을 두 번 저장하지 않기 위함"이고, 이 함수는 "이미 별개로 저장된 두 행이
// 실질적으로 같은 제품/옵션/대체재인지"를 판정합니다. categoryKey는 이미 계산된 값을
// 그대로 입력받을 뿐, 이 함수 내부에서 classifyProductCategory()를 다시 호출하지 않습니다.

import {
  ProductIdentityFingerprint,
  ProductRelationInput,
  ProductRelationResult,
  ProductVariationDimensionValue,
  ProductVariationFingerprint,
} from "./types";

const CONFIDENCE_EXACT = 0.95;
const CONFIDENCE_VARIANT = 0.85;
const CONFIDENCE_DIFFERENT_CATEGORY = 0.9;
const CONFIDENCE_SIMILAR = 0.5;
const CONFIDENCE_INDETERMINATE = 0;

// SIMILAR는 절대 EXACT/VARIANT보다 confidence가 높을 수 없다(설계서 10절) - 상수
// 관계를 코드로도 고정해 둔다.
if (!(CONFIDENCE_SIMILAR < CONFIDENCE_VARIANT && CONFIDENCE_VARIANT < CONFIDENCE_EXACT)) {
  throw new Error("relation confidence 상수 순서가 설계 원칙을 위반합니다");
}

// 의미 있는 identity token이 최소 이만큼은 있어야 EXACT/VARIANT/SIMILAR를 확정한다.
// 부족하면 무조건 INDETERMINATE(false positive 방지, 설계서 11절/13절).
const MIN_IDENTITY_TOKENS = 2;

// productName/optionName 안에서 결정론적 정규식만으로 안전하게 뽑을 수 있는 variation만
// v1에서 지원한다(모호한 "대용량/특대/프리미엄" 등은 추측하지 않고 그냥 남겨둔다).
const CAPACITY_SRC = "(\\d+(?:\\.\\d+)?)\\s*(tb|gb)\\b";
const QUANTITY_SRC = "(\\d+)\\s*(개입|팩|개|입)";
const VOLUME_SRC = "(\\d+(?:\\.\\d+)?)\\s*(ml|l)\\b";
const WEIGHT_SRC = "(\\d+(?:\\.\\d+)?)\\s*(kg|g)\\b";
const VARIATION_PATTERN_SOURCES = [CAPACITY_SRC, QUANTITY_SRC, VOLUME_SRC, WEIGHT_SRC];

function normalizeText(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[-_/·・,()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCategoryKey(raw: string | null | undefined): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function extractDimension(text: string, patternSource: string): ProductVariationDimensionValue | null {
  const match = text.match(new RegExp(patternSource, "i"));
  if (!match) return null;
  return { value: parseFloat(match[1]), unit: match[2].toLowerCase() };
}

function stripDimensionMatches(text: string, patternSource: string): string {
  return text.replace(new RegExp(patternSource, "gi"), " ");
}

// Product Identity: productName만 사용한다(설계서 8절) - optionName은 Variation 전용
// 신호로만 쓴다. variation 토큰(용량/수량/부피/무게)을 제거한 뒤 남는 토큰 집합이
// identity다.
export function extractIdentityFingerprint(input: ProductRelationInput | null | undefined): ProductIdentityFingerprint {
  const categoryKey = normalizeCategoryKey(input?.categoryKey);
  const rawName = typeof input?.productName === "string" ? input.productName : "";
  let text = normalizeText(rawName);
  for (const src of VARIATION_PATTERN_SOURCES) {
    text = stripDimensionMatches(text, src);
  }
  text = text.replace(/\s+/g, " ").trim();
  const tokens = text.length ? text.split(" ").filter(Boolean) : [];
  const identityTokens = Array.from(new Set(tokens)).sort();
  return { categoryKey, identityTokens };
}

// Product Variation: productName+optionName 결합 텍스트에서 결정론적 패턴만 추출한다.
// 패턴이 매치되지 않으면 "추출 안 됨"(null)으로 남기고 추측하지 않는다(missing과 same을
// 구분 - 설계서 11절).
export function extractVariationFingerprint(input: ProductRelationInput | null | undefined): ProductVariationFingerprint {
  const productName = typeof input?.productName === "string" ? input.productName : "";
  const optionNameRaw = typeof input?.optionName === "string" ? input.optionName : "";
  const combined = normalizeText(`${productName} ${optionNameRaw}`);

  const optionName = optionNameRaw.trim() ? normalizeText(optionNameRaw) : null;

  return {
    capacity: extractDimension(combined, CAPACITY_SRC),
    quantity: extractDimension(combined, QUANTITY_SRC),
    volume: extractDimension(combined, VOLUME_SRC),
    weight: extractDimension(combined, WEIGHT_SRC),
    optionName,
  };
}

// "missing"을 한 종류로 뭉치면 "한쪽에만 값이 있음"(asymmetric_missing, 실제로 같은지
// 확인 불가능 - EXACT 금지)과 "양쪽 다 값이 없음"(both_missing, 그냥 비교할 정보가
// 없을 뿐 - 기존 EXACT 사례까지 깨뜨리면 안 됨)을 구분하지 못해 false-positive EXACT가
// 나온다(검수 보정 1건). 반드시 네 값으로 분리한다.
type DimComparison = "same" | "different" | "asymmetric_missing" | "both_missing";

function compareNumericDim(a: ProductVariationDimensionValue | null, b: ProductVariationDimensionValue | null): DimComparison {
  if (!a && !b) return "both_missing";
  if (!a || !b) return "asymmetric_missing";
  return a.value === b.value && a.unit === b.unit ? "same" : "different";
}

function compareOptionDim(a: string | null, b: string | null): DimComparison {
  if (!a && !b) return "both_missing";
  if (!a || !b) return "asymmetric_missing";
  return a === b ? "same" : "different";
}

function sameTokenSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((t) => setB.has(t));
}

// 판정 절차(결정론적, 순서 고정 - 설계서 10절):
// 1. categoryKey가 둘 중 하나라도 unknown이면 INDETERMINATE("모르면 UNRELATED 금지").
// 2. categoryKey가 둘 다 알려져 있고 다르면 UNRELATED.
// 3. categoryKey가 같아도 identity evidence가 부족하면(토큰 2개 미만) INDETERMINATE
//    (같은 category라는 이유만으로 SIMILAR/EXACT/VARIANT를 자동 확정하지 않는다).
// 4. identity token 집합이 다르면 SIMILAR(같은 category, 다른 identity).
// 5. identity token 집합이 같으면 variation을 비교해 EXACT/VARIANT/INDETERMINATE를 가른다:
//    - 하나라도 명확히 다르면(different) -> VARIANT(다른 dimension의 missing 여부와 무관).
//    - 명확히 다른 게 없는데 한쪽에만 값이 있는 dimension(asymmetric_missing)이 있으면
//      -> INDETERMINATE(같은 variation인지 확인 불가 - EXACT 금지, 검수 보정 1건).
//    - 그 외(모든 dimension이 same 또는 양쪽 다 missing) -> EXACT.
export function compareProductRelation(
  a: ProductRelationInput | null | undefined,
  b: ProductRelationInput | null | undefined
): ProductRelationResult {
  const categoryA = normalizeCategoryKey(a?.categoryKey);
  const categoryB = normalizeCategoryKey(b?.categoryKey);

  if (categoryA === null || categoryB === null) {
    return { relation: "INDETERMINATE", confidence: CONFIDENCE_INDETERMINATE, reasons: ["category_unknown"] };
  }

  if (categoryA !== categoryB) {
    return { relation: "UNRELATED", confidence: CONFIDENCE_DIFFERENT_CATEGORY, reasons: ["different_category"] };
  }

  const identityA = extractIdentityFingerprint(a);
  const identityB = extractIdentityFingerprint(b);

  if (identityA.identityTokens.length < MIN_IDENTITY_TOKENS || identityB.identityTokens.length < MIN_IDENTITY_TOKENS) {
    return { relation: "INDETERMINATE", confidence: CONFIDENCE_INDETERMINATE, reasons: ["insufficient_identity_signal"] };
  }

  if (!sameTokenSet(identityA.identityTokens, identityB.identityTokens)) {
    return { relation: "SIMILAR", confidence: CONFIDENCE_SIMILAR, reasons: ["same_category", "different_identity_tokens"] };
  }

  const variationA = extractVariationFingerprint(a);
  const variationB = extractVariationFingerprint(b);

  const dims: Array<[string, DimComparison]> = [
    ["capacity", compareNumericDim(variationA.capacity, variationB.capacity)],
    ["option", compareOptionDim(variationA.optionName, variationB.optionName)],
    ["quantity", compareNumericDim(variationA.quantity, variationB.quantity)],
    ["volume", compareNumericDim(variationA.volume, variationB.volume)],
    ["weight", compareNumericDim(variationA.weight, variationB.weight)],
  ];

  const differing = dims.filter(([, cmp]) => cmp === "different").map(([name]) => name).sort();
  if (differing.length > 0) {
    return {
      relation: "VARIANT",
      confidence: CONFIDENCE_VARIANT,
      reasons: ["same_normalized_identity", ...differing.map((d) => `different_${d}`)],
    };
  }

  const asymmetric = dims.filter(([, cmp]) => cmp === "asymmetric_missing").map(([name]) => name).sort();
  if (asymmetric.length > 0) {
    return {
      relation: "INDETERMINATE",
      confidence: CONFIDENCE_INDETERMINATE,
      reasons: ["same_normalized_identity", ...asymmetric.map((d) => `missing_${d}`)],
    };
  }

  const same = dims.filter(([, cmp]) => cmp === "same").map(([name]) => name).sort();
  return {
    relation: "EXACT",
    confidence: CONFIDENCE_EXACT,
    reasons: ["same_normalized_identity", ...same.map((d) => `same_${d}`)],
  };
}
