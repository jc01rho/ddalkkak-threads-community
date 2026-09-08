// src/productRadar/mediaPersistence.ts
// 상품 레이더 Phase 12.5.3.2: product_radar_media_jobs/product_radar_media_files 저장 계층.
// comparisonPersistence.ts/recommendationPersistence.ts와 동일한 원칙 - 이 파일은 저장/조회만
// 담당하고 렌더링/다운로드/도메인 판단은 하지 않는다. database.ts에 이 CRUD를 몰아넣지
// 않고 Product Radar 전용 파일로 둔다(요청서 15절).
//
// list/search/pagination은 이번 Phase 범위 밖(요청서 15절) - exact id read만 제공한다.

import { getDb, nowIso } from "../database";
import { ProductRadarMediaFailureReason, ProductRadarMediaFileRole, ProductRadarMediaJob, ProductRadarMediaJobStatus, ProductRadarMediaType } from "./types";

interface MediaJobRow {
  id: number;
  compare_group_id: number | null;
  product_id: number | null;
  recommendation_snapshot_id: number | null;
  media_type: string;
  template_id: string;
  template_version: string;
  status: string;
  failure_reason: string | null;
  draft_id: number | null;
  manifest_path: string | null;
  source_media_job_id: number | null;
  created_at: string;
  updated_at: string;
}

