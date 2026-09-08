// src/productRadar/category.ts
// 상품 레이더 Phase 9.1: AI 없이 동작하는 결정론적(deterministic) category 분류.
// docs/designs/product-radar-phase9-comparison-foundation-design.md 7~15절 대응.
//
// classifyProductCategory()는 순수 함수입니다 - network 요청 없음, DOM 접근 없음, DB
// 접근 없음, AI 호출 없음. 같은 입력은 항상 같은 결과를 반환합니다. 이 파일은 아직
// save/update pipeline 어디에도 연결되지 않았습니다(호출부는 후속 Phase에서 명시적으로
// 추가합니다) - 지금은 함수와 그 unit test만 존재합니다.

import { ProductCategoryClassification, ProductCategorySource, ProductRadarSiteId } from "./types";

export const CATEGORY_CLASSIFICATION_VERSION = 1;

export interface ProductCategoryClassificationInput {
  siteId: ProductRadarSiteId;
  canonicalUrl: string | null;
  productName: string | null;
  optionName?: string | null;
  sellerName?: string | null;
}

interface CategoryRule {
  categoryLevel1: string;
  categoryLevel2: string;
  categoryLevel3: string;
  categoryKey: string;
  keywords: string[];
  reason: string;
}

// v1 taxonomy: 거대한 전자상거래 taxonomy를 만들지 않습니다(설계서 8절) - 지금 실제
// 저장 흐름(쿠팡/스마트스토어)에서 결정론적으로 안전하게 잡을 수 있는 소수 category만
// 시작합니다. 새 category가 필요하면 이 배열에 규칙 하나만 추가합니다.
const CATEGORY_RULES: CategoryRule[] = [
  {
    categoryLevel1: "electronics",
    categoryLevel2: "storage",
    categoryLevel3: "ssd",
    categoryKey: "electronics.storage.ssd",
    keywords: ["SSD", "NVMe"],
    reason: "title_contains_ssd",
  },
  {
    categoryLevel1: "food",
    categoryLevel2: "beverage",
    categoryLevel3: "tea",
    categoryKey: "food.beverage.tea",
    keywords: ["옥수수차", "보리차", "녹차"],
    reason: "title_contains_tea",
  },
];

const PRODUCT_NAME_HEURISTIC_CONFIDENCE = 0.8;
const URL_SIGNAL_CONFIDENCE = 1.0;

function unknownResult(reasons: string[]): ProductCategoryClassification {
  return {
    categoryLevel1: null,
    categoryLevel2: null,
    categoryLevel3: null,
    categoryKey: null,
    source: "unknown",
    confidence: 0,
    classificationVersion: CATEGORY_CLASSIFICATION_VERSION,
    reasons,
  };
}

function ruleToClassification(rule: CategoryRule, source: ProductCategorySource, confidence: number): ProductCategoryClassification {
  return {
    categoryLevel1: rule.categoryLevel1,
    categoryLevel2: rule.categoryLevel2,
    categoryLevel3: rule.categoryLevel3,
    categoryKey: rule.categoryKey,
    source,
    confidence,
    classificationVersion: CATEGORY_CLASSIFICATION_VERSION,
    reasons: [rule.reason],
  };
}

// 현재 지원 사이트(coupang/smartstore)의 상품 상세 URL은 카테고리 정보를 전혀 담지
// 않습니다(launcher/ProductRadarBrowser/SiteDetector.cs의 /vp/products/\d+,
// /{store}/products/\d+ 패턴 참고 - 둘 다 순수 상품 id 경로일 뿐 카테고리 세그먼트가
// 없음). "검증 없이 과도하게 추정하지 않는다"는 원칙(설계서 10절)에 따라 이 신호는
// 지금은 항상 매치되지 않습니다 - 카테고리 경로를 실제로 갖는 사이트가 지원 대상에
// 추가되면 이 함수 안에서만 확장합니다.
function urlCategorySignal(_input: ProductCategoryClassificationInput): CategoryRule | null {
  return null;
}

// 보수적인 productName 키워드 매칭. 브랜드명/판매자명만으로 상품군을 확정하지
// 않습니다(설계서 11절 금지 항목) - productName 원문에 등록된 키워드가 그대로
// 포함될 때만 매치합니다.
function titleKeywordSignal(productName: string): CategoryRule[] {
  const normalized = productName.toUpperCase();
  const matched: CategoryRule[] = [];
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => normalized.includes(kw.toUpperCase()))) {
      matched.push(rule);
    }
  }
  return matched;
}

export function classifyProductCategory(input: ProductCategoryClassificationInput): ProductCategoryClassification {
  const urlMatch = urlCategorySignal(input);
  if (urlMatch) {
    return ruleToClassification(urlMatch, "url_pattern", URL_SIGNAL_CONFIDENCE);
  }

  const productName = typeof input?.productName === "string" ? input.productName.trim() : "";
  if (!productName) return unknownResult(["no_deterministic_category_signal"]);

  const titleMatches = titleKeywordSignal(productName);
  if (titleMatches.length === 0) return unknownResult(["no_deterministic_category_signal"]);

  // 두 개 이상의 서로 다른 category가 동시에 매치되면(비정상 충돌) 강제로 하나를
  // 고르지 않습니다 - 잘못된 고신뢰 분류보다 unknown이 낫습니다(설계서 15절).
  const distinctCategoryKeys = new Set(titleMatches.map((r) => r.categoryKey));
  if (distinctCategoryKeys.size > 1) return unknownResult(["conflicting_signals"]);

  return ruleToClassification(titleMatches[0], "product_name_heuristic", PRODUCT_NAME_HEURISTIC_CONFIDENCE);
}
