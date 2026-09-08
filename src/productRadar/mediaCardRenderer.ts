// src/productRadar/mediaCardRenderer.ts
// 상품 레이더 Phase 12.5.3.2: 단일 상품 이미지 카드 host deterministic 렌더링(순수 함수 -
// DB/네트워크 호출 없음, 이미 검증된 입력만 받는다). Claude에게 레이아웃을 맡기지 않는다 -
// 이 파일의 좌표/폰트 크기/줄바꿈 규칙이 유일한 layout 결정 기준이다.
//
// text overlay는 SVG로 만들어 sharp.composite()로 합성한다 - 모든 text는 XML escape를
// 거친다(요청서 6절, injection 방지). displayLabel/strength text는 persisted exact source
// 문자열을 그대로 쓰고(재작성 없음), 화면에 넘칠 것 같으면 이 파일의 결정론적 wrap+ellipsis
// 규칙으로만 줄인다 - source DB 값 자체는 건드리지 않는다.

import sharp from "sharp";
import { MAX_SOURCE_IMAGE_PIXELS } from "./imageValidation";

export const PRODUCT_RADAR_CARD_WIDTH = 1080;
export const PRODUCT_RADAR_CARD_HEIGHT = 1350;
const TEXT_PADDING_X = 60;
// Windows에 기본 내장된 시스템 폰트만 이름으로 참조한다(Malgun Gothic=한글, Segoe UI=영문) -
// font 파일 자체를 repo에 넣지 않는다(요청서 6절).
const FONT_FAMILY = "'Malgun Gothic', 'Segoe UI', sans-serif";

// Phase 12.5.3.5: deterministic composition preset 3종(요청서 3절) - 전부 1080x1350 유지,
// 외부 AI 이미지 생성 없음. 같은 snapshot data + source image bytes + composition이면 항상
// 같은 바이트를 만든다(레이아웃 상수만 preset별로 다를 뿐 로직 자체는 결정론적).
export type ProductRadarSingleCardComposition = "product_focus" | "price_focus" | "recommendation_focus";

// IMAGE_AREA_HEIGHT(상품 이미지 영역 높이)만 preset별로 다르게 잡는다 - 나머지(텍스트 영역
// 배치 순서/크기)는 buildProductRadarCardOverlaySvg()의 composition 분기가 결정한다.
const IMAGE_AREA_HEIGHT_BY_COMPOSITION: Record<ProductRadarSingleCardComposition, number> = {
  product_focus: 950, // 상품 이미지를 가장 크게(기존 V1 레이아웃과 완전히 동일 - 요청서 10절 하위호환)
  price_focus: 650, // 가격 영역을 크게 쓰기 위해 이미지를 중간 크기로
  recommendation_focus: 650, // 추천 포인트를 크게 쓰기 위해 이미지를 중간 크기로
};

export interface ProductRadarSingleCardInput {
  // 화면에 보일 상품명. caller가 이미 non-empty를 보장한다(orchestration이 legacy/corrupt
  // displayLabel을 여기까지 넘기지 않는다).
  displayLabel: string;
  language: "ko" | "en";
  // comparisonFields.price.value가 없으면 null - 이 경우 가격 블록 자체를 생략한다(요청서 4절,
  // currency symbol을 새로 발명하지 않는다 - 숫자만 locale formatting).
  priceValue: number | null;
  // RecommendationSnapshot의 해당 product 첫 strength.text - 없으면 null(블록 생략, 새 문장
  // 발명 없음). cautions는 V1 단일 카드에 넣지 않는다(요청서 4절).
  firstStrengthText: string | null;
  // validateSourceImageBuffer()를 이미 통과한 원본 이미지 바이트.
  sourceImageBuffer: Buffer;
  // 생략 시 "product_focus"(기존 V1 레이아웃과 100% 동일한 기본값) - 기존 caller(테스트 포함)가
  // 이 필드 없이 호출해도 회귀가 발생하지 않는다(요청서 10절, 하위호환 우선).
  composition?: ProductRadarSingleCardComposition;
}

function resolveComposition(input: ProductRadarSingleCardInput): ProductRadarSingleCardComposition {
  return input.composition || "product_focus";
}

const LANGUAGE_LABELS: Record<"ko" | "en", { priceLabel: string }> = {
  ko: { priceLabel: "가격" },
  en: { priceLabel: "Price" },
};

