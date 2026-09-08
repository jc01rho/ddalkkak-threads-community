// src/routes/productRadar/library.ts
// 상품 레이더 Phase 12.5.3.6: 미디어 보관함 API. 생성된 미디어(product_radar_media_jobs)와
// 사용자 업로드 미디어(product_radar_library_assets)를 하나의 목록에서 조회하고, 업로드/찜/
// draft attach/폴더 열기를 제공한다.
//
// local-first(요청서 1·9절): 여기서 다루는 모든 파일은 실제로 config.UPLOAD_DIR(로컬 디스크)
// 에 있고, public URL을 생성하는 코드가 이 파일 어디에도 없다 - product_radar_uploads(공개
// 게이트웨이)는 전혀 건드리지 않는다.
//
// 업로드는 attach가 아니다(요청서 20절) - 이 파일의 /assets/upload는 draft를 전혀 참조하지
// 않는다(body에 draftId조차 없음). draft에 적용하려면 반드시 별도 /assets/attach를
// 명시적으로 호출해야 한다.
//
// origin은 항상 server-authoritative(요청서 14절) - client가 origin 값을 body로 보낼 방법이
// 이 파일 어디에도 없다(generated는 product_radar_media_jobs에서, uploaded는
// product_radar_library_assets에서만 각각 읽힌다 - 두 테이블은 완전히 분리돼 있다).

import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { ZipFile } from "yazl";
import { config } from "../../env";
import { mediaFileExists, resolveMediaPath, saveValidatedMedia, UploadedFileLike, validateUploadedFile } from "../../mediaUpload";
import {
  createProductRadarLibraryAsset,
  favoriteProductRadarMediaAsset,
  getProductRadarLibraryAssetById,
  isProductRadarMediaFavorited,
  listProductRadarLibraryAssetFilesByAssetId,
  listProductRadarLibraryItems,
  parseProductRadarLibraryAssetKey,
  ProductRadarLibraryAssetFileInput,
  ProductRadarLibraryCategory,
  unfavoriteProductRadarMediaAsset,
} from "../../productRadar/libraryPersistence";
import { openMediaLibraryFolder } from "../../productRadar/mediaLibraryFolder";
import { getProductRadarMediaJobById, listProductRadarMediaFilesByJobId } from "../../productRadar/mediaPersistence";

const router = Router();

// affiliate.ts와 같은 이유로 utf8을 명시합니다: multer 기본값 latin1에서는 한글 파일명이 깨집니다.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_MEDIA_UPLOAD_BYTES },
  defParamCharset: "utf8",
});

const ALLOWED_CATEGORIES: ReadonlySet<string> = new Set(["image", "carousel", "video", "gif"]);
function isLibraryCategory(v: unknown): v is ProductRadarLibraryCategory {
  return typeof v === "string" && ALLOWED_CATEGORIES.has(v);
}

// 카테고리별 파일 개수/허용 확장자(요청서 2·16절 - 실제 mediaUpload.ts 검증 범위 안에서만).
// "짤"은 이번 Phase에서는 GIF로만 지원한다(요청서 2절 - MP4 짤 같은 의미 기반 자동분류를
// 새로 만들지 않는다). image/carousel에서는 gif를 제외해 카테고리 의미를 명확히 구분한다.
const CATEGORY_RULES: Record<ProductRadarLibraryCategory, { minFiles: number; maxFiles: number; allowedExt: ReadonlySet<string> }> = {
  image: { minFiles: 1, maxFiles: 1, allowedExt: new Set([".jpg", ".jpeg", ".png", ".webp"]) },
  carousel: { minFiles: 2, maxFiles: 3, allowedExt: new Set([".jpg", ".jpeg", ".png", ".webp"]) },
  video: { minFiles: 1, maxFiles: 1, allowedExt: new Set([".mp4", ".mov", ".webm"]) },
  gif: { minFiles: 1, maxFiles: 1, allowedExt: new Set([".gif"]) },
};

function extOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx === -1 ? "" : filename.slice(idx).toLowerCase();
}

function sendLibraryError(res: import("express").Response, status: number, code: string): void {
  res.status(status).json({ ok: false, error: { code } });
}

// ---- GET /assets - 통합 목록(요청서 12·13절 필터: category/origin, 32절 limit/offset) ----
const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;

