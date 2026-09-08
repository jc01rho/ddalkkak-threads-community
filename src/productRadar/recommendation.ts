// src/productRadar/recommendation.ts
// 상품 레이더 Phase 9.9: Recommendation Foundation.
// docs/designs/product-radar-phase9-comparison-foundation-design.md 26절
// ("Recommendation은 ComparisonSnapshot을 입력으로만 받는다 - Comparison 내부에 추천
// 로직을 섞지 않는다") 대응.
//
// buildRecommendationResult()는 "판단 엔진"이 아니라 comparisonSnapshot.ts와 같은
// "기록 계층"이다 - strengths/cautions 문장을 스스로 만들지 않는다(generation !=
// foundation, 요청서 7절). caller(미래의 comparison_engine/Claude/manual override)가
// 이미 만든 해석을 받아 검증(unknown productId/중복/unknown field/provenance) →
// canonicalize(snapshot 순서) → deep freeze만 한다.
//
// 순수 domain layer - database.ts를 import하지 않는다(live product 재조회 금지, 요청서
// 13절), classifyProductCategory()/compareProductRelation()/
// compareProductComparisonCompatibility()/findProductRadarComparisonCandidates()도
// 재호출하지 않는다(요청서 14절) - Recommendation은 이미 얼어 있는 ComparisonSnapshot의
// 상위 계층일 뿐이다. Claude 호출도 없다(요청서 20절).

import { ComparisonSnapshot } from "./types";
import { buildRecommendationEvidencePayload, RecommendationEvidenceProduct } from "./recommendationEvidence";
import { areMeasurementsComparable, areUnitPricesComparable, NormalizedMeasurement, UnitPriceResult } from "./unitNormalization";

export type RecommendationProvenance = "comparison_engine" | "claude_inference" | "manual_override";

const RECOMMENDATION_PROVENANCE_VALUES: ReadonlySet<string> = new Set<RecommendationProvenance>([
  "comparison_engine",
  "claude_inference",
  "manual_override",
]);

// Phase 12.2: evidenceFields 추가 - 이 statement가 근거로 삼은 RecommendationEvidencePayload의
// canonical field path 목록이다("products.<id>.comparisonFields.price" 등, recommendation.ts
// 하단 evidence path validator 참고). legacy statement(Phase 12.2 이전에 만들어진 것)는
// 이 key 자체가 없었으므로 canonical hydration에서는 항상 key가 존재하되(빈 배열 허용) -
// 값이 없다는 뜻은 null이 아니라 빈 배열이다(배열의 자연스러운 "없음" 표현, 요청서 3절).
export interface RecommendationStatement {
  text: string;
  provenance: RecommendationProvenance;
  evidenceFields: readonly string[];
}

export interface RecommendationProductResult {
  productId: number;
  strengths: RecommendationStatement[];
  cautions: RecommendationStatement[];
}

export interface RecommendationMissingInformation {
  productId: number;
  field: string;
  reason: string;
}

// metadata(comparisonSnapshotId/compareGroupId/comparisonRevision/infoAsOf)는 전부
// ComparisonSnapshot에서 builder가 직접 파생한다 - caller input에는 이 필드 자체가
// 존재하지 않는다(요청서 4절/12절, top-level 허용 key에 없음).
export interface RecommendationResult {
  comparisonSnapshotId: number;
  compareGroupId: number;
  comparisonRevision: number;
  infoAsOf: string;
  products: RecommendationProductResult[];
  missingInformation: RecommendationMissingInformation[];
}

export type RecommendationBuildResult =
  | { ok: true; recommendation: RecommendationResult; errors: [] }
  | { ok: false; recommendation: null; errors: string[] };

