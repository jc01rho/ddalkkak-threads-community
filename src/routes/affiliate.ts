// src/routes/affiliate.ts
// "쿠파스 상품 홍보 모드" - 사용자가 직접 입력한 쿠팡 파트너스 상품 정보(상품명/특징/제휴 링크
// 등)만 근거로 Threads 홍보 문구 6개를 만들어 기존 초안 검수·승인·예약 발행 흐름으로 넘깁니다.
//
// 중요(요청서 기준 제약 - 이 파일 전체에 적용):
// - 쿠팡 API 연동을 하지 않습니다.
// - 쿠팡 상품 페이지를 자동 수집하거나 크롤링하지 않습니다.
// - 상품 이미지·영상을 다운로드하지 않습니다.
// - 사용자가 입력한 정보만 근거로 문구를 작성합니다(src/affiliatePromo.ts의 프롬프트/검증 참고).
// - 기존 일반 자료 수집·글 생성 기능(src/routes/drafts.ts, materials.ts)은 건드리지 않습니다.

import { Router } from "express";
import multer from "multer";
import { runClaudePrompt } from "../claude";
import { getProductRadarProduct, getSetting, insertDraftsAtomic, listActiveMediaFilenames, setSetting } from "../database";
import { CLAUDE_BUYER_FAILURE_MESSAGE } from "../claude";
import { config } from "../env";
import { ensurePersona, saveFailureLog } from "./drafts";
import {
  AffiliateDraftFromClaude,
  AffiliateProgram,
  affiliateProgramForSite,
  affiliateProgramLabel,
  AFFILIATE_TONE_VARIATIONS,
  buildAffiliatePromoPrompt,
  composeAffiliateBody,
  validateAffiliateInput,
  validateComposedBody,
  validateGeneratedPosts,
} from "../affiliatePromo";
import {
  deleteMediaFileIfExists,
  isSafeMediaFilename,
  resolveAttachedMedia,
  resolveMediaPath,
  saveValidatedMedia,
  validateUploadedFile,
} from "../mediaUpload";

const router = Router();

// 제휴글 표현 variation 순환 위치. 기존 settings 키-값 테이블만 쓰고 새 테이블은 만들지 않는다.
const AFFILIATE_TONE_VARIATION_KEY = "affiliate_tone_variation_index";

// 메모리에만 받습니다 - 검증(확장자/MIME/매직 바이트)을 통과한 파일만 디스크에 씁니다.
// 크기 제한은 여기서 1차로 강제되고(초과 시 아래 핸들러에서 깔끔한 JSON 오류로 변환),
// validateUploadedFile()에서 다시 한 번 확인합니다.
// multer의 defParamCharset 기본값이 "latin1"이라, "내가찍은사진.jpg" 같은 한글 파일명이
// originalname에 깨진 글자로 들어옵니다. 한국어 사용자에게는 이게 기본 상황이므로 utf8로 고정합니다.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_MEDIA_UPLOAD_BYTES },
  defParamCharset: "utf8",
});

function handleSingleMediaUpload(req: any, res: any, next: any) {
  upload.single("media")(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      const maxMb = Math.floor(config.MAX_MEDIA_UPLOAD_BYTES / (1024 * 1024));
      return res.status(400).json({ success: false, error: `첨부 파일이 너무 큽니다(최대 ${maxMb}MB).` });
    }
    return res.status(400).json({ success: false, error: `파일 업로드 처리 중 오류가 발생했습니다: ${err.message}` });
  });
}

// "내 사진·영상 첨부" - 사용자가 로컬 PC에서 직접 고른 파일 1개만 받습니다(요청서 2·3번).
// 외부 URL을 가져오는 코드가 이 함수 안 어디에도 없습니다 - 오직 req.file(브라우저가 보낸
// 바이트)만 다룹니다.
router.post("/media", handleSingleMediaUpload, (req: any, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "첨부할 파일을 선택해주세요." });
  }
  const validation = validateUploadedFile({
    buffer: req.file.buffer,
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
  });
  if (!validation.ok) {
    return res.status(400).json({ success: false, error: validation.error });
  }
  try {
    const saved = saveValidatedMedia(req.file, validation);
    res.json({
      success: true,
      mediaFilename: saved.filename,
      mediaType: saved.type,
      mediaMime: saved.mime,
      originalName: req.file.originalname,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: `파일 저장 중 오류가 발생했습니다: ${e?.message || String(e)}` });
  }
});

