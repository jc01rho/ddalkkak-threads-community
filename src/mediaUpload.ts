// src/mediaUpload.ts
// "쿠파스 상품 홍보 모드"의 "내 사진·영상 첨부" 전용 - 사용자가 로컬 PC에서 직접 선택한 파일만
// 다룹니다.
//
// 중요(요청서 기준 제약):
// - 쿠팡 상품 페이지의 이미지·영상을 수집하거나 다운로드하지 않습니다(이 파일은 사용자가
//   브라우저에서 직접 업로드한 바이트만 받습니다 - 외부 URL을 fetch하는 코드가 없습니다).
// - 사용자가 지정한 원본 파일명은 저장 경로 생성에 절대 사용하지 않습니다(경로 조작 방지).
//   내부 저장명은 항상 이 모듈이 crypto.randomUUID()로 새로 만듭니다.
// - 확장자/선언된 MIME/실제 파일 시그니처(매직 바이트) 세 가지를 모두 검사해, 실행 파일을
//   이미지·영상으로 위장해 올리는 것을 차단합니다.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "./env";
import { listActiveMediaFilenames } from "./database";

export type MediaType = "image" | "video";

interface MediaKind {
  type: MediaType;
  mime: string;
}

// 확장자 → (분류, 정규 MIME) 매핑. 이 목록에 없는 확장자는 무조건 거부합니다.
const ALLOWED_EXTENSIONS: Record<string, MediaKind> = {
  ".jpg": { type: "image", mime: "image/jpeg" },
  ".jpeg": { type: "image", mime: "image/jpeg" },
  ".png": { type: "image", mime: "image/png" },
  ".gif": { type: "image", mime: "image/gif" },
  ".webp": { type: "image", mime: "image/webp" },
  ".mp4": { type: "video", mime: "video/mp4" },
  ".mov": { type: "video", mime: "video/quicktime" },
  ".webm": { type: "video", mime: "video/webm" },
};

// 확장자와 무관하게, 브라우저가 보낸 Content-Type이 최소한 이 목록에는 있어야 합니다.
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "application/octet-stream", // 일부 브라우저/OS가 영상 파일에 이 값을 보내는 경우가 있어 허용(시그니처 검사로 최종 판정)
]);

export interface UploadedFileLike {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export type FileValidationResult = { ok: true; type: MediaType; ext: string } | { ok: false; error: string };

// 파일 내용 앞부분(매직 바이트)으로 실제 형식을 판정합니다. 확장자나 브라우저가 보낸 Content-Type을
// 그대로 믿지 않고, 파일 자체의 시그니처를 직접 확인합니다(실행 파일 위장 차단의 핵심).
export function detectMediaKindFromBuffer(buf: Buffer): MediaType | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image"; // JPEG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image"; // PNG
  if (buf.subarray(0, 4).toString("ascii") === "GIF8") return "image"; // GIF87a/GIF89a
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image"; // WEBP
  const atom4 = buf.subarray(4, 8).toString("ascii");
  if (atom4 === "ftyp") return "video"; // MP4/MOV(QuickTime 계열)
  if (["moov", "free", "wide", "mdat", "skip"].includes(atom4)) return "video"; // 구형 QuickTime(.mov)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "video"; // WebM/EBML
  return null;
}

