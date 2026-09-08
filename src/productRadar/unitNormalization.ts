// src/productRadar/unitNormalization.ts
// 상품 레이더 Phase 11.2: Unit Normalization + Unit Price Domain(순수 domain, DB/서버 없음).
//
// 지원 unit vocabulary는 src/productRadar/relation.ts(Phase 9.2)의 실제 정규식 추출
// 결과를 authoritative source로 삼는다(CAPACITY_SRC/QUANTITY_SRC/VOLUME_SRC/WEIGHT_SRC,
// extractDimension()이 match[2]를 .toLowerCase()해 저장) - 실제로 나오는 값은 소문자
// "g"/"kg"/"ml"/"l"/"gb"/"tb"와 한글 "개"/"개입"/"입"/"팩"뿐이다. lbs/oz/MB/GiB/TiB/
// 박스/봉/세트 등 근거 없는 단위는 추가하지 않는다. 이 파일은 relation.ts를 import하지
// 않는다(coupling을 낮추기 위해 standalone {value, unit} shape를 그대로 받는다) - relation.ts
// 자체의 의미/판정도 이 Phase에서 절대 수정하지 않는다.
//
// GB/TB는 상품 판매 표기 기준 decimal(1TB = 1000GB) 체계로 확정한다(Phase 11.0 조사
// 결론) - OS가 보고하는 1024 기준(GiB/TiB)이 아니다. 이 상수를 "정확한" 1024 기준으로
// 고치면 안 된다 - 실제 소매 표기와 어긋난다(23절 회귀 테스트로 고정).
//
// normalizeMeasurement()/buildUnitPriceResult()/areMeasurementsComparable() 전부 순수
// 함수다 - network 요청 없음, DOM 접근 없음, DB 접근 없음, AI 호출 없음, random/Date.now
// 없음. 같은 입력은 항상 같은 결과를 반환한다. ComparisonSnapshot 통합,
// comparisonOrchestration 연결, DB persistence, API 노출, FactualComparisonEvidence와의
// 결합은 전부 Phase 11.3 몫이다.

export type MeasurementDimension = "weight" | "volume" | "storage" | "item_count" | "pack_count";

// relation.ts가 실제로 반환하는 정확한 unit 문자열(소문자 case-fold)만 지원한다.
export type RawMeasurementUnit = "g" | "kg" | "ml" | "l" | "gb" | "tb" | "개" | "개입" | "입" | "팩";

export type NormalizedMeasurementUnit = "g" | "ml" | "GB" | "item" | "pack";

export interface NormalizedMeasurement {
  readonly dimension: MeasurementDimension;
  readonly value: number;
  readonly unit: NormalizedMeasurementUnit;
}

export type NormalizeMeasurementResult =
  | { ok: true; measurement: NormalizedMeasurement; errors: [] }
  | { ok: false; measurement: null; errors: string[] };

interface UnitConversion {
  readonly dimension: MeasurementDimension;
  readonly canonicalUnit: NormalizedMeasurementUnit;
  readonly factor: number; // canonicalValue = rawValue * factor
}

// 팩과 개수는 절대 서로 변환하지 않는다(요청서 4절) - "팩" 안에 몇 개가 들어있는지 아는
// 정보가 없으므로, item_count와 pack_count는 서로 다른 dimension으로 완전히 분리한다.
const UNIT_CONVERSIONS: Readonly<Record<RawMeasurementUnit, UnitConversion>> = {
  g: { dimension: "weight", canonicalUnit: "g", factor: 1 },
  kg: { dimension: "weight", canonicalUnit: "g", factor: 1000 },
  ml: { dimension: "volume", canonicalUnit: "ml", factor: 1 },
  l: { dimension: "volume", canonicalUnit: "ml", factor: 1000 },
  gb: { dimension: "storage", canonicalUnit: "GB", factor: 1 },
  tb: { dimension: "storage", canonicalUnit: "GB", factor: 1000 }, // decimal(1000) 확정 - 1024 금지
  개: { dimension: "item_count", canonicalUnit: "item", factor: 1 },
  개입: { dimension: "item_count", canonicalUnit: "item", factor: 1 },
  입: { dimension: "item_count", canonicalUnit: "item", factor: 1 },
  팩: { dimension: "pack_count", canonicalUnit: "pack", factor: 1 },
};

