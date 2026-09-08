// src/productRadar/motionOrchestration.ts
// 상품 레이더 Phase 12.5.3.9: 짧은 영상(MP4)/GIF candidate 배치 생성 흐름 조립.
// mediaCarouselOrchestration.ts와 동일한 원칙 - 이 파일의 책임은 "흐름 조립"뿐이다. 실제
// 인코딩은 ffmpegRuntime.ts, 필터 그래프 계산은 motionPresets.ts, 저장은 mediaPersistence.ts
// 가 담당한다. draft 자격 확인/lock은 이 파일이 하지 않는다(mediaDraftAttachment.ts의
// generateProductRadarMotionBatchForDraft 몫 - carousel과 동일한 계층 분리).
//
// motion source(요청서 3절): sourceMediaJobId는 반드시 이 exact recommendation lineage의,
// status='rendered'인, mediaType이 'card' 또는 'carousel'인 job이어야 한다. video/animation을
// source로 넘기면(재귀) 거부한다 - "video/GIF에서 다시 video/GIF 만들기" 버튼 자체가 프론트에
// 없지만, API 레벨에서도 구조적으로 막는다. uploaded library asset은애초에 이 함수가 받는
// sourceMediaJobId 공간(product_radar_media_jobs.id)에 속하지 않으므로 별도 차단 코드 없이
// 이미 배제되어 있다(다른 id 체계).
//
// remote 재다운로드/외부 네트워크 접근 없음(요청서 2절) - source는 항상 이미 로컬 디스크에
// 렌더링된 PNG(card 1장 또는 carousel 2~3장)만 읽는다.
//
// batch atomicity(요청서 17절) - 3개 preset(smooth/slide/punch) 중 하나라도 실패하면
// rendered/user-visible candidate는 0개다. mediaCarouselOrchestration.ts의 rollback 패턴을
// 그대로 재사용(파일 삭제 실패해도 job failed 마킹은 반드시 계속).
//
// idempotency(요청서 16절): 같은 sourceMediaJobId+outputType의 3개 preset이 이미 rendered로
// 존재하면 재인코딩하지 않고 그대로 재사용한다.

import fs from "fs";
import crypto from "crypto";
import { config } from "../env";
import { getProductRadarComparisonSnapshotById } from "./comparisonPersistence";
import { getProductRadarRecommendationSnapshotById } from "./recommendationPersistence";
import { isSafeMediaFilename, resolveMediaPath, deleteMediaFileIfExists, mediaFileExists } from "../mediaUpload";
import {
  completeProductRadarMediaJobWithFiles,
  createProductRadarMediaJob,
  getProductRadarMediaJobById,
  listLatestRenderedProductRadarMediaJobsBySource,
  listProductRadarMediaFilesByJobId,
  markProductRadarMediaJobFailed,
} from "./mediaPersistence";
import { ProductRadarMediaFailureReason, ProductRadarMediaType } from "./types";
import {
  PRODUCT_RADAR_MOTION_GIF_FPS,
  PRODUCT_RADAR_MOTION_GIF_HEIGHT,
  PRODUCT_RADAR_MOTION_GIF_WIDTH,
  PRODUCT_RADAR_MOTION_PRESETS,
  PRODUCT_RADAR_MOTION_VIDEO_FPS,
  PRODUCT_RADAR_MOTION_VIDEO_HEIGHT,
  PRODUCT_RADAR_MOTION_VIDEO_WIDTH,
  ProductRadarMotionPreset,
  gifTotalDurationSeconds,
  videoTotalDurationSeconds,
} from "./motionPresets";
import {
  encodeMotionGif,
  encodeMotionVideo,
  FfmpegTestOverrides,
  preflightFfmpegEncoder,
  validateMotionGif,
  validateMotionMp4,
} from "./ffmpegRuntime";

export type ProductRadarMotionOutputType = "video" | "animation";

const TEMPLATE_VERSION = "1";
function templateIdFor(outputType: ProductRadarMotionOutputType, preset: ProductRadarMotionPreset): string {
  return `product-radar-motion-${outputType}-${preset}`;
}