// 의도적으로 만들지 않는 필드(요청서 6절): winner/rank/score/bestProductId/globalWinner/
// useCaseRecommendations/finalRecommendation/recommendedFor/useCases/*Score/가성비·편의성·
// 휴대성·설치부담·관리부담 평가 - 현재 ComparisonSnapshot에 이를 근거 있게 만들
// factual input(price/features)이 없다. 자리도 미리 만들지 않는다(9.8 조사 보고 32절).
const TOP_LEVEL_ALLOWED_KEYS: ReadonlySet<string> = new Set(["products", "missingInformation"]);
const PRODUCT_ALLOWED_KEYS: ReadonlySet<string> = new Set(["productId", "strengths", "cautions"]);
const STATEMENT_ALLOWED_KEYS: ReadonlySet<string> = new Set(["text", "provenance", "evidenceFields"]);
const MISSING_INFO_ALLOWED_KEYS: ReadonlySet<string> = new Set(["productId", "field", "reason"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isPositiveSafeInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Object.keys()는 own enumerable property만 본다(prototype chain 없음) - 이 결과를
// 그대로 output 조립에 쓰지 않고 허용된 key만 명시적으로 읽으므로(아래
// checkStatement/checkProduct/checkMissingInfo) prototype/property injection이
// output으로 흘러들 경로가 없다(요청서 11절).
function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key));
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// Phase 11.1 pre-commit 검수에서 발견된 결함(`key in obj`/직접 property read가 prototype
// chain을 따라가 own property가 없어도 검증을 통과하던 문제)을 이 파일에서도 처음부터
// 반복하지 않는다 - evidenceFields key 존재 확인(legacy vs 명시적 빈 배열 구분)에 own
// property만 인정한다.
function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ==================================================================================
// Phase 12.2: evidence path validator.
//
// evidenceFields의 semantic validation(경로가 실제로 존재하는가/null이 아닌가/
// cross-product 비교 가능한가)은 live DB를 전혀 쓰지 않는다 - buildRecommendationResult()가
// 이미 받은 ComparisonSnapshot에서 순수하게 buildRecommendationEvidencePayload()를
// 다시 만들어 그 payload를 authoritative evidence source로 쓴다(요청서 5절). unitPrices는
// ComparisonSnapshot에 저장되지 않고 payload에서 결정론적으로 파생되므로, snapshot raw
// object만 봐서는 unitPrices path를 검증할 수 없다 - 반드시 payload를 거쳐야 한다.
//
// path parser는 generic object traversal(path.split(".")로 얻은 segment를 그대로
// obj[segment]에 넣는 방식)을 쓰지 않는다(요청서 7절) - 각 segment를 고정된 리터럴
// 집합/정규식과만 비교하고, 그 비교 결과로 만든 명시적 switch로 카테고리를 판정한다.
// 이 방식에서는 "__proto__"/"constructor"/"prototype" 같은 segment도 다른 인식되지
// 않는 문자열과 완전히 동일하게 "일치하는 항목 없음"으로 자연스럽게 거부된다 - property
// injection 경로 자체가 구조적으로 없다.
// ==================================================================================

// Phase 12.5.6D.5.1: conditionalPrice/conditionalPriceLabel을 comparisonFields의 인용
// 가능한 leaf에 추가했다(comparisonEvidence.ts의 FactualComparisonEvidence 확장과 대응).
// Phase 12.5.6D.5.2: shippingType/shippingText도 동일하게 추가했다.
// Phase 12.5.6D.5.3: rating/reviewCount도 동일하게 추가했다. 이 여섯 leaf 전부
// normalizedMeasurements/unitPrices와 달리 cross-product comparability gate 대상이
// 아니다(price/originalPrice/shippingFee와 동일 - checkEvidenceFields의 comparability
// gate는 "kind"로만 분기하고 comparisonFields kind는 애초에 그 배열에 모으지 않는다,
// 아래 checkEvidenceFields 참고) - 별도 게이트 로직을 새로 만들지 않는다. rating이
// 숫자라고 해서 unitPrices처럼 "비교 가능성"을 검증하지 않는다 - 단순 factual 인용
// 여부(null 아님)만 확인한다(요청서 D.5.3 10절 - 단순 숫자라는 이유만으로 monetary/unit
// comparison gate에 억지로 넣지 않는다).
type EvidencePathKind =
  | { readonly kind: "categoryKey"; readonly productId: number }
  | { readonly kind: "optionName"; readonly productId: number }
  | {
      readonly kind: "comparisonFields";
      readonly productId: number;
      readonly field:
        | "price"
        | "originalPrice"
        | "conditionalPrice"
        | "conditionalPriceLabel"
        | "shippingFee"
        | "shippingType"
        | "shippingText"
        | "rating"
        | "reviewCount";
    }
  | { readonly kind: "normalizedMeasurements"; readonly productId: number; readonly slot: "capacity" | "quantity" | "volume" | "weight" }
  | { readonly kind: "unitPrices"; readonly productId: number; readonly slot: "capacity" | "quantity" | "volume" | "weight" };

