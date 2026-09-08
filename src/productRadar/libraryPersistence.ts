// src/productRadar/libraryPersistence.ts
// 상품 레이더 Phase 12.5.3.6: 미디어 보관함 persistence + 통합 read model. mediaPersistence.ts
// (product_radar_media_jobs/files, "생성된" 미디어)와 이 파일(product_radar_library_assets/
// files, "사용자가 업로드한" 미디어)은 완전히 별개 테이블이다 - client가 origin을 조작해
// 하나를 다른 쪽으로 위장할 방법이 구조적으로 없다(요청서 14절).
//
// local-first(요청서 1·9절): 여기서 다루는 모든 파일은 실제로 config.UPLOAD_DIR(로컬
// 디스크)에 존재하고, 이 파일은 그 metadata/index만 관리한다. product_radar_uploads(공개
// URL 게이트웨이)와 절대 섞이지 않는다 - public URL을 생성하는 코드가 이 파일 어디에도 없다.
//
// disk missing 처리(요청서 5·10절): 사용자가 탐색기에서 파일을 직접 지워도 DB row는 남을 수
// 있다 - authoritative는 항상 local DB고, 파일시스템을 재스캔해 DB를 재구성하지 않는다.
// 대신 조회 시점에 mediaFileExists()로 실제 존재 여부를 확인해 각 파일에 available 플래그를
// 붙인다 - 없어도 목록 자체가 죽지 않고, 그 파일만 "찾을 수 없음" 상태로 표시된다.

import { getDb, nowIso } from "../database";
import { mediaFileExists } from "../mediaUpload";
import {
  countRenderedProductRadarMediaJobs,
  listProductRadarMediaFilesByJobId,
  listProductRadarMediaFilesByJobIds,
  listProductRadarMediaJobsByIds,
  listRenderedProductRadarMediaJobs,
} from "./mediaPersistence";

export type ProductRadarLibraryCategory = "image" | "carousel" | "video" | "gif";
export type ProductRadarLibraryOrigin = "generated" | "user_upload";

export interface ProductRadarLibraryAssetFileInput {
  filename: string;
  mime: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  slideIndex: number | null;
}