// Phase 12.5.3.7: carousel renderer(mediaCarouselRenderer.ts)도 동일한 XML escape가
// 필요해 export한다 - 로직 복제 없음(injection 방지 규칙이 두 파일에서 갈라지지 않게).
export function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 한글/한자/가나 등 "정사각형에 가까운" 글자는 폭을 fontSize와 거의 같게, 그 외(라틴/숫자/
// 기호)는 평균 0.58배로 어림한다 - 실제 폰트 metrics를 측정하지 않는 대신 넉넉히 보수적으로
// 잡아(실제보다 넓게 어림) 카드 밖으로 넘치기보다 조금 일찍 줄바꿈하는 쪽으로 치우친다.
function isWideChar(ch: string): boolean {
  const code = ch.codePointAt(0) || 0;
  return (
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0x1100 && code <= 0x11ff) || // 한글 자모
    (code >= 0x3130 && code <= 0x318f) || // 한글 호환 자모
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 통합 한자
    (code >= 0x3040 && code <= 0x30ff) || // 히라가나/가타카나
    (code >= 0xff00 && code <= 0xffef) // 전각 형태
  );
}

function charWidth(ch: string, fontSize: number): number {
  return isWideChar(ch) ? fontSize : fontSize * 0.58;
}

function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch, fontSize);
  return width;
}

// 결정론적 줄바꿈: 같은 입력은 항상 같은 줄 배열을 만든다(폰트 렌더링 엔진의 실측 대신
// 위 어림 규칙만 사용하므로 host/OS가 달라져도 결과가 바뀌지 않는다). maxLines를 넘기면
// 마지막 줄 끝에 ellipsis(…)를 붙이고 자른다.
export function wrapTextDeterministic(text: string, fontSize: number, maxWidth: number, maxLines: number): string[] {
  const chars = Array.from(text);
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const ch of chars) {
    const w = charWidth(ch, fontSize);
    if (currentWidth + w > maxWidth && current.length > 0) {
      lines.push(current);
      current = "";
      currentWidth = 0;
      if (lines.length === maxLines) break;
    }
    current += ch;
    currentWidth += w;
  }
  if (lines.length < maxLines && current.length > 0) lines.push(current);

  const consumedChars = lines.reduce((sum, l) => sum + l.length, 0);
  if (consumedChars < chars.length && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 0 && estimateTextWidth(last + "…", fontSize) > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = last + "…";
  }
  return lines;
}

// 블록 하나(상품명/가격/강점)를 그리고 다음 블록이 시작할 y좌표를 돌려준다 - preset마다
// 블록 "순서"와 "크기"만 다를 뿐 그리는 방식 자체는 공유한다(요청서 4·5절: currency
// symbol/새 문구를 발명하지 않고, missing 값은 블록 자체를 생략).
function pushLabelBlock(parts: string[], y: number, fontSize: number, maxLines: number, maxWidth: number, displayLabel: string): number {
  const lines = wrapTextDeterministic(displayLabel, fontSize, maxWidth, maxLines);
  for (const line of lines) {
    parts.push(`<text x="${TEXT_PADDING_X}" y="${y}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="700" fill="#111111">${escapeXml(line)}</text>`);
    y += Math.round(fontSize * 1.19);
  }
  return y + 10;
}

function pushPriceBlock(parts: string[], y: number, fontSize: number, priceLabel: string, priceValue: number): number {
  const priceText = `${priceLabel} ${priceValue.toLocaleString("en-US")}`;
  parts.push(`<text x="${TEXT_PADDING_X}" y="${y}" font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="#1a1a1a">${escapeXml(priceText)}</text>`);
  return y + Math.round(fontSize * 1.33) + 10;
}

function pushStrengthBlock(parts: string[], y: number, fontSize: number, maxLines: number, maxWidth: number, firstStrengthText: string): number {
  const lines = wrapTextDeterministic(firstStrengthText, fontSize, maxWidth, maxLines);
  for (const line of lines) {
    parts.push(`<text x="${TEXT_PADDING_X}" y="${y}" font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="#444444">${escapeXml(line)}</text>`);
    y += Math.round(fontSize * 1.29);
  }
  return y + 10;
}