function hydrateJobRow(row: MediaJobRow): ProductRadarMediaJob {
  return {
    id: row.id,
    compareGroupId: row.compare_group_id,
    productId: row.product_id,
    recommendationSnapshotId: row.recommendation_snapshot_id,
    mediaType: row.media_type as ProductRadarMediaType,
    templateId: row.template_id,
    templateVersion: row.template_version,
    status: row.status as ProductRadarMediaJobStatus,
    failureReason: row.failure_reason as ProductRadarMediaFailureReason | null,
    draftId: row.draft_id,
    manifestPath: row.manifest_path,
    sourceMediaJobId: row.source_media_job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getJobRow(id: number): MediaJobRow | undefined {
  return getDb().prepare("SELECT * FROM product_radar_media_jobs WHERE id = ?").get(id) as MediaJobRow | undefined;
}

export function getProductRadarMediaJobById(id: number): ProductRadarMediaJob | null {
  const row = getJobRow(id);
  return row ? hydrateJobRow(row) : null;
}

// Phase 12.5.3.6: 미디어 보관함의 "공장 생성" 목록용 - status='rendered'인 job만 돌려준다
// (요청서 15절 - failed/pending job은 일반 asset처럼 표시하지 않는다). draft attach 여부와
// 무관하게 전부 포함한다(요청서 15절 - "현재 draft에 attach되지 않은 candidate도 job/file이
// 정상 rendered 상태라면 보관함에서 보일 수 있도록"). limit/offset 페이지네이션만 지원 -
// 검색/필터는 route 계층에서 결과를 다시 거른다(이 함수는 exact/paged read만 담당).
export interface ListRenderedProductRadarMediaJobsOptions {
  limit: number;
  offset: number;
}
export function listRenderedProductRadarMediaJobs(opts: ListRenderedProductRadarMediaJobsOptions): ProductRadarMediaJob[] {
  const rows = getDb()
    .prepare("SELECT * FROM product_radar_media_jobs WHERE status = 'rendered' ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(opts.limit, opts.offset) as MediaJobRow[];
  return rows.map(hydrateJobRow);
}
export function countRenderedProductRadarMediaJobs(): number {
  return (getDb().prepare("SELECT COUNT(*) as c FROM product_radar_media_jobs WHERE status = 'rendered'").get() as { c: number }).c;
}

export interface CreateMediaJobInput {
  compareGroupId: number;
  // Phase 12.5.3.7: carousel job은 단일 상품이 아니라 comparison 전체를 다루므로 null(DB
  // 컬럼 자체가 이미 nullable - 요청서 1절). single-card 호출부는 계속 number만 넘긴다(하위호환).
  productId: number | null;
  recommendationSnapshotId: number;
  mediaType: ProductRadarMediaType;
  templateId: string;
  templateVersion: string;
  // Phase 12.5.3.9: video/animation job만 채운다(motion source의 정확한 job id). card/carousel
  // 호출부는 넘기지 않으므로 기본 null(하위호환 - 기존 호출부 전부 무변경).
  sourceMediaJobId?: number | null;
}

// status는 항상 'pending'(types.ts ProductRadarMediaJobStatus의 실제 값)으로 시작한다 - 새
// 상태 문자열을 발명하지 않는다(요청서 11절).
export function createProductRadarMediaJob(input: CreateMediaJobInput): ProductRadarMediaJob {
  const db = getDb();
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO product_radar_media_jobs
        (compare_group_id, product_id, recommendation_snapshot_id, media_type, template_id, template_version, status, failure_reason, draft_id, manifest_path, source_media_job_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?)`
    )
    .run(input.compareGroupId, input.productId, input.recommendationSnapshotId, input.mediaType, input.templateId, input.templateVersion, input.sourceMediaJobId ?? null, ts, ts);
  return hydrateJobRow(getJobRow(Number(info.lastInsertRowid))!);
}

// 실제 실패 사유 vocabulary(ProductRadarMediaFailureReason)만 받는다 - 호출부가 임의 문자열을
// 넣지 못하도록 타입으로 강제한다(요청서 14절, 새 reason 발명 금지).
export function markProductRadarMediaJobFailed(jobId: number, failureReason: ProductRadarMediaFailureReason): void {
  getDb().prepare("UPDATE product_radar_media_jobs SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?").run(failureReason, nowIso(), jobId);
}

interface MediaFileRow {
  id: number;
  media_job_id: number;
  role: string;
  slide_index: number | null;
  filename: string;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  retention_pinned: number;
  created_at: string;
}

export interface ProductRadarMediaFileRecord {
  id: number;
  mediaJobId: number;
  role: ProductRadarMediaFileRole;
  slideIndex: number | null;
  filename: string;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  retentionPinned: boolean;
  createdAt: string;
}

function hydrateFileRow(row: MediaFileRow): ProductRadarMediaFileRecord {
  return {
    id: row.id,
    mediaJobId: row.media_job_id,
    role: row.role as ProductRadarMediaFileRole,
    slideIndex: row.slide_index,
    filename: row.filename,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    durationSeconds: row.duration_seconds,
    retentionPinned: !!row.retention_pinned,
    createdAt: row.created_at,
  };
}

function getFileRow(id: number): MediaFileRow | undefined {
  return getDb().prepare("SELECT * FROM product_radar_media_files WHERE id = ?").get(id) as MediaFileRow | undefined;
}

export function listProductRadarMediaFilesByJobId(jobId: number): ProductRadarMediaFileRecord[] {
  const rows = getDb().prepare("SELECT * FROM product_radar_media_files WHERE media_job_id = ? ORDER BY id ASC").all(jobId) as MediaFileRow[];
  return rows.map(hydrateFileRow);
}

export interface CompleteMediaJobFileInput {
  role: ProductRadarMediaFileRole;
  slideIndex: number | null;
  filename: string;
  byteSize: number;
  width: number;
  height: number;
  // Phase 12.5.3.9: video/animation 파일만 채운다(카드/캐러셀 PNG는 계속 undefined -> NULL,
  // 하위호환 - 기존 호출부 전부 무변경).
  durationSeconds?: number | null;
}

export interface CompletedMediaJob {
  job: ProductRadarMediaJob;
  file: ProductRadarMediaFileRecord;
}

// media file INSERT + job status='rendered' 전환을 하나의 transaction으로 묶는다 - "성공인데
// media_file row가 없음"이나 "file row는 있는데 job이 아직 pending/failed임" 같은 절반
// 상태를 만들지 않는다(요청서 13절 6단계). 'rendered'는 실제 status enum 값이다(요청서 11절).
export function completeProductRadarMediaJob(jobId: number, file: CompleteMediaJobFileInput): CompletedMediaJob {
  const db = getDb();
  const ts = nowIso();
  const fileId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO product_radar_media_files
          (media_job_id, role, slide_index, filename, byte_size, width, height, duration_seconds, retention_pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`
      )
      .run(jobId, file.role, file.slideIndex, file.filename, file.byteSize, file.width, file.height, ts);
    db.prepare("UPDATE product_radar_media_jobs SET status = 'rendered', updated_at = ? WHERE id = ?").run(ts, jobId);
    return Number(info.lastInsertRowid);
  })();
  return { job: hydrateJobRow(getJobRow(jobId)!), file: hydrateFileRow(getFileRow(fileId)!) };
}

