// src/productRadar/comparisonSnapshot.ts
// 상품 레이더 Phase 9.4: 결정론적(deterministic) Immutable Comparison Snapshot builder.
// docs/designs/product-radar-phase9-comparison-foundation-design.md 14절 대응.
//
// buildComparisonSnapshot()은 순수 함수입니다 - network 요청 없음, DOM 접근 없음, DB
// 접근 없음, AI 호출 없음, random/Date.now 없음. 같은 입력은 항상 같은 결과를 반환합니다.
//
// Snapshot builder는 "판단 엔진"이 아니라 "기록 계층"입니다(설계서 14절/Phase 9.4 지시서
// 8절) - category classification, relation, compatibility, product extraction 중
// 어느 것도 여기서 다시 계산하지 않습니다. 상위 계층이 Phase 9.2 compareProductRelation()과
// Phase 9.3 compareProductComparisonCompatibility()로 이미 계산한 결과를 pairs로 넘기면,
// 이 함수는 그 값을 재해석 없이 그대로 얼려서 반환할 뿐입니다. snapshotId/revision/
// createdAt/infoAsOf도 전부 호출자가 제공합니다.

import {
  ComparisonSnapshot,
  ComparisonSnapshotBuildResult,
  ComparisonSnapshotInput,
  ComparisonSnapshotPairResult,
  ComparisonSnapshotProductEvidence,
  ComparisonSnapshotProductRef,
  NormalizedMeasurements,
  ProductIdentityFingerprint,
  ProductVariationFingerprint,
} from "./types";
import { buildFactualComparisonEvidence, FactualComparisonEvidence } from "./comparisonEvidence";
import { isValidNormalizedMeasurement, MeasurementDimension, NormalizedMeasurement } from "./unitNormalization";
// Phase 12.5.3.1: representativeImageUrl 검증은 기존 provenance URL 필드들과 동일한
// legacy-vs-corrupt 규칙(missing/null -> 정상 null, http/https 문자열 -> 그대로, 그 외 ->
// corrupt)을 따르므로 새 URL parser를 만들지 않고 기존 checkFrozenProductSnapshotUrl()을
// 그대로 재사용한다(요청서 5절). 이 파일 자체는 여전히 그 provenance 필드들을 직접
// 다루지 않는다(12.5.2.3.2는 계속 보류).
import { checkFrozenProductSnapshotUrl } from "./productSnapshotProvenance";

const MIN_PRODUCTS = 2;
const MAX_PRODUCTS = 4;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidProductRef(ref: unknown): ref is ComparisonSnapshotProductRef {
  if (!ref || typeof ref !== "object") return false;
  const r = ref as Partial<ComparisonSnapshotProductRef>;
  return isFiniteNumber(r.productId) && isFiniteNumber(r.productSnapshotId) && isNonEmptyString(r.capturedAt);
}

// pair 하나를 검사해 어떤 부분이 문제인지 stable reason code로 구분해 낸다(형식 오류 /
// relation 누락 / compatibility 누락은 서로 다른 원인이므로 하나로 뭉치지 않는다).
function checkPairShape(pair: unknown): { ok: true; pair: ComparisonSnapshotPairResult } | { ok: false; reasons: string[] } {
  if (!pair || typeof pair !== "object") return { ok: false, reasons: ["invalid_pair_shape"] };
  const p = pair as Partial<ComparisonSnapshotPairResult>;
  const reasons: string[] = [];
  if (!isFiniteNumber(p.productIdA) || !isFiniteNumber(p.productIdB)) reasons.push("invalid_pair_shape");
  if (!isFiniteNumber(p.productSnapshotIdA) || !isFiniteNumber(p.productSnapshotIdB)) reasons.push("invalid_pair_shape");
  if (!p.relation || typeof p.relation.relation !== "string") reasons.push("missing_relation_result");
  if (!p.compatibility || typeof p.compatibility.compatibility !== "string") reasons.push("missing_compatibility_result");
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, pair: p as ComparisonSnapshotPairResult };
}

function isValidVariationDimensionValue(v: unknown): boolean {
  if (v === null) return true;
  if (!v || typeof v !== "object") return false;
  const d = v as { value?: unknown; unit?: unknown };
  return isFiniteNumber(d.value) && typeof d.unit === "string";
}