const COMPARISON_FIELDS_LEAVES: ReadonlySet<string> = new Set([
  "price",
  "originalPrice",
  "conditionalPrice",
  "conditionalPriceLabel",
  "shippingFee",
  "shippingType",
  "shippingText",
  "rating",
  "reviewCount",
]);
const MEASUREMENT_SLOT_LEAVES: ReadonlySet<string> = new Set(["capacity", "quantity", "volume", "weight"]);
// productId segment: 앞자리 0 없는 순수 양의 정수 문자열만(comparisons.ts의
// parsePositiveIntParam()과 동일 원칙 - 부호/소수점/문자 전부 거부).
const PRODUCT_ID_SEGMENT_RE = /^[1-9]\d*$/;

// Phase 12.5.2.1 최종 audit: Threads Copy(threadsCopy.ts)가 evidenceFields의 path 문법과
// productId/null 존재 여부만 재사용할 수 있도록 export를 추가한다(behavior 변경 없음,
// 가시성만 변경). cross-product comparability gate(checkEvidenceFields 하단)는 export하지
// 않는다 - Threads Copy는 그 검증까지 복제할 필요가 없다(불필요한 Recommendation 생성
// 전용 검증 복제 금지 원칙).
export function parseEvidencePath(path: string): EvidencePathKind | null {
  const segments = path.split(".");
  if (segments.length !== 3 && segments.length !== 4) return null;
  if (segments[0] !== "products") return null;

  const idSegment = segments[1];
  if (!PRODUCT_ID_SEGMENT_RE.test(idSegment)) return null;
  const productId = Number(idSegment);
  // 9007199254740993류 - 자릿수는 regex를 통과해도 Number() 변환에서 정밀도가 깨질 수
  // 있다(comparisons.ts parsePositiveIntParam()과 동일 방어) - 원문 문자열로 되돌려
  // 정확히 같은지 재확인한다.
  if (!Number.isSafeInteger(productId) || productId <= 0 || String(productId) !== idSegment) return null;

  if (segments.length === 3) {
    const leaf = segments[2];
    if (leaf === "categoryKey") return { kind: "categoryKey", productId };
    if (leaf === "optionName") return { kind: "optionName", productId };
    return null;
  }

  const group = segments[2];
  const leaf = segments[3];
  if (leaf.length === 0) return null;
  if (group === "comparisonFields") {
    if (!COMPARISON_FIELDS_LEAVES.has(leaf)) return null;
    return {
      kind: "comparisonFields",
      productId,
      field: leaf as
        | "price"
        | "originalPrice"
        | "conditionalPrice"
        | "conditionalPriceLabel"
        | "shippingFee"
        | "shippingType"
        | "shippingText"
        | "rating"
        | "reviewCount",
    };
  }
  if (group === "normalizedMeasurements") {
    if (!MEASUREMENT_SLOT_LEAVES.has(leaf)) return null;
    return { kind: "normalizedMeasurements", productId, slot: leaf as "capacity" | "quantity" | "volume" | "weight" };
  }
  if (group === "unitPrices") {
    if (!MEASUREMENT_SLOT_LEAVES.has(leaf)) return null;
    return { kind: "unitPrices", productId, slot: leaf as "capacity" | "quantity" | "volume" | "weight" };
  }
  return null;
}

// RecommendationEvidencePayload를 한 번 순회해 "이 canonical path가 실제로 존재하고
// null이 아닌가"를 O(1)로 답할 수 있는 색인을 만든다. normalizedMeasurements/unitPrices
// 두 evidence family는 서로 다른 Map으로 분리해 둔다 - cross-product comparability gate가
// 두 family를 절대 섞어서 비교하지 않기 때문이다(요청서 13절).
interface EvidencePathIndex {
  readonly productIds: ReadonlySet<number>;
  readonly validNonNullPaths: ReadonlySet<string>;
  readonly normalizedMeasurementByPath: ReadonlyMap<string, NormalizedMeasurement>;
  readonly unitPriceByPath: ReadonlyMap<string, UnitPriceResult>;
}

