// src/productRadar/recommendationEvidence.ts
// 상품 레이더 Phase 12.1: Recommendation Evidence Payload Domain(순수 domain, DB/서버/
// Claude 없음).
//
// buildRecommendationEvidencePayload()는 이미 hydrate된 canonical ComparisonSnapshot
// 하나만 authoritative source로 받는다 - database.ts/comparisonPersistence.ts를
// import하지 않는다(live product 재조회 금지, Phase 12.0 조사 2절). getProductRadarProduct(),
// 현재 price, 현재 userOverriddenFields, 현재 variation, live product snapshot 재조회
// 전부 이 파일에 존재하지 않는다 - snapshot 생성 이후 바뀐 live state는 이 payload에
// 절대 반영되지 않는다.
//
// Claude prompt/CLI invocation/output parser/evidenceFields/persistence 연결은 전부
// Phase 12.2 이후 몫이다 - 이 파일은 Claude를 호출하지 않고, RecommendationResult/
// RecommendationStatement도 건드리지 않는다.

import { FactualComparisonEvidence } from "./comparisonEvidence";
import { ComparisonSnapshot, ComparisonSnapshotProductEvidence, NormalizedMeasurements } from "./types";
import { buildUnitPriceFromNormalizedMeasurement, UnitPriceResult } from "./unitNormalization";

export interface RecommendationUnitPrices {
  readonly capacity: UnitPriceResult | null;
  readonly quantity: UnitPriceResult | null;
  readonly volume: UnitPriceResult | null;
  readonly weight: UnitPriceResult | null;
}

// productSnapshotId/identity/raw variation dimension 값/pairs/relation/compatibility는
// 의도적으로 넣지 않는다(Phase 12.0 조사 5절) - Claude에게 필요한 최소 evidence만
// 담는다. optionName만 예외적으로 variation에서 그대로 복사한다(6절) - 그 외 raw
// capacity/quantity/volume/weight는 이미 normalizedMeasurements가 더 명확한 형태로
// 대체한다.
export interface RecommendationEvidenceProduct {
  readonly productId: number;
  readonly categoryKey: string | null;
  readonly optionName: string | null;
  readonly comparisonFields: FactualComparisonEvidence | null;
  readonly normalizedMeasurements: NormalizedMeasurements | null;
  readonly unitPrices: RecommendationUnitPrices | null;
}

export interface RecommendationEvidencePayload {
  readonly comparisonSnapshotId: number;
  readonly compareGroupId: number;
  readonly comparisonRevision: number;
  readonly infoAsOf: string;
  readonly products: readonly RecommendationEvidenceProduct[];
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

type PhysicalOrQuantitySlot = "capacity" | "quantity" | "volume" | "weight";
const UNIT_PRICE_SLOTS: readonly PhysicalOrQuantitySlot[] = ["capacity", "quantity", "volume", "weight"];

// compound/multipack ambiguity 억제(Phase 12.0 조사 11~13절, 요청서 15~19절):
// "500ml + 6개"처럼 physical dimension(capacity/volume/weight)과 quantity가 동시에
// 존재하면, price가 "낱개 1개 기준"인지 "리스팅 전체 기준"인지 frozen extraction만으로
// 증명할 수 없으므로 physical dimension의 unit price는 계산하지 않는다. quantity(개당/
// 팩당)만은 price가 항상 "그 리스팅 전체"에 대한 값이라는 사실이 구조적으로 명확하므로
// 안전하게 계산 가능하다.
//
// 중요: ambiguity 판단 signal은 normalizedMeasurements.quantity가 아니라
// productEvidence.variation.quantity(raw, 이미 얼려 있는 원본)의 존재 여부다(요청서 16절).
// raw quantity가 있는데 정규화만 실패한 경우("0개"처럼)에도 "이 listing에 quantity
// 표현이 있었다"는 사실 자체는 남아 있어 여전히 위험하기 때문이다 - 그 raw 값을 다시
// normalize하거나 unit price 계산에 쓰지는 않는다, ambiguity 여부 판단에만 쓴다.
function buildUnitPricesForProduct(evidence: ComparisonSnapshotProductEvidence): RecommendationUnitPrices | null {
  const comparisonFields = evidence.comparisonFields;
  if (comparisonFields === null) return null;
  const priceEvidence = comparisonFields.price;
  if (priceEvidence === null) return null;
  const measurements = evidence.normalizedMeasurements;
  if (measurements === null) return null;

  const hasRawQuantity = evidence.variation.quantity !== null;
  const price = priceEvidence.value;

  const unitPriceForSlot = (slot: PhysicalOrQuantitySlot): UnitPriceResult | null => {
    if (hasRawQuantity && slot !== "quantity") return null; // physical 억제, quantity는 예외
    const measurement = measurements[slot];
    if (measurement === null) return null;
    const built = buildUnitPriceFromNormalizedMeasurement(price, measurement);
    return built.ok ? built.result : null;
  };

  const result: Record<PhysicalOrQuantitySlot, UnitPriceResult | null> = {
    capacity: null,
    quantity: null,
    volume: null,
    weight: null,
  };
  for (const slot of UNIT_PRICE_SLOTS) {
    result[slot] = unitPriceForSlot(slot);
  }
  return result;
}

function buildProductPayload(evidence: ComparisonSnapshotProductEvidence): RecommendationEvidenceProduct {
  return {
    productId: evidence.productId,
    categoryKey: evidence.categoryKey,
    optionName: evidence.variation.optionName,
    comparisonFields: evidence.comparisonFields,
    normalizedMeasurements: evidence.normalizedMeasurements,
    unitPrices: buildUnitPricesForProduct(evidence),
  };
}

// snapshot.productEvidence는 이미 comparisonSnapshot.ts가 canonical productId 오름차순으로
// 재조립해 얼린 것이므로(Phase 9.4), 여기서 다시 정렬하지 않는다 - .map()이 그 순서를
// 그대로 보존한다. score/rank 등으로 재정렬하지 않는다(요청서 7절).
//
// 반환값은 항상 새 object 그래프다(deepClone) - snapshot의 frozen nested object를 그대로
// 참조에 담아 흘리지 않는다. snapshot 자체는 이미 불변이라 참조를 공유해도 안전하지만,
// payload의 독립적 불변성을 snapshot의 freeze에 의존하지 않고 스스로 보장한다.
export function buildRecommendationEvidencePayload(snapshot: ComparisonSnapshot): RecommendationEvidencePayload {
  const products = snapshot.productEvidence.map(buildProductPayload);

  return deepFreeze(
    deepClone({
      comparisonSnapshotId: snapshot.id,
      compareGroupId: snapshot.compareGroupId,
      comparisonRevision: snapshot.revision,
      infoAsOf: snapshot.infoAsOf,
      products,
    })
  );
}
