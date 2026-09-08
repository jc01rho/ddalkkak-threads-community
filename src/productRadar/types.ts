// src/productRadar/types.ts
// 상품 레이더 전용 타입 정의. 이 파일은 값을 계산하지 않고 구조만 정의합니다.
// MVP1-1에서 실제로 쓰이는 것은 ProductRadarProduct/ProductRadarProductManualInput뿐이며,
// 나머지(이미지/비교/미디어/업로드/확장 토큰)는 이후 MVP(1-2~2)에서 값이 채워지기 시작합니다.
// docs/design/product-radar-v1-final-design.md 12.1절·36.3절과 1:1 대응합니다.
//
// Phase 11.3: FactualComparisonEvidence(comparisonEvidence.ts)/NormalizedMeasurement
// (unitNormalization.ts) 타입만 import합니다 - 계산 로직은 그 두 파일에 그대로 남아
// 있고, 이 파일은 여전히 값을 계산하지 않습니다(파일 상단 원칙 그대로).

import { FactualComparisonEvidence } from "./comparisonEvidence";
import { NormalizedMeasurement } from "./unitNormalization";

export type ProductRadarSiteId = "coupang" | "smartstore" | "brandstore" | "brandconnect" | "generic" | "manual";
export type ProductRadarRawSourceType = "site_adapter" | "json_ld" | "open_graph" | "generic_dom" | "user_input";
export type ProductRadarProductStatus = "active" | "excluded" | "archived";

export interface ProductRadarProduct {
  id: number;
  siteId: ProductRadarSiteId;
  adapterVersion: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  productExternalId: string | null;
  sellerName: string | null;
  productName: string;
  brand: string | null;
  modelName: string | null;
  optionName: string | null;
  category: string | null;
  price: number | null;
  originalPrice: number | null;
  // Phase 12.5.6D.4.2.6: 검증된 Naver 대표 가격 영역의 조건부 가격("최대할인가" 등). price를
  // 절대 덮어쓰지 않는 완전히 독립된 optional 필드 - 없을 때(smartstore 등)는 둘 다 null.
  conditionalPrice: number | null;
  conditionalPriceLabel: string | null;
  shippingFee: number | null;
  shippingType: string | null;
  shippingText: string | null;
  rating: number | null;
  reviewCount: number | null;
  features: string[];
  // Phase 12.5.6D.4: ProductRadarBrowser가 클릭 없이 background에서 자동 추출한 쿠팡 후기
  // aggregate 요약(리뷰 원문/작성자는 절대 포함하지 않음 - browserSave.ts validateReviewSummary
  // 참고). 아직 추출되지 않았거나 실패했으면 null.
  reviewSummary: ProductRadarReviewSummary | null;
  representativeImageId: number | null;
  rawSourceType: ProductRadarRawSourceType;
  userOverriddenFields: string[];
  status: ProductRadarProductStatus;
  // 쿠팡 파트너스 제휴링크. 저장 시점에 "이 상품의 링크가 맞다"고 1회 검증된 값만 들어온다
  // (productRadar/affiliateLink.ts). 검증 못 했으면 셋 다 null 이고 상품은 그대로 저장된다.
  affiliateUrl: string | null;
  affiliateProductId: string | null;
  affiliateVerifiedAt: string | null;
  firstCollectedAt: string;
  lastCheckedAt: string;
  createdAt: string;
  updatedAt: string;
}

// 상품 레이더 Phase 9.1: 비교 기반용 category 판정 결과 타입(값 계산은
// src/productRadar/category.ts, 이 파일은 구조만 정의 - 파일 상단 주석 원칙 그대로).
// docs/designs/product-radar-phase9-comparison-foundation-design.md 7절/16절 대응.
// 이 타입은 아직 product_radar_products 조회 결과(ProductRadarProduct)에도, save/update
// pipeline에도 연결되지 않았습니다 - classifyProductCategory()의 반환 타입일 뿐입니다.
export type ProductCategorySource = "url_pattern" | "product_name_heuristic" | "manual" | "unknown";