// 업로드된 파일이 이미지/영상으로 허용 가능한지 확인합니다. 확장자, 선언된 MIME, 실제 파일
// 시그니처가 모두 "같은 분류(이미지 또는 영상)"를 가리켜야 통과합니다.
export function validateUploadedFile(file: UploadedFileLike): FileValidationResult {
  if (!file || !file.buffer || file.size <= 0) {
    return { ok: false, error: "업로드된 파일이 비어 있습니다." };
  }
  if (file.size > config.MAX_MEDIA_UPLOAD_BYTES) {
    const maxMb = Math.floor(config.MAX_MEDIA_UPLOAD_BYTES / (1024 * 1024));
    return { ok: false, error: `첨부 파일이 너무 큽니다(최대 ${maxMb}MB).` };
  }

  // 원본 파일명은 확장자 판정에만 사용하고, 저장 경로에는 절대 쓰지 않습니다.
  const ext = path.extname(file.originalname || "").toLowerCase();
  const kindByExt = ALLOWED_EXTENSIONS[ext];
  if (!kindByExt) {
    return { ok: false, error: "지원하지 않는 파일 형식입니다. jpg/png/gif/webp 이미지 또는 mp4/mov/webm 영상만 첨부할 수 있습니다." };
  }

  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return { ok: false, error: `허용되지 않는 파일 유형입니다(${file.mimetype}).` };
  }

  const detected = detectMediaKindFromBuffer(file.buffer);
  if (!detected) {
    return { ok: false, error: "파일 내용을 이미지·영상으로 확인할 수 없습니다. 실제 사진·영상 파일만 첨부해주세요." };
  }
  if (detected !== kindByExt.type) {
    return { ok: false, error: "파일 확장자와 실제 파일 내용이 일치하지 않습니다(위장된 파일일 수 있습니다)." };
  }

  return { ok: true, type: kindByExt.type, ext };
}

// 내부 저장 파일명은 항상 이 정규식과 일치합니다(랜덤 UUID + 허용 확장자). 다른 경로에서
// 이 형식이 아닌 값이 들어오면 전부 거부해 경로 조작(../ 등)을 원천 차단합니다.
const SAFE_FILENAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|gif|webp|mp4|mov|webm)$/;

export function isSafeMediaFilename(filename: string): boolean {
  return typeof filename === "string" && SAFE_FILENAME_PATTERN.test(filename);
}

function ensureUploadDir(): void {
  if (!fs.existsSync(config.UPLOAD_DIR)) fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
}

// resolveMediaPath는 반드시 isSafeMediaFilename()을 통과한 파일명에만 사용합니다.
// path.join 이후에도 resolve한 경로가 업로드 폴더 밖으로 나가지 않는지 한 번 더 확인합니다
// (SAFE_FILENAME_PATTERN이 이미 "../" 등을 걸러내지만, 방어를 한 겹 더 둡니다).
export function resolveMediaPath(filename: string): string | null {
  if (!isSafeMediaFilename(filename)) return null;
  const uploadDirResolved = path.resolve(config.UPLOAD_DIR);
  const full = path.resolve(uploadDirResolved, filename);
  if (!full.startsWith(uploadDirResolved + path.sep) && full !== uploadDirResolved) return null;
  return full;
}

export function getMimeForFilename(filename: string): string | null {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS[ext]?.mime || null;
}

export function getMediaTypeForFilename(filename: string): MediaType | null {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS[ext]?.type || null;
}

export interface SavedMedia {
  filename: string;
  type: MediaType;
  mime: string;
}

// 검증을 통과한 파일만 디스크에 씁니다(검증 실패한 파일은 애초에 디스크에 닿지 않습니다 -
// multer가 메모리 스토리지를 쓰기 때문에 가능합니다).
export function saveValidatedMedia(file: UploadedFileLike, validated: { type: MediaType; ext: string }): SavedMedia {
  ensureUploadDir();
  const filename = `${crypto.randomUUID()}${validated.ext}`;
  const fullPath = resolveMediaPath(filename);
  if (!fullPath) throw new Error("내부 저장 파일명 생성에 실패했습니다."); // 이 정규식은 randomUUID()로 항상 통과하므로 사실상 발생하지 않음
  fs.writeFileSync(fullPath, file.buffer);
  return { filename, type: validated.type, mime: getMimeForFilename(filename) || file.mimetype };
}