interface AssetRow {
  id: number;
  category: string;
  original_name: string | null;
  created_at: string;
}
interface AssetFileRow {
  id: number;
  asset_id: number;
  slide_index: number | null;
  filename: string;
  mime: string;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface ProductRadarLibraryAssetFile {
  id: number;
  assetId: number;
  slideIndex: number | null;
  filename: string;
  mime: string;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface ProductRadarLibraryAsset {
  id: number;
  category: ProductRadarLibraryCategory;
  originalName: string | null;
  createdAt: string;
}

function hydrateAsset(row: AssetRow): ProductRadarLibraryAsset {
  return { id: row.id, category: row.category as ProductRadarLibraryCategory, originalName: row.original_name, createdAt: row.created_at };
}
function hydrateAssetFile(row: AssetFileRow): ProductRadarLibraryAssetFile {
  return {
    id: row.id,
    assetId: row.asset_id,
    slideIndex: row.slide_index,
    filename: row.filename,
    mime: row.mime,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
  };
}

// 업로드 asset + file(들)을 하나의 트랜잭션으로 저장한다(캐러셀은 파일이 여러 개, 요청서
// 19절 - 파일명 정렬로 순서를 자동 확정하지 않고 slideIndex를 그대로 보존한다). 원본 파일명은
// 표시용 metadata뿐이다(요청서 18절) - files[].filename은 이미 mediaUpload.ts의
// saveValidatedMedia()가 만든 UUID 내부 파일명이어야 한다(caller 책임, 이 함수는 그대로 저장).
export function createProductRadarLibraryAsset(
  category: ProductRadarLibraryCategory,
  originalName: string | null,
  files: ProductRadarLibraryAssetFileInput[]
): { asset: ProductRadarLibraryAsset; files: ProductRadarLibraryAssetFile[] } {
  const db = getDb();
  const ts = nowIso();
  const result = db.transaction(() => {
    const assetInfo = db.prepare("INSERT INTO product_radar_library_assets (category, original_name, created_at) VALUES (?, ?, ?)").run(category, originalName, ts);
    const assetId = Number(assetInfo.lastInsertRowid);
    const fileRows: AssetFileRow[] = [];
    for (const f of files) {
      const fileInfo = db
        .prepare(
          `INSERT INTO product_radar_library_asset_files (asset_id, slide_index, filename, mime, byte_size, width, height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(assetId, f.slideIndex, f.filename, f.mime, f.byteSize, f.width, f.height, ts);
      fileRows.push({
        id: Number(fileInfo.lastInsertRowid),
        asset_id: assetId,
        slide_index: f.slideIndex,
        filename: f.filename,
        mime: f.mime,
        byte_size: f.byteSize,
        width: f.width,
        height: f.height,
        created_at: ts,
      });
    }
    return { asset: hydrateAsset({ id: assetId, category, original_name: originalName, created_at: ts }), files: fileRows.map(hydrateAssetFile) };
  })();
  return result;
}

export function getProductRadarLibraryAssetById(id: number): ProductRadarLibraryAsset | null {
  const row = getDb().prepare("SELECT * FROM product_radar_library_assets WHERE id = ?").get(id) as AssetRow | undefined;
  return row ? hydrateAsset(row) : null;
}

export function listProductRadarLibraryAssetFilesByAssetId(assetId: number): ProductRadarLibraryAssetFile[] {
  const rows = getDb()
    .prepare("SELECT * FROM product_radar_library_asset_files WHERE asset_id = ? ORDER BY slide_index ASC, id ASC")
    .all(assetId) as AssetFileRow[];
  return rows.map(hydrateAssetFile);
}

// Phase 12.5.3.8: mediaPersistence.ts의 listProductRadarMediaJobsByIds()와 동일한 이유(초안함
// draft 목록 N+1 방지, 요청서 4절) - asset id들을 IN절 1회로 배치 조회한다.
export function listProductRadarLibraryAssetsByIds(ids: readonly number[]): ProductRadarLibraryAsset[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT * FROM product_radar_library_assets WHERE id IN (${placeholders})`).all(...ids) as AssetRow[];
  return rows.map(hydrateAsset);
}
export function listProductRadarLibraryAssetFilesByAssetIds(assetIds: readonly number[]): ProductRadarLibraryAssetFile[] {
  if (assetIds.length === 0) return [];
  const placeholders = assetIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT * FROM product_radar_library_asset_files WHERE asset_id IN (${placeholders}) ORDER BY asset_id ASC, slide_index ASC, id ASC`)
    .all(...assetIds) as AssetFileRow[];
  return rows.map(hydrateAssetFile);
}

export function listProductRadarLibraryAssets(opts: { limit: number; offset: number }): ProductRadarLibraryAsset[] {
  const rows = getDb()
    .prepare("SELECT * FROM product_radar_library_assets ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(opts.limit, opts.offset) as AssetRow[];
  return rows.map(hydrateAsset);
}
export function countProductRadarLibraryAssets(): number {
  return (getDb().prepare("SELECT COUNT(*) as c FROM product_radar_library_assets").get() as { c: number }).c;
}

// ---- 미디어 찜(요청서 23절) - generated/uploaded 공용, asset_key로만 구분 ----

export function isProductRadarMediaFavorited(assetKey: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM product_radar_media_favorites WHERE asset_key = ?").get(assetKey);
}
export function favoriteProductRadarMediaAsset(assetKey: string): void {
  getDb().prepare("INSERT OR IGNORE INTO product_radar_media_favorites (asset_key, created_at) VALUES (?, ?)").run(assetKey, nowIso());
}
export function unfavoriteProductRadarMediaAsset(assetKey: string): void {
  getDb().prepare("DELETE FROM product_radar_media_favorites WHERE asset_key = ?").run(assetKey);
}
export function listFavoritedProductRadarMediaAssetKeys(): Set<string> {
  const rows = getDb().prepare("SELECT asset_key FROM product_radar_media_favorites").all() as { asset_key: string }[];
  return new Set(rows.map((r) => r.asset_key));
}

// ---- 통합 read model(요청서 12·15절) ----

export interface ProductRadarLibraryItemFile {
  filename: string;
  slideIndex: number | null;
  width: number | null;
  height: number | null;
  available: boolean; // 요청서 5·10절: 디스크에 실제로 있는지 - 없어도 목록/응답 자체는 안전하게 유지
}

export interface ProductRadarLibraryItem {
  assetKey: string; // "job:<mediaJobId>" | "upload:<libraryAssetId>"
  origin: ProductRadarLibraryOrigin;
  category: ProductRadarLibraryCategory;
  originalName: string | null; // uploaded만 값 존재, generated는 null
  createdAt: string;
  favorited: boolean;
  files: ProductRadarLibraryItemFile[]; // 실제 미디어(다운로드/찜/attach/viewer가 그대로 참조) - GIF 자동재생 회피를 위해 목록 썸네일 용도로는 아래 thumbnailFilename을 대신 쓴다.
  // Phase 12.5.3.9 adversarial 수정: category='gif'인 generated 항목은 실제 GIF 파일이 아니라
  // motion source(product_radar_media_jobs.source_media_job_id)의 첫 PNG를 가리킨다 - 목록에서
  // <img src="실제 GIF">를 그대로 쓰면 브라우저가 항상 자동 재생하기 때문이다(CPU 과다).
  // 그 외 모든 category/origin(image/carousel/video, uploaded GIF 포함)는 기존과 동일하게
  // files[0]과 같은 값이다(uploaded GIF는 원본 자체에서 정지 프레임을 뽑아낼 provenance가
  // 없어 이번 Phase에서는 다루지 않는다 - 완료 보고 known limitation 참고).
  thumbnailFilename: string | null;
  thumbnailAvailable: boolean;
}

// mediaType(현재는 "card"뿐 - 향후 carousel/video 렌더러가 생기면 매핑을 추가한다,
// 요청서 35절 future-proof)을 공개 category로 변환한다. 새 mediaType이 추가돼도 여기 한
// 줄만 늘리면 되고, 호출부(listProductRadarLibraryItems)는 그대로다.
function categoryForGeneratedMediaType(mediaType: string): ProductRadarLibraryCategory {
  if (mediaType === "carousel") return "carousel";
  if (mediaType === "video") return "video";
  if (mediaType === "animation") return "gif"; // Phase 12.5.3.9: 무음 GIF
  return "image"; // "card" 및 알 수 없는 값은 안전하게 image로 취급
}

export interface ListProductRadarLibraryItemsOptions {
  limit: number;
  offset: number;
}

// generated(rendered job)와 uploaded(library asset)를 각각 최대 limit+offset개까지 가져와
// createdAt 내림차순으로 병합한 뒤 최종 limit개만 자른다 - 완벽한 cursor 페이지네이션은
// 아니지만 "더 보기" 버튼(offset 누적) 방식에는 충분하다(요청서 32절, thumbnail 재생성 등
// 과도한 최적화는 하지 않는다).
export function listProductRadarLibraryItems(opts: ListProductRadarLibraryItemsOptions): { items: ProductRadarLibraryItem[]; total: number } {
  const fetchCount = opts.limit + opts.offset;
  const favoritedKeys = listFavoritedProductRadarMediaAssetKeys();

  const generatedJobs = listRenderedProductRadarMediaJobs({ limit: fetchCount, offset: 0 });

  // Phase 12.5.3.9 adversarial 수정: animation(GIF) job들의 motion source를 batch로 미리
  // 조회한다(N+1 방지 - listProductRadarMediaJobsByIds/listProductRadarMediaFilesByJobIds는
  // 기존 draftMediaReview.ts와 동일한 batch 패턴). source job이 없거나(구버전 데이터/삭제됨)
  // status가 rendered가 아니거나 파일이 없으면 안전하게 thumbnail 없음으로 처리한다 - 절대
  // 크래시하지 않고, 목록 자체도 죽지 않는다(요청서 5·10절과 동일한 fail-safe 원칙).
  const sourceJobIds = generatedJobs.filter((j) => j.mediaType === "animation" && j.sourceMediaJobId !== null).map((j) => j.sourceMediaJobId as number);
  const uniqueSourceJobIds = [...new Set(sourceJobIds)];
  const sourceJobsById = new Map(listProductRadarMediaJobsByIds(uniqueSourceJobIds).map((j) => [j.id, j]));
  const sourceFilesByJobId = new Map<number, { filename: string; role: string; slideIndex: number | null }[]>();
  for (const f of listProductRadarMediaFilesByJobIds(uniqueSourceJobIds)) {
    const list = sourceFilesByJobId.get(f.mediaJobId) ?? [];
    list.push({ filename: f.filename, role: f.role, slideIndex: f.slideIndex });
    sourceFilesByJobId.set(f.mediaJobId, list);
  }
  function resolveGifThumbnail(sourceMediaJobId: number | null): { filename: string | null; available: boolean } {
    if (sourceMediaJobId === null) return { filename: null, available: false };
    const sourceJob = sourceJobsById.get(sourceMediaJobId);
    if (!sourceJob || sourceJob.status !== "rendered") return { filename: null, available: false };
    const files = (sourceFilesByJobId.get(sourceMediaJobId) ?? []).filter((f) => f.role === "card" || f.role === "slide").sort((a, b) => (a.slideIndex ?? 0) - (b.slideIndex ?? 0));
    if (files.length === 0) return { filename: null, available: false };
    return { filename: files[0].filename, available: mediaFileExists(files[0].filename) };
  }

  const generatedItems: ProductRadarLibraryItem[] = generatedJobs.map((job) => {
    const files = listProductRadarMediaFilesByJobId(job.id);
    const assetKey = `job:${job.id}`;
    const category = categoryForGeneratedMediaType(job.mediaType);
    const hydratedFiles = files.map((f) => ({ filename: f.filename, slideIndex: f.slideIndex, width: f.width, height: f.height, available: mediaFileExists(f.filename) }));
    const gifThumbnail = category === "gif" ? resolveGifThumbnail(job.sourceMediaJobId) : null;
    return {
      assetKey,
      origin: "generated" as const,
      category,
      originalName: null,
      createdAt: job.createdAt,
      favorited: favoritedKeys.has(assetKey),
      files: hydratedFiles,
      thumbnailFilename: gifThumbnail ? gifThumbnail.filename : (hydratedFiles[0]?.filename ?? null),
      thumbnailAvailable: gifThumbnail ? gifThumbnail.available : (hydratedFiles[0]?.available ?? false),
    };
  });

  const uploadedAssets = listProductRadarLibraryAssets({ limit: fetchCount, offset: 0 });
  const uploadedItems: ProductRadarLibraryItem[] = uploadedAssets.map((asset) => {
    const files = listProductRadarLibraryAssetFilesByAssetId(asset.id);
    const assetKey = `upload:${asset.id}`;
    const hydratedFiles = files.map((f) => ({ filename: f.filename, slideIndex: f.slideIndex, width: f.width, height: f.height, available: mediaFileExists(f.filename) }));
    return {
      assetKey,
      origin: "user_upload" as const,
      category: asset.category,
      originalName: asset.originalName,
      createdAt: asset.createdAt,
      favorited: favoritedKeys.has(assetKey),
      files: hydratedFiles,
      // uploaded GIF는 이번 Phase에서 정지 썸네일을 만들지 않는다(known limitation - 완료 보고 참고).
      thumbnailFilename: hydratedFiles[0]?.filename ?? null,
      thumbnailAvailable: hydratedFiles[0]?.available ?? false,
    };
  });

  const merged = [...generatedItems, ...uploadedItems].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const page = merged.slice(opts.offset, opts.offset + opts.limit);
  const total = countRenderedProductRadarMediaJobs() + countProductRadarLibraryAssets();
  return { items: page, total };
}

// asset_key(예: "job:12" | "upload:7")를 파싱한다 - 잘못된 형식/음수/0/NaN은 전부 null.
export type ProductRadarLibraryAssetKeyParsed = { origin: ProductRadarLibraryOrigin; id: number };
export function parseProductRadarLibraryAssetKey(assetKey: unknown): ProductRadarLibraryAssetKeyParsed | null {
  if (typeof assetKey !== "string") return null;
  const m = /^(job|upload):([1-9]\d*)$/.exec(assetKey);
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { origin: m[1] === "job" ? "generated" : "user_upload", id };
}