function isValidIdentityFingerprint(v: unknown): v is ProductIdentityFingerprint {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<ProductIdentityFingerprint>;
  return (f.categoryKey === null || typeof f.categoryKey === "string") && Array.isArray(f.identityTokens);
}

function isValidVariationFingerprint(v: unknown): v is ProductVariationFingerprint {
  if (!v || typeof v !== "object") return false;
  const f = v as Partial<ProductVariationFingerprint>;
  return (
    isValidVariationDimensionValue(f.capacity) &&
    isValidVariationDimensionValue(f.quantity) &&
    isValidVariationDimensionValue(f.volume) &&
    isValidVariationDimensionValue(f.weight) &&
    (f.optionName === null || typeof f.optionName === "string")
  );
}

// Phase 11.3: comparisonFields/normalizedMeasurements 전용 own-property 검증 helper.
// 이 파일은 지금까지 own-property 여부를 따로 구분하지 않았지만(identity/variation은
// 항상 comparisonOrchestration.ts가 고정된 field 순서로 만든 object만 들어온다는 전제),
// 이번에 새로 추가하는 두 필드는 comparisonEvidence.ts/unitNormalization.ts의 own-property
// 전용 builder/validator를 그대로 재사용한다 - Phase 11.1 pre-commit에서 발견된 결함
// (prototype inherited property가 required key 검증을 통과하던 문제)을 다시 만들지
// 않기 위해서다.
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key));
}

// comparisonFields: undefined(구버전 row에 key 자체 없음)/null(evidence 없음) 둘 다
// "정상, canonical null"로 취급한다(요청서 18절) - 이 둘을 corrupt로 취급하지 않는다.
// object면 comparisonEvidence.ts의 buildFactualComparisonEvidence()를 그대로 재사용해
// strict 검증한다 - 새 검증 로직을 이 파일에 중복 작성하지 않는다. 그 외 타입(문자열/
// 배열/숫자 등)은 corrupt.
type ComparisonFieldsCheck = { ok: true; value: FactualComparisonEvidence | null } | { ok: false };

function checkComparisonFields(raw: unknown): ComparisonFieldsCheck {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const built = buildFactualComparisonEvidence(raw);
  if (!built.ok) return { ok: false };
  return { ok: true, value: built.evidence };
}

// Phase 12.5.2.2.1: displayLabel도 comparisonFields와 동일한 legacy-vs-corrupt 철학을
// 따른다 - key 자체가 없음(undefined, 이 필드가 생기기 전 저장된 구버전 row)과 명시적
// null(저장 당시 상품명이 없었음) 둘 다 정상으로 취급해 canonical null로 만든다. string이
// 아닌 다른 타입(number/object/array/boolean)은 missing이 아니라 corrupt이므로 거부한다 -
// identityTokens용 normalization(lowercase/토큰화/정렬)은 여기서 절대 적용하지 않는다
// (저장된 원문 문자열을 그대로 통과시킬 뿐이다).
type DisplayLabelCheck = { ok: true; value: string | null } | { ok: false };
function checkDisplayLabel(raw: unknown): DisplayLabelCheck {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === "string") return { ok: true, value: raw };
  return { ok: false };
}

// normalizedMeasurements bundle의 4 slot(variation과 동일한 이름 - capacity/quantity/
// volume/weight)이 각각 어떤 MeasurementDimension만 허용하는지 고정한다(요청서 16~17절) -
// structurally valid한 NormalizedMeasurement라도 slot과 dimension이 맞지 않으면(예:
// capacity slot에 weight/g) corrupt로 거부한다. quantity만 item_count/pack_count 둘 다
// 허용 - 팩과 개수는 서로 다른 dimension이지만 같은 variation.quantity 원본 슬롯에서
// 나올 수 있기 때문이다(Phase 9.2 추출 구조 그대로).
const NORMALIZED_MEASUREMENTS_SLOTS = ["capacity", "quantity", "volume", "weight"] as const;
type NormalizedMeasurementSlot = (typeof NORMALIZED_MEASUREMENTS_SLOTS)[number];
const NORMALIZED_MEASUREMENTS_ALLOWED_KEYS: ReadonlySet<string> = new Set(NORMALIZED_MEASUREMENTS_SLOTS);