const TOP_LEVEL_ALLOWED_KEYS: ReadonlySet<string> = new Set(["value", "unit"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key));
}

// Phase 11.1 pre-commit 검수에서 발견된 결함(`key in obj`/직접 property read가 prototype
// chain을 따라가 own property가 없어도 검증을 통과하던 문제)을 이 파일에서는 처음부터
// 반복하지 않는다 - required key 존재 확인과 값 읽기 전부 own property만 인정한다.
function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return hasOwn(obj, key) ? obj[key] : undefined;
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

// measurement quantity는 0을 허용하지 않는다(요청서 7절 - Phase 11.1 monetary value와
// 다르다: 가격은 0이 실제 값일 수 있지만, 수량은 0이면 unit price의 분모로 쓸 수 없다).
// decimal은 허용한다(0.5kg/1.5L 등 정상) - safe integer 요구 없음.
//
// pre-commit 검수 보정: "정확히 0"과 "그 외 사용 불가능한 값(음수/NaN/Infinity/-Infinity/
// non-number)"을 하나의 value_invalid로 뭉치면 그 위 계층(classifyMeasurementFailure())이
// 이미 잃어버린 정보를 되살릴 방법이 없다 - 하위 domain에서부터 두 reason을 분리해야
// 한다. -0은 별도 taxonomy를 만들지 않는다 - `-0 < 0`은 false이고 `-0 === 0`은 true이므로
// 아래 분기가 자연스럽게 value_zero로 처리한다.
type RawMeasurementValueCheck = "ok" | "value_zero" | "value_invalid";

function checkRawMeasurementValue(v: unknown): RawMeasurementValueCheck {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return "value_invalid";
  if (v === 0) return "value_zero";
  return "ok";
}

function isSupportedRawUnit(v: unknown): v is RawMeasurementUnit {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(UNIT_CONVERSIONS, v);
}

// 판정 절차(결정론적, comparisonEvidence.ts와 동일 스타일 - own property만 인정, stable
// reason code로 실패 사유를 구분):
// 1. input이 object(배열/null 아님)인지, top-level에 value/unit 외 key가 없는지 확인.
// 2. value/unit이 전부 input의 own property인지 확인(요청서 6절 - in 연산자 금지).
// 3. value가 정확히 0인지(value_zero) / 그 외 사용 불가능한 값인지(value_invalid)를
//    구분하고, unit이 지원 vocabulary에 속하는지 확인.
// 4. 정규화(value * factor)한 결과도 finite && > 0인지 확인(overflow 방어).
// 5. 전부 통과하면 dimension/value/unit 순서로 재조립해 deep clone + deep freeze한다.
export function normalizeMeasurement(input: unknown): NormalizeMeasurementResult {
  if (!isPlainObject(input)) {
    return { ok: false, measurement: null, errors: ["measurement_invalid"] };
  }

  const structuralErrors: string[] = [];
  if (!hasOnlyAllowedKeys(input, TOP_LEVEL_ALLOWED_KEYS)) {
    structuralErrors.push("measurement_unknown_field");
  }
  if (!hasOwn(input, "value")) structuralErrors.push("value_missing");
  if (!hasOwn(input, "unit")) structuralErrors.push("unit_missing");
  if (structuralErrors.length > 0) {
    return { ok: false, measurement: null, errors: Array.from(new Set(structuralErrors)) };
  }

  const rawValue = ownValue(input, "value");
  const rawUnit = ownValue(input, "unit");

  const errors: string[] = [];
  const valueCheck = checkRawMeasurementValue(rawValue);
  if (valueCheck !== "ok") errors.push(valueCheck);
  if (!isSupportedRawUnit(rawUnit)) errors.push("unsupported_unit");
  if (errors.length > 0) {
    return { ok: false, measurement: null, errors: Array.from(new Set(errors)) };
  }

  const conversion = UNIT_CONVERSIONS[rawUnit as RawMeasurementUnit];
  const normalizedValue = (rawValue as number) * conversion.factor;
  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    return { ok: false, measurement: null, errors: ["normalization_overflow"] };
  }

  const measurement: NormalizedMeasurement = deepFreeze(
    deepClone({
      dimension: conversion.dimension,
      value: normalizedValue,
      unit: conversion.canonicalUnit,
    })
  );

  return { ok: true, measurement, errors: [] };
}