export interface ProductCategoryClassification {
  categoryLevel1: string | null;
  categoryLevel2: string | null;
  categoryLevel3: string | null;
  categoryKey: string | null;
  source: ProductCategorySource;
  confidence: number; // 0..1
  classificationVersion: number;
  reasons: string[];
}

// 확장프로그램이 보낼 원시 추출 결과(MVP1-3부터 실제로 사용). 페이지에서 확인되지 않은 값은
// null/빈 배열로 두고 추측하지 않습니다(설계서 11절 원칙).
export interface ProductRadarRawExtract {
  siteId: Exclude<ProductRadarSiteId, "manual">;
  adapterVersion: string;
  sourceUrl: string;
  canonicalUrl: string | null;
  productExternalId: string | null;
  sellerName: string | null;
  productName: string;
  brand: string | null;
  modelName: string | null;
  optionName: string | null;
  category: string | null;
  price: number | null;
  originalPrice: number | null;
  shippingFee: number | null;
  shippingType: string | null;
  shippingText: string | null;
  rating: number | null;
  reviewCount: number | null;
  features: string[];
  representativeImageUrl: string | null;
  additionalImageUrls: string[];
  rawSourceType: ProductRadarRawSourceType;
  collectedAtClientIso: string;
}

// ProductRadarBrowser Phase 5가 보내는 저장
// 요청 원본 그대로의 형태. ProductRadarRawExtract와 필드 의미는 같지만 브라우저 확장프로그램이
// 아직 채우지 않는 필드(features/additionalImageUrls)는 없고, 대신 클라이언트 세션·중복 클릭
// 방지 식별자(saveJobId/pageSessionId/analysisRevision)가 추가로 붙습니다. 서버는 이 값을
// 그대로 신뢰하지 않고 다시 검증합니다(src/productRadar/browserSave.ts).
//
// Phase 12.5.6D.2.1: brand/modelName/category/rating/reviewCount를 optional로 추가합니다
// (구버전 C# 클라이언트는 이 키 자체를 아예 보내지 않음 - `?`로 undefined를 허용해 하위
// 호환을 유지합니다. null은 "이번에 확인 안 됨", undefined는 "구버전 client"로 서버가 동일하게
// 처리합니다 - browserSave.ts 참고).
export interface ProductRadarBrowserSaveRequest {
  saveJobId: string;
  pageSessionId: string;
  analysisRevision: number;
  capturedAtUtc: string;
  siteId: string;
  currentUrl: string;
  canonicalUrl: string | null;
  productExternalId: string | null;
  productName: string;
  price: number | null;
  originalPrice: number | null;
  // Phase 12.5.6D.4.2.6: 구버전 client는 이 키를 보내지 않는다(undefined) - optional로 하위
  // 호환 유지. 서버는 이 값을 그대로 신뢰하지 않고 다시 검증한다(browserSave.ts).
  conditionalPrice?: number | null;
  conditionalPriceLabel?: string | null;
  representativeImageUrl: string | null;
  sellerName: string | null;
  optionName: string | null;
  shippingFee: number | null;
  shippingType: string | null;
  shippingText: string | null;
  brand?: string | null;
  modelName?: string | null;
  category?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  // Phase 12.5.6D.4: 구버전 client는 이 키 자체를 보내지 않는다(undefined) - optional로 하위
  // 호환을 유지한다. 서버는 이 값을 그대로 신뢰하지 않고 다시 검증한다(browserSave.ts
  // validateReviewSummary).
  reviewSummary?: ProductRadarReviewSummary | null;
  adapterVersion: string;
  extractionSuccessFields: string[];
  extractionMissingFields: string[];
  rawSourceType: string;
  rawMinimalSource: string | null;
}

// Phase 12.5.6D.4: 쿠팡이 이미 렌더링해 둔 후기 aggregate 요약(개별 리뷰 원문/작성자/날짜/
// 이미지 등은 이 타입에 애초에 존재하지 않는다 - contract 자체가 그런 필드를 표현할 수
// 없다, 요청서 12·18절). 원본 비율을 그대로 보존한다(합이 rounding으로 99/101이어도 강제
// 재정규화하지 않음, 요청서 8절).
export interface ProductRadarReviewOverallDistribution {
  excellent: number;
  good: number;
  neutral: number;
  poor: number;
  bad: number;
}