// Phase 12.5.3.7: carousel(2~3 slides)을 위한 다중 파일 atomic 완료(요청서 16·17절 -
// "candidate 하나는 job rendered + 2~3 media_files + 실제 files 존재가 모두 맞아야 성공").
// completeProductRadarMediaJob()을 slide마다 여러 번 호출하면 "1번째 slide INSERT 직후 이미
// status='rendered'인데 2·3번째는 아직 없는" 반쪽 상태가 생길 수 있다 - 이 함수는 모든 slide
// 파일이 디스크에 이미 다 쓰인 뒤(caller 책임) 한 트랜잭션으로 전부 INSERT + status 전환해
// 그 반쪽 상태를 구조적으로 없앤다.
export function completeProductRadarMediaJobWithFiles(jobId: number, files: readonly CompleteMediaJobFileInput[]): { job: ProductRadarMediaJob; files: ProductRadarMediaFileRecord[] } {
  const db = getDb();
  const ts = nowIso();
  const fileIds = db.transaction(() => {
    const ids: number[] = [];
    for (const file of files) {
      const info = db
        .prepare(
          `INSERT INTO product_radar_media_files
            (media_job_id, role, slide_index, filename, byte_size, width, height, duration_seconds, retention_pinned, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
        )
        .run(jobId, file.role, file.slideIndex, file.filename, file.byteSize, file.width, file.height, file.durationSeconds ?? null, ts);
      ids.push(Number(info.lastInsertRowid));
    }
    db.prepare("UPDATE product_radar_media_jobs SET status = 'rendered', updated_at = ? WHERE id = ?").run(ts, jobId);
    return ids;
  })();
  return { job: hydrateJobRow(getJobRow(jobId)!), files: fileIds.map((id) => hydrateFileRow(getFileRow(id)!)) };
}

// Phase 12.5.3.7: carousel batch idempotency(요청서 20절) - 같은 recommendation에 대해
// 같은 template_id(=composition+variant)가 이미 rendered 상태로 존재하면 그 job을 그대로
// 재사용하고 새 PNG를 또 만들지 않는다. "가장 최근" 1개만 본다(여러 개가 있을 수 있는 이유는
// 없지만 방어적으로 최신순 정렬).
export function getLatestRenderedProductRadarMediaJobByRecommendationAndTemplate(recommendationSnapshotId: number, templateId: string): ProductRadarMediaJob | null {
  const row = getDb()
    .prepare("SELECT * FROM product_radar_media_jobs WHERE recommendation_snapshot_id = ? AND template_id = ? AND status = 'rendered' ORDER BY id DESC LIMIT 1")
    .get(recommendationSnapshotId, templateId) as MediaJobRow | undefined;
  return row ? hydrateJobRow(row) : null;
}

// Phase 12.5.3.9: motion(video/animation) candidate idempotency(요청서 16절) - carousel과
//달리 키가 recommendationSnapshotId가 아니라 sourceMediaJobId다(같은 recommendation에서도
// source card/carousel job이 여러 개일 수 있으므로, "이 정확한 원본 PNG로 이미 만든 적
// 있는가"만 물어야 한다). template_id(=preset)별 최신 1개만 본다.
export function listLatestRenderedProductRadarMediaJobsBySource(sourceMediaJobId: number, mediaType: ProductRadarMediaType): ProductRadarMediaJob[] {
  const rows = getDb()
    .prepare("SELECT * FROM product_radar_media_jobs WHERE source_media_job_id = ? AND media_type = ? AND status = 'rendered' ORDER BY id DESC")
    .all(sourceMediaJobId, mediaType) as MediaJobRow[];
  return rows.map(hydrateJobRow);
}

// Phase 12.5.3.8: 초안함 draft 목록(N개)을 렌더할 때 job마다 개별 조회하는 N+1을 피하기
// 위한 batch read - IN절 1회로 여러 job을 한 번에 가져온다(요청서 4절). 빈 배열이면 SQL을
// 아예 실행하지 않는다(better-sqlite3는 빈 IN절을 허용하지 않음).
export function listProductRadarMediaJobsByIds(ids: readonly number[]): ProductRadarMediaJob[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT * FROM product_radar_media_jobs WHERE id IN (${placeholders})`).all(...ids) as MediaJobRow[];
  return rows.map(hydrateJobRow);
}

// 위와 동일한 이유의 batch read - 여러 job의 파일을 media_job_id IN절 1회로 가져온다.
export function listProductRadarMediaFilesByJobIds(jobIds: readonly number[]): ProductRadarMediaFileRecord[] {
  if (jobIds.length === 0) return [];
  const placeholders = jobIds.map(() => "?").join(",");
  const rows = getDb().prepare(`SELECT * FROM product_radar_media_files WHERE media_job_id IN (${placeholders}) ORDER BY media_job_id ASC, id ASC`).all(...jobIds) as MediaFileRow[];
  return rows.map(hydrateFileRow);
}