export interface ProductRadarMotionTestOverrides extends FfmpegTestOverrides {}

interface ResolvedSourceFile {
  slideIndex: number;
  filename: string;
}

// carousel/card만 motion source로 허용한다(요청서 3절) - video/animation/기타는 여기서
// null을 반환해 배제한다(mediaDraftAttachment.ts의 validateProductRadarMediaJobFiles와
// 별개 함수인 이유: 이 함수는 의도적으로 card/carousel 두 케이스만 다룬다 - 계층 분리를
// 위해 mediaDraftAttachment.ts를 import하지 않는다, carousel orchestration이
// mediaDraftAttachment.ts를 모르는 것과 동일한 원칙).
function resolveSourcePngFiles(sourceJob: { mediaType: string }, sourceMediaJobId: number): readonly ResolvedSourceFile[] | null {
  const rows = listProductRadarMediaFilesByJobId(sourceMediaJobId);
  if (sourceJob.mediaType === "card") {
    const row = rows.find((f) => f.role === "card");
    if (!row) return null;
    return [{ slideIndex: 0, filename: row.filename }];
  }
  if (sourceJob.mediaType === "carousel") {
    const slides = rows
      .filter((f) => f.role === "slide" && f.slideIndex !== null)
      .sort((a, b) => (a.slideIndex as number) - (b.slideIndex as number));
    if (slides.length < 2 || slides.length > 3) return null;
    if (!slides.every((f, i) => f.slideIndex === i)) return null;
    return slides.map((f) => ({ slideIndex: f.slideIndex as number, filename: f.filename }));
  }
  return null;
}

function ensureUploadDirExists(): void {
  if (!fs.existsSync(config.UPLOAD_DIR)) fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
}

export interface ProductRadarMotionCandidate {
  readonly mediaJobId: number;
  readonly preset: ProductRadarMotionPreset;
  readonly filename: string;
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
}

