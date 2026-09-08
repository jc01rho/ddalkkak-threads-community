// src/productRadar/comparisonEvidence.ts
// 상품 레이더 Phase 11.1: Factual Comparison Evidence Domain(순수 domain, DB/서버 없음).
// Phase 11.0 보정 조사에서 확정한 범위 그대로 - price/originalPrice/shippingFee 세
// factual monetary field를 다룬다.
//
// Phase 12.5.6D.5.1: conditionalPrice/conditionalPriceLabel을 추가했다(요청서 - D.5 착수
// 전 감사에서 확인된 gap을 닫는 첫 bounded slice). conditionalPrice는 price를 대체하지
// 않는 완전히 독립된 필드다 - 사이트가 별도로 노출한 조건부/최대 할인가일 뿐, "누구나
// 항상 받을 수 있는 실구매가"로 취급하지 않는다(회원/쿠폰/카드/적립 등 자격 조건을
// 구조적으로 분해해서 저장하지 않으므로 그런 단정을 할 근거가 없다). conditionalPrice가
// 더 낮다는 이유로 이 파일이 "더 싸다"/"winner" 같은 판정을 만들지 않는다 - 순수 factual
// value + source만 제공한다(기존 monetary field와 동일 원칙). conditionalPriceLabel은
// 숫자가 아니므로 MonetaryFieldEvidence 계약을 그대로 쓰지 않고, 사이트 원문 label을
// 그대로 보존하는 별도의 작은 문자열 계약을 둔다 - label에서 "쿠폰가"/"회원가" 같은 새
// taxonomy를 추론하지 않는다.
//
// backward compatibility: conditionalPrice/conditionalPriceLabel은 이번에 새로 추가된
// key라 이 Phase 이전에 저장된 comparison snapshot의 얼려진 evidence JSON에는 이 key
// 자체가 없다(과거 snapshot을 재작성하지 않음 - 12절). 따라서 이 둘은 price/originalPrice/
// shippingFee와 달리 "key가 반드시 있어야 하는" required field가 아니라 additive/
// optional이다 - key 자체가 없으면 legacy로 인정해 canonical null로 처리한다(recommendation.ts
// evidenceFields의 기존 legacy-key-absence 처리와 동일 원칙 재사용, 새 패턴 발명 아님).
//
// Phase 12.5.6D.5.2: shippingType/shippingText를 추가했다(요청서). shippingFee(숫자, 이미
// Phase 11.1부터 존재)와 달리 이 둘은 "우열 점수"가 아니라 순수 factual descriptor다 -
// "택배가 직접배송보다 좋다"/"무료배송이 무조건 유리하다"/"배송 안내가 길면 불리하다" 같은
// 판정을 이 파일도, 하위 소비자(recommendation)도 자동으로 만들지 않는다. shippingText는
// D.4.2.7에서 저장된 원문을 그대로 노출할 뿐 의미 단위로 재파싱하지 않는다 - "50,000원
// 이상 무료"의 50,000원을 shippingFee로 옮기거나, "제주 추가 3,000원"을 기본 배송비로
// 쓰지 않는다. 원문 안의 " / " 같은 구분자도 훼손하지 않고 그대로 보존한다.
//
// Phase 12.5.6D.5.3: rating/reviewCount를 추가했다(요청서). 둘 다 monetary field가
// 아니다 - {value, source} 계약을 쓰지 않고 conditionalPriceLabel/shippingType/
// shippingText와 같은 방식으로 "값 자체가 factual이며 별도 provenance wrapper가
// 필요 없는" 단순 optional 숫자로 다룬다(browserSave.ts의 PRODUCT_PATCH_COLUMN_MAP에
// rating/reviewCount가 없어 manual_override 경로 자체가 없음을 실제 코드로 확인 -
// originalPrice/shippingFee와 달리 이 둘은 "source가 항상 collected뿐이라 구분할
// 필요가 없다"는 점에서 문자열 descriptor와 같은 성격이다). rating은 0~5 범위의 실수이며
// 사이트가 제공한 원본 정밀도를 그대로 보존한다(browserSave.ts의 ratingField와 동일하게
// 반올림하지 않는다 - 4.86을 4.9로 뭉개지 않는다). reviewCount는 0 이상의 안전 정수다
// (browserSave.ts의 reviewCountField가 저장 시점에 이미 Math.round()하므로 이 계층에
// 도달하는 값은 항상 정수 - 여기서 반올림하지 않고 정수가 아니면 그대로 거부한다,
// monetary value와 동일한 엄격도). 이 두 필드는 rating이 높다고/reviewCount가 많다고
// 자동으로 "더 좋은 상품"이라고 판정하는 근거로 쓰이지 않는다 - 순수 factual value만
// 제공하고 winner/score/rank는 이 파일도 하위 소비자(recommendation)도 만들지 않는다
// (요청서 - D.5.3 정책 확정 1~6절).
//
// buildFactualComparisonEvidence()는 comparisonSnapshot.ts/recommendation.ts와 같은 순수
// builder 스타일이다 - network 요청 없음, DOM 접근 없음, DB 접근 없음, AI 호출 없음,
// random/Date.now 없음. 같은 입력은 항상 같은 결과를 반환한다. ComparisonSnapshot 통합,
// comparisonOrchestration 연결, DB persistence, API 노출은 전부 Phase 11.3 몫이다 - 이
// 파일은 어떤 기존 파일도 import하지 않고 어떤 기존 파일에서도 아직 import되지 않는다.