router.get("/assets", (req, res) => {
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;

  const categoryFilter = typeof req.query.category === "string" && isLibraryCategory(req.query.category) ? req.query.category : null;
  const originFilter = req.query.origin === "generated" || req.query.origin === "user_upload" ? req.query.origin : null;
  const favoritedOnly = req.query.favoritedOnly === "true";

  // 필터가 있으면 넉넉히 더 가져온 뒤 걸러서 자른다(간단한 필터-후-페이지 방식 - 요청서
  // 32절 "더 보기" 수준의 pagination에는 충분하다, 과도한 쿼리 최적화는 하지 않는다).
  const fetchLimit = categoryFilter || originFilter || favoritedOnly ? MAX_LIST_LIMIT * 4 : limit;
  const { items, total } = listProductRadarLibraryItems({ limit: fetchLimit, offset: categoryFilter || originFilter || favoritedOnly ? 0 : offset });

  let filtered = items;
  if (categoryFilter) filtered = filtered.filter((it) => it.category === categoryFilter);
  if (originFilter) filtered = filtered.filter((it) => it.origin === originFilter);
  if (favoritedOnly) filtered = filtered.filter((it) => it.favorited);
  const page = categoryFilter || originFilter || favoritedOnly ? filtered.slice(offset, offset + limit) : filtered;

  res.status(200).json({ ok: true, items: page, total: categoryFilter || originFilter || favoritedOnly ? filtered.length : total });
});

// ---- POST /assets/upload - 사용자 업로드(요청서 16·17·20절) ----
// multipart form: category(text field) + files(최대 3개). 업로드 자체는 draft를 전혀
// 참조하지 않는다 - body에 draftId가 없다(요청서 20절 "업로드 = attach 아님").
function handleLibraryUpload(req: any, res: any, next: any) {
  upload.array("files", 3)(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return sendLibraryError(res, 400, "file_too_large");
    }
    return sendLibraryError(res, 400, "upload_failed");
  });
}

router.post("/assets/upload", handleLibraryUpload, async (req: any, res) => {
  const category = req.body?.category;
  if (!isLibraryCategory(category)) {
    return sendLibraryError(res, 400, "invalid_category");
  }
  const rule = CATEGORY_RULES[category];
  const files: Express.Multer.File[] = Array.isArray(req.files) ? req.files : [];
  if (files.length < rule.minFiles || files.length > rule.maxFiles) {
    return sendLibraryError(res, 400, "invalid_file_count");
  }

  // 각 파일: 기존 mediaUpload.ts 검증(확장자+MIME+매직바이트) 통과 + 이 카테고리가 허용하는
  // 확장자인지 추가 확인(요청서 16절 - 검증 불충분한 format을 "지원"한다고 표시하지 않는다).
  const validatedList: { file: UploadedFileLike; ext: string; type: "image" | "video" }[] = [];
  for (const f of files) {
    const fileLike: UploadedFileLike = { buffer: f.buffer, originalname: f.originalname, mimetype: f.mimetype, size: f.size };
    const validation = validateUploadedFile(fileLike);
    if (!validation.ok) {
      return sendLibraryError(res, 400, "invalid_file");
    }
    if (!rule.allowedExt.has(validation.ext)) {
      return sendLibraryError(res, 400, "invalid_file_type_for_category");
    }
    validatedList.push({ file: fileLike, ext: validation.ext, type: validation.type });
  }

  // 검증을 전부 통과한 뒤에만 디스크에 쓴다(기존 saveValidatedMedia 원칙 - 요청서 17절
  // "temp -> final atomic"과 동일하게, 검증 실패한 파일은 애초에 디스크에 닿지 않는다).
  const savedInputs: ProductRadarLibraryAssetFileInput[] = [];
  try {
    for (let i = 0; i < validatedList.length; i++) {
      const { file, ext, type } = validatedList[i];
      const saved = saveValidatedMedia(file, { type, ext });
      let width: number | null = null;
      let height: number | null = null;
      if (type === "image") {
        try {
          const meta = await sharp(file.buffer).metadata();
          width = meta.width ?? null;
          height = meta.height ?? null;
        } catch {
          // 메타데이터를 못 읽어도(예: 일부 GIF variant) 업로드 자체는 유지한다 - width/height는
          // 표시용 부가정보일 뿐 저장/서빙 안전성과 무관하다.
        }
      }
      savedInputs.push({
        filename: saved.filename,
        mime: saved.mime,
        byteSize: file.size,
        width,
        height,
        slideIndex: category === "carousel" ? i : null, // 요청서 19절: 업로드 순서를 그대로 slideIndex로 보존(파일명 정렬로 재확정하지 않음)
      });
    }
  } catch {
    return sendLibraryError(res, 500, "local_save_failed");
  }

  const rawOriginalName = typeof req.body?.originalName === "string" ? req.body.originalName : files[0]?.originalname || null;
  // 원본 파일명은 표시용 metadata뿐이다(요청서 18절) - 태그 제거 + 길이 제한만 적용.
  const originalName = rawOriginalName ? String(rawOriginalName).replace(/<[^>]*>/g, "").trim().slice(0, 200) || null : null;

  const created = createProductRadarLibraryAsset(category, originalName, savedInputs);
  res.status(201).json({
    ok: true,
    assetKey: `upload:${created.asset.id}`,
    category: created.asset.category,
    originalName: created.asset.originalName,
    files: created.files.map((f) => ({ filename: f.filename, slideIndex: f.slideIndex, width: f.width, height: f.height })),
  });
});