export function buildEvidencePathIndex(products: readonly RecommendationEvidenceProduct[]): EvidencePathIndex {
  const productIds = new Set<number>();
  const validNonNullPaths = new Set<string>();
  const normalizedMeasurementByPath = new Map<string, NormalizedMeasurement>();
  const unitPriceByPath = new Map<string, UnitPriceResult>();

  for (const product of products) {
    const id = product.productId;
    productIds.add(id);
    if (product.categoryKey !== null) validNonNullPaths.add(`products.${id}.categoryKey`);
    if (product.optionName !== null) validNonNullPaths.add(`products.${id}.optionName`);
    if (product.comparisonFields !== null) {
      for (const field of [
        "price",
        "originalPrice",
        "conditionalPrice",
        "conditionalPriceLabel",
        "shippingFee",
        "shippingType",
        "shippingText",
        "rating",
        "reviewCount",
      ] as const) {
        if (product.comparisonFields[field] !== null) validNonNullPaths.add(`products.${id}.comparisonFields.${field}`);
      }
    }
    if (product.normalizedMeasurements !== null) {
      for (const slot of ["capacity", "quantity", "volume", "weight"] as const) {
        const measurement = product.normalizedMeasurements[slot];
        if (measurement !== null) {
          const path = `products.${id}.normalizedMeasurements.${slot}`;
          validNonNullPaths.add(path);
          normalizedMeasurementByPath.set(path, measurement);
        }
      }
    }
    if (product.unitPrices !== null) {
      for (const slot of ["capacity", "quantity", "volume", "weight"] as const) {
        const unitPrice = product.unitPrices[slot];
        if (unitPrice !== null) {
          const path = `products.${id}.unitPrices.${slot}`;
          validNonNullPaths.add(path);
          unitPriceByPath.set(path, unitPrice);
        }
      }
    }
  }

  return { productIds, validNonNullPaths, normalizedMeasurementByPath, unitPriceByPath };
}

type EvidenceFieldsCheck = { ok: true; paths: string[] } | { ok: false; codes: string[] };

// evidenceFields 검사(요청서 4·9·10·11절):
// - key 자체가 없으면(raw === undefined) legacy로 인정 - canonical []. 이 경로에서는
//   comparability gate/개수 최소치도 적용하지 않는다(legacy row에는 애초에 이 필드가
//   없었으므로 검사할 대상이 없다).
// - 존재하면 배열이어야 하고, 각 원소는 앞뒤 공백 없는 비어있지 않은 문자열이어야
//   한다(trim 후 달라지는 문자열은 자동 보정하지 않고 거부, 요청서 10절).
// - 같은 statement 안에서 완전히 같은 path 문자열이 두 번 나오면 거부(자동 dedupe
//   금지, 요청서 11절).
// - 문법적으로 유효한 canonical path라도 payload에 존재하지 않거나(다른 snapshot/
//   productId) null이면 거부 - "왜" 거부됐는지는 unknown과 null을 구분해 stable
//   reason code로 남긴다.
// - 마지막으로 cross-product comparability gate(요청서 13~17절)를 적용한다.
function checkEvidenceFields(raw: unknown, index: EvidencePathIndex): EvidenceFieldsCheck {
  if (raw === undefined) return { ok: true, paths: [] };
  if (!Array.isArray(raw)) return { ok: false, codes: ["recommendation_evidence_fields_invalid"] };

  const codes: string[] = [];
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0 || item.trim().length === 0 || item !== item.trim()) {
      codes.push("recommendation_evidence_fields_invalid");
      continue;
    }
    if (seen.has(item)) {
      codes.push("recommendation_evidence_fields_invalid");
      continue;
    }
    seen.add(item);

    const parsed = parseEvidencePath(item);
    if (parsed === null || !index.productIds.has(parsed.productId)) {
      codes.push("recommendation_evidence_field_unknown");
      continue;
    }
    if (!index.validNonNullPaths.has(item)) {
      codes.push("recommendation_evidence_field_null");
      continue;
    }
    paths.push(item);
  }

  if (codes.length > 0) return { ok: false, codes: Array.from(new Set(codes)) };

  // cross-product comparability gate. family A(normalizedMeasurements)와 family
  // B(unitPrices)는 서로 직접 비교하지 않는다(요청서 13절/AT) - 별도 배열에 모아 각자
  // 안에서만 pairwise 비교한다. 같은 productId끼리는 gate 대상이 아니다(요청서 17절).
  const normalizedCites: Array<{ productId: number; measurement: NormalizedMeasurement }> = [];
  const unitPriceCites: Array<{ productId: number; unitPrice: UnitPriceResult }> = [];
  for (const path of paths) {
    const parsed = parseEvidencePath(path)!;
    if (parsed.kind === "normalizedMeasurements") {
      normalizedCites.push({ productId: parsed.productId, measurement: index.normalizedMeasurementByPath.get(path)! });
    } else if (parsed.kind === "unitPrices") {
      unitPriceCites.push({ productId: parsed.productId, unitPrice: index.unitPriceByPath.get(path)! });
    }
  }
  for (let i = 0; i < normalizedCites.length; i++) {
    for (let j = i + 1; j < normalizedCites.length; j++) {
      if (normalizedCites[i].productId === normalizedCites[j].productId) continue;
      if (!areMeasurementsComparable(normalizedCites[i].measurement, normalizedCites[j].measurement)) {
        return { ok: false, codes: ["recommendation_evidence_not_comparable"] };
      }
    }
  }
  for (let i = 0; i < unitPriceCites.length; i++) {
    for (let j = i + 1; j < unitPriceCites.length; j++) {
      if (unitPriceCites[i].productId === unitPriceCites[j].productId) continue;
      if (!areUnitPricesComparable(unitPriceCites[i].unitPrice, unitPriceCites[j].unitPrice)) {
        return { ok: false, codes: ["recommendation_evidence_not_comparable"] };
      }
    }
  }

  return { ok: true, paths };
}