export type FactualEvidenceSource = "collected" | "manual_override";

const FACTUAL_EVIDENCE_SOURCE_VALUES: ReadonlySet<string> = new Set<FactualEvidenceSource>([
  "collected",
  "manual_override",
]);

export interface MonetaryFieldEvidence {
  readonly value: number;
  readonly source: FactualEvidenceSource;
}

export interface FactualComparisonEvidence {
  readonly price: MonetaryFieldEvidence | null;
  readonly originalPrice: MonetaryFieldEvidence | null;
  readonly conditionalPrice: MonetaryFieldEvidence | null;
  readonly conditionalPriceLabel: string | null;
  readonly shippingFee: MonetaryFieldEvidence | null;
  readonly shippingType: string | null;
  readonly shippingText: string | null;
  readonly rating: number | null;
  readonly reviewCount: number | null;
}

export type FactualComparisonEvidenceBuildResult =
  | { ok: true; evidence: FactualComparisonEvidence; errors: [] }
  | { ok: false; evidence: null; errors: string[] };

type MonetaryFieldName = "price" | "originalPrice" | "conditionalPrice" | "shippingFee";
// price/originalPrice/shippingFee는 Phase 11.1부터 항상 key가 존재해야 하는 required
// field다(이 계약이 처음 만들어졌을 때부터 이 셋뿐이었으므로 "구버전에는 key가 없었다"는
// 상태 자체가 없다). conditionalPrice는 나중에 추가된 additive field라 REQUIRED 목록에
// 넣지 않는다 - MONETARY_FIELD_NAMES(허용된 top-level key 전체)에는 포함하되, 구조 검증의
// "반드시 있어야 하는 key" 목록에서는 뺀다(아래 buildFactualComparisonEvidence 참고).
const REQUIRED_MONETARY_FIELD_NAMES: readonly MonetaryFieldName[] = ["price", "originalPrice", "shippingFee"];
const MONETARY_FIELD_NAMES: readonly MonetaryFieldName[] = ["price", "originalPrice", "conditionalPrice", "shippingFee"];
// conditionalPriceLabel/shippingType/shippingText는 전부 additive/optional 문자열
// descriptor다(D.5.1/D.5.2 - 과거 snapshot에는 이 key들이 없다).
const OPTIONAL_STRING_FIELD_NAMES: readonly string[] = ["conditionalPriceLabel", "shippingType", "shippingText"];
// rating/reviewCount도 additive/optional이다(D.5.3 - 과거 snapshot에는 이 key들이 없다).
// monetary가 아니므로 MONETARY_FIELD_NAMES에 넣지 않는다.
const OPTIONAL_NUMERIC_FIELD_NAMES: readonly string[] = ["rating", "reviewCount"];

const TOP_LEVEL_ALLOWED_KEYS: ReadonlySet<string> = new Set<string>([
  ...MONETARY_FIELD_NAMES,
  ...OPTIONAL_STRING_FIELD_NAMES,
  ...OPTIONAL_NUMERIC_FIELD_NAMES,
]);
// rating: 0~5 범위 실수, 원본 정밀도 보존(browserSave.ts MAX_RATING과 동일 상한 - 근거
// 없는 임의 상한을 새로 만들지 않는다).
const MAX_RATING = 5;
const MONETARY_ALLOWED_KEYS: ReadonlySet<string> = new Set(["value", "source"]);
// 사이트 원문 그대로 보존(요청서 - 조건/의미 재해석·새 taxonomy 생성 금지). 저장 시점에
// 이미 browserSave.ts의 MAX_TEXT_FIELD_CHARS(200)를 통과한 값만 여기 도달하지만
// (conditionalPriceLabel/shippingType/shippingText 전부 서버에서 동일한 200자 상한을
// 씀 - browserSave.ts 실제 코드로 확인), 이 파일은 다른 파일을 import하지 않는 순수
// domain이므로 동일한 상한을 로컬 상수로 다시 둔다(방어적 이중 검증 - 기존 monetary
// value의 isSafeInteger 검사와 같은 원칙).
const MAX_OPTIONAL_STRING_FIELD_CHARS = 200;