export type ProductRadarMotionBatchResult =
  | {
      readonly ok: true;
      readonly recommendationSnapshotId: number;
      readonly comparisonSnapshotId: number;
      readonly sourceMediaJobId: number;
      readonly outputType: ProductRadarMotionOutputType;
      readonly candidates: readonly ProductRadarMotionCandidate[];
      readonly errors: readonly [];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

export async function generateProductRadarMotionBatch(
  recommendationSnapshotId: number,
  sourceMediaJobId: number,
  outputType: ProductRadarMotionOutputType,
  testOverrides?: ProductRadarMotionTestOverrides
): Promise<ProductRadarMotionBatchResult> {
  // ---- 1. exact lineage(pre-job) ----
  const recommendationResult = getProductRadarRecommendationSnapshotById(recommendationSnapshotId);
  if (!recommendationResult.ok || !recommendationResult.record) {
    return { ok: false, errors: recommendationResult.errors };
  }
  const recommendationRecord = recommendationResult.record;
  const comparisonResult = getProductRadarComparisonSnapshotById(recommendationRecord.comparisonSnapshotId);
  if (!comparisonResult.ok || !comparisonResult.snapshot) {
    return { ok: false, errors: comparisonResult.errors };
  }
  const comparisonSnapshot = comparisonResult.snapshot;

  // ---- 2. source job 검증(요청서 3절, pre-job) ----
  const sourceJob = getProductRadarMediaJobById(sourceMediaJobId);
  if (!sourceJob) {
    return { ok: false, errors: ["product_radar_media_job_not_found"] };
  }
  if (sourceJob.recommendationSnapshotId !== recommendationSnapshotId) {
    return { ok: false, errors: ["product_radar_media_job_lineage_mismatch"] };
  }
  if (sourceJob.status !== "rendered") {
    return { ok: false, errors: ["product_radar_media_job_not_ready"] };
  }
  if (sourceJob.mediaType !== "card" && sourceJob.mediaType !== "carousel") {
    return { ok: false, errors: ["product_radar_media_motion_source_invalid"] };
  }
  const sourceFiles = resolveSourcePngFiles(sourceJob, sourceMediaJobId);
  if (!sourceFiles) {
    return { ok: false, errors: ["product_radar_media_motion_source_invalid"] };
  }
  const sourceAbsolutePaths: string[] = [];
  for (const f of sourceFiles) {
    if (!mediaFileExists(f.filename)) {
      return { ok: false, errors: ["source_media_missing"] };
    }
    const abs = resolveMediaPath(f.filename);
    if (!abs) {
      return { ok: false, errors: ["source_media_missing"] };
    }
    sourceAbsolutePaths.push(abs);
  }
  const slideCount = sourceAbsolutePaths.length;

  // ---- 3. duration contract(요청서 확정본, pre-job) ----
  const totalDuration = outputType === "video" ? videoTotalDurationSeconds(slideCount) : gifTotalDurationSeconds(slideCount);
  if (totalDuration === null) {
    return { ok: false, errors: ["product_radar_media_motion_source_invalid"] };
  }
  const width = outputType === "video" ? PRODUCT_RADAR_MOTION_VIDEO_WIDTH : PRODUCT_RADAR_MOTION_GIF_WIDTH;
  const height = outputType === "video" ? PRODUCT_RADAR_MOTION_VIDEO_HEIGHT : PRODUCT_RADAR_MOTION_GIF_HEIGHT;
  const fps = outputType === "video" ? PRODUCT_RADAR_MOTION_VIDEO_FPS : PRODUCT_RADAR_MOTION_GIF_FPS;

  // ---- 4. idempotency(요청서 16절) - source+outputType의 3개 preset이 이미 rendered면 재사용.
  // adversarial 리뷰 발견: 이 체크를 FFmpeg preflight보다 먼저 해야 한다 - preflight 결과는
  // 프로세스 생애주기 동안 실패 시 영구 캐시되므로(ffmpegRuntime.ts), 순서를 바꾸지 않으면
  // 이미 만들어둔 rendered candidate가 있어도 "그 이후 우연히 preflight가 한 번 실패"했다는
  // 이유만으로 재조회조차 못 하게 된다(재인코딩이 전혀 필요 없는 요청인데도). ----
  const existingJobs = listLatestRenderedProductRadarMediaJobsBySource(sourceMediaJobId, outputType as ProductRadarMediaType);
  const existingByPreset = new Map<ProductRadarMotionPreset, (typeof existingJobs)[number]>();
  for (const job of existingJobs) {
    for (const preset of PRODUCT_RADAR_MOTION_PRESETS) {
      if (job.templateId === templateIdFor(outputType, preset) && !existingByPreset.has(preset)) {
        existingByPreset.set(preset, job);
      }
    }
  }
  if (existingByPreset.size === PRODUCT_RADAR_MOTION_PRESETS.length) {
    const candidates: ProductRadarMotionCandidate[] = [];
    for (const preset of PRODUCT_RADAR_MOTION_PRESETS) {
      const job = existingByPreset.get(preset)!;
      const files = listProductRadarMediaFilesByJobId(job.id).filter((f) => f.role === "video" || f.role === "animation");
      if (files.length !== 1 || files[0].width === null || files[0].height === null) {
        existingByPreset.clear(); // 데이터 불일치 - 안전하게 재생성 경로로
        break;
      }
      candidates.push({
        mediaJobId: job.id,
        preset,
        filename: files[0].filename,
        durationSeconds: files[0].durationSeconds ?? totalDuration,
        width: files[0].width,
        height: files[0].height,
      });
    }
    if (candidates.length === PRODUCT_RADAR_MOTION_PRESETS.length) {
      return {
        ok: true,
        recommendationSnapshotId: recommendationRecord.id,
        comparisonSnapshotId: comparisonSnapshot.id,
        sourceMediaJobId,
        outputType,
        candidates,
        errors: [],
      };
    }
  }

  // ---- 5. FFmpeg/encoder preflight(요청서 6절, pre-job) - idempotency로 이미 해결되지 않은
  // 경우에만 확인한다(위 4단계 참고) - 환경 문제로 아무것도 못 만들면 job조차 만들지 않는다
  // (recommendation/lineage 실패와 동일한 pre-job 분류). ----
  const preflight = await preflightFfmpegEncoder(testOverrides);
  if (!preflight.ok) {
    return { ok: false, errors: ["ffmpeg_unavailable"] };
  }

  // ---- 6. all-or-nothing 3개 생성(요청서 17절) ----
  ensureUploadDirExists();
  const createdJobIds: number[] = [];
  const createdFilenames: string[] = [];
  const failureReason: ProductRadarMediaFailureReason = outputType === "video" ? "video_render_failed" : "animation_render_failed";

  function rollback(): void {
    for (const filename of createdFilenames) {
      try {
        deleteMediaFileIfExists(filename);
      } catch {
        /* 파일 삭제 실패가 있어도 아래 job failed 마킹은 반드시 진행 */
      }
    }
    for (const jobId of createdJobIds) markProductRadarMediaJobFailed(jobId, failureReason);
  }

  const candidates: ProductRadarMotionCandidate[] = [];
  for (const preset of PRODUCT_RADAR_MOTION_PRESETS) {
    const job = createProductRadarMediaJob({
      compareGroupId: comparisonSnapshot.compareGroupId,
      productId: null,
      recommendationSnapshotId: recommendationRecord.id,
      mediaType: outputType,
      templateId: templateIdFor(outputType, preset),
      templateVersion: TEMPLATE_VERSION,
      sourceMediaJobId,
    });
    createdJobIds.push(job.id);

    const ext = outputType === "video" ? "mp4" : "gif";
    const finalFilename = `${crypto.randomUUID()}.${ext}`;
    if (!isSafeMediaFilename(finalFilename)) {
      rollback();
      return { ok: false, errors: [failureReason] };
    }
    const finalPath = resolveMediaPath(finalFilename);
    if (!finalPath) {
      rollback();
      return { ok: false, errors: [failureReason] };
    }
    const tempPath = `${finalPath}.tmp-${crypto.randomUUID()}`;

    const encodeResult =
      outputType === "video"
        ? await encodeMotionVideo({ pngPaths: sourceAbsolutePaths, outPath: tempPath, preset, totalDurationSeconds: totalDuration, width, height, fps }, testOverrides)
        : await encodeMotionGif({ pngPaths: sourceAbsolutePaths, outPath: tempPath, preset, totalDurationSeconds: totalDuration, width, height, fps }, testOverrides);
    if (!encodeResult.ok) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* 없거나 못 지워도 무시 */
      }
      rollback();
      return { ok: false, errors: [failureReason] };
    }

    // ---- output validation(요청서 19절) - exit code만 믿지 않는다 ----
    const validation =
      outputType === "video"
        ? await validateMotionMp4(tempPath, { width, height, durationSeconds: totalDuration }, testOverrides)
        : await validateMotionGif(tempPath, { width, height, durationSeconds: totalDuration }, testOverrides);
    if (!validation.ok) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* 무시 */
      }
      rollback();
      return { ok: false, errors: [failureReason] };
    }

    let byteSize: number;
    try {
      fs.renameSync(tempPath, finalPath);
      byteSize = fs.statSync(finalPath).size;
      createdFilenames.push(finalFilename);
    } catch {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* 무시 */
      }
      rollback();
      return { ok: false, errors: ["local_save_failed"] };
    }

    try {
      const completed = completeProductRadarMediaJobWithFiles(job.id, [
        {
          role: outputType === "video" ? "video" : "animation",
          slideIndex: null,
          filename: finalFilename,
          byteSize,
          width,
          height,
          durationSeconds: totalDuration,
        },
      ]);
      const file = completed.files[0];
      candidates.push({ mediaJobId: job.id, preset, filename: file.filename, durationSeconds: totalDuration, width, height });
    } catch {
      rollback();
      return { ok: false, errors: ["local_save_failed"] };
    }
  }

  return {
    ok: true,
    recommendationSnapshotId: recommendationRecord.id,
    comparisonSnapshotId: comparisonSnapshot.id,
    sourceMediaJobId,
    outputType,
    candidates,
    errors: [],
  };
}
