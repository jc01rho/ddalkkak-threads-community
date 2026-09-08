// src/routes/productRadar/index.ts
// Threads 초안 미디어(보관함·미디어 제작·비교/추천 근거)에서 쓰는 하위 라우트를
// 한 번에 묶어 server.ts에 마운트합니다.
// Community에서는 상품 레이더 사용자 기능(상품 수집·전용 브라우저·확장프로그램)을
// 제공하지 않으므로 products/extension/browser/launch/curation/clear 라우트는 없습니다.

import { Router } from "express";
import comparisonsRoutes from "./comparisons";
import mediaRoutes from "./media";
import libraryRoutes from "./library";

const router = Router();

// comparisons.ts는 메인 UI 전용(별도 게이트 없음)입니다.
router.use("/comparisons", comparisonsRoutes);
// media.ts는 자체적으로 "/drafts/:draftId/media/single-card"와 "/media/:filename"
// 두 전체 경로를 정의하므로 prefix 없이 mount합니다.
router.use(mediaRoutes);
// 미디어 보관함 - "/library" prefix로 마운트합니다(media.ts 무변경).
router.use("/library", libraryRoutes);

export default router;