// "첨부 취소" 버튼 - 아직 어떤 초안에도 연결되지 않은(생성 전) 업로드 파일을 즉시 정리합니다.
// 이미 초안이 참조 중인 파일은 지우지 않습니다(안전 확인 후 거부).
router.delete("/media/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!isSafeMediaFilename(filename)) {
    return res.status(400).json({ success: false, error: "올바르지 않은 파일 식별자입니다." });
  }
  if (listActiveMediaFilenames().has(filename)) {
    return res.status(400).json({ success: false, error: "이미 초안에 사용된 파일은 여기서 삭제할 수 없습니다." });
  }
  deleteMediaFileIfExists(filename);
  res.json({ success: true });
});

// 첨부 미리보기(업로드 직후 화면) 및 초안함 카드의 미디어 미리보기가 이 엔드포인트로 파일을
// 불러옵니다. filename은 반드시 안전한 패턴(무작위 UUID + 허용 확장자)이어야 하고, 업로드
// 폴더를 벗어나는 경로는 resolveMediaPath()가 이미 차단합니다.
router.get("/media/:filename", (req, res) => {
  const filename = req.params.filename;
  if (!isSafeMediaFilename(filename)) {
    return res.status(400).json({ error: "올바르지 않은 파일 식별자입니다." });
  }
  const fullPath = resolveMediaPath(filename);
  if (!fullPath) {
    return res.status(400).json({ error: "올바르지 않은 파일 식별자입니다." });
  }
  res.sendFile(fullPath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "파일을 찾을 수 없습니다." });
  });
});