export interface ProductRadarReviewAttributeSummary {
  name: string;
  label: string;
  ratio: number;
}

// Phase 12.5.6D.4.2.1: 네이버는 5점~1점 "건수"(count)로 분포를 보여준다 - 쿠팡의 percentage
// 기반 overall과는 다른 개념이라 별도 타입으로 둔다(요청서 6·26절 - count를 percentage로
// 억지 변환하지 않는다).
export interface ProductRadarReviewRatingDistribution {
  five: number;
  four: number;
  three: number;
  two: number;
  one: number;
}

// Phase 12.5.6D.4.2.1: source가 없는 legacy row(D.4 시절 저장, overall이 항상 필수였던
// 시기)는 여전히 쿠팡으로 취급한다(요청서 7절 backward compatibility) - overall이 optional로
// 바뀐 것은 네이버(overall 없음, 대신 아래 네이버 전용 필드)를 표현하기 위해서다.
export interface ProductRadarReviewSummary {
  source?: "coupang" | "naver" | null;
  overall?: ProductRadarReviewOverallDistribution | null;
  attributes: ProductRadarReviewAttributeSummary[];
  averageRating?: number | null;
  recentAverageRating?: number | null;
  totalReviewCount?: number | null;
  ratingDistribution?: ProductRadarReviewRatingDistribution | null;
  aiSummaryTags?: string[];
}

export type ProductRadarBrowserSaveMatchedBy = "canonicalUrl" | "siteIdAndExternalId";

export interface ProductRadarBrowserSaveFieldDiff {
  field: string;
  existingValue: unknown;
  newValue: unknown;
}

// "상품 직접 등록" 폼 입력(MVP1-1에서 사용하는 유일한 입력 경로). siteId는 항상 "manual"로 고정됩니다.
export interface ProductRadarProductManualInput {
  productName: string;
  sourceUrl?: string;
  brand?: string;
  modelName?: string;
  optionName?: string;
  category?: string;
  price?: number;
  sellerName?: string;
}

// PATCH 요청 바디(부분 수정). 수정된 필드명은 서버가 userOverriddenFields에 누적 기록합니다.
export type ProductRadarProductPatch = Partial<ProductRadarProductManualInput>;

// 상품 레이더 Phase 9.2: Product Identity/Variation/Relation 판정 결과 타입(값 계산은
// src/productRadar/relation.ts, 이 파일은 구조만 정의 - 파일 상단 주석 원칙 그대로).
// docs/designs/product-radar-phase9-comparison-foundation-design.md 8~10절 대응.
// 아직 어떤 저장 조회 결과에도, save/update pipeline에도, DB 컬럼에도 연결되지 않았습니다 -
// compareProductRelation()의 입출력 타입일 뿐입니다.
export interface ProductIdentityFingerprint {
  categoryKey: string | null;
  identityTokens: string[]; // productName에서 variation 토큰을 제거하고 정규화한 토큰 집합(정렬됨)
}

export interface ProductVariationDimensionValue {
  value: number;
  unit: string;
}

export interface ProductVariationFingerprint {
  capacity: ProductVariationDimensionValue | null; // GB/TB
  quantity: ProductVariationDimensionValue | null; // 개/개입/팩/입
  volume: ProductVariationDimensionValue | null; // ml/L
  weight: ProductVariationDimensionValue | null; // g/kg
  optionName: string | null; // 정규화된 optionName 원문(명시적 variation), 없으면 null
}

export type ProductRelation = "EXACT" | "VARIANT" | "SIMILAR" | "UNRELATED" | "INDETERMINATE";

export interface ProductRelationResult {
  relation: ProductRelation;
  confidence: number; // 0..1, deterministic constant
  reasons: string[];
}