// dimension별 정확히 하나의 canonical unit만 허용한다(16절 - weight+g, volume+ml,
// storage+GB, item_count+item, pack_count+pack 외 조합은 전부 거부). UNIT_CONVERSIONS의
// canonicalUnit 값과 반드시 일치해야 하므로 별도 상수로 중복 정의하지 않고 그 값들에서
// 파생한다.
const DIMENSION_CANONICAL_UNIT: Readonly<Record<MeasurementDimension, NormalizedMeasurementUnit>> = {
  weight: "g",
  volume: "ml",
  storage: "GB",
  item_count: "item",
  pack_count: "pack",
};

const NORMALIZED_MEASUREMENT_ALLOWED_KEYS: ReadonlySet<string> = new Set(["dimension", "value", "unit"]);

// Phase 11.3: comparisonSnapshot.ts가 DB(product_evidence_json)에서 읽은 "이미 정규화된"
// NormalizedMeasurement가 신뢰할 수 있는 shape인지 재검증할 때 쓴다. normalizeMeasurement()는
// raw {value, unit} 입력 -> normalized 결과를 만드는 함수라 이미 정규화된 {dimension, value,
// unit} 결과 자체를 재검증하는 용도로 재사용할 수 없다 - 역할이 다른 별도 validator다.
// dimension/unit 매핑 지식이 comparisonSnapshot.ts에 중복되지 않도록 이 파일에 둔다.
// Phase 11.1 pre-commit 검수에서 발견된 결함(prototype inherited property가 required key
// 검증을 통과하던 문제)을 이 validator에서도 처음부터 반복하지 않는다 - own property만
// 인정한다.
export function isValidNormalizedMeasurement(input: unknown): input is NormalizedMeasurement {
  if (!isPlainObject(input)) return false;
  if (!hasOnlyAllowedKeys(input, NORMALIZED_MEASUREMENT_ALLOWED_KEYS)) return false;
  if (!hasOwn(input, "dimension") || !hasOwn(input, "value") || !hasOwn(input, "unit")) return false;

  const dimension = ownValue(input, "dimension");
  const value = ownValue(input, "value");
  const unit = ownValue(input, "unit");

  if (typeof dimension !== "string" || !Object.prototype.hasOwnProperty.call(DIMENSION_CANONICAL_UNIT, dimension)) {
    return false;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return false;
  if (unit !== DIMENSION_CANONICAL_UNIT[dimension as MeasurementDimension]) return false;

  return true;
}

// 두 normalized measurement가 unit-price 축에서 직접 비교 가능한지만 답한다 - relation.ts의
// ProductComparisonCompatibility를 대체/수정하지 않는 완전히 별도의 dimension-level
// utility다(요청서 16절). 이미 normalizeMeasurement()를 통과한 canonical 값만 받으므로
// 재검증하지 않는다 - dimension과 canonical unit이 같으면(고정 변환표상 서로 동치) 비교
// 가능하다.
export function areMeasurementsComparable(a: NormalizedMeasurement, b: NormalizedMeasurement): boolean {
  return a.dimension === b.dimension && a.unit === b.unit;
}

export interface UnitPriceResult {
  readonly dimension: MeasurementDimension;
  readonly normalizedQuantity: number;
  readonly normalizedUnit: NormalizedMeasurementUnit;
  readonly unitPrice: number;
}

export type UnitPriceBuildResult =
  | { ok: true; result: UnitPriceResult; errors: [] }
  | { ok: false; result: null; errors: string[] };

const UNIT_PRICE_TOP_LEVEL_ALLOWED_KEYS: ReadonlySet<string> = new Set(["price", "measurement"]);

// Phase 11.1 MonetaryFieldEvidence와 동일한 규칙(finite/safe integer/>=0, 0은 실제 값) -
// comparisonEvidence.ts를 import하지 않고 이 파일 안에서 다시 정의한다(요청서 17절 -
// coupling을 낮추기 위해 기존 파일과 동일한 작은 순수 helper를 각 파일이 독립적으로 두는
// 이 프로젝트의 기존 관례, comparisonSnapshot.ts/recommendation.ts도 각자 자신의
// isPlainObject/deepClone/deepFreeze를 따로 둔다).
function isValidPrice(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0;
}

// normalizeMeasurement()의 실패 사유를 Unit Price 전용의 더 좁은 reason으로 압축한다 -
// 세분화된 measurement error code를 그대로 노출하면 taxonomy가 불필요하게 커지므로,
// caller에게 의미 있는 4가지(단위 미지원/수량이 정확히 0/정규화 overflow/그 외 값·형식
// 오류)로만 구분한다. precedence는 기존 그대로 unsupported_unit 최우선 - 이번 hotfix는
// value_zero와 value_invalid의 의미 분리, normalization_overflow pass-through만 다룬다
// (요청서 6절 - 다른 precedence를 뒤집지 않는다). normalization_overflow는 실제로는
// unsupported_unit/value_zero/value_invalid와 절대 동시에 나오지 않는다 -
// normalizeMeasurement()가 unit/value 검증을 전부 통과한 뒤에만 overflow 계산에 도달하고,
// 그 시점엔 이미 함수가 반환했으므로 순서는 방어적 의미만 갖는다. value_zero ->
// quantity_zero, normalization_overflow -> normalization_overflow(그대로 전달),
// value_invalid(negative/NaN/Infinity/-Infinity/non-number)와 그 외 structural error
// (missing key 등)는 invalid_measurement로 압축한다 - 이 둘을 더 세분화할 근거는 없다
// (요청서 3절 taxonomy 최소화 원칙).
function classifyMeasurementFailure(errors: readonly string[]): string {
  if (errors.includes("unsupported_unit")) return "unsupported_unit";
  if (errors.includes("value_zero")) return "quantity_zero";
  if (errors.includes("normalization_overflow")) return "normalization_overflow";
  return "invalid_measurement";
}

// Phase 12.1: 이미 정규화된(canonical) NormalizedMeasurement에서 직접 Unit Price를
// 계산한다 - raw {value, unit}을 받지 않고 다시 normalizeMeasurement()를 호출하지도
// 않는다. ComparisonSnapshot에 이미 얼려 있는 normalizedMeasurements를 authoritative
// quantity로 쓰는 Recommendation Evidence Payload(recommendationEvidence.ts)가 이 함수를
// 쓴다 - 그 값을 raw unit parser에 다시 넣으면 storage(canonical "GB")가 raw unit
// vocabulary(소문자 "gb"만 지원)에 없어 unsupported_unit으로 잘못 거부되는 문제가
// 생긴다(Phase 12.0 조사 9절). measurement 검증은 isValidNormalizedMeasurement()를
// 그대로 재사용한다 - dimension/unit 매핑 지식을 이 함수에 다시 두지 않는다. invalid
// measurement는 raw-input 전용 세분화(quantity_zero/unsupported_unit)를 적용할 수
// 없다 - 이미 정규화된 값에는 "원래 0이었다/단위가 안 맞았다" 같은 원본 정보가 없으므로
// 기존 UnitPrice failure convention의 invalid_measurement로 압축한다(요청서 12절).
export function buildUnitPriceFromNormalizedMeasurement(price: unknown, measurement: unknown): UnitPriceBuildResult {
  if (!isValidPrice(price)) {
    return { ok: false, result: null, errors: ["invalid_price"] };
  }
  if (!isValidNormalizedMeasurement(measurement)) {
    return { ok: false, result: null, errors: ["invalid_measurement"] };
  }

  const unitPrice = price / measurement.value;
  if (!Number.isFinite(unitPrice)) {
    return { ok: false, result: null, errors: ["normalization_overflow"] };
  }

  const result: UnitPriceResult = deepFreeze(
    deepClone({
      dimension: measurement.dimension,
      normalizedQuantity: measurement.value,
      normalizedUnit: measurement.unit,
      unitPrice,
    })
  );

  return { ok: true, result, errors: [] };
}

// 입력: { price, measurement }. price는 위 isValidPrice 규칙, measurement는
// normalizeMeasurement()가 그대로 받는 raw {value, unit} shape(요청서 12절 - "성공적으로
// normalized 가능한 양수 measurement여야 한다"이므로 이 함수가 내부에서 정규화까지
// 수행한다). 판정 절차:
// 1. input이 object인지, top-level에 price/measurement 외 key가 없는지, 두 key 모두 own
//    property인지 확인.
// 2. price 형식 검사.
// 3. measurement를 normalizeMeasurement()에 그대로 위임 - 실패하면 classifyMeasurementFailure()로
//    압축한 reason 하나만 반환(단위 변환/재검증 로직을 여기서 중복하지 않는다).
// 4. Phase 12.1: 나눗셈/non-finite 방어/canonical 조립 로직은 buildUnitPriceFromNormalizedMeasurement()에
//    위임한다 - 같은 계산을 두 곳에 복제하지 않는다(요청서 11절). 외부 contract(입력
//    shape/에러 taxonomy)는 이 리팩터로 전혀 바뀌지 않는다 - raw measurement 전용 검증
//    (quantity_zero/unsupported_unit/normalization_overflow 세분화)은 여전히
//    normalizeMeasurement()/classifyMeasurementFailure()가 먼저 처리하고, 그 이후
//    단계(가격 나눗셈)만 새 함수가 담당한다.
export function buildUnitPriceResult(input: unknown): UnitPriceBuildResult {
  if (!isPlainObject(input)) {
    return { ok: false, result: null, errors: ["invalid_price"] };
  }

  const structuralErrors: string[] = [];
  if (!hasOnlyAllowedKeys(input, UNIT_PRICE_TOP_LEVEL_ALLOWED_KEYS)) {
    structuralErrors.push("invalid_price");
  }
  if (!hasOwn(input, "price")) structuralErrors.push("invalid_price");
  if (!hasOwn(input, "measurement")) structuralErrors.push("invalid_measurement");
  if (structuralErrors.length > 0) {
    return { ok: false, result: null, errors: Array.from(new Set(structuralErrors)) };
  }

  const rawPrice = ownValue(input, "price");
  if (!isValidPrice(rawPrice)) {
    return { ok: false, result: null, errors: ["invalid_price"] };
  }

  const measurementInput = ownValue(input, "measurement");
  const normalized = normalizeMeasurement(measurementInput);
  if (!normalized.ok) {
    return { ok: false, result: null, errors: [classifyMeasurementFailure(normalized.errors)] };
  }

  return buildUnitPriceFromNormalizedMeasurement(rawPrice, normalized.measurement);
}

// 상품 레이더 Phase 12.2: 두 UnitPriceResult가 같은 축(dimension/canonical unit)에서
// 직접 비교 가능한지만 답한다 - areMeasurementsComparable()과 동일한 성격의 utility지만
// UnitPriceResult는 NormalizedMeasurement와 타입이 달라(unitPrice/normalizedQuantity
// 필드를 추가로 가짐) 그대로 캐스팅해 넣을 수 없다(요청서 15절). UnitPriceResult는 이미
// buildUnitPriceFromNormalizedMeasurement()/buildUnitPriceResult()가 만든 canonical
// 값만 들어온다는 전제라 여기서 재검증/재정규화하지 않는다.
export function areUnitPricesComparable(a: UnitPriceResult, b: UnitPriceResult): boolean {
  return a.dimension === b.dimension && a.normalizedUnit === b.normalizedUnit;
}