type StatementCheck = { ok: true; statement: RecommendationStatement } | { ok: false; codes: string[] };

// Phase 12.2: evidenceFields key 자체가 없으면(legacy statement, hasOwn으로 확인 - `in`
// 연산자나 `raw.evidenceFields === undefined` 비교를 쓰지 않는다, Phase 11.1에서 발견된
// prototype inherited property 결함을 이 신규 로직에서 반복하지 않기 위해) checkEvidenceFields가
// undefined를 받아 canonical []로 처리한다(legacy hydration 허용). key가 있으면(빈
// 배열 포함) 그 값을 그대로 검사한다.
function checkStatement(raw: unknown, index: EvidencePathIndex): StatementCheck {
  if (!isPlainObject(raw)) return { ok: false, codes: ["recommendation_statement_invalid"] };
  const codes: string[] = [];
  if (!hasOnlyAllowedKeys(raw, STATEMENT_ALLOWED_KEYS)) codes.push("recommendation_unknown_field");
  if (!isNonEmptyString(raw.text)) codes.push("recommendation_statement_invalid");
  if (typeof raw.provenance !== "string" || !RECOMMENDATION_PROVENANCE_VALUES.has(raw.provenance)) {
    codes.push("recommendation_provenance_invalid");
  }
  const evidenceFieldsChecked = checkEvidenceFields(hasOwn(raw, "evidenceFields") ? raw.evidenceFields : undefined, index);
  if (!evidenceFieldsChecked.ok) codes.push(...evidenceFieldsChecked.codes);

  if (codes.length > 0 || !evidenceFieldsChecked.ok) return { ok: false, codes: Array.from(new Set(codes)) };
  return {
    ok: true,
    statement: {
      text: (raw.text as string).trim(),
      provenance: raw.provenance as RecommendationProvenance,
      evidenceFields: evidenceFieldsChecked.paths,
    },
  };
}

type StatementArrayCheck = { ok: true; statements: RecommendationStatement[] } | { ok: false; codes: string[] };

// strengths/cautions는 빈 배열을 허용한다(요청서 9절 - 정보 부족한 상품을 억지로
// 해석하지 않기 위해 "추천 문장 없음"을 정상 상태로 표현). 입력 순서는 그대로
// 보존한다(임의 sort 금지, 요청서 16절 - 문장 순서에 해석 의미가 있을 수 있음).
function checkStatementArray(raw: unknown, index: EvidencePathIndex): StatementArrayCheck {
  if (!Array.isArray(raw)) return { ok: false, codes: ["recommendation_statement_invalid"] };
  const codes: string[] = [];
  const statements: RecommendationStatement[] = [];
  for (const item of raw) {
    const checked = checkStatement(item, index);
    if (checked.ok) statements.push(checked.statement);
    else codes.push(...checked.codes);
  }
  const seen = new Set<string>();
  for (const s of statements) {
    const key = `${s.provenance} ${s.text}`;
    if (seen.has(key)) {
      codes.push("recommendation_statement_invalid");
      break;
    }
    seen.add(key);
  }
  if (codes.length > 0) return { ok: false, codes };
  return { ok: true, statements };
}