// relation 함수 입력. dedup(canonicalUrl/externalId)이나 sellerName만으로 identity를
// 확정하지 않는다는 원칙(설계서 8절/11절)에 따라, v1 판정 로직이 실제로 쓰는 필드만
// 담는다 - siteId/canonicalUrl/externalId/sellerName은 결정타로 쓰지 않으므로 여기 없음.
export interface ProductRelationInput {
  productName?: string | null;
  optionName?: string | null;
  categoryKey?: string | null;
}

// 상품 레이더 Phase 9.3: Comparison Compatibility 판정 결과 타입(값 계산은
// src/productRadar/compatibility.ts, 이 파일은 구조만 정의 - 파일 상단 주석 원칙 그대로).
// docs/designs/product-radar-phase9-comparison-foundation-design.md 11절 대응.
// Relation("두 상품이 어떤 관계인가")과 Compatibility("그 관계를 의미 있게 비교할 수
// 있는가")는 서로 다른 질문이다 - Compatibility는 Phase 9.2의 ProductRelationResult를
// 입력으로 받을 뿐, compareProductRelation()을 내부에서 다시 호출하지 않는다.
export type ProductComparisonCompatibility = "COMPARABLE" | "PARTIALLY_COMPARABLE" | "NOT_COMPARABLE" | "INSUFFICIENT_DATA";

export interface ProductComparisonCompatibilityResult {
  compatibility: ProductComparisonCompatibility;
  confidence: number; // 0..1, deterministic constant
  reasons: string[];
  comparableDimensions: string[]; // 양쪽 모두 값이 있어 실제로 비교 가능한 variation dimension
  missingDimensions: string[]; // 한쪽에만 값이 있어(asymmetric) 비교할 수 없는 variation dimension
}

// compatibility 함수 입력. relationResult는 상위 계층이 compareProductRelation()으로
// 미리 계산해서 넘긴다(11절 - category classifier·relation 재호출 금지). left/right는
// Phase 9.2와 동일한 구조화 evidence(ProductRelationInput)를 재사용한다.
export interface ProductComparisonCompatibilityInput {
  relationResult: ProductRelationResult;
  left?: ProductRelationInput | null;
  right?: ProductRelationInput | null;
}

// 상품 레이더 Phase 9.4: Immutable Comparison Snapshot 타입(값 계산은
// src/productRadar/comparisonSnapshot.ts, 이 파일은 구조만 정의 - 파일 상단 주석 원칙
// 그대로). docs/designs/product-radar-phase9-comparison-foundation-design.md 14절
// 대응. Snapshot builder는 category/relation/compatibility를 다시 계산하지
// 않는다 - 상위 계층이 이미 계산한 ProductRelationResult/ProductComparisonCompatibilityResult를
// 그대로 얼려서 기록할 뿐이다. productSnapshotId는 기존
// `product_radar_product_snapshots.id`(src/database.ts) 구조를 그대로 재사용한다 -
// 새 ID 형식을 발명하지 않는다.
export interface ComparisonSnapshotProductRef {
  productId: number;
  productSnapshotId: number; // 그 순간 참조한 product_radar_product_snapshots.id
  capturedAt: string;
}

// 두 상품 사이의 판정 결과 기록. relation/compatibility는 Phase 9.2/9.3이 이미 계산한
// 결과를 그대로 담을 뿐, 여기서 재해석하지 않는다. productSnapshotIdA/B는 그 relation/
// compatibility를 실제로 계산할 때 사용한 정확한 snapshot을 명시한다 - productRefs가
// 가리키는 snapshot과 다르면(검수 보정, 예: productId는 같은데 더 오래된/다른
// snapshot으로 계산된 결과) builder가 거부한다(comparisonSnapshot.ts 참고).
export interface ComparisonSnapshotPairResult {
  productIdA: number;
  productIdB: number;
  productSnapshotIdA: number;
  productSnapshotIdB: number;
  relation: ProductRelationResult;
  compatibility: ProductComparisonCompatibilityResult;
}