// field별 실제 허용 source(Phase 11.0 3~4절 - database.ts의 PRODUCT_PATCH_COLUMN_MAP을
// 근거로 확정). price만 PATCH 경로가 존재해 manual_override가 실제로 가능하다.
// originalPrice/shippingFee/conditionalPrice는 PATCH 대상 필드 목록에 없어 override 경로
// 자체가 없으므로, 나중 가능성을 이유로 지금 없는 경로를 허용하지 않는다.
const FIELD_ALLOWED_SOURCES: Readonly<Record<MonetaryFieldName, ReadonlySet<FactualEvidenceSource>>> = {
  price: new Set<FactualEvidenceSource>(["collected", "manual_override"]),
  originalPrice: new Set<FactualEvidenceSource>(["collected"]),
  conditionalPrice: new Set<FactualEvidenceSource>(["collected"]),
  shippingFee: new Set<FactualEvidenceSource>(["collected"]),
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Object.keys()는 own enumerable property만 본다(prototype chain 없음) - 이 결과를 그대로
// output 조립에 쓰지 않고 허용된 key만 명시적으로 읽으므로(아래 checkMonetaryField/
// buildFactualComparisonEvidence) prototype/property injection이 output으로 흘러들 경로가
// 없다(recommendation.ts와 동일 원칙).
function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key));
}

// pre-commit 검수 보정: `key in obj`와 `obj.key` 둘 다 prototype chain을 따라가므로,
// Object.create({...})로 만든 값은 own property가 하나도 없어도 required key/value/source
// 검사를 통과할 수 있었다. required 존재 확인과 값 읽기는 반드시 own property만 인정한다 -
// hasOwnProperty.call()만이 prototype 유무와 무관하게 "이 객체 자신이 그 key를 가졌는가"를
// 정확히 답한다.
function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// own property가 아니면 값이 아예 없는 것과 동일하게 취급한다(undefined 반환) - 기존
// isValidMonetaryValue(undefined)/typeof undefined !== "string" 분기가 이미 "값 없음"을
// `${field}_invalid`/`${field}_source_invalid`로 처리하므로, 새 error code를 만들지 않고
// 기존 malformed-input 처리 경로를 그대로 재사용한다.
function ownValue(obj: Record<string, unknown>, key: string): unknown {
  return hasOwn(obj, key) ? obj[key] : undefined;
}

