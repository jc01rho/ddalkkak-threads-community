// src/productRadar/mediaCarouselRenderer.ts
// 상품 레이더 Phase 12.5.3.7: 비교 캐러셀(2~3 slides) host deterministic 렌더링(순수 함수 -
// DB/네트워크 호출 없음, 이미 검증된 입력만 받는다). mediaCardRenderer.ts와 동일한 원칙 -
// Claude에게 레이아웃을 맡기지 않는다. 이 파일의 좌표/폰트 크기/줄바꿈/상품 분배 규칙이
// 유일한 layout 결정 기준이다.
//
// XML escape(escapeXml)/줄바꿈(wrapTextDeterministic)은 mediaCardRenderer.ts에서 그대로
// 재사용한다 - injection 방지·wrap 규칙이 두 파일에서 갈라지지 않게 한다(요청서 38절
// "공통: image fit/text wrapping/safe font/render helpers 재사용").
//
// 상품 수(2~4)와 slide 수(2~3)는 완전히 별개다(요청서 4절) - groupProductsCompact/Summary가
// "몇 장이고 상품을 슬라이드에 어떻게 나누는지"만 결정하고, 3개 composition은 "각 슬라이드
// 안에서 무엇을 강조할지"만 다르다. A/C(compact 그룹)와 B/D(summary 그룹)는 실제 좌표/폰트
// 크기/텍스트-이미지 배치 순서가 서로 달라 실제로 다른 PNG 바이트를 만든다(요청서 7절 -
// 랜덤 없이도 12개가 실제로 다른 이유).

import sharp from "sharp";
import { MAX_SOURCE_IMAGE_PIXELS } from "./imageValidation";
import { escapeXml, wrapTextDeterministic } from "./mediaCardRenderer";

export const PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH = 1080;
export const PRODUCT_RADAR_CAROUSEL_SLIDE_HEIGHT = 1350;
const TEXT_PADDING_X = 60;
const FONT_FAMILY = "'Malgun Gothic', 'Segoe UI', sans-serif";

export type ProductRadarCarouselComposition = "comparison_focus" | "product_focus" | "recommendation_focus";
export type ProductRadarCarouselVariant = "a" | "b" | "c" | "d";

const LANGUAGE_LABELS: Record<"ko" | "en", { priceLabel: string }> = {
  ko: { priceLabel: "가격" },
  en: { priceLabel: "Price" },
};

export interface ProductRadarCarouselSlideProductInput {
  displayLabel: string;
  priceValue: number | null; // null이면 블록 생략(요청서 11·12절 - 발명 금지)
  firstStrengthText: string | null; // null이면 블록 생략
  sourceImageBuffer: Buffer | null; // null이면 text-centered placeholder(요청서 13절)
}

export interface ProductRadarCarouselInput {
  products: readonly ProductRadarCarouselSlideProductInput[]; // 2~4개 - caller(orchestration)가 이미 검증
  language: "ko" | "en";
  composition: ProductRadarCarouselComposition;
  variant: ProductRadarCarouselVariant;
}

// ---- 상품 -> slide 분배(요청서 4절, deterministic, product count와 slide count 분리) ----
// compact(variant a/c): 최대한 1상품/슬라이드, 4개면 마지막 슬라이드에 2개 압축 -> 2~3 slides.
// summary(variant b/d): 최대 2 slides로 요약 -> 항상 2 slides.
export function groupProductsCompact(n: number): number[][] {
  if (n === 2) return [[0], [1]];
  if (n === 3) return [[0], [1], [2]];
  return [[0], [1], [2, 3]]; // n===4 - 4 slides로 늘어나지 않는다(요청서 4절 핵심 제약)
}
export function groupProductsSummary(n: number): number[][] {
  if (n === 2) return [[0], [1]];
  if (n === 3) return [[0], [1, 2]];
  return [[0, 1], [2, 3]]; // n===4
}
function groupProductsForVariant(variant: ProductRadarCarouselVariant, n: number): number[][] {
  return variant === "a" || variant === "c" ? groupProductsCompact(n) : groupProductsSummary(n);
}