// 상품 레이더 Phase 11.3: variation의 capacity/quantity/volume/weight 4-slot 구조를
// 그대로 mirror하는 snapshot-specific bundle(unitNormalization.ts의
// normalizeMeasurement() 결과를 얼려 담는 그릇일 뿐, 계산은 하지 않는다 - 이 파일 원칙
// 그대로). MeasurementDimension 기준 5-key 구조로 만들지 않는다 - variation.quantity
// 하나가 item_count/pack_count 중 무엇으로 정규화될지는 데이터에 따라 달라지므로,
// dimension이 아니라 원본 variation slot 이름을 key로 삼아야 자연스럽다.
export interface NormalizedMeasurements {
  capacity: NormalizedMeasurement | null;
  quantity: NormalizedMeasurement | null;
  volume: NormalizedMeasurement | null;
  weight: NormalizedMeasurement | null;
}

// 비교 시점에 사용한 원본 evidence(data provenance) - relation/compatibility의
// reasons(decision provenance)만으로는 "실제 비교 당시 값이 무엇이었는지" 복원할 수
// 없으므로(검수 보정) categoryKey/identity/variation 원본을 그대로 함께 얼린다.
// Phase 9.2 extractIdentityFingerprint()/extractVariationFingerprint()가 이미 계산한
// 값을 호출자가 그대로 넘길 뿐 - builder는 이 값을 재계산하지 않는다. productSnapshotId는
// 이 evidence가 "현재 product row"가 아니라 productRefs가 고정한 정확한
// product_radar_product_snapshots 행에서 계산됐음을 구조적으로 보장한다(최종 불변식
// 보정 2건) - productId가 같아도 productSnapshotId가 다르면 builder가 거부한다.
//
// Phase 11.3: comparisonFields/normalizedMeasurements 추가. 둘 다 `T | null` - null은
// "이 evidence 없음"(구버전 snapshot의 legacy absence 포함)을 뜻하고, 새로 생성되는
// snapshot에서는 항상 object(내부 개별 field/slot이 null일지언정 object 자체는 항상
// 존재)다. price/originalPrice/shippingFee는 이미 comparisonEvidence.ts가, unit
// normalization은 이미 unitNormalization.ts가 계산했으므로 여기서는 그 결과를 얼려
// 담을 뿐 재계산하지 않는다(comparisonOrchestration.ts 참고).
//
// Phase 12.5.2.2.1: displayLabel 추가 - 사람이 읽는 상품명(frozen). source-of-truth는
// product_radar_product_snapshots.snapshot_json이고(Phase 12.5.2.2.0 survey 15절 결론),
// 이 필드는 정확히 그 productSnapshotId 행에서 그대로 복사된 값이다 - live
// product_radar_products.product_name을 직접 읽지 않는다(comparisonOrchestration.ts
// 참고). identityTokens(정규화/토큰화/정렬된 fingerprint)와 다르다 - displayLabel은
// 원래 어순/대소문자를 보존한 사람이 읽는 문자열이다. `string | null` - null은
// "구버전 snapshot에 이 값이 없음(legacy absence)" 또는 "저장 당시 상품명이 없었음"을
// 뜻하며, 새로 생성되는 snapshot에서도 이 key 자체는 항상 존재한다(값이 null일
// 뿐이다) - comparisonFields/normalizedMeasurements와 동일한 legacy-vs-corrupt 철학.
export interface ComparisonSnapshotProductEvidence {
  productId: number;
  productSnapshotId: number;
  displayLabel: string | null;
  // 상품 레이더 Phase 12.5.3.1: 이 exact productSnapshotId가 가리키는 ProductSnapshot
  // capture 시점에 기록된 대표 이미지 reference URL(displayLabel과 동일한 same-row
  // freeze 원칙) - image bytes가 아니라 URL reference일 뿐이다("frozen representative
  // image reference" ≠ "frozen image bytes", 원격 이미지는 이후 만료/삭제/교체될 수
  // 있다). live product row/product_radar_images 재조회 없음.
  representativeImageUrl: string | null;
  categoryKey: string | null;
  identity: ProductIdentityFingerprint;
  variation: ProductVariationFingerprint;
  comparisonFields: FactualComparisonEvidence | null;
  normalizedMeasurements: NormalizedMeasurements | null;
}