type ProductCheck = { ok: true; product: RecommendationProductResult } | { ok: false; codes: string[] };

function checkProduct(raw: unknown, snapshotProductIds: ReadonlySet<number>, index: EvidencePathIndex): ProductCheck {
  if (!isPlainObject(raw)) return { ok: false, codes: ["recommendation_input_invalid"] };
  const codes: string[] = [];
  if (!hasOnlyAllowedKeys(raw, PRODUCT_ALLOWED_KEYS)) codes.push("recommendation_unknown_field");

  let productId: number | null = null;
  if (!isPositiveSafeInteger(raw.productId)) {
    codes.push("recommendation_input_invalid");
  } else if (!snapshotProductIds.has(raw.productId)) {
    codes.push("recommendation_product_not_in_snapshot");
  } else {
    productId = raw.productId;
  }

  const strengthsChecked = checkStatementArray(raw.strengths, index);
  if (!strengthsChecked.ok) codes.push(...strengthsChecked.codes);
  const cautionsChecked = checkStatementArray(raw.cautions, index);
  if (!cautionsChecked.ok) codes.push(...cautionsChecked.codes);

  if (codes.length > 0 || productId === null || !strengthsChecked.ok || !cautionsChecked.ok) {
    return { ok: false, codes };
  }
  return { ok: true, product: { productId, strengths: strengthsChecked.statements, cautions: cautionsChecked.statements } };
}

type MissingInfoCheck = { ok: true; info: RecommendationMissingInformation } | { ok: false; codes: string[] };

function checkMissingInfo(raw: unknown, snapshotProductIds: ReadonlySet<number>): MissingInfoCheck {
  if (!isPlainObject(raw)) return { ok: false, codes: ["recommendation_missing_information_invalid"] };
  const codes: string[] = [];
  if (!hasOnlyAllowedKeys(raw, MISSING_INFO_ALLOWED_KEYS)) codes.push("recommendation_unknown_field");

  let productId: number | null = null;
  if (!isPositiveSafeInteger(raw.productId)) {
    codes.push("recommendation_missing_information_invalid");
  } else if (!snapshotProductIds.has(raw.productId)) {
    codes.push("recommendation_product_not_in_snapshot");
  } else {
    productId = raw.productId;
  }

  // field 이름의 고정 enum은 만들지 않는다(요청서 10절) - Comparison Field 모델(price/
  // shipping/features 등)이 아직 구현되지 않았으므로 자유 문자열만 형식 검증한다.
  if (!isNonEmptyString(raw.field)) codes.push("recommendation_missing_information_invalid");
  if (!isNonEmptyString(raw.reason)) codes.push("recommendation_missing_information_invalid");

  if (codes.length > 0 || productId === null) return { ok: false, codes };
  return { ok: true, info: { productId, field: (raw.field as string).trim(), reason: (raw.reason as string).trim() } };
}