// ---- 미디어 찜(요청서 23절) - generated/uploaded 공용 ----
router.post("/assets/:assetKey/favorite", (req, res) => {
  const parsed = parseProductRadarLibraryAssetKey(req.params.assetKey);
  if (!parsed) return sendLibraryError(res, 400, "invalid_asset_key");
  favoriteProductRadarMediaAsset(req.params.assetKey);
  res.status(200).json({ ok: true, favorited: true });
});
router.delete("/assets/:assetKey/favorite", (req, res) => {
  const parsed = parseProductRadarLibraryAssetKey(req.params.assetKey);
  if (!parsed) return sendLibraryError(res, 400, "invalid_asset_key");
  unfavoriteProductRadarMediaAsset(req.params.assetKey);
  res.status(200).json({ ok: true, favorited: false });
});

// ---- POST /assets/attach - "이 미디어 사용"(요청서 20·21절) ----

// ---- GET /assets/:assetKey/zip - 전체 파일 ZIP 다운로드(요청서 28·29절) ----
// yazl(exact-pin, 수제 ZIP 아님)로 on-demand streaming - 디스크에 영구 zip을 만들지 않고
// 요청마다 즉석에서 조립해 응답 스트림으로 바로 흘려보낸다. attachment/favorite/approval에
// 어떤 side effect도 없다(순수 read + stream). entry 이름은 slideIndex 순서를 기반으로
// 서버가 고정 생성한다(slide-01.png 등) - 업로드 시 사용자가 입력한 원본 파일명은 여기 전혀
// 쓰이지 않는다(요청서 28절 traversal-safe/고정 이름). 실제 디스크 경로는
// resolveMediaPath()(mediaUpload.ts, path traversal 구조적 차단)로만 얻는다.
router.get("/assets/:assetKey/zip", (req, res) => {
  const parsed = parseProductRadarLibraryAssetKey(req.params.assetKey);
  if (!parsed) return sendLibraryError(res, 400, "invalid_asset_key");

  let files: { filename: string; slideIndex: number | null }[];
  if (parsed.origin === "generated") {
    const job = getProductRadarMediaJobById(parsed.id);
    if (!job || job.status !== "rendered") return sendLibraryError(res, 404, "product_radar_media_job_not_found");
    files = listProductRadarMediaFilesByJobId(parsed.id).map((f) => ({ filename: f.filename, slideIndex: f.slideIndex }));
  } else {
    const asset = getProductRadarLibraryAssetById(parsed.id);
    if (!asset) return sendLibraryError(res, 404, "product_radar_library_asset_not_found");
    files = listProductRadarLibraryAssetFilesByAssetId(parsed.id).map((f) => ({ filename: f.filename, slideIndex: f.slideIndex }));
  }
  if (files.length === 0) return sendLibraryError(res, 404, "product_radar_media_files_missing");

  const sorted = [...files].sort((a, b) => (a.slideIndex ?? 0) - (b.slideIndex ?? 0));
  const realPaths: { realPath: string; entryName: string }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    if (!mediaFileExists(f.filename)) return sendLibraryError(res, 404, "product_radar_media_file_missing");
    const realPath = resolveMediaPath(f.filename);
    if (!realPath) return sendLibraryError(res, 404, "product_radar_media_file_missing");
    const ext = extOf(f.filename) || ".png";
    const entryName = sorted.length > 1 ? `slide-${String(i + 1).padStart(2, "0")}${ext}` : `image${ext}`;
    realPaths.push({ realPath, entryName });
  }

  const zip = new ZipFile();
  // adversarial 리뷰 발견: yazl은 addFile() 이후 내부 fs.stat/read 실패 시 'error' 이벤트를
  // emit하는데, 리스너가 없으면 EventEmitter 기본 동작으로 예외가 던져져 Node 프로세스 전체가
  // 죽는다(mediaFileExists() 확인 직후에도 다른 프로세스가 파일을 지우는 TOCTOU 레이스로
  // 재현 가능). 헤더 전송 여부에 따라 정상 에러 응답 또는 연결 종료로만 처리한다.
  zip.on("error", () => {
    if (!res.headersSent) sendLibraryError(res, 404, "product_radar_media_file_missing");
    else res.destroy();
  });
  for (const { realPath, entryName } of realPaths) {
    zip.addFile(realPath, entryName);
  }
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="product-radar-media.zip"');
  zip.outputStream.pipe(res);
  zip.end();
});

// ---- POST /open-folder - 미디어 폴더 열기(요청서 3·4절) ----
// body 없음 - 서버가 config.UPLOAD_DIR(authoritative)만 사용한다. client가 경로를 전달할
// 방법이 이 route 어디에도 없다.
router.post("/open-folder", async (_req, res) => {
  const result = await openMediaLibraryFolder();
  if (!result.ok) {
    return sendLibraryError(res, 500, result.error === "MEDIA_FOLDER_NOT_FOUND" ? "media_folder_not_found" : "open_failed");
  }
  res.status(200).json({ ok: true });
});

export default router;