// builder 입력. id/compareGroupId/revision/createdAt은 호출자가 제공한다 - builder
// 내부에서 Date.now/random으로 만들지 않는다(설계서 13절 Determinism). productEvidence는
// 필수다(최종 불변식 보정 1건) - Comparison Snapshot은 data provenance 없이 생성될 수
// 없으므로, 이 타입은 아직 Persistence/API에 공개되지 않은 Phase 9.4 신규 domain으로서
// 불필요한 하위 호환을 유지하지 않는다. productRefs 각각에 정확히 하나씩 있어야 한다
// (누락/중복/대상 외 extra 전부 금지, comparisonSnapshot.ts 참고).
export interface ComparisonSnapshotInput {
  id: number;
  compareGroupId: number; // 기존 product_radar_compare_groups FK
  revision: number; // 그룹 내 1부터 증가, 호출자가 계산해서 넘김
  createdAt: string;
  infoAsOf: string; // 비교에 포함된 상품 중 가장 오래된 last_checked_at, 호출자가 계산
  productRefs: ComparisonSnapshotProductRef[];
  pairs: ComparisonSnapshotPairResult[];
  productEvidence: ComparisonSnapshotProductEvidence[];
}

// builder 출력. 생성 후 절대 바뀌지 않는다(설계서 14절 "INSERT-only") - 최상위
// 필드뿐 아니라 productRefs/pairs/productEvidence와 그 내부 relation/compatibility/
// identity/variation 객체까지 전부 deep-freeze한다(comparisonSnapshot.ts의 deepFreeze
// 참고).
export interface ComparisonSnapshot {
  readonly id: number;
  readonly compareGroupId: number;
  readonly revision: number;
  readonly createdAt: string;
  readonly infoAsOf: string;
  readonly productRefs: readonly ComparisonSnapshotProductRef[];
  readonly pairs: readonly ComparisonSnapshotPairResult[];
  readonly productEvidence: readonly ComparisonSnapshotProductEvidence[];
}

// 실패해도 throw하지 않는다(relation.ts/compatibility.ts와 동일한 스타일) - stable
// reason code만 담은 errors로 실패 사유를 알린다.
export interface ComparisonSnapshotBuildResult {
  ok: boolean;
  snapshot: ComparisonSnapshot | null;
  errors: string[];
}

export interface ProductRadarImage {
  id: number;
  productId: number;
  role: "representative" | "additional";
  sourceUrl: string;
  localFilename: string | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  isUserUploaded: boolean;
  excluded: boolean;
  createdAt: string;
}

export type ProductRadarCompareType =
  | "same_category"
  | "alternative_use"
  | "same_product_seller"
  | "price_shipping"
  | "tier"
  | "audience";

export type ProductRadarCompareGroupStatus = "draft" | "analyzed" | "archived";