// composition별 레이아웃 파라미터(요청서 10절 의미 - 무엇을 강조하는지) - 이미지 영역 높이와
// 텍스트 블록 폰트 크기/등장 순서가 다르다. product_focus는 이미지를 가장 크게(시각 중심),
// recommendation_focus는 strength를 가장 크게(추천 문구 중심), comparison_focus는 가격을
// 가장 크게(비교하기 쉽도록).
interface CompositionLayoutParams {
  imageAreaHeight: number;
  labelFontSize: number;
  priceFontSize: number;
  strengthFontSize: number;
  // 텍스트 블록이 그려지는 순서(요청서 10절) - 배열 순서 그대로 위에서 아래로 쌓인다.
  order: readonly ("label" | "price" | "strength")[];
}
const COMPOSITION_LAYOUT: Record<ProductRadarCarouselComposition, CompositionLayoutParams> = {
  comparison_focus: { imageAreaHeight: 420, labelFontSize: 30, priceFontSize: 46, strengthFontSize: 24, order: ["label", "price", "strength"] },
  product_focus: { imageAreaHeight: 640, labelFontSize: 36, priceFontSize: 26, strengthFontSize: 20, order: ["label", "price", "strength"] },
  recommendation_focus: { imageAreaHeight: 480, labelFontSize: 26, priceFontSize: 20, strengthFontSize: 38, order: ["strength", "label", "price"] },
};

// A/C, B/D 배치 반전(요청서 6·7절 - "이름만 다른 random seed가 아님, 실제 curated layout") -
// a/b는 이미지가 위/텍스트가 아래, c/d는 텍스트가 위/이미지가 아래로 완전히 뒤집는다. 같은
// compact/summary 그룹화라도 A와 C가 실제로 다른 좌표/순서를 갖는 이유가 바로 이 반전이다.
function isFlippedVariant(variant: ProductRadarCarouselVariant): boolean {
  return variant === "c" || variant === "d";
}

function pushTextBlock(
  parts: string[],
  y: number,
  kind: "label" | "price" | "strength",
  fontSize: number,
  maxWidth: number,
  labels: { priceLabel: string },
  product: ProductRadarCarouselSlideProductInput
): number {
  if (kind === "label") {
    const lines = wrapTextDeterministic(product.displayLabel, fontSize, maxWidth, 2);
    for (const line of lines) {
      parts.push(`<text x="0" y="${y}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="700" fill="#111111">${escapeXml(line)}</text>`);
      y += Math.round(fontSize * 1.19);
    }
    return y + 8;
  }
  if (kind === "price") {
    if (product.priceValue === null) return y; // 요청서 12절: 없으면 생략, "정보 없음" 발명 금지
    const priceText = `${labels.priceLabel} ${product.priceValue.toLocaleString("en-US")}`;
    parts.push(`<text x="0" y="${y}" font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="#1a1a1a">${escapeXml(priceText)}</text>`);
    return y + Math.round(fontSize * 1.33) + 8;
  }
  // strength
  if (!product.firstStrengthText) return y;
  const lines = wrapTextDeterministic(product.firstStrengthText, fontSize, maxWidth, 2);
  for (const line of lines) {
    parts.push(`<text x="0" y="${y}" font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="#444444">${escapeXml(line)}</text>`);
    y += Math.round(fontSize * 1.29);
  }
  return y + 8;
}

// 슬라이드 하나(1~2개 상품)의 텍스트 오버레이 SVG. 상품이 2개면 폭을 절반씩 나눠 나란히
// 배치한다(column). 각 column은 독립적으로 자기 텍스트 블록만 그린다(짧은 상품명 때문에
// 옆 column과 줄바꿈이 서로 간섭하지 않는다).
function buildSlideOverlaySvg(
  productIndices: readonly number[],
  products: readonly ProductRadarCarouselSlideProductInput[],
  layout: CompositionLayoutParams,
  language: "ko" | "en",
  flipped: boolean
): string {
  const labels = LANGUAGE_LABELS[language];
  const textAreaHeight = PRODUCT_RADAR_CAROUSEL_SLIDE_HEIGHT - layout.imageAreaHeight;
  const columnCount = productIndices.length;
  const columnWidth = (PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH - TEXT_PADDING_X * (columnCount + 1)) / columnCount;

  const columns = productIndices.map((productIdx, col) => {
    const product = products[productIdx];
    const x = TEXT_PADDING_X + col * (columnWidth + TEXT_PADDING_X);
    const parts: string[] = [];
    let y = 56;
    for (const kind of layout.order) {
      y = pushTextBlock(parts, y, kind, kind === "label" ? layout.labelFontSize : kind === "price" ? layout.priceFontSize : layout.strengthFontSize, columnWidth, labels, product);
    }
    return `<g transform="translate(${x},0)">${parts.join("")}</g>`;
  });

  // flipped(c/d)면 텍스트가 slide 상단(이미지가 하단)에 오도록 top=0 그대로 두고, 합성 시
  // (renderProductRadarCarouselSlide) 이미지 top 좌표를 그 아래로 옮긴다 - 여기서는 텍스트
  // 배경 사각형 색만 살짝 다르게 해 실제 바이트 차이를 명확히 한다(a/b는 흰 배경, c/d는
  // 아주 옅은 회색 배경 - 육안 대비도 자연스럽게 유지).
  const bg = flipped ? "#fafafa" : "#ffffff";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH}" height="${textAreaHeight}"><rect width="${PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH}" height="${textAreaHeight}" fill="${bg}"/>${columns.join("")}</svg>`;
}