const SLOT_ALLOWED_DIMENSIONS: Readonly<Record<NormalizedMeasurementSlot, ReadonlySet<MeasurementDimension>>> = {
  capacity: new Set<MeasurementDimension>(["storage"]),
  quantity: new Set<MeasurementDimension>(["item_count", "pack_count"]),
  volume: new Set<MeasurementDimension>(["volume"]),
  weight: new Set<MeasurementDimension>(["weight"]),
};

function isValidNormalizedMeasurementSlotValue(slot: NormalizedMeasurementSlot, v: unknown): v is NormalizedMeasurement | null {
  if (v === null) return true;
  if (!isValidNormalizedMeasurement(v)) return false;
  return SLOT_ALLOWED_DIMENSIONS[slot].has(v.dimension);
}

// normalizedMeasurements: comparisonFields와 동일하게 undefined/null은 정상(canonical
// null), object면 own-property 4개(capacity/quantity/volume/weight)가 전부 존재해야
// 하고(요청서 17절 - 4개 모두 required own property, 값 자체는 null 허용) 그 외 unknown
// own key가 없어야 하며, 각 슬롯 값이 위 dimension 제약을 만족해야 한다.
type NormalizedMeasurementsCheck = { ok: true; value: NormalizedMeasurements | null } | { ok: false };

// 검수 보정: 슬롯 값을 그대로 caller reference로 반환하면(as 캐스팅만) 그 nested
// object의 key 순서가 저장된 그대로(비-canonical) 남는다 - comparisonFields가
// buildFactualComparisonEvidence()를 통해 항상 {value, source} 순서로 재조립되는 것과
// 달리, 이 슬롯은 별도 builder가 없었기 때문이다. dimension/value/unit 고정 순서로
// 항상 새 object를 만든다(canonical order 보장, AW 테스트로 확인).
function canonicalizeNormalizedMeasurement(v: NormalizedMeasurement | null): NormalizedMeasurement | null {
  if (v === null) return null;
  return { dimension: v.dimension, value: v.value, unit: v.unit };
}

function checkNormalizedMeasurements(raw: unknown): NormalizedMeasurementsCheck {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!isPlainObject(raw)) return { ok: false };
  if (!hasOnlyAllowedKeys(raw, NORMALIZED_MEASUREMENTS_ALLOWED_KEYS)) return { ok: false };

  for (const slot of NORMALIZED_MEASUREMENTS_SLOTS) {
    if (!hasOwn(raw, slot)) return { ok: false };
    if (!isValidNormalizedMeasurementSlotValue(slot, raw[slot])) return { ok: false };
  }

  return {
    ok: true,
    value: {
      capacity: canonicalizeNormalizedMeasurement(raw.capacity as NormalizedMeasurement | null),
      quantity: canonicalizeNormalizedMeasurement(raw.quantity as NormalizedMeasurement | null),
      volume: canonicalizeNormalizedMeasurement(raw.volume as NormalizedMeasurement | null),
      weight: canonicalizeNormalizedMeasurement(raw.weight as NormalizedMeasurement | null),
    },
  };
}

// categoryKey/identity/variation은 data provenance다(relation/compatibility의
// reasons는 decision provenance일 뿐, 예: "different_capacity" 하나로는 실제 비교
// 당시 값이 1TB/2TB였는지 복원할 수 없다 - 검수 보정). category classifier/identity
// normalization/variation extraction 중 어느 것도 여기서 다시 계산하지 않는다 - 호출자가
// Phase 9.2 extractIdentityFingerprint()/extractVariationFingerprint()로 이미 계산한
// 값을 그대로 검증만 한다. productSnapshotId까지 형식 검사에 포함해 "어느 snapshot에서
// 나온 evidence인지"가 애초에 숫자로 존재하는지 확인한다(exact reference 검증은 아래
// buildComparisonSnapshot 안에서 productRefs와 대조). Phase 11.3: comparisonFields/
// normalizedMeasurements도 여기서 함께 형식 검증한다(undefined/null은 정상 - 구버전
// row와 legacy absence를 corrupt로 취급하지 않는다, 18절).
function isValidProductEvidence(v: unknown): v is ComparisonSnapshotProductEvidence {
  if (!v || typeof v !== "object") return false;
  const e = v as Partial<ComparisonSnapshotProductEvidence>;
  return (
    isFiniteNumber(e.productId) &&
    isFiniteNumber(e.productSnapshotId) &&
    checkDisplayLabel(e.displayLabel).ok &&
    checkFrozenProductSnapshotUrl(e.representativeImageUrl).ok &&
    (e.categoryKey === null || typeof e.categoryKey === "string") &&
    isValidIdentityFingerprint(e.identity) &&
    isValidVariationFingerprint(e.variation) &&
    checkComparisonFields(e.comparisonFields).ok &&
    checkNormalizedMeasurements(e.normalizedMeasurements).ok
  );
}

