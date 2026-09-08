// src/productRadar/imageValidation.ts
// 상품 레이더 Phase 12.5.3.2: 원격에서 받은 이미지 바이트가 실제로 안전하게 디코드 가능한
// JPEG/PNG/WebP인지 검증하는 순수 domain(네트워크 호출 없음 - safeFetchBinary()가 이미
// 받아온 바이트만 받는다). Content-Type 헤더 하나만 믿지 않고, magic bytes(파일 시그니처) +
// 실제 sharp 디코더 결과까지 전부 일치해야 통과한다(요청서 9절).
//
// SVG(텍스트 기반이라 아래 어떤 binary magic byte 검사에도 안 걸림)와 GIF(magic byte 검사
// 목록에 의도적으로 없음)는 이 파일에서 항상 image_invalid로 거부된다 - "첫 frame만 사용"
// 같은 애매한 부분 지원 없이 명확한 실패 하나로 통일한다(요청서 9절).

import sharp from "sharp";

export type ValidatedImageFormat = "jpeg" | "png" | "webp";

// decompression bomb 방지 - sharp가 실제 디코드를 시도하기 전에 예상 픽셀 수를 먼저 확인해
// 초과하면 즉시 거부한다(약 40MP - 1080x1350 카드 소스 이미지로는 충분히 넉넉하면서도
// 수백 MB 메모리를 요구하는 악의적 입력은 막는다).
export const MAX_SOURCE_IMAGE_PIXELS = 40_000_000;

interface MagicCheck {
  format: ValidatedImageFormat;
  matches(buf: Buffer): boolean;
}

const MAGIC_CHECKS: MagicCheck[] = [
  { format: "jpeg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    format: "png",
    matches: (b) =>
      b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  { format: "webp", matches: (b) => b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

const ALLOWED_CONTENT_TYPES: Record<ValidatedImageFormat, ReadonlySet<string>> = {
  jpeg: new Set(["image/jpeg", "image/jpg"]),
  png: new Set(["image/png"]),
  webp: new Set(["image/webp"]),
};

export function detectImageFormatFromMagicBytes(buffer: Buffer): ValidatedImageFormat | null {
  for (const check of MAGIC_CHECKS) {
    if (check.matches(buffer)) return check.format;
  }
  return null;
}

export type ValidateSourceImageResult =
  | { ok: true; format: ValidatedImageFormat; width: number; height: number }
  | { ok: false; reason: "image_invalid" };

// 판정 순서: 1) magic bytes로 형식 확정(실패 -> SVG/GIF/기타 전부 image_invalid) 2) Content-Type이
// 있으면(빈 값/누락은 관대하게 통과 - CDN이 흔히 생략) 그 형식과 모순되지 않는지 확인 3) 실제
// sharp 디코더로 열어서(픽셀 상한 적용) 진짜 열리는 이미지인지, 디코더가 판단한 format도 같은지
// 확인한다. 셋 중 하나라도 어긋나면 image_invalid로 fail closed - 어느 것도 단독으로 신뢰하지 않는다.
export async function validateSourceImageBuffer(buffer: Buffer, contentType: string): Promise<ValidateSourceImageResult> {
  const magicFormat = detectImageFormatFromMagicBytes(buffer);
  if (!magicFormat) return { ok: false, reason: "image_invalid" };

  const normalizedContentType = (contentType || "").split(";")[0].trim().toLowerCase();
  if (normalizedContentType && !ALLOWED_CONTENT_TYPES[magicFormat].has(normalizedContentType)) {
    return { ok: false, reason: "image_invalid" };
  }

  try {
    const meta = await sharp(buffer, { limitInputPixels: MAX_SOURCE_IMAGE_PIXELS }).metadata();
    if (!meta.width || !meta.height || meta.format !== magicFormat) {
      return { ok: false, reason: "image_invalid" };
    }
    return { ok: true, format: magicFormat, width: meta.width, height: meta.height };
  } catch {
    return { ok: false, reason: "image_invalid" };
  }
}