// 실패한 생성 요청이 남긴 파일을 즉시 정리할 때, 그리고 "첨부 취소" 시 사용합니다.
export function deleteMediaFileIfExists(filename: string): void {
  const fullPath = resolveMediaPath(filename);
  if (!fullPath) return;
  try {
    fs.unlinkSync(fullPath);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
}

export function mediaFileExists(filename: string): boolean {
  const fullPath = resolveMediaPath(filename);
  if (!fullPath) return false;
  return fs.existsSync(fullPath);
}

const MAX_ORIGINAL_NAME_CHARS = 200;

export interface AttachedMedia {
  filename: string;
  type: MediaType;
  mime: string;
  originalName: string;
}

export type ResolveAttachedMediaResult = { ok: true; media: AttachedMedia | null } | { ok: false; error: string };

// POST /generate가 받은 mediaFilename(선택값)을 검증합니다. 클라이언트가 보낸 값을 그대로 믿지
// 않고, ①안전한 파일명 패턴인지 ②실제로 업로드 폴더에 그 파일이 있는지를 다시 확인합니다.
// mediaFilename이 없으면(미디어 미첨부) ok:true, media:null을 돌려줍니다(요청서 4번 - 미디어는
// 선택사항이며 없어도 정상 동작해야 함).
export function resolveAttachedMedia(mediaFilename: unknown, mediaOriginalName: unknown): ResolveAttachedMediaResult {
  if (mediaFilename === undefined || mediaFilename === null || mediaFilename === "") {
    return { ok: true, media: null };
  }
  if (typeof mediaFilename !== "string" || !isSafeMediaFilename(mediaFilename)) {
    return { ok: false, error: "첨부 파일 정보가 올바르지 않습니다. 다시 첨부해주세요." };
  }
  if (!mediaFileExists(mediaFilename)) {
    return { ok: false, error: "첨부한 파일을 찾을 수 없습니다(만료되었을 수 있습니다). 다시 첨부해주세요." };
  }
  const type = getMediaTypeForFilename(mediaFilename);
  const mime = getMimeForFilename(mediaFilename);
  if (!type || !mime) {
    return { ok: false, error: "첨부 파일 정보가 올바르지 않습니다. 다시 첨부해주세요." };
  }
  const rawOriginalName = typeof mediaOriginalName === "string" ? mediaOriginalName : "";
  // 원본 파일명은 표시 용도로만 저장합니다(경로 생성에는 절대 사용하지 않음). HTML 태그 제거 +
  // 길이 제한만 적용합니다.
  const originalName = rawOriginalName.replace(/<[^>]*>/g, "").trim().slice(0, MAX_ORIGINAL_NAME_CHARS) || mediaFilename;
  return { ok: true, media: { filename: mediaFilename, type, mime, originalName } };
}

export interface SweepResult {
  deleted: string[];
  keptInUse: number;
  keptTooRecent: number;
}

// 사용하지 않는 임시 파일 정리 정책(요청서 9번):
// - 거절된 초안(6개 전부 거절 포함)만 참조하거나 아무 초안도 참조하지 않는 파일을 대상으로 합니다.
// - 방금 업로드됐지만 아직 생성 요청이 끝나지 않은 파일을 실수로 지우지 않도록, 수정 시각이
//   graceMinutes(기본 30분)보다 오래된 파일만 삭제합니다.
// - 업로드 폴더 안의 파일만 다루며, 파일명이 안전한 패턴(SAFE_FILENAME_PATTERN)일 때만 삭제합니다.
export function sweepOrphanedMedia(graceMinutes = 30): SweepResult {
  const result: SweepResult = { deleted: [], keptInUse: 0, keptTooRecent: 0 };
  if (!fs.existsSync(config.UPLOAD_DIR)) return result;

  const active = listActiveMediaFilenames();
  const graceMs = graceMinutes * 60 * 1000;
  const now = Date.now();

  for (const filename of fs.readdirSync(config.UPLOAD_DIR)) {
    if (!isSafeMediaFilename(filename)) continue; // 우리가 만들지 않은 파일은 건드리지 않음
    if (active.has(filename)) {
      result.keptInUse++;
      continue;
    }
    const fullPath = resolveMediaPath(filename);
    if (!fullPath) continue;
    const stat = fs.statSync(fullPath);
    if (now - stat.mtimeMs < graceMs) {
      result.keptTooRecent++; // 아직 생성 요청 처리 중일 수 있으므로 보류
      continue;
    }
    fs.unlinkSync(fullPath);
    result.deleted.push(filename);
  }

  return result;
}