// 0 이상의 유한 안전 정수만 허용한다 - 현재 시스템은 DB INTEGER 기반 KRW 정수 값만
// 다루므로(Phase 11.0 5절) decimal/negative/NaN/Infinity/unsafe integer/문자열 숫자를
// 전부 거부한다. value: 0은 missing이 아니라 "실제 관측된 0"이다 - field 자체가 없음(null)과
// 값이 0임을 절대 같은 표현으로 합치지 않는다.
function isValidMonetaryValue(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0;
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

type MonetaryFieldCheck = { ok: true; evidence: MonetaryFieldEvidence | null } | { ok: false; codes: string[] };

// raw가 null이면 "이 필드는 관측되지 않음"으로 정상 처리한다(missing은 field 값 자체의
// null로만 표현 - 요청서 6절). null이 아니면 {value, source} 외 key가 없고, value가
// isValidMonetaryValue를 만족하고, source가 FactualEvidenceSource enum 안에 있으면서
// 그 field가 실제로 허용하는 source 집합에 속해야 한다.
function checkMonetaryField(field: MonetaryFieldName, raw: unknown): MonetaryFieldCheck {
  if (raw === null) return { ok: true, evidence: null };
  if (!isPlainObject(raw)) return { ok: false, codes: [`${field}_invalid`] };

  const codes: string[] = [];
  if (!hasOnlyAllowedKeys(raw, MONETARY_ALLOWED_KEYS)) codes.push(`${field}_unknown_field`);

  // value/source는 own property에서만 읽는다 - prototype에만 있는 값은 ownValue()가
  // undefined로 취급하므로, 아래 두 검사는 "진짜로 값이 없을 때"와 동일한 기존 error
  // code(`${field}_invalid`/`${field}_source_invalid`)로 자연스럽게 떨어진다.
  const rawValue = ownValue(raw, "value");
  const rawSource = ownValue(raw, "source");

  if (!isValidMonetaryValue(rawValue)) codes.push(`${field}_invalid`);

  let source: FactualEvidenceSource | null = null;
  if (typeof rawSource !== "string" || !FACTUAL_EVIDENCE_SOURCE_VALUES.has(rawSource)) {
    codes.push(`${field}_source_invalid`);
  } else if (!FIELD_ALLOWED_SOURCES[field].has(rawSource as FactualEvidenceSource)) {
    codes.push(`${field}_source_not_allowed`);
  } else {
    source = rawSource as FactualEvidenceSource;
  }

  if (codes.length > 0 || source === null) return { ok: false, codes };
  return { ok: true, evidence: { value: rawValue as number, source } };
}

type OptionalStringFieldCheck = { ok: true; value: string | null } | { ok: false; codes: string[] };

// conditionalPriceLabel/shippingType/shippingText가 공유하는 검증 규칙(요청서 - D.5.2
// 2·4·5절): null=값 없음(정상 - 예: conditionalPrice는 있는데 label이 없거나, shippingFee/
// shippingType만 있고 shippingText는 없는 경우도 전부 유효하다). 존재하면 공백만 있지
// 않은 문자열이어야 하고 상한을 넘지 않아야 한다. trim/재구성하지 않고 원문 그대로
// 보존한다 - " / " 같은 내부 구분자를 훼손하지 않고, "최대할인가"->"쿠폰 적용가"나
// "택배"->"일반배송" 같은 재해석/새 taxonomy 생성은 이 함수의 책임이 아니다.
function checkOptionalStringField(field: string, raw: unknown): OptionalStringFieldCheck {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > MAX_OPTIONAL_STRING_FIELD_CHARS) {
    return { ok: false, codes: [`${field}_invalid`] };
  }
  return { ok: true, value: raw };
}

type OptionalNumericFieldCheck = { ok: true; value: number | null } | { ok: false; codes: string[] };

// rating(요청서 D.5.3 6절): null=값 없음(정상). 존재하면 0~5 범위의 유한 실수여야 한다 -
// browserSave.ts의 ratingField와 동일하게 반올림하지 않는다(4.86/4.85처럼 소수 2자리
// 차이를 이 계층이 뭉개면 안 된다 - Duplicate diff 패널이 이미 겪은 문제를 comparison
// evidence에서 반복하지 않는다).
function checkRating(raw: unknown): OptionalNumericFieldCheck {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > MAX_RATING) {
    return { ok: false, codes: ["rating_invalid"] };
  }
  return { ok: true, value: raw };
}

// reviewCount(요청서 D.5.3 6절): null=값 없음(정상). 존재하면 0 이상의 안전 정수여야
// 한다 - browserSave.ts의 reviewCountField가 저장 시점에 이미 Math.round()하므로 이
// 계층에 도달하는 정상 값은 항상 정수다. monetary value(isValidMonetaryValue)와 동일한
// 엄격도로 정수가 아니면 여기서 반올림하지 않고 그대로 거부한다.
function checkReviewCount(raw: unknown): OptionalNumericFieldCheck {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isSafeInteger(raw) || raw < 0) {
    return { ok: false, codes: ["reviewCount_invalid"] };
  }
  return { ok: true, value: raw };
}