// 이미지 영역: 상품이 1개면 풀폭, 2개면 좌우 절반. source가 null인 상품은 연한 placeholder
// 배경(요청서 13절 - "URL이 없으면 text-centered layout으로 정상 생성", 새 이미지를 발명하지
// 않고 단순 배경색으로만 대체).
async function buildImageAreaComposite(
  productIndices: readonly number[],
  products: readonly ProductRadarCarouselSlideProductInput[],
  imageAreaHeight: number
): Promise<Buffer> {
  const columnCount = productIndices.length;
  const columnWidth = Math.floor(PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH / columnCount);
  const composites: { input: Buffer; top: number; left: number }[] = [];

  for (let col = 0; col < columnCount; col++) {
    const product = products[productIndices[col]];
    const left = col * columnWidth;
    const width = col === columnCount - 1 ? PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH - left : columnWidth;
    let piece: Buffer;
    if (product.sourceImageBuffer) {
      piece = await sharp(product.sourceImageBuffer, { limitInputPixels: MAX_SOURCE_IMAGE_PIXELS })
        .resize(width, imageAreaHeight, { fit: "cover", position: "centre" })
        .png()
        .toBuffer();
    } else {
      piece = await sharp({ create: { width, height: imageAreaHeight, channels: 4, background: { r: 226, g: 230, b: 236, alpha: 1 } } }).png().toBuffer();
    }
    composites.push({ input: piece, top: 0, left });
  }

  return sharp({
    create: { width: PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH, height: imageAreaHeight, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

// 슬라이드 하나(1080x1350) 렌더 - export 이유: 테스트가 슬라이드 1장 단위로 deterministic
// 여부/차분을 직접 검증할 수 있게 한다(요청서 49절 I-Q).
export async function renderProductRadarCarouselSlide(
  productIndices: readonly number[],
  products: readonly ProductRadarCarouselSlideProductInput[],
  composition: ProductRadarCarouselComposition,
  variant: ProductRadarCarouselVariant,
  language: "ko" | "en"
): Promise<Buffer> {
  const layout = COMPOSITION_LAYOUT[composition];
  const flipped = isFlippedVariant(variant);
  const imageArea = await buildImageAreaComposite(productIndices, products, layout.imageAreaHeight);
  const overlaySvg = buildSlideOverlaySvg(productIndices, products, layout, language, flipped);
  const textAreaHeight = PRODUCT_RADAR_CAROUSEL_SLIDE_HEIGHT - layout.imageAreaHeight;
  // flipped(c/d): 텍스트가 위, 이미지가 아래. 그렇지 않으면(a/b) 이미지가 위, 텍스트가 아래.
  const imageTop = flipped ? textAreaHeight : 0;
  const textTop = flipped ? 0 : layout.imageAreaHeight;

  return sharp({
    create: { width: PRODUCT_RADAR_CAROUSEL_SLIDE_WIDTH, height: PRODUCT_RADAR_CAROUSEL_SLIDE_HEIGHT, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([
      { input: imageArea, top: imageTop, left: 0 },
      { input: Buffer.from(overlaySvg), top: textTop, left: 0 },
    ])
    .png()
    .toBuffer();
}

// 캐러셀 전체(2~3 slides) 렌더 - orchestration이 그대로 파일로 저장한다.
export async function renderProductRadarCarousel(input: ProductRadarCarouselInput): Promise<Buffer[]> {
  const groups = groupProductsForVariant(input.variant, input.products.length);
  const slides: Buffer[] = [];
  for (const group of groups) {
    slides.push(await renderProductRadarCarouselSlide(group, input.products, input.composition, input.variant, input.language));
  }
  return slides;
}