// 두 productId를 순서 무관 canonical key(작은 값:큰 값)로 만든다 - A,B와 B,A를 같은
// pair로 취급하기 위함(설계서 7절, "중복 pair로 저장하지 않는다").
function pairKey(idA: number, idB: number): string {
  const [lo, hi] = idA <= idB ? [idA, idB] : [idB, idA];
  return `${lo}:${hi}`;
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

// 판정 절차(결정론적, 순서 고정 - Phase 9.4 지시서 12절 validation, 검수 보정으로 6/7 추가):
// 1. 기본 메타데이터(id/compareGroupId/revision/createdAt/infoAsOf) 존재/타입 확인.
// 2. 상품 수 2~4개, 각 productRef 형식, productId 중복 여부 확인.
// 3. 각 pair 형식(양쪽 productId/productSnapshotId, relation/compatibility 결과 존재)
//    확인, self-pair 금지, productRefs에 없는 productId 참조 금지, 중복 pair 금지.
// 4. productRefs로부터 필요한 전체 조합(2개→1, 3개→3, 4개→6)이 빠짐없이 있는지 확인.
// 5. 전부 통과하면 productId 오름차순 canonical 순서로 productRefs/pairs를 재구성해
//    deep clone + deep freeze한 불변 snapshot을 반환한다(입력 배열 순서와 무관하게 항상
//    같은 표준 형태 - 지시서 14절 P, 설계 문서가 입력 순서 보존을 요구하는 조항은 없어
//    canonical ordering을 채택하고 완료 보고에서 설명한다).
// 6. (검수 보정) 각 pair의 productSnapshotIdA/B가 productRefs가 그 productId에 대해
//    등록한 정확한 productSnapshotId와 일치하는지 확인 - productId가 같아도 다른
//    snapshot을 가리키면 거부한다("Exact Product Snapshot Reference").
// 7. (최종 불변식 보정) productEvidence는 필수다 - productRefs 각각에 정확히 하나씩
//    있어야 하고(누락/중복/대상 외 extra 전부 거부), productId+productSnapshotId가
//    productRefs가 등록한 정확한 값과 일치해야 한다(같은 productId라도 다른
//    productSnapshotId면 거부 - evidence가 "현재 product row"가 아니라 비교 당시
//    정확한 snapshot에서 나왔음을 구조적으로 보장).
export function buildComparisonSnapshot(input: ComparisonSnapshotInput | null | undefined): ComparisonSnapshotBuildResult {
  const errors: string[] = [];

  if (
    !input ||
    !isFiniteNumber(input.id) ||
    !isFiniteNumber(input.compareGroupId) ||
    !isFiniteNumber(input.revision) ||
    !isNonEmptyString(input.createdAt) ||
    !isNonEmptyString(input.infoAsOf)
  ) {
    return { ok: false, snapshot: null, errors: ["invalid_snapshot_metadata"] };
  }

  const productRefs = Array.isArray(input.productRefs) ? input.productRefs : [];
  const pairs = Array.isArray(input.pairs) ? input.pairs : [];

  if (productRefs.length < MIN_PRODUCTS || productRefs.length > MAX_PRODUCTS) {
    errors.push("invalid_product_count");
  }

  if (!productRefs.every(isValidProductRef)) {
    errors.push("missing_product_ref");
  }

  const validRefs = productRefs.filter(isValidProductRef);
  const productIds = validRefs.map((r) => r.productId);
  const uniqueProductIds = new Set(productIds);
  if (uniqueProductIds.size !== productIds.length) {
    errors.push("duplicate_product_ref");
  }
  // productId -> productRefs가 등록한 정확한 productSnapshotId(6절 exact reference 검증에 사용).
  const refSnapshotIdByProductId = new Map<number, number>();
  for (const r of validRefs) refSnapshotIdByProductId.set(r.productId, r.productSnapshotId);

  const validPairs: ComparisonSnapshotPairResult[] = [];
  for (const raw of pairs) {
    const checked = checkPairShape(raw);
    if (checked.ok) validPairs.push(checked.pair);
    else errors.push(...checked.reasons);
  }

  if (validPairs.some((p) => p.productIdA === p.productIdB)) {
    errors.push("self_pair");
  }
  if (validPairs.some((p) => !uniqueProductIds.has(p.productIdA) || !uniqueProductIds.has(p.productIdB))) {
    errors.push("pair_references_unknown_product");
  }
  // 검수 보정: productId는 productRefs에 등록돼 있어도, pair가 들고 있는
  // productSnapshotId가 그 productId에 대해 productRefs가 실제로 등록한 값과 정확히
  // 일치해야 한다 - 다르면(예: 더 오래된/다른 snapshot으로 계산된 결과) 거부한다.
  if (
    validPairs.some((p) => {
      const expectedA = refSnapshotIdByProductId.get(p.productIdA);
      const expectedB = refSnapshotIdByProductId.get(p.productIdB);
      if (expectedA === undefined || expectedB === undefined) return false; // 미등록 productId는 위에서 이미 별도 처리
      return p.productSnapshotIdA !== expectedA || p.productSnapshotIdB !== expectedB;
    })
  ) {
    errors.push("pair_snapshot_reference_mismatch");
  }

  const seenPairKeys = new Set<string>();
  const duplicateKeys = new Set<string>();
  for (const p of validPairs) {
    const key = pairKey(p.productIdA, p.productIdB);
    if (seenPairKeys.has(key)) duplicateKeys.add(key);
    seenPairKeys.add(key);
  }
  if (duplicateKeys.size > 0) {
    errors.push("duplicate_pair");
  }

  const sortedProductIds = [...uniqueProductIds].sort((a, b) => a - b);
  const expectedPairKeys: string[] = [];
  for (let i = 0; i < sortedProductIds.length; i++) {
    for (let j = i + 1; j < sortedProductIds.length; j++) {
      expectedPairKeys.push(pairKey(sortedProductIds[i], sortedProductIds[j]));
    }
  }
  const missingPairKeys = expectedPairKeys.filter((k) => !seenPairKeys.has(k));
  if (missingPairKeys.length > 0) {
    errors.push("missing_pair");
  }

  // productEvidence는 필수다(최종 불변식 보정 1건) - Comparison Snapshot은 data
  // provenance 없이 생성될 수 없다. productRefs 각각에 정확히 하나씩 있어야 한다.
  const rawEvidence = Array.isArray(input.productEvidence) ? input.productEvidence : [];
  if (!Array.isArray(input.productEvidence) || !rawEvidence.every(isValidProductEvidence)) {
    errors.push("invalid_product_evidence_shape");
  }
  const validProductEvidence = rawEvidence.filter(isValidProductEvidence);

  const evidenceProductIds = validProductEvidence.map((e) => e.productId);
  if (new Set(evidenceProductIds).size !== evidenceProductIds.length) {
    errors.push("duplicate_product_evidence");
  }
  if (validProductEvidence.some((e) => !uniqueProductIds.has(e.productId))) {
    errors.push("unexpected_product_evidence");
  }
  const evidenceProductIdSet = new Set(evidenceProductIds);
  if ([...uniqueProductIds].some((id) => !evidenceProductIdSet.has(id))) {
    errors.push("missing_product_evidence");
  }
  // 최종 불변식 보정 2건: productId가 productRefs에 있어도, evidence가 들고 있는
  // productSnapshotId가 그 productId에 대해 productRefs가 실제로 등록한 값과 정확히
  // 일치해야 한다 - "현재 product row"가 아니라 비교 당시 정확한 snapshot에서 나온
  // evidence임을 구조적으로 보장한다.
  if (
    validProductEvidence.some((e) => {
      const expected = refSnapshotIdByProductId.get(e.productId);
      if (expected === undefined) return false; // 미등록 productId는 위에서 이미 별도 처리
      return e.productSnapshotId !== expected;
    })
  ) {
    errors.push("product_evidence_snapshot_mismatch");
  }

  if (errors.length > 0) {
    return { ok: false, snapshot: null, errors: Array.from(new Set(errors)) };
  }

  const pairByKey = new Map<string, ComparisonSnapshotPairResult>();
  for (const p of validPairs) {
    pairByKey.set(pairKey(p.productIdA, p.productIdB), p);
  }

  const canonicalProductRefs: ComparisonSnapshotProductRef[] = [...validRefs].sort((a, b) => a.productId - b.productId);
  const canonicalPairs: ComparisonSnapshotPairResult[] = [];
  for (let i = 0; i < sortedProductIds.length; i++) {
    for (let j = i + 1; j < sortedProductIds.length; j++) {
      const idA = sortedProductIds[i];
      const idB = sortedProductIds[j];
      const source = pairByKey.get(pairKey(idA, idB))!;
      canonicalPairs.push({
        productIdA: idA,
        productIdB: idB,
        // source.productSnapshotIdA/B가 아니라 productRefs의 authoritative 값을 그대로
        // 쓴다 - 검증을 이미 통과했으므로 값은 같지만, source 쪽이 canonical A/B와
        // 반대 방향으로 들어왔을 수 있어(예: 입력이 (idB,idA) 순서) productRefs 기준으로
        // 다시 조회하는 쪽이 순서 혼동이 없다.
        productSnapshotIdA: refSnapshotIdByProductId.get(idA)!,
        productSnapshotIdB: refSnapshotIdByProductId.get(idB)!,
        relation: source.relation,
        compatibility: source.compatibility,
      });
    }
  }
  const evidenceByProductId = new Map<number, ComparisonSnapshotProductEvidence>();
  for (const e of validProductEvidence) evidenceByProductId.set(e.productId, e);
  const canonicalProductEvidence: ComparisonSnapshotProductEvidence[] = sortedProductIds.map((id) => {
    const source = evidenceByProductId.get(id)!;
    // Phase 11.3: source.comparisonFields/normalizedMeasurements를 그대로 참조하지 않고
    // 다시 checkComparisonFields()/checkNormalizedMeasurements()를 통과시켜 canonical
    // 값(고정 field 순서)을 쓴다 - isValidProductEvidence()에서 이미 .ok를 확인했으므로
    // 여기서는 항상 { ok: true } 분기다. 저장된 JSON의 key 순서가 무엇이었든 API 출력은
    // 항상 같은 canonical shape가 된다(19절 요구사항).
    const comparisonFieldsCheck = checkComparisonFields(source.comparisonFields);
    const normalizedMeasurementsCheck = checkNormalizedMeasurements(source.normalizedMeasurements);
    const displayLabelCheck = checkDisplayLabel(source.displayLabel);
    const representativeImageUrlCheck = checkFrozenProductSnapshotUrl(source.representativeImageUrl);
    return {
      productId: id,
      // pair와 동일한 이유로 productRefs의 authoritative 값을 그대로 쓴다(검증을 이미
      // 통과했으므로 source.productSnapshotId와 값은 같다).
      productSnapshotId: refSnapshotIdByProductId.get(id)!,
      displayLabel: displayLabelCheck.ok ? displayLabelCheck.value : null,
      representativeImageUrl: representativeImageUrlCheck.ok ? representativeImageUrlCheck.value : null,
      categoryKey: source.categoryKey,
      identity: source.identity,
      variation: source.variation,
      comparisonFields: comparisonFieldsCheck.ok ? comparisonFieldsCheck.value : null,
      normalizedMeasurements: normalizedMeasurementsCheck.ok ? normalizedMeasurementsCheck.value : null,
    };
  });

  const snapshot: ComparisonSnapshot = deepFreeze(
    deepClone({
      id: input.id,
      compareGroupId: input.compareGroupId,
      revision: input.revision,
      createdAt: input.createdAt,
      infoAsOf: input.infoAsOf,
      productRefs: canonicalProductRefs,
      pairs: canonicalPairs,
      productEvidence: canonicalProductEvidence,
    })
  );

  return { ok: true, snapshot, errors: [] };
}