// 판정 절차(결정론적, comparisonSnapshot.ts/recommendation.ts와 동일 스타일 - 형식 오류를
// stable reason code로 구분해 errors 배열에 모으고, 통과한 것만 마지막에 canonical 순서로
// 재조립):
// 1. input이 object(배열/null 아님)인지, top-level에 허용된 key 외 key가 없는지 확인.
// 2. price/originalPrice/shippingFee 세 key가 전부 존재하는지 확인(값이 null이어도 key
//    자체는 있어야 함 - 요청서 7절 "새 FactualComparisonEvidence domain object에서는 모두
//    존재해야 한다"). conditionalPrice/conditionalPriceLabel은 additive라 이 필수 검사
//    대상이 아니다 - key 자체가 없으면(과거 snapshot) legacy로 인정해 canonical null로
//    처리한다(아래).
// 3. 각 field 형식 검사(null=missing 허용, monetary는 value/source 형식 + field별 허용
//    source 검사, 문자열 descriptor는 문자열 형식 검사).
// 4. 전부 통과하면 price -> originalPrice -> conditionalPrice -> conditionalPriceLabel ->
//    shippingFee -> shippingType -> shippingText -> rating -> reviewCount 순서로 재조립해
//    deep clone + deep freeze한다 - 입력 property 순서와 무관하게 항상 같은 canonical shape.
export function buildFactualComparisonEvidence(input: unknown): FactualComparisonEvidenceBuildResult {
  if (!isPlainObject(input)) {
    return { ok: false, evidence: null, errors: ["factual_comparison_evidence_invalid"] };
  }

  const structuralErrors: string[] = [];
  if (!hasOnlyAllowedKeys(input, TOP_LEVEL_ALLOWED_KEYS)) {
    structuralErrors.push("factual_comparison_evidence_unknown_field");
  }
  for (const field of REQUIRED_MONETARY_FIELD_NAMES) {
    if (!hasOwn(input, field)) structuralErrors.push(`${field}_missing`);
  }
  if (structuralErrors.length > 0) {
    return { ok: false, evidence: null, errors: Array.from(new Set(structuralErrors)) };
  }

  const priceCheck = checkMonetaryField("price", input.price);
  const originalPriceCheck = checkMonetaryField("originalPrice", input.originalPrice);
  const shippingFeeCheck = checkMonetaryField("shippingFee", input.shippingFee);
  // additive/optional: key 자체가 없으면(과거 snapshot) legacy로 인정해 canonical null로
  // 처리한다 - recommendation.ts의 evidenceFields legacy-key-absence 처리와 동일 원칙
  // (checkEvidenceFields 주석 참고).
  const conditionalPriceCheck: MonetaryFieldCheck = hasOwn(input, "conditionalPrice")
    ? checkMonetaryField("conditionalPrice", input.conditionalPrice)
    : { ok: true, evidence: null };
  const conditionalPriceLabelCheck: OptionalStringFieldCheck = hasOwn(input, "conditionalPriceLabel")
    ? checkOptionalStringField("conditionalPriceLabel", input.conditionalPriceLabel)
    : { ok: true, value: null };
  const shippingTypeCheck: OptionalStringFieldCheck = hasOwn(input, "shippingType")
    ? checkOptionalStringField("shippingType", input.shippingType)
    : { ok: true, value: null };
  const shippingTextCheck: OptionalStringFieldCheck = hasOwn(input, "shippingText")
    ? checkOptionalStringField("shippingText", input.shippingText)
    : { ok: true, value: null };
  const ratingCheck: OptionalNumericFieldCheck = hasOwn(input, "rating") ? checkRating(input.rating) : { ok: true, value: null };
  const reviewCountCheck: OptionalNumericFieldCheck = hasOwn(input, "reviewCount")
    ? checkReviewCount(input.reviewCount)
    : { ok: true, value: null };

  const errors: string[] = [];
  if (!priceCheck.ok) errors.push(...priceCheck.codes);
  if (!originalPriceCheck.ok) errors.push(...originalPriceCheck.codes);
  if (!shippingFeeCheck.ok) errors.push(...shippingFeeCheck.codes);
  if (!conditionalPriceCheck.ok) errors.push(...conditionalPriceCheck.codes);
  if (!conditionalPriceLabelCheck.ok) errors.push(...conditionalPriceLabelCheck.codes);
  if (!shippingTypeCheck.ok) errors.push(...shippingTypeCheck.codes);
  if (!shippingTextCheck.ok) errors.push(...shippingTextCheck.codes);
  if (!ratingCheck.ok) errors.push(...ratingCheck.codes);
  if (!reviewCountCheck.ok) errors.push(...reviewCountCheck.codes);

  if (
    errors.length > 0 ||
    !priceCheck.ok ||
    !originalPriceCheck.ok ||
    !shippingFeeCheck.ok ||
    !conditionalPriceCheck.ok ||
    !conditionalPriceLabelCheck.ok ||
    !shippingTypeCheck.ok ||
    !shippingTextCheck.ok ||
    !ratingCheck.ok ||
    !reviewCountCheck.ok
  ) {
    return { ok: false, evidence: null, errors: Array.from(new Set(errors)) };
  }

  const evidence: FactualComparisonEvidence = deepFreeze(
    deepClone({
      price: priceCheck.evidence,
      originalPrice: originalPriceCheck.evidence,
      conditionalPrice: conditionalPriceCheck.evidence,
      conditionalPriceLabel: conditionalPriceLabelCheck.value,
      shippingFee: shippingFeeCheck.evidence,
      shippingType: shippingTypeCheck.value,
      shippingText: shippingTextCheck.value,
      rating: ratingCheck.value,
      reviewCount: reviewCountCheck.value,
    })
  );

  return { ok: true, evidence, errors: [] };
}