// 판정 절차(결정론적, comparisonSnapshot.ts와 동일 스타일 - 형식 오류를 stable reason
// code로 구분해 errors 배열에 모으고, 통과한 것만 마지막에 canonical 순서로 재조립):
// 1. snapshot 자체의 최소 형식(id/compareGroupId/revision/infoAsOf/productRefs) 확인 -
//    이미 buildComparisonSnapshot()을 통과한 값이라고 가정하지 않는다(순수 함수 원칙).
// 2. input이 object인지, top-level에 products/missingInformation 외 key가 없는지 확인.
// 3. products 각 원소 형식(productId/strengths/cautions 외 key 없음, productId가
//    snapshot에 실존, statement 형식/provenance enum/중복 문장 없음) 확인.
// 4. products가 snapshot productRefs와 정확히 1:1인지(중복/누락/추가 전부 거부) 확인.
// 5. missingInformation 각 원소 형식(productId 실존, field/reason 비어있지 않음, 완전
//    중복 없음) 확인.
// 6. 전부 통과하면 products는 snapshot의 canonical productId 순서로, missingInformation은
//    (productId, field, reason) 오름차순으로 재배열해 deep clone + deep freeze한다
//    (요청서 16절 - caller 순서에 의미가 없는 목록은 canonical ordering을 채택).
export function buildRecommendationResult(
  comparisonSnapshot: ComparisonSnapshot | null | undefined,
  input: unknown
): RecommendationBuildResult {
  if (
    !comparisonSnapshot ||
    !isPositiveSafeInteger(comparisonSnapshot.id) ||
    !isPositiveSafeInteger(comparisonSnapshot.compareGroupId) ||
    !isPositiveSafeInteger(comparisonSnapshot.revision) ||
    !isNonEmptyString(comparisonSnapshot.infoAsOf) ||
    !Array.isArray(comparisonSnapshot.productRefs) ||
    comparisonSnapshot.productRefs.length === 0
  ) {
    return { ok: false, recommendation: null, errors: ["recommendation_input_invalid"] };
  }

  const snapshotProductIds = comparisonSnapshot.productRefs.map((r) => r.productId);
  const snapshotProductIdSet = new Set(snapshotProductIds);

  // Phase 12.2: evidenceFields의 semantic validation(경로 실존/null 여부/cross-product
  // comparability)에 쓸 authoritative source를 여기서 딱 한 번 만든다 - 이미 받은
  // comparisonSnapshot에서 순수하게 파생할 뿐 DB를 다시 읽지 않는다(요청서 5절).
  const evidencePayload = buildRecommendationEvidencePayload(comparisonSnapshot);
  const evidenceIndex = buildEvidencePathIndex(evidencePayload.products);

  if (!isPlainObject(input)) {
    return { ok: false, recommendation: null, errors: ["recommendation_input_invalid"] };
  }

  const errors: string[] = [];
  if (!hasOnlyAllowedKeys(input, TOP_LEVEL_ALLOWED_KEYS)) errors.push("recommendation_unknown_field");

  const rawProducts = Array.isArray(input.products) ? input.products : [];
  const validatedProducts: RecommendationProductResult[] = [];
  for (const raw of rawProducts) {
    const checked = checkProduct(raw, snapshotProductIdSet, evidenceIndex);
    if (checked.ok) validatedProducts.push(checked.product);
    else errors.push(...checked.codes);
  }

  const seenProductIds = new Set<number>();
  const duplicateProductIds = new Set<number>();
  for (const p of validatedProducts) {
    if (seenProductIds.has(p.productId)) duplicateProductIds.add(p.productId);
    seenProductIds.add(p.productId);
  }
  if (duplicateProductIds.size > 0) errors.push("recommendation_product_duplicate");
  if (snapshotProductIds.some((id) => !seenProductIds.has(id))) errors.push("recommendation_product_missing");

  const rawMissingInformation = Array.isArray(input.missingInformation) ? input.missingInformation : [];
  const validatedMissingInformation: RecommendationMissingInformation[] = [];
  for (const raw of rawMissingInformation) {
    const checked = checkMissingInfo(raw, snapshotProductIdSet);
    if (checked.ok) validatedMissingInformation.push(checked.info);
    else errors.push(...checked.codes);
  }
  const seenMissingInfoKeys = new Set<string>();
  for (const info of validatedMissingInformation) {
    const key = `${info.productId} ${info.field} ${info.reason}`;
    if (seenMissingInfoKeys.has(key)) {
      errors.push("recommendation_missing_information_invalid");
      break;
    }
    seenMissingInfoKeys.add(key);
  }

  if (errors.length > 0) {
    return { ok: false, recommendation: null, errors: Array.from(new Set(errors)) };
  }

  const productByProductId = new Map(validatedProducts.map((p) => [p.productId, p]));
  const canonicalProducts: RecommendationProductResult[] = snapshotProductIds.map((id) => {
    const p = productByProductId.get(id)!;
    return { productId: p.productId, strengths: p.strengths, cautions: p.cautions };
  });

  const canonicalMissingInformation: RecommendationMissingInformation[] = [...validatedMissingInformation].sort((a, b) => {
    if (a.productId !== b.productId) return a.productId - b.productId;
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
    return 0;
  });

  const recommendation: RecommendationResult = deepFreeze(
    deepClone({
      comparisonSnapshotId: comparisonSnapshot.id,
      compareGroupId: comparisonSnapshot.compareGroupId,
      comparisonRevision: comparisonSnapshot.revision,
      infoAsOf: comparisonSnapshot.infoAsOf,
      products: canonicalProducts,
      missingInformation: canonicalMissingInformation,
    })
  );

  return { ok: true, recommendation, errors: [] };
}