// export 이유: 테스트가 PNG 픽셀을 직접 판독하지 않고도 XML escape/텍스트 생략 규칙을 문자열
// 레벨에서 직접 검증할 수 있게 한다(요청서 20절 M/J 테스트).
//
// composition별 블록 "순서/크기"만 다르다(요청서 4절) - 그리는 방식/escape/wrap 규칙은
// 공유한다. 세 preset 모두 실제로 다른 좌표·폰트크기·순서를 쓰므로 실제로 다른 PNG 바이트를
// 만든다(같은 입력이면 각 preset 내부적으로는 여전히 결정론적).
export function buildProductRadarCardOverlaySvg(input: ProductRadarSingleCardInput): string {
  const composition = resolveComposition(input);
  const labels = LANGUAGE_LABELS[input.language];
  const maxTextWidth = PRODUCT_RADAR_CARD_WIDTH - TEXT_PADDING_X * 2;
  const textAreaHeight = PRODUCT_RADAR_CARD_HEIGHT - IMAGE_AREA_HEIGHT_BY_COMPOSITION[composition];
  const parts: string[] = [];
  let y = 70;

  if (composition === "price_focus") {
    // 가격을 가장 크게, 상단
    if (input.priceValue !== null) y = pushPriceBlock(parts, y, 90, labels.priceLabel, input.priceValue);
    y = pushLabelBlock(parts, y, 44, 2, maxTextWidth, input.displayLabel);
    if (input.firstStrengthText) y = pushStrengthBlock(parts, y, 32, 2, maxTextWidth, input.firstStrengthText);
  } else if (composition === "recommendation_focus") {
    // 첫 강점을 가장 크게, 상단
    if (input.firstStrengthText) y = pushStrengthBlock(parts, y, 48, 3, maxTextWidth, input.firstStrengthText);
    y = pushLabelBlock(parts, y, 40, 2, maxTextWidth, input.displayLabel);
    if (input.priceValue !== null) y = pushPriceBlock(parts, y, 32, labels.priceLabel, input.priceValue);
  } else {
    // product_focus(기존 V1 레이아웃과 동일 좌표/크기 - 요청서 10절 하위호환): 상품명 -> 가격 -> 강점
    y = pushLabelBlock(parts, y, 52, 2, maxTextWidth, input.displayLabel);
    if (input.priceValue !== null) y = pushPriceBlock(parts, y, 42, labels.priceLabel, input.priceValue);
    if (input.firstStrengthText) y = pushStrengthBlock(parts, y, 34, 2, maxTextWidth, input.firstStrengthText);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PRODUCT_RADAR_CARD_WIDTH}" height="${textAreaHeight}"><rect width="${PRODUCT_RADAR_CARD_WIDTH}" height="${textAreaHeight}" fill="#ffffff"/>${parts.join("")}</svg>`;
}

// source 이미지를 상단 고정 영역(1080 x IMAGE_AREA_HEIGHT_BY_COMPOSITION[composition])에
// fit:cover로 맞춘다 - 종횡비를 유지하면서(늘리거나 찌그러뜨리지 않음) 영역을 정확히 채우고,
// 영역 밖으로는 절대 튀어나가지 않는다(composite 좌표가 고정 사각형이므로 구조적으로 보장됨).
export async function renderProductRadarSingleCard(input: ProductRadarSingleCardInput): Promise<Buffer> {
  const composition = resolveComposition(input);
  const imageAreaHeight = IMAGE_AREA_HEIGHT_BY_COMPOSITION[composition];
  // 이 함수는 항상 validateSourceImageBuffer()를 이미 통과한 buffer만 받지만(요청서 4절
  // 계약), 어드버서리얼 리뷰 지적대로 렌더러 자신도 독립적으로 decompression-bomb 가드를
  // 갖춰야 defense-in-depth가 성립한다 - imageValidation.ts가 이미 검증에 쓰는 동일 상한을
  // 재사용한다(새 상수 발명 없음).
  const resizedImage = await sharp(input.sourceImageBuffer, { limitInputPixels: MAX_SOURCE_IMAGE_PIXELS })
    .resize(PRODUCT_RADAR_CARD_WIDTH, imageAreaHeight, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();

  const overlaySvg = buildProductRadarCardOverlaySvg(input);

  return sharp({
    create: { width: PRODUCT_RADAR_CARD_WIDTH, height: PRODUCT_RADAR_CARD_HEIGHT, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([
      { input: resizedImage, top: 0, left: 0 },
      { input: Buffer.from(overlaySvg), top: imageAreaHeight, left: 0 },
    ])
    .png()
    .toBuffer();
}