// 메인 버튼: 쿠파스 상품 홍보 글 만들기
router.post("/generate", async (req, res) => {
  // 상품 레이더에서 넘어온 경우(productRadarProductId 지정): 상품명/제휴링크는 화면이 보낸
  // 값이 아니라 **저장 시 검증된 DB 값**을 쓴다. 이렇게 해야 "글 A에는 링크 A"가 화면 상태와
  // 무관하게 보장된다(다른 상품 링크가 섞일 여지 자체를 없앤다). 나머지 입력(특징/대상/
  // 말투/고지문구/미디어)은 기존 그대로 화면 값을 쓴다.
  let body = req.body;
  // 경제적 이해관계 고지문은 제휴 프로그램마다 문구가 다르다. 어느 프로그램인지도 화면 값이
  // 아니라 **저장된 상품의 siteId**에서 정한다 - 링크와 같은 근거를 쓰므로 "글 A에는 A의
  // 프로그램 고지문"이 화면 상태와 무관하게 보장된다. 상품 없이 직접 입력하는 기존 경로는
  // 지금까지와 똑같이 쿠팡이다.
  let program: AffiliateProgram = "coupang";
  const radarProductId = Number(req.body?.productRadarProductId);
  if (Number.isSafeInteger(radarProductId) && radarProductId > 0) {
    const product = getProductRadarProduct(radarProductId);
    if (!product) {
      return res.status(400).json({ success: false, error: "선택한 상품을 찾을 수 없습니다." });
    }
    program = affiliateProgramForSite(product.siteId);
    if (!product.affiliateUrl) {
      return res.status(400).json({
        success: false,
        error: `이 상품에는 검증된 ${affiliateProgramLabel(program)} 제휴링크가 없습니다. 상품 페이지를 다시 저장해주세요.`,
      });
    }
    body = { ...req.body, productName: product.productName, affiliateUrl: product.affiliateUrl };
  }

  const validation = validateAffiliateInput(body, program);
  if (!validation.ok) {
    return res.status(400).json({ success: false, error: validation.error });
  }
  const input = validation.value;

  // 미디어 첨부는 선택사항입니다 - mediaFilename이 없으면 media는 null이고 이후 로직은 기존과
  // 완전히 동일하게 동작합니다(요청서 4번).
  const mediaResolution = resolveAttachedMedia(req.body?.mediaFilename, req.body?.mediaOriginalName);
  if (!mediaResolution.ok) {
    return res.status(400).json({ success: false, error: mediaResolution.error });
  }
  const media = mediaResolution.media;

  const persona = ensurePersona();

  // 표현 variation 순환: [제휴글 6개 만들기]를 누를 때마다 다음 결로 넘어간다(담백 → 질문 →
  // 숫자 → 담백 …). persona 자체는 읽기만 하고 바꾸지 않으며, persona_versions에도 쓰지 않는다.
  // 순환 위치는 새 테이블 없이 기존 settings 키-값 저장소에 정수 하나로만 남긴다.
  const variationIndex = Number(getSetting(AFFILIATE_TONE_VARIATION_KEY, "0")) || 0;
  const prompt = buildAffiliatePromoPrompt(input, persona.data, program, variationIndex);
  const result = await runClaudePrompt(prompt);

  if (!result.success || !result.posts) {
    // 로그에는 실제 원인(rawResponse=CLI JSON, diagnostics=exit code 등)을, 응답에는 구매자
    // 문구만 담는다 - 종료 코드 같은 내부 값이 화면으로 새지 않게 한다.
    saveFailureLog(result.rawResponse, JSON.stringify(result.diagnostics || {}) || "알 수 없는 오류");
    return res.status(502).json({
      success: false,
      error: CLAUDE_BUYER_FAILURE_MESSAGE,
      canRetry: true,
    });
  }

  const posts = result.posts as AffiliateDraftFromClaude[];

  // 6개 정확히 생성되었는지, 6가지 유형이 모두 있는지, 첫 줄이 겹치지 않는지, "직접 사용하지
  // 않음"일 때 금지 표현이 없는지 등을 여기서 확정적으로 검증합니다. 하나라도 걸리면 전체를
  // 실패로 처리하고 DB에는 아무것도 저장하지 않습니다(부분 저장 없음).
  const contentCheck = validateGeneratedPosts(posts, input);
  if (!contentCheck.ok) {
    saveFailureLog(result.rawResponse, contentCheck.error);
    return res.status(502).json({
      success: false,
      error: contentCheck.error,
      canRetry: true,
    });
  }

  // 최종 본문 = 고지 문구(맨 앞) + Claude가 쓴 상품 소개 문구 + 제휴 링크(맨 뒤, 원문 그대로),
  // 각각 별도 줄. 고지 문구·링크는 여기서 프로그램이 결정적으로 붙이므로 절대 빠지지 않습니다.
  const composedBodies = posts.map((p) => composeAffiliateBody(p.body, input));

  // 조립 결과가 실제로 "고지 문구로 시작 + 링크로 끝 + 각각 정확히 1번"을 만족하는지 다시
  // 확인합니다(요청서 8번). 하나라도 실패하면 배치 전체를 실패로 처리하고 DB에 저장하지 않습니다.
  for (const body of composedBodies) {
    const bodyCheck = validateComposedBody(body, input, program);
    if (!bodyCheck.ok) {
      saveFailureLog(result.rawResponse, bodyCheck.error);
      return res.status(502).json({
        success: false,
        error: bodyCheck.error,
        canRetry: true,
      });
    }
  }

  const batchId = `affiliate-batch-${Date.now()}`;
  const draftInputs = posts.map((p, i) => ({
    title: p.title || input.productName,
    hook: p.hook,
    body: composedBodies[i],
    topic: p.topic || (p.promotion_style as string) || `${affiliateProgramLabel(program)} 상품 홍보`,
    // 기존 초안 화면이 이미 source_title/source_url을 "참고 자료"로 표시하고 "원문 열기" 버튼을
    // 그려주므로, 여기에 상품명/제휴 링크를 그대로 채워 기존 UI를 그대로 재사용합니다.
    source_title: input.productName,
    source_url: input.affiliateUrl,
    source_summary: p.source_summary || input.features.slice(0, 300),
    confidence: p.confidence || "medium",
    risk_notes: p.risk_notes || "",
    persona_version: persona.version,
    generation_batch_id: batchId,
    source_type: "affiliate_product",
    product_name: input.productName,
    affiliate_url: input.affiliateUrl,
    usage_status: input.usageStatus,
    disclosure_text: input.disclosureText,
    promotion_style: p.promotion_style || null,
    // 6개 초안이 모두 같은 첨부 파일을 참조합니다(요청서 7번). 미첨부면 전부 null.
    media_filename: media?.filename || null,
    media_type: media?.type || null,
    media_mime: media?.mime || null,
    media_original_name: media?.originalName || null,
  }));

  // 6개 모두 하나의 트랜잭션으로 저장합니다 - 하나라도 실패하면 자동으로 전부 롤백되어
  // "일부만 저장"되는 상태가 생기지 않습니다.
  let insertedIds: number[];
  try {
    insertedIds = insertDraftsAtomic(draftInputs);
  } catch (e: any) {
    return res.status(500).json({
      success: false,
      error: `초안을 DB에 저장하는 중 오류가 발생했습니다: ${e?.message || String(e)}`,
      canRetry: true,
    });
  }

  if (insertedIds.length !== 6) {
    // insertDraftsAtomic이 트랜잭션이므로 이론적으로는 발생하지 않지만, 안전망으로 확인합니다.
    return res.status(502).json({
      success: false,
      error: "초안 6개가 모두 저장되지 않아 생성을 취소했습니다.",
      canRetry: true,
    });
  }

  // 생성이 실제로 성공했을 때만 다음 표현 결로 넘긴다(실패한 시도는 순환을 소비하지 않는다).
  setSetting(AFFILIATE_TONE_VARIATION_KEY, String((variationIndex + 1) % AFFILIATE_TONE_VARIATIONS.length));

  // 초안이 DB에 실제로 저장된 뒤에만 성공 응답을 보냅니다.
  res.json({
    success: true,
    draftIds: insertedIds,
    count: insertedIds.length,
    batchId,
  });
});

export default router;