export interface ProductRadarCompareGroup {
  id: number;
  compareType: ProductRadarCompareType;
  title: string | null;
  status: ProductRadarCompareGroupStatus;
  analysisJson: string | null;
  infoAsOf: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductRadarCompareItem {
  id: number;
  compareGroupId: number;
  productId: number;
  sortOrder: number;
  analysisJson: string | null;
  createdAt: string;
}

// Phase 12.5.3.9: "animation"(무음 GIF)을 추가한다 - "video"는 Phase 12.5.3.2부터 이미
// 존재했던 값(그때는 generation 자체가 없어 미사용)이었고, 이번 Phase가 처음으로 실제로
// video/animation job을 만든다.
export type ProductRadarMediaType = "card" | "carousel" | "video" | "animation";

// 33.1절 상태 머신 전체(MVP2부터 실제로 전이가 일어남).
export type ProductRadarMediaJobStatus =
  | "pending"
  | "preparing"
  | "rendering"
  | "rendered"
  | "preview_ready"
  | "approved"
  | "upload_pending"
  | "uploading"
  | "ready_to_publish"
  | "published"
  | "failed"
  | "excluded";

// 33.2절 실패 사유 전체.
export type ProductRadarMediaFailureReason =
  | "product_data_missing"
  | "image_missing"
  | "image_download_failed"
  | "image_too_small"
  | "image_invalid"
  | "image_duplicate"
  | "template_data_missing"
  | "text_overflow"
  | "card_render_failed"
  | "carousel_render_failed"
  | "video_render_failed"
  | "animation_render_failed" // Phase 12.5.3.9: GIF 인코딩 실패(video_render_failed와 별개 값 - MP4/GIF 실패를 구분해서 기록)
  | "ffmpeg_unavailable" // Phase 12.5.3.9: h264_mf encoder preflight 실패(Windows N/KN Media Feature Pack 미설치 등) - FFmpeg 내부 에러를 그대로 노출하지 않기 위한 stable 사유
  | "source_media_missing" // Phase 12.5.3.9: sourceMediaJobId가 가리키는 원본 PNG가 디스크에 없음(known limitation과 동일한 missing-file 계열)
  | "thumbnail_failed"
  | "manifest_failed"
  | "disk_space_low"
  | "local_save_failed"
  | "upload_failed"
  | "temporary_url_expired"
  | "publish_failed"
  | "cleanup_failed";

export interface ProductRadarMediaJob {
  id: number;
  compareGroupId: number | null;
  productId: number | null;
  // 상품 레이더 Phase 12.5.3.2: 이 job이 어느 정확한 RecommendationSnapshot의 strengths/
  // cautions를 소비했는지 historical lineage. compare_group_id만으로는 같은 group 안의
  // 여러 recommendation revision을 구분할 수 없어 별도 FK로 둔다. comparisonSnapshotId는
  // 여기 중복 저장하지 않는다 - recommendation row에서 파생 가능하다.
  recommendationSnapshotId: number | null;
  mediaType: ProductRadarMediaType;
  templateId: string;
  templateVersion: string;
  status: ProductRadarMediaJobStatus;
  failureReason: ProductRadarMediaFailureReason | null;
  draftId: number | null;
  manifestPath: string | null;
  // Phase 12.5.3.9: 이 job이 video/animation이면, 어느 정확한 rendered card/carousel job의
  // PNG를 motion source로 썼는지 provenance. card/carousel job 자신은 항상 null(자기 자신이
  // source의 시작점이므로) - recommendationSnapshotId와 동일한 "historical lineage, FK 아님"
  // 성격(그 job이 나중에 지워져도 이 컬럼 값 자체는 남는다, 요청서 13·14절).
  sourceMediaJobId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type ProductRadarMediaFileRole = "card" | "slide" | "video" | "animation" | "thumbnail";

export interface ProductRadarMediaFile {
  id: number;
  mediaJobId: number;
  role: ProductRadarMediaFileRole;
  slideIndex: number | null;
  filename: string;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  retentionPinned: boolean;
  createdAt: string;
}

export type ProductRadarUploadStatus = "uploaded" | "published" | "expired" | "deleted";

export interface ProductRadarUpload {
  id: number;
  mediaJobId: number;
  gatewayUploadId: string;
  publicUrl: string;
  status: ProductRadarUploadStatus;
  expiresAt: string;
  extendedCount: number;
  createdAt: string;
}

export interface ProductRadarExtensionToken {
  id: number;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
}

// 상품 레이더 Phase 12.4.1: Recommendation 생성 자연어 출력 언어. 원래 Phase 12.3에서
// recommendationClaude.ts(Claude invocation 전용 파일)에 정의됐으나, recommendationPersistence.ts가
// 이 값을 저장 메타데이터로 다뤄야 하면서 Claude invocation 모듈을 import할 수 없다는
// 문제가 생겼다(Persistence는 Claude를 몰라야 한다 - 요청서 17절). 이 파일(types.ts)은
// "구조만 정의하고 계산하지 않는다"는 원칙을 갖는 neutral 위치라 여기로 옮긴다.
// recommendationClaude.ts는 이 타입을 그대로 re-export해 외부에서 관찰 가능한 union은
// 계속 정확히 "ko" | "en"으로 유지된다(중복 선언 없음).
export type RecommendationOutputLanguage = "ko" | "en";
