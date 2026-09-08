// src/database.ts
// SQLite(better-sqlite3) 데이터베이스 연결과 테이블 생성, 그리고 자주 쓰는 조회/저장 함수들을 모아둔 파일입니다.
// 초보자 안내: 표(테이블) 구조를 바꾸고 싶으면 아래 SCHEMA_SQL만 수정하면 됩니다.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { config } from "./env";
import { clampDailyLimit, DEFAULT_SCHEDULE_ROUTINE, ScheduleRoutine, validateScheduleRoutineInput } from "./scheduleRoutine";
import { ProductRadarProduct, ProductRadarProductManualInput, ProductRadarProductPatch } from "./productRadar/types";

let dbInstance: Database.Database | null = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_name TEXT,
  source_url TEXT,
  source_type TEXT NOT NULL, -- 'rss' | 'url' | 'text' | 'keyword'
  published_at TEXT,
  collected_at TEXT NOT NULL,
  content TEXT,
  dedupe_hash TEXT NOT NULL UNIQUE,
  meta_json TEXT -- 자유 형식 부가정보(JSON): 사용자 키워드/참고 설명/사실 근거 수준 등. 없으면 NULL.
);

CREATE TABLE IF NOT EXISTS feeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  hook TEXT,
  body TEXT NOT NULL,
  topic TEXT,
  source_title TEXT,
  source_url TEXT,
  source_summary TEXT,
  confidence TEXT,
  risk_notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  persona_version INTEGER,
  scheduled_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_material_id INTEGER,
  generation_batch_id TEXT,
  source_type TEXT,
  product_name TEXT,
  affiliate_url TEXT,
  usage_status TEXT,
  disclosure_text TEXT,
  promotion_style TEXT,
  media_filename TEXT,
  media_type TEXT,
  media_mime TEXT,
  media_original_name TEXT,
  allow_publish_without_affiliate_link INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  scheduled_at TEXT,
  attempted_at TEXT NOT NULL,
  published_at TEXT,
  threads_post_id TEXT,
  success INTEGER NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  sources TEXT,
  persona_version INTEGER,
  media_type TEXT, -- Phase 12.5.4: 'TEXT'|'IMAGE'|'VIDEO' (시도 자체가 없었던 옛 행은 NULL)
  FOREIGN KEY(draft_id) REFERENCES drafts(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS claude_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  raw_response TEXT,
  error_message TEXT
);

-- 글 생성(자료 선별) 배치마다, 평가에 사용된 모든 자료의 점수/이유를 기록합니다.
-- (선정된 것과 제외된 것 모두 기록되어 나중에 확인할 수 있습니다)
CREATE TABLE IF NOT EXISTS material_candidates_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  material_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  reason TEXT NOT NULL,
  selected INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- ===================== 상품 레이더 (product_radar_*) =====================
-- docs/design/product-radar-v1-final-design.md 36.3절 스키마를 그대로 채택합니다.
-- MVP1-1에서는 product_radar_products만 실제로 값이 채워지고, 나머지 8개는 이후 MVP
-- (확장프로그램 연결/상품 수집/비교/미디어 제작)에서 값이 채워지기 시작하는 빈 테이블입니다.

CREATE TABLE IF NOT EXISTS product_radar_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  source_url TEXT NOT NULL,
  canonical_url TEXT,
  product_external_id TEXT,
  seller_name TEXT,
  product_name TEXT NOT NULL,
  brand TEXT,
  model_name TEXT,
  option_name TEXT,
  category TEXT,
  price INTEGER,
  original_price INTEGER,
  shipping_fee INTEGER,
  shipping_type TEXT,
  shipping_text TEXT,
  rating REAL,
  review_count INTEGER,
  features_json TEXT,
  representative_image_id INTEGER,
  raw_source_type TEXT NOT NULL,
  user_overridden_fields_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  first_collected_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  affiliate_url TEXT,
  affiliate_product_id TEXT,
  affiliate_verified_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prp_canonical_url ON product_radar_products(canonical_url) WHERE canonical_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prp_site_external ON product_radar_products(site_id, product_external_id);
CREATE INDEX IF NOT EXISTS idx_prp_status ON product_radar_products(status);

CREATE TABLE IF NOT EXISTS product_radar_product_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  price INTEGER,
  original_price INTEGER,
  shipping_fee INTEGER,
  rating REAL,
  review_count INTEGER,
  snapshot_json TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  FOREIGN KEY(product_id) REFERENCES product_radar_products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prps_product ON product_radar_product_snapshots(product_id);

CREATE TABLE IF NOT EXISTS product_radar_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  source_url TEXT NOT NULL,
  local_filename TEXT,
  width INTEGER,
  height INTEGER,
  byte_size INTEGER,
  is_user_uploaded INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(product_id) REFERENCES product_radar_products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pri_product ON product_radar_images(product_id);

CREATE TABLE IF NOT EXISTS product_radar_compare_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compare_type TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  analysis_json TEXT,
  info_as_of TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_radar_compare_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compare_group_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  analysis_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(compare_group_id) REFERENCES product_radar_compare_groups(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES product_radar_products(id)
);
CREATE INDEX IF NOT EXISTS idx_prci_group ON product_radar_compare_items(compare_group_id);

CREATE TABLE IF NOT EXISTS product_radar_media_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compare_group_id INTEGER,
  product_id INTEGER,
  media_type TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  failure_reason TEXT,
  draft_id INTEGER,
  manifest_path TEXT,
  -- Phase 12.5.3.9: video/animation job이 어느 rendered card/carousel job의 PNG를 motion
  -- source로 썼는지(historical lineage, FK 아님 - recommendation_snapshot_id와 동일 원칙).
  source_media_job_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(compare_group_id) REFERENCES product_radar_compare_groups(id),
  FOREIGN KEY(product_id) REFERENCES product_radar_products(id),
  FOREIGN KEY(draft_id) REFERENCES drafts(id)
);
CREATE INDEX IF NOT EXISTS idx_prmj_status ON product_radar_media_jobs(status);
CREATE INDEX IF NOT EXISTS idx_prmj_draft ON product_radar_media_jobs(draft_id);

CREATE TABLE IF NOT EXISTS product_radar_media_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_job_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  slide_index INTEGER,
  filename TEXT NOT NULL,
  byte_size INTEGER,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  retention_pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(media_job_id) REFERENCES product_radar_media_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prmf_job ON product_radar_media_files(media_job_id);

CREATE TABLE IF NOT EXISTS product_radar_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_job_id INTEGER NOT NULL,
  gateway_upload_id TEXT NOT NULL,
  public_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  expires_at TEXT NOT NULL,
  extended_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(media_job_id) REFERENCES product_radar_media_jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_pru_job ON product_radar_uploads(media_job_id);
CREATE INDEX IF NOT EXISTS idx_pru_expires ON product_radar_uploads(expires_at);

CREATE TABLE IF NOT EXISTS product_radar_extension_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

-- 상품 레이더 Phase 9.5: Immutable Comparison Snapshot(src/productRadar/comparisonSnapshot.ts)를
-- INSERT-only로 얼려서 저장. docs/designs/product-radar-phase9-comparison-foundation-design.md
-- 16절이 제안한 물리 schema(product_refs_json 등 JSON 컬럼 관례)를 따르되, relations_json/
-- compatibility/fields_json/missing_fields_json은 실제로 구현된 Phase 9.2~9.4 데이터 모양에
-- 맞게 pairs_json(관계별 relation+compatibility를 이미 함께 담고 있음)과
-- product_evidence_json(설계서 이후 추가된 data provenance)으로 대체했다(완료 보고 참고 -
-- Comparison Field/Unit Normalization 모델은 아직 구현되지 않아 존재하지 않는 데이터를
-- 억지로 채우지 않는다). id는 호출자가 이미 완성한 ComparisonSnapshot.id를 그대로 쓴다
-- (AUTOINCREMENT는 그 값을 명시적으로 넣을 때도 그대로 저장 - 중복 INSERT는 PK 위반으로
-- 자연히 거부된다).
CREATE TABLE IF NOT EXISTS product_radar_comparison_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compare_group_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  info_as_of TEXT NOT NULL,
  product_refs_json TEXT NOT NULL,
  product_evidence_json TEXT NOT NULL,
  pairs_json TEXT NOT NULL,
  FOREIGN KEY(compare_group_id) REFERENCES product_radar_compare_groups(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prcs_group_revision
  ON product_radar_comparison_snapshots(compare_group_id, revision);

-- 상품 레이더 Phase 10.1: Recommendation Snapshot Persistence. comparison_snapshot_id로만
-- 부모와 연결한다 - compareGroupId/comparisonRevision/infoAsOf는 전부 ComparisonSnapshot에서
-- 파생 가능하므로 컬럼으로 중복 저장하지 않는다(불일치 가능성을 만들지 않기 위함, 완료 보고
-- 참고). provenance도 별도 컬럼으로 정규화하지 않는다 - 검색/필터 요구가 없어
-- products_json 안에 그대로 보존하면 충분하다. product_radar_comparison_snapshots와 동일한
-- INSERT-only + (parent_id, revision) UNIQUE 패턴.
--
-- Phase 12.4.1: output_language(nullable) 추가 - RecommendationResult 자체의 필드가
-- 아니라 "이 revision이 어떤 언어로 생성됐는가"라는 저장 메타데이터라 별도 컬럼으로 둔다
-- (provenance와 달리 "latest ko/en" 조회 요구가 실제로 있어 컬럼 자격이 다름, 완료 보고
-- 참고). CHECK 제약은 추가하지 않는다 - "ko"/"en"/NULL 외 값 거부는 application
-- hydration/insert 계층(recommendationPersistence.ts)이 이미 강제하므로 DB 레벨 제약을
-- 중복으로 얹지 않는다(불필요한 migration 복잡도 회피).
CREATE TABLE IF NOT EXISTS product_radar_recommendation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comparison_snapshot_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  products_json TEXT NOT NULL,
  missing_information_json TEXT NOT NULL,
  output_language TEXT,
  FOREIGN KEY(comparison_snapshot_id) REFERENCES product_radar_comparison_snapshots(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_prrs_snapshot_revision
  ON product_radar_recommendation_snapshots(comparison_snapshot_id, revision);

-- 상품 레이더 Phase 12.5.3.6: 상품 선별("찜"/"후보") - 비교 evidence가 아니므로 가격/상품명/
-- 이미지/variation 등을 절대 freeze하지 않는다(요청서 4절). productId + 상태 + 시각뿐이다.
-- 계층형 상태(요청서 5절): 'shortlisted'는 'favorite'을 항상 포함하는 상위 상태로 다룬다
-- (찜 목록 조회 시 'favorite'/'shortlisted' 둘 다 보임 - 별도 UNION 테이블을 두지 않고 이
-- 하나의 state 컬럼으로 표현하는 쪽이 이 repo의 기존 status-column convention과 일치한다,
-- product_radar_products.status/drafts.status와 동일한 패턴). product당 row는 최대 1개
-- (UNIQUE product_id) - "찜 해제"는 이 row 자체를 지운다(후보였어도 완전히 제거, 요청서 41절
-- C). "후보에서 제외"는 state만 shortlisted -> favorite로 낮춘다(row는 유지, 요청서 8·41절 F).
CREATE TABLE IF NOT EXISTS product_radar_curations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL, -- 'favorite' | 'shortlisted'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(product_id) REFERENCES product_radar_products(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prcur_state ON product_radar_curations(state);

-- 상품 레이더 Phase 12.5.3.6: 미디어 보관함 - 사용자가 직접 업로드한 asset(요청서 12·16절).
-- "asset"(업로드 묶음 - 캐러셀이면 파일 여러 개)과 "asset file"(실제 파일 1개)을 분리해
-- slide_index로 순서를 표현한다(요청서 19절 - 파일명 정렬로 순서를 자동 확정하지 않는다).
-- 이 테이블은 오직 사용자 업로드만 담는다 - client가 origin을 조작할 방법이 구조적으로
-- 없다(요청서 14절 - "generated"로 위장 불가. generated media는 별도 테이블
-- product_radar_media_jobs/files에만 존재하고 이 테이블과 절대 섞이지 않는다).
CREATE TABLE IF NOT EXISTS product_radar_library_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL, -- 'image' | 'carousel' | 'video' | 'gif'
  original_name TEXT, -- 표시용 metadata뿐 - 저장 경로/서빙 키로 절대 쓰지 않는다(요청서 18절)
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_radar_library_asset_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL,
  slide_index INTEGER, -- carousel만 0-based로 사용, image/video/gif는 NULL
  filename TEXT NOT NULL, -- mediaUpload.ts가 만든 UUID 내부 파일명(saveValidatedMedia() 재사용)
  mime TEXT NOT NULL,
  byte_size INTEGER,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(asset_id) REFERENCES product_radar_library_assets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prlaf_asset ON product_radar_library_asset_files(asset_id);

-- 상품 레이더 Phase 12.5.3.6: 미디어 찜(요청서 23절) - generated/uploaded 어느 쪽이든 asset_key
-- 하나로 표현한다("job:<mediaJobId>" | "upload:<libraryAssetId>") - 두 개의 별도 테이블(FK
-- NULL 허용 둘 다) 대신 문자열 키 하나로 묶는 쪽이 훨씬 단순하다(찜 여부 조회가 항상 단일
-- SELECT). 찜 = 사용 확정 아님 - 이 테이블은 draft attachment와 전혀 연결되지 않는다.
CREATE TABLE IF NOT EXISTS product_radar_media_favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
`;

// 기존에 만들어진 DB(예: 이미 자료를 모아둔 상태)에도 새 컬럼을 안전하게 추가합니다.
// 기존 데이터(자료함 등)는 전혀 건드리지 않고, 컬럼이 없을 때만 추가합니다.
function migrateSchema(db: Database.Database) {
  const cols = db.prepare("PRAGMA table_info(drafts)").all() as { name: string }[];
  const colNames = cols.map((c) => c.name);
  if (!colNames.includes("source_material_id")) {
    db.exec("ALTER TABLE drafts ADD COLUMN source_material_id INTEGER");
  }
  if (!colNames.includes("generation_batch_id")) {
    db.exec("ALTER TABLE drafts ADD COLUMN generation_batch_id TEXT");
  }
  // 쿠파스(쿠팡 파트너스) 상품 홍보 모드 전용 메타데이터. 일반 글에는 전부 NULL로 남습니다.
  if (!colNames.includes("source_type")) {
    db.exec("ALTER TABLE drafts ADD COLUMN source_type TEXT");
  }
  if (!colNames.includes("product_name")) {
    db.exec("ALTER TABLE drafts ADD COLUMN product_name TEXT");
  }
  if (!colNames.includes("affiliate_url")) {
    db.exec("ALTER TABLE drafts ADD COLUMN affiliate_url TEXT");
  }
  // 제휴글인데 발행 본문에 제휴링크가 없는 상태로 예약하는 것을 사용자가 경고를 보고
  // 명시적으로 승인했는지. 0(기본) = 승인 안 함이라 기존 행은 전부 안전한 쪽으로 남는다.
  // 기존 컬럼 재사용을 먼저 검토했으나 적합한 것이 없었다 - risk_notes/usage_status/
  // confidence 는 각각 사람이 읽는 메모·직접사용여부·신뢰도라는 고유 의미가 있고
  // (사용자가 고치면 승인이 날아간다), 범용 메타데이터/플래그 컬럼은 존재하지 않는다.
  if (!colNames.includes("allow_publish_without_affiliate_link")) {
    db.exec("ALTER TABLE drafts ADD COLUMN allow_publish_without_affiliate_link INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.includes("usage_status")) {
    db.exec("ALTER TABLE drafts ADD COLUMN usage_status TEXT");
  }
  if (!colNames.includes("disclosure_text")) {
    db.exec("ALTER TABLE drafts ADD COLUMN disclosure_text TEXT");
  }
  if (!colNames.includes("promotion_style")) {
    db.exec("ALTER TABLE drafts ADD COLUMN promotion_style TEXT");
  }
  // 쿠파스 "내 사진·영상 첨부" 전용. 일반 글/미첨부 쿠파스 글에는 전부 NULL로 남습니다.
  if (!colNames.includes("media_filename")) {
    db.exec("ALTER TABLE drafts ADD COLUMN media_filename TEXT");
  }
  if (!colNames.includes("media_type")) {
    db.exec("ALTER TABLE drafts ADD COLUMN media_type TEXT");
  }
  if (!colNames.includes("media_mime")) {
    db.exec("ALTER TABLE drafts ADD COLUMN media_mime TEXT");
  }
  if (!colNames.includes("media_original_name")) {
    db.exec("ALTER TABLE drafts ADD COLUMN media_original_name TEXT");
  }
  // 상품 레이더 미디어 작업(product_radar_media_jobs)과 초안을 연결하는 컬럼(MVP2부터 값이 채워짐).
  if (!colNames.includes("product_radar_media_job_id")) {
    db.exec("ALTER TABLE drafts ADD COLUMN product_radar_media_job_id INTEGER");
  }
  // 직접 글 작성(source_type='manual') 전용 UI 순번. #draftId와는 별개의 표시용
  // 메타데이터이며, Threads 본문/제목/발행 payload에는 절대 들어가지 않는다.
  // AI 생성 초안은 영원히 NULL로 남는다(백필 대상도 아니다).
  if (!colNames.includes("manual_sequence")) {
    db.exec("ALTER TABLE drafts ADD COLUMN manual_sequence INTEGER");
  }

  const materialCols = db.prepare("PRAGMA table_info(materials)").all() as { name: string }[];
  const materialColNames = materialCols.map((c) => c.name);
  if (!materialColNames.includes("meta_json")) {
    db.exec("ALTER TABLE materials ADD COLUMN meta_json TEXT");
  }

  // 상품 레이더 MVP1-2: 확장프로그램 연결 토큰 상세 정보(MVP1-1은 token_hash/created_at/
  // last_seen_at/revoked만 있는 최소 스키마였습니다). token_prefix는 원문 토큰의 앞 8자만
  // 저장하는 표시용 값입니다(라이선스 key_last4와 동일한 원칙 - 전체 토큰은 해시로만 저장).
  const extTokenCols = db.prepare("PRAGMA table_info(product_radar_extension_tokens)").all() as { name: string }[];
  const extTokenColNames = extTokenCols.map((c) => c.name);
  if (!extTokenColNames.includes("token_prefix")) {
    db.exec("ALTER TABLE product_radar_extension_tokens ADD COLUMN token_prefix TEXT");
  }
  if (!extTokenColNames.includes("extension_version")) {
    db.exec("ALTER TABLE product_radar_extension_tokens ADD COLUMN extension_version TEXT");
  }
  if (!extTokenColNames.includes("browser")) {
    db.exec("ALTER TABLE product_radar_extension_tokens ADD COLUMN browser TEXT");
  }
  if (!extTokenColNames.includes("revoked_at")) {
    db.exec("ALTER TABLE product_radar_extension_tokens ADD COLUMN revoked_at TEXT");
  }

  // 상품 레이더 Phase 5: ProductRadarBrowser가 보낸 saveJobId를 멱등 키로 씁니다(같은
  // saveJobId가 재전송돼도 상품/snapshot이 두 번 생기지 않게). 값이 있을 때만 유니크해야
  // 하므로(과거 행에는 이 컬럼이 없음) canonical_url과 동일하게 부분 유니크 인덱스로 둡니다.
  const snapshotCols = db.prepare("PRAGMA table_info(product_radar_product_snapshots)").all() as { name: string }[];
  const snapshotColNames = snapshotCols.map((c) => c.name);
  if (!snapshotColNames.includes("save_job_id")) {
    db.exec("ALTER TABLE product_radar_product_snapshots ADD COLUMN save_job_id TEXT");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_prps_save_job_id ON product_radar_product_snapshots(save_job_id) WHERE save_job_id IS NOT NULL"
  );

  // 상품 레이더 Phase 12.5.6D.4.2.6: ProductRadarBrowser의 Naver 가격 enrichment(검증된
  // 대표 가격 영역의 "최대할인가" 등 conditional 가격). price/original_price와 완전히 별개인
  // nullable 추가 컬럼 - 기존 행은 전부 NULL로 남는다(백필 없음). product_radar_product_snapshots
  // 쪽도 product_radar_products와 동일하게 additive로 추가한다(요청서 9절).
  if (!snapshotColNames.includes("conditional_price")) {
    db.exec("ALTER TABLE product_radar_product_snapshots ADD COLUMN conditional_price INTEGER");
  }
  if (!snapshotColNames.includes("conditional_price_label")) {
    db.exec("ALTER TABLE product_radar_product_snapshots ADD COLUMN conditional_price_label TEXT");
  }

  // 상품 레이더 Phase 9.1: 비교 기반용 category metadata(설계서
  // docs/designs/product-radar-phase9-comparison-foundation-design.md 16절/7절). 전부
  // nullable이고 기존 행은 전부 NULL로 남습니다(백필 없음, 요청서 5절/16절) - 이번
  // Phase는 저장 공간만 추가할 뿐, save/update pipeline 어디에도 아직 연결하지
  // 않습니다. dedup key(canonical_url, site_id+product_external_id)와 완전히
  // 무관하며 UNIQUE 제약도 걸지 않습니다(요청서 3절 7번/8번).
  const productCols = db.prepare("PRAGMA table_info(product_radar_products)").all() as { name: string }[];
  const productColNames = productCols.map((c) => c.name);
  if (!productColNames.includes("category_level1")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN category_level1 TEXT");
  }
  if (!productColNames.includes("category_level2")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN category_level2 TEXT");
  }
  if (!productColNames.includes("category_level3")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN category_level3 TEXT");
  }
  if (!productColNames.includes("category_key")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN category_key TEXT");
  }
  if (!productColNames.includes("category_source")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN category_source TEXT");
  }
  if (!productColNames.includes("category_confidence")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN category_confidence REAL");
  }
  if (!productColNames.includes("category_classification_version")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN category_classification_version INTEGER");
  }

  // 상품 레이더 Phase 12.5.6D.4: ProductRadarBrowser가 background one-shot으로 자동 추출한
  // 쿠팡 후기 aggregate 요약(overall 5단계 + attribute[]). 기존 컬럼(features_json 등)에
  // 억지로 합치지 않고 명확한 이름의 새 nullable 컬럼을 추가한다(요청서 19절) - 리뷰 원문은
  // 절대 저장하지 않으며, 구조화된 요약만 JSON으로 담는다. 기존 행은 전부 NULL로 남고
  // (백필 없음), null이 기존 non-null 값을 덮어쓰지 않는 갱신 원칙은
  // refreshProductRadarProductFromSnapshot()이 REFRESH_STRING_COLUMN_MAP 등과 동일하게 적용한다.
  if (!productColNames.includes("review_summary_json")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN review_summary_json TEXT");
  }

  // 쿠팡 파트너스 제휴링크(저장 시 1회 검증된 값만 들어온다 - productRadar/affiliateLink.ts).
  // 위 review_summary_json 과 동일하게 additive nullable 컬럼이며 기존 행은 전부 NULL로 남는다.
  // affiliate_product_id 는 검증 당시 링크가 가리킨 쿠팡 productId 로, product_external_id 와
  // 같을 때만 저장된다 - 나중에 이 값만 비교하면 재검증(=재클릭) 없이 짝이 맞는지 알 수 있다.
  if (!productColNames.includes("affiliate_url")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN affiliate_url TEXT");
  }
  if (!productColNames.includes("affiliate_product_id")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN affiliate_product_id TEXT");
  }
  if (!productColNames.includes("affiliate_verified_at")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN affiliate_verified_at TEXT");
  }

  // 상품 레이더 Phase 12.5.6D.4.2.6: 위 product_radar_product_snapshots와 동일한 이유로
  // product_radar_products 쪽에도 additive nullable 컬럼을 추가한다.
  if (!productColNames.includes("conditional_price")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN conditional_price INTEGER");
  }
  if (!productColNames.includes("conditional_price_label")) {
    db.exec("ALTER TABLE product_radar_products ADD COLUMN conditional_price_label TEXT");
  }

  // 상품 레이더 Phase 12.4.1: 기존(migration 전) recommendation snapshot row에는
  // output_language 컬럼이 없다 - nullable로 추가하고 기존 행은 그대로 NULL로 남긴다
  // (backfill 안 함 - 옛 row가 어떤 언어였는지 추측하지 않는다).
  const recommendationSnapshotCols = db.prepare("PRAGMA table_info(product_radar_recommendation_snapshots)").all() as { name: string }[];
  const recommendationSnapshotColNames = recommendationSnapshotCols.map((c) => c.name);
  if (!recommendationSnapshotColNames.includes("output_language")) {
    db.exec("ALTER TABLE product_radar_recommendation_snapshots ADD COLUMN output_language TEXT");
  }

  // 상품 레이더 Phase 12.5.2.3.3.1: draft가 "어느 정확한 RecommendationSnapshot으로 생성됐는가"
  // historical lineage. nullable - 기존 일반/쿠파스/legacy draft는 전부 NULL로 남는다(backfill
  // 없음). SCHEMA_SQL 실행(위 dbInstance.exec(SCHEMA_SQL))이 이 ALTER TABLE보다 항상 먼저
  // 실행되므로 product_radar_recommendation_snapshots 테이블은 이미 존재한다 - 별도 순서
  // 조정이 필요 없다. FK REFERENCES는 ON DELETE를 명시하지 않는다(SQLite 기본 NO ACTION) -
  // 부모 recommendation이 삭제될 때 draft가 CASCADE 삭제되거나 SET NULL되면 안 된다는
  // 요청서 6절 원칙 그대로(현재 recommendation을 삭제하는 경로 자체가 없다).
  const draftColsForLineage = db.prepare("PRAGMA table_info(drafts)").all() as { name: string }[];
  const draftColNamesForLineage = draftColsForLineage.map((c) => c.name);
  if (!draftColNamesForLineage.includes("product_radar_recommendation_snapshot_id")) {
    db.exec("ALTER TABLE drafts ADD COLUMN product_radar_recommendation_snapshot_id INTEGER REFERENCES product_radar_recommendation_snapshots(id)");
  }
  // "이 recommendation으로 만든 draft 목록" 조회를 대비한 partial index(idx_prps_save_job_id와
  // 동일한 기존 관례 - WHERE IS NOT NULL로 대다수인 legacy NULL row를 인덱스에서 제외).
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_drafts_prrs_id ON drafts(product_radar_recommendation_snapshot_id) WHERE product_radar_recommendation_snapshot_id IS NOT NULL"
  );

  // 상품 레이더 Phase 12.5.3.2: media job이 "어느 정확한 RecommendationSnapshot의 strengths/
  // cautions를 소비했는가" historical lineage. compare_group_id만으로는 부족하다(같은 group
  // 안에 recommendation revision이 여러 개 있을 수 있음) - drafts.product_radar_recommendation_snapshot_id와
  // 동일한 원칙(nullable, backfill 없음, ON DELETE 명시 안 함=SQLite 기본 NO ACTION, UNIQUE 없음
  // - 같은 recommendation으로 여러 media job을 만들 수 있다). comparison_snapshot_id는 별도
  // 컬럼으로 중복 저장하지 않는다 - recommendation row에서 파생 가능하다(요청서 2절).
  const mediaJobCols = db.prepare("PRAGMA table_info(product_radar_media_jobs)").all() as { name: string }[];
  const mediaJobColNames = mediaJobCols.map((c) => c.name);
  if (!mediaJobColNames.includes("recommendation_snapshot_id")) {
    db.exec("ALTER TABLE product_radar_media_jobs ADD COLUMN recommendation_snapshot_id INTEGER REFERENCES product_radar_recommendation_snapshots(id)");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_prmj_recommendation ON product_radar_media_jobs(recommendation_snapshot_id) WHERE recommendation_snapshot_id IS NOT NULL"
  );
  // Phase 12.5.3.9: video/animation job의 motion source provenance(위 CREATE TABLE에도 이미
  // 있지만, 이 컬럼이 생기기 전에 만들어진 기존 DB 파일에는 이 ALTER가 필요하다).
  if (!mediaJobColNames.includes("source_media_job_id")) {
    db.exec("ALTER TABLE product_radar_media_jobs ADD COLUMN source_media_job_id INTEGER");
  }

  // 상품 레이더 Phase 12.5.3.6: draft가 현재 쓰는 미디어가 "생성된 media job"인지 "사용자가
  // 업로드해 보관함에서 고른 asset"인지 별도 컬럼으로 구분한다(요청서 21절 architecture 결정 -
  // 기존 product_radar_media_job_id의 lineage 검증(attachProductRadarMediaJobToDraft)을 전혀
  // 건드리지 않는다. uploaded asset은 특정 recommendation에 묶여있지 않으므로 그 lineage
  // 검증 대상이 아니다 - 완전히 별개의 attach 경로/컬럼을 쓴다). 두 컬럼은 상호 배타적으로
  // 관리한다 - 한쪽을 attach하면 다른 쪽은 NULL로 지운다(attachProductRadarMediaJobToDraftIfNewer/
  // attachProductRadarLibraryAssetToDraft 양쪽에서 SET절로 처리, 요청서 21절 "현재 draft가
  // 쓰는 미디어"는 항상 정확히 하나).
  //
  // adversarial review(Phase 12.5.3.6)에서 발견/수정: FK REFERENCES는 유지하되 ON DELETE SET
  // NULL을 명시한다(직접 재현 확인 - foreign_keys=ON이면 ALTER TABLE로 추가된 FK도 실제로
  // 강제되고, ON DELETE SET NULL도 정상 동작함). 이 컬럼은 product_radar_recommendation_snapshot_id
  // 처럼 "역사적 근거"가 아니라 "현재 draft가 쓰는 미디어"를 가리키는 가변 포인터다(요청서
  // 21절 - 이미 두 attachment 컬럼이 서로를 NULL로 지우는 상호배타 로직을 갖고 있음) - asset이
  // 사라지면 draft는 유지한 채 참조만 자연히 해제되는 것이 정확히 원하는 시맨틱이며, 향후(다음
  // Phase) 미디어 삭제 기능이 추가돼도 애플리케이션 코드 실수와 무관하게 항상 안전을 보장한다.
  // ON DELETE SET NULL 덕분에 factoryResetClearAllTables()가 product_radar_library_assets를
  // drafts보다 먼저 비워도(기존 삭제 순서 그대로) FOREIGN KEY constraint failed가 발생하지
  // 않는다 - 순서 조정이 불필요하다. (참고: product_radar_media_job_id는 FK가 없는데, 그건
  // 이 컬럼과 다른 의도적 설계가 아니라 그 시점에 이 문제 자체가 고려되지 않았던 것으로
  // 보인다 - 형제 컬럼을 그대로 따라가지 않는다.)
  if (!draftColNamesForLineage.includes("product_radar_library_asset_id")) {
    db.exec("ALTER TABLE drafts ADD COLUMN product_radar_library_asset_id INTEGER REFERENCES product_radar_library_assets(id) ON DELETE SET NULL");
  }

  // Phase 12.5.4: 이 tick에서 실제로 발행 시도한 media_type(TEXT/IMAGE/VIDEO)을 남깁니다(요청서
  // 11절 - "이미 대응 필드가 있다면 새 필드를 만들지 않는다": threads_post_id/published_at은
  // 이미 있어 재사용하고, "발행된 media type"만 대응 컬럼이 없어 최소 1개만 추가). nullable -
  // 기존 행은 전부 NULL로 남습니다(백필 없음, 다른 lineage 컬럼과 동일 원칙).
  const publishLogCols = db.prepare("PRAGMA table_info(publish_log)").all() as { name: string }[];
  const publishLogColNames = publishLogCols.map((c) => c.name);
  if (!publishLogColNames.includes("media_type")) {
    db.exec("ALTER TABLE publish_log ADD COLUMN media_type TEXT");
  }

  // 남아 있는 직접 작성 초안의 번호를 항상 1..N으로 정규화한다. 값이 이미 맞는 행은
  // 건드리지 않으므로 앱을 몇 번 재시작해도 결과가 변하지 않는다(idempotent).
  // 예전 high-water mark 방식이 남긴 settings 값도 여기서 함께 정리한다.
  db.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_MANUAL_SEQUENCE_HIGH_WATER_KEY);
  renumberManualSequences(db);
}

// ==================================================================================
// 직접 글 작성 순번(manual_sequence)
//
// 이 번호는 영구 누적 일련번호가 아니라 "지금 남아 있는 직접 작성 초안의 작업 순서"를
// 보여주는 UI 번호다. 그래서 초안이 늘거나 줄 때마다 created_at ASC, id ASC 순서로
// 1..N을 다시 매긴다 - 직접 작성 초안을 전부 지우면 다음 저장은 다시 01부터 시작한다.
//
// 예전에는 지워진 번호를 재사용하지 않으려고 settings에 high-water mark를 남겼는데,
// 그러면 01·02를 지우고 03만 남았을 때 화면에 "직접 작성 03"이 그대로 남아 현재 목록과
// 어긋난다. 번호의 의미가 "작업 목록에서의 순서"이므로 그 방식을 폐기했다.
// 아래 키는 더 이상 읽지 않으며, migrateSchema에서 기존 값을 삭제하기 위해서만 남겨 둔다.
// ==================================================================================
const LEGACY_MANUAL_SEQUENCE_HIGH_WATER_KEY = "manual_draft_sequence_high_water";

// 남아 있는 manual 초안에 created_at ASC, id ASC 순서로 1..N을 다시 매긴다.
// AI 생성 초안(source_type != 'manual')은 조회 대상이 아니므로 항상 NULL 그대로 남는다.
// 값이 이미 맞는 행은 UPDATE하지 않는다 - 재실행해도 결과가 같고 불필요한 쓰기도 없다.
export function renumberManualSequences(db: Database.Database = getDb()): void {
  const rows = db
    .prepare("SELECT id, manual_sequence FROM drafts WHERE source_type = 'manual' ORDER BY created_at ASC, id ASC")
    .all() as { id: number; manual_sequence: number | null }[];
  if (rows.length === 0) return;
  const upd = db.prepare("UPDATE drafts SET manual_sequence = ? WHERE id = ?");
  // 이미 transaction 안에서 불릴 수 있다(insertManualDraft) - better-sqlite3가 중첩
  // transaction을 SAVEPOINT로 처리하므로 그대로 감싸도 안전하다.
  const txn = db.transaction(() => {
    rows.forEach((r, i) => {
      const want = i + 1;
      if (r.manual_sequence !== want) upd.run(want, r.id);
    });
  });
  txn();
}

export function countManualDrafts(db: Database.Database = getDb()): number {
  const r = db.prepare("SELECT COUNT(*) AS c FROM drafts WHERE source_type = 'manual'").get() as { c: number };
  return r.c;
}

// 모달이 "다음은 몇 번째 글인지" 보여주기 위한 조회. 지금 남아 있는 직접 작성 초안 수 + 1이며,
// 아무것도 남아 있지 않으면 1이다. 값을 소모하지 않는다(읽기 전용).
export function peekNextManualSequence(): number {
  return countManualDrafts() + 1;
}

// 직접 글 작성 전용 INSERT. INSERT와 재번호를 한 transaction으로 묶는다(better-sqlite3는
// 동기 실행이라 transaction 중간에 다른 쓰기가 끼어들 수 없다 - 기존 insertDraftsAtomic과
// 같은 직렬화 패턴). 새 초안은 created_at/id가 가장 크므로 정렬상 마지막 = N번이 된다.
export function insertManualDraft(d: DraftInput): { id: number; manualSequence: number } {
  const db = getDb();
  const txn = db.transaction(() => {
    const id = insertDraft({ ...d, source_type: "manual" });
    renumberManualSequences(db);
    const row = db.prepare("SELECT manual_sequence FROM drafts WHERE id = ?").get(id) as { manual_sequence: number };
    return { id, manualSequence: row.manual_sequence };
  });
  return txn();
}

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  dbInstance = new Database(config.DB_PATH);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  dbInstance.exec(SCHEMA_SQL);
  migrateSchema(dbInstance);
  return dbInstance;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayKST(): string {
  // Asia/Seoul 기준 오늘 날짜(YYYY-MM-DD)
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}

function dateKST(isoOrNull: string | null): string | null {
  if (!isoOrNull) return null;
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(isoOrNull));
}

// ---------- settings ----------
export function getSetting(key: string, fallback: string | null = null): string | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ---------- 자료 입력(오늘 자료 수집) 화면의 마지막 입력값 저장/복원 ----------
// 새 설정 파일을 만들지 않고 기존 settings 키-값 테이블을 재사용한다.
// Claude 로그인 정보, Threads 비밀번호, 쿠키, 세션, 토큰 등은 절대 여기 저장하지 않는다.
export interface MaterialInputPrefs {
  lastMode: "auto" | "keyword" | "url" | "mixed";
  includeKeywords: string;
  excludeKeywords: string;
  note: string;
  candidateCount: number;
  recentUrls: string[];
}

const MATERIAL_INPUT_PREFS_KEY = "material_input_prefs";

export const DEFAULT_MATERIAL_INPUT_PREFS: MaterialInputPrefs = {
  lastMode: "auto",
  includeKeywords: "",
  excludeKeywords: "",
  note: "",
  candidateCount: 3,
  recentUrls: [],
};

// 설정 파일(값)이 없거나 손상되어도 프로그램이 멈추지 않고 기본값으로 복구된다.
export function getMaterialInputPrefs(): MaterialInputPrefs {
  const raw = getSetting(MATERIAL_INPUT_PREFS_KEY, null);
  if (!raw) return { ...DEFAULT_MATERIAL_INPUT_PREFS };
  try {
    const parsed = JSON.parse(raw);
    return {
      lastMode: ["auto", "keyword", "url", "mixed"].includes(parsed.lastMode) ? parsed.lastMode : DEFAULT_MATERIAL_INPUT_PREFS.lastMode,
      includeKeywords: typeof parsed.includeKeywords === "string" ? parsed.includeKeywords : "",
      excludeKeywords: typeof parsed.excludeKeywords === "string" ? parsed.excludeKeywords : "",
      note: typeof parsed.note === "string" ? parsed.note : "",
      candidateCount: Number.isFinite(parsed.candidateCount) ? parsed.candidateCount : DEFAULT_MATERIAL_INPUT_PREFS.candidateCount,
      recentUrls: Array.isArray(parsed.recentUrls) ? parsed.recentUrls.filter((u: unknown) => typeof u === "string") : [],
    };
  } catch {
    return { ...DEFAULT_MATERIAL_INPUT_PREFS };
  }
}

export function setMaterialInputPrefs(prefs: MaterialInputPrefs): void {
  setSetting(MATERIAL_INPUT_PREFS_KEY, JSON.stringify(prefs));
}

// ---------- 예약 루틴(반복 시간/요일/하루 최대 발행 수) ----------
// 새 설정 파일을 만들지 않고 기존 settings 키-값 테이블을 재사용합니다.
const SCHEDULE_ROUTINE_SETTING_KEY = "schedule_routine";

// dailyLimit은 "승인 글 자동배치 계획"과 "스케줄러의 실제 하루 발행 상한" 양쪽이 함께 사용하는
// 단일 값입니다(scheduler.ts가 매 tick 이 함수를 다시 호출해서 읽으므로, 서버 재시작 없이 다음
// tick부터 바로 반영됩니다). settings에 저장된 값이 없거나 손상되었으면(JSON 파싱 실패 또는
// 검증 실패) config.DAILY_MAX_PUBLISH(.env 기본값)를 기본 dailyLimit으로 사용합니다 - 시간·요일은
// scheduleRoutine.ts의 하드코딩된 기본값을 그대로 씁니다.
export function getScheduleRoutine(): ScheduleRoutine {
  const fallback: ScheduleRoutine = { ...DEFAULT_SCHEDULE_ROUTINE, dailyLimit: clampDailyLimit(config.DAILY_MAX_PUBLISH) };
  const raw = getSetting(SCHEDULE_ROUTINE_SETTING_KEY, null);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    const validated = validateScheduleRoutineInput(parsed);
    return validated.ok ? validated.value : fallback;
  } catch {
    return fallback;
  }
}

export function setScheduleRoutine(routine: ScheduleRoutine): void {
  setSetting(SCHEDULE_ROUTINE_SETTING_KEY, JSON.stringify(routine));
}

// ---------- persona ----------
export interface PersonaData {
  channel_identity: string;
  audience: string;
  tone_description: string;
  common_phrases: string;
  banned_phrases: string;
  length_preference: string;
  emoji_level: string;
  allow_question_ending: boolean;
  allow_external_links: boolean;
}

export interface PersonaRow {
  id: number;
  version: number;
  data: PersonaData;
  created_at: string;
}

export function getCurrentPersona(): PersonaRow | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM persona_versions ORDER BY version DESC LIMIT 1").get() as any;
  if (!row) return null;
  return { id: row.id, version: row.version, data: JSON.parse(row.data_json), created_at: row.created_at };
}

export function saveNewPersonaVersion(data: PersonaData): PersonaRow {
  const db = getDb();
  const current = getCurrentPersona();
  const nextVersion = current ? current.version + 1 : 1;
  const created_at = nowIso();
  const info = db
    .prepare("INSERT INTO persona_versions (version, data_json, created_at) VALUES (?, ?, ?)")
    .run(nextVersion, JSON.stringify(data), created_at);
  return { id: Number(info.lastInsertRowid), version: nextVersion, data, created_at };
}

// ---------- feeds ----------
export interface FeedRow {
  id: number;
  name: string;
  url: string;
  enabled: number;
  created_at: string;
}

export function listFeeds(): FeedRow[] {
  return getDb().prepare("SELECT * FROM feeds ORDER BY id ASC").all() as FeedRow[];
}

// 자료 출처 URL 비교용 정규화. UNIQUE 제약은 문자열 정확 일치라, 같은 피드를 사소한 표기
// 차이(대소문자 호스트, 후행 슬래시, 기본 포트)로 두 번 등록할 수 있었다. 중복 판정과
// built-in 여부 판정이 같은 기준을 쓰도록 이 함수 하나만 사용한다.
// 쿼리스트링은 피드를 구분하는 실제 값이므로 절대 버리지 않는다.
export function canonicalizeFeedUrl(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  try {
    const u = new URL(trimmed);
    const port = (u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443") ? "" : u.port;
    const host = u.hostname.toLowerCase() + (port ? ":" + port : "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol.toLowerCase()}//${host}${path}${u.search}`;
  } catch {
    return trimmed.toLowerCase(); // URL 파싱 불가 - 문자열 비교로 보수적 처리
  }
}

// 같은 자료원이 이미 등록돼 있으면 그 행을 돌려준다(없으면 null).
export function findFeedByUrl(rawUrl: string): FeedRow | null {
  const target = canonicalizeFeedUrl(rawUrl);
  if (!target) return null;
  return listFeeds().find((f) => canonicalizeFeedUrl(f.url) === target) ?? null;
}

export function addFeed(name: string, url: string): FeedRow {
  const db = getDb();
  const info = db.prepare("INSERT INTO feeds (name, url, enabled, created_at) VALUES (?, ?, 1, ?)").run(name, url, nowIso());
  return db.prepare("SELECT * FROM feeds WHERE id = ?").get(info.lastInsertRowid) as FeedRow;
}

export function deleteFeed(id: number): void {
  getDb().prepare("DELETE FROM feeds WHERE id = ?").run(id);
}

// feeds 테이블이 비어있을 때만 data/default-feeds.json의 기본 RSS 피드를 채워 넣습니다.
// 서버 시작 시 1회, 그리고 공장 전체 초기화 직후(재시작 없이 즉시 기본값을 복구하기 위해) 둘 다에서 호출됩니다.
export function seedDefaultFeedsIfEmpty(): number {
  if (listFeeds().length > 0) return 0;
  const defaultsPath = path.join(__dirname, "..", "data", "default-feeds.json");
  let defaults: Array<{ name: string; url: string }> = [];
  try {
    defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf-8"));
  } catch {
    return 0;
  }
  let seeded = 0;
  for (const f of defaults) {
    try {
      addFeed(f.name, f.url);
      seeded++;
    } catch {
      // 중복 URL 등은 무시
    }
  }
  return seeded;
}

// P1.7A: built-in 기본 자료원 팩 동기화. seedDefaultFeedsIfEmpty()는 feeds가 완전히 빈
// 경우에만 동작해서, 이미 6개 feed를 쓰던 기존 사용자는 새 카테고리 자료원을 영원히 받지
// 못했다. 이 함수는 "없는 built-in feed만 추가"한다:
//   - 기존 행(사용자가 직접 추가한 feed 포함)을 절대 수정/삭제하지 않는다
//   - enabled 상태를 덮어쓰지 않는다(사용자가 끈 feed는 꺼진 채로 유지)
//   - URL이 이미 있으면 건너뛴다(UNIQUE 제약 + 중복 등록 금지)
// 이름만 다르고 URL이 같은 경우도 URL 기준으로 판정하므로 중복이 생기지 않는다.
export function syncBuiltInFeeds(builtIns: readonly { name: string; url: string }[]): { added: number; skipped: number } {
  const db = getDb();
  const existing = new Set(
    (db.prepare("SELECT url FROM feeds").all() as { url: string }[]).map((r) => canonicalizeFeedUrl(r.url))
  );
  let added = 0;
  let skipped = 0;
  for (const f of builtIns) {
    if (existing.has(canonicalizeFeedUrl(f.url))) {
      skipped++;
      continue;
    }
    try {
      addFeed(f.name, f.url);
      existing.add(canonicalizeFeedUrl(f.url));
      added++;
    } catch {
      skipped++; // UNIQUE 충돌 등은 조용히 건너뛴다(기존 데이터 우선)
    }
  }
  return { added, skipped };
}

export function setFeedEnabled(id: number, enabled: boolean): void {
  getDb().prepare("UPDATE feeds SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

// ---------- materials ----------
export interface MaterialInput {
  title: string;
  source_name?: string;
  source_url?: string;
  source_type: "rss" | "url" | "text" | "keyword";
  published_at?: string | null;
  content?: string;
  dedupe_hash: string;
  meta_json?: string | null;
}

export function isDuplicateMaterial(hash: string): boolean {
  const row = getDb().prepare("SELECT id FROM materials WHERE dedupe_hash = ?").get(hash);
  return !!row;
}

// 같은 dedupe_hash를 가진 기존 자료의 id. URL 재수집(갱신)이 어느 row를 제자리 갱신할지
// 찾을 때 쓴다. dedupe_hash는 UNIQUE라 결과는 항상 0건 또는 1건이다.
// Trend 상세의 근거 자료 표시용. 긴 URL을 그대로 보여주는 대신 출처명·제목·시각을 쓰기 위해
// 이미 저장된 자료 행을 그대로 읽는다(추가 AI 호출 없음, 새 테이블 없음).
export function findMaterialByDedupeHash(hash: string): { id: number; title: string; source_name: string | null; published_at: string | null; collected_at: string } | null {
  const row = getDb()
    .prepare("SELECT id, title, source_name, published_at, collected_at FROM materials WHERE dedupe_hash = ?")
    .get(hash) as { id: number; title: string; source_name: string | null; published_at: string | null; collected_at: string } | undefined;
  return row ?? null;
}

export function findMaterialIdByDedupeHash(hash: string): number | null {
  const row = getDb().prepare("SELECT id FROM materials WHERE dedupe_hash = ?").get(hash) as { id: number } | undefined;
  return row ? row.id : null;
}

// URL 재수집으로 기존 자료를 제자리 갱신한다. 새 본문이 검증을 통과한 뒤에만 호출해야 하며
// (호출부 rss.ts가 보장), 바뀌는 것은 title/content/collected_at 세 컬럼뿐이다.
// id/dedupe_hash/source_url 등 자료의 identity는 그대로 두어 이 자료를 참조하는
// 다른 데이터의 연결이 깨지지 않는다. 삭제 후 재등록(INSERT) 방식은 쓰지 않는다.
export function updateMaterialContent(id: number, fields: { title: string; content: string }): boolean {
  const info = getDb()
    .prepare("UPDATE materials SET title = ?, content = ?, collected_at = ? WHERE id = ?")
    .run(fields.title, fields.content, nowIso(), id);
  return info.changes > 0;
}

export function insertMaterial(m: MaterialInput): { inserted: boolean; id?: number } {
  if (isDuplicateMaterial(m.dedupe_hash)) return { inserted: false };
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO materials (title, source_name, source_url, source_type, published_at, collected_at, content, dedupe_hash, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.title,
      m.source_name || null,
      m.source_url || null,
      m.source_type,
      m.published_at || null,
      nowIso(),
      m.content || null,
      m.dedupe_hash,
      m.meta_json ?? null
    );
  return { inserted: true, id: Number(info.lastInsertRowid) };
}

export function listMaterials(limit = 100): any[] {
  return getDb().prepare("SELECT * FROM materials ORDER BY id DESC LIMIT ?").all(limit);
}

export function recentMaterialsForGeneration(limit = 15): any[] {
  return getDb().prepare("SELECT * FROM materials ORDER BY id DESC LIMIT ?").all(limit);
}

// 글 생성 후보 자동 선별(materialSelector)에 전달할 "전체 자료" 목록입니다.
// 자료가 많아도(수백 건) 여기서는 모두 가져오고, 실제 후보 압축은 materialSelector.ts에서 처리합니다.
export function listAllMaterialsForSelection(): any[] {
  return getDb().prepare("SELECT * FROM materials ORDER BY id DESC").all();
}

export function getMaterialById(id: number): any {
  return getDb().prepare("SELECT * FROM materials WHERE id = ?").get(id);
}

export function deleteMaterial(id: number): void {
  getDb().prepare("DELETE FROM materials WHERE id = ?").run(id);
}

export function countMaterialsToday(): number {
  const rows = getDb().prepare("SELECT collected_at FROM materials").all() as { collected_at: string }[];
  return rows.filter((r) => dateKST(r.collected_at) === todayKST()).length;
}

// ---------- drafts ----------
// 'dry_run_done'은 DRY_RUN 모드에서 예약 처리가 "모의로" 완료된 상태입니다.
// 실제로 Threads에 게시된 것은 아니므로 'published'와는 구분합니다.
export type DraftStatus = "draft" | "approved" | "scheduled" | "publishing" | "published" | "failed" | "rejected" | "dry_run_done";

export interface DraftInput {
  title: string;
  hook: string;
  body: string;
  topic: string;
  source_title?: string;
  source_url?: string;
  source_summary?: string;
  confidence?: string;
  risk_notes?: string;
  persona_version?: number | null;
  source_material_id?: number | null;
  generation_batch_id?: string | null;
  // 쿠파스(쿠팡 파트너스) 상품 홍보 모드 전용 - 일반 글 생성에서는 전부 비워둠(NULL로 저장됨)
  source_type?: string | null;
  product_name?: string | null;
  affiliate_url?: string | null;
  usage_status?: string | null;
  disclosure_text?: string | null;
  promotion_style?: string | null;
  // "내 사진·영상 첨부" 전용 - 첨부가 없으면 전부 NULL
  media_filename?: string | null;
  media_type?: string | null;
  media_mime?: string | null;
  media_original_name?: string | null;
  // 상품 레이더 Phase 12.5.2.3.3.1 - 이 draft를 생성한 정확한 RecommendationSnapshot row.
  // Product Radar가 아닌 draft(일반/쿠파스)는 전부 비워둠(NULL로 저장됨).
  product_radar_recommendation_snapshot_id?: number | null;
  // 직접 글 작성(source_type='manual') 전용 - 작성 화면에서 곧바로 업로드한 미디어 보관함
  // asset을 draft 생성과 동시에 붙인다. 기존 attach 경로(setProductRadarLibraryAssetAttachment)는
  // source_type='product_radar'만 허용하므로, 수동 초안은 INSERT 시점에 이 컬럼을 채운다.
  // 컬럼 자체는 기존 것 그대로 재사용한다(새 컬럼/마이그레이션 없음).
  product_radar_library_asset_id?: number | null;
  // 직접 글 작성 UI 순번. insertManualDraft()가 INSERT 직후 renumberManualSequences()로
  // 채우므로 호출부에서 직접 지정하지 않는다.
  manual_sequence?: number | null;
}

export function insertDraft(d: DraftInput): number {
  const db = getDb();
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO drafts
        (title, hook, body, topic, source_title, source_url, source_summary, confidence, risk_notes, status, persona_version, scheduled_at, retry_count, created_at, updated_at, source_material_id, generation_batch_id, source_type, product_name, affiliate_url, usage_status, disclosure_text, promotion_style, media_filename, media_type, media_mime, media_original_name, product_radar_recommendation_snapshot_id, product_radar_library_asset_id, manual_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.title || "",
      d.hook || "",
      d.body,
      d.topic || "",
      d.source_title || null,
      d.source_url || null,
      d.source_summary || null,
      d.confidence || null,
      d.risk_notes || null,
      d.persona_version ?? null,
      ts,
      ts,
      d.source_material_id ?? null,
      d.generation_batch_id ?? null,
      d.source_type ?? null,
      d.product_name ?? null,
      d.affiliate_url ?? null,
      d.usage_status ?? null,
      d.disclosure_text ?? null,
      d.promotion_style ?? null,
      d.media_filename ?? null,
      d.media_type ?? null,
      d.media_mime ?? null,
      d.media_original_name ?? null,
      d.product_radar_recommendation_snapshot_id ?? null,
      d.product_radar_library_asset_id ?? null,
      d.manual_sequence ?? null
    );
  return Number(info.lastInsertRowid);
}

// 첨부 미디어 정리 정책(요청서 9번)에서 사용: "지금 삭제해도 안전한" 파일 목록을 판단하기 위해,
// 아직 거절(rejected)되지 않은 초안이 참조 중인 미디어 파일명만 돌려줍니다. 6개 초안이 같은
// 파일을 공유하므로, 6개 전부가 거절된 뒤에야 그 파일명이 이 목록에서 빠집니다.
// Phase 12.5.3.6에서 발견해 함께 고침: 기존에는 drafts.media_filename(쿠파스 첨부 전용)만
// active로 인식했다 - Product Radar가 생성한 media(product_radar_media_files)와 미디어
// 보관함에 업로드된 asset(product_radar_library_asset_files)은 둘 다 같은 UPLOAD_DIR/안전
// 파일명 패턴을 공유하는데도 여기서 전혀 고려되지 않아, 서버 재시작 시 sweepOrphanedMedia()가
// "draft에 아직 attach 안 된 candidate"나 "보관함에만 있는 업로드 asset"을 orphan으로
// 오인해 지울 수 있었다(latent bug). 미디어 보관함 자체가 "attach 여부와 무관하게 보관"이
// 목적이므로(요청서 12·22절) 이 두 종류는 draft 참조 여부와 상관없이 항상 active로 취급한다.
// active 판정 기준(요청서 재확인 후 확정):
//   A. 기존 drafts.media_filename(status != 'rejected')
//   B. status='rendered'인 Product Radar media job에 속한 파일만 - draft에 아직 attach되지
//      않은 candidate(다른 구성으로 만들기로 만든 이전 후보 등)도 rendered이면 미디어
//      보관함의 재사용 가능한 asset이므로 보호한다. failed/pending job에 연결된 파일(정상
//      흐름에서는 존재하지 않아야 함 - mediaOrchestration.ts가 local_save_failed 시
//      deleteMediaFileIfExists로 즉시 정리함)까지 영구 보호하지 않는다 - job status로
//      필터링해 "DB reference는 있지만 더 이상 유효하지 않은" 파일은 걸러진다.
//   C. product_radar_library_asset_files(미디어 보관함 업로드 asset) - 검증 통과한 파일만
//      INSERT되므로(mediaUpload.ts와 동일 원칙 - 실패한 업로드는 애초에 디스크/DB에 남지
//      않음) 이 테이블에 존재하는 row는 전부 무조건 active.
// "현재 draft attachment가 참조하는 파일"은 별도로 조회하지 않는다 - attach된 job은 항상
// rendered 상태이므로 B에 이미 포함된다(중복 조회 불필요).
export function listActiveMediaFilenames(): Set<string> {
  const db = getDb();
  const draftRows = db
    .prepare("SELECT DISTINCT media_filename FROM drafts WHERE media_filename IS NOT NULL AND status != 'rejected'")
    .all() as { media_filename: string }[];
  const generatedRows = db
    .prepare(
      `SELECT DISTINCT f.filename FROM product_radar_media_files f
       JOIN product_radar_media_jobs j ON j.id = f.media_job_id
       WHERE j.status = 'rendered'`
    )
    .all() as { filename: string }[];
  const uploadedRows = db.prepare("SELECT DISTINCT filename FROM product_radar_library_asset_files").all() as { filename: string }[];
  const filenames = new Set<string>(draftRows.map((r) => r.media_filename));
  for (const r of generatedRows) filenames.add(r.filename);
  for (const r of uploadedRows) filenames.add(r.filename);
  return filenames;
}

// 여러 초안을 하나의 트랜잭션으로 저장합니다. 하나라도 실패하면 전체가 자동으로 롤백되어
// "일부만 저장"되는 상태가 절대 생기지 않습니다(쿠파스 상품 홍보 모드처럼 정확히 N개가 모두
// 저장된 뒤에만 성공으로 취급해야 하는 흐름에서 사용).
export function insertDraftsAtomic(drafts: DraftInput[]): number[] {
  const db = getDb();
  const runAll = db.transaction((items: DraftInput[]) => items.map((d) => insertDraft(d)));
  return runAll(drafts);
}

export function getDraft(id: number): any {
  return getDb().prepare("SELECT * FROM drafts WHERE id = ?").get(id);
}

// 특정 상태의 글만 읽습니다(스케줄러 복구 등에서 의도를 분명히 하려고 이름을 나눠 둡니다).
export function listDraftsByStatus(status: DraftStatus): any[] {
  return listDrafts(status);
}

export function listDrafts(status?: DraftStatus): any[] {
  const db = getDb();
  if (status) return db.prepare("SELECT * FROM drafts WHERE status = ? ORDER BY id DESC").all(status);
  return db.prepare("SELECT * FROM drafts ORDER BY id DESC").all();
}

export function updateDraftBody(id: number, body: string, title?: string): void {
  const db = getDb();
  if (title !== undefined) {
    db.prepare("UPDATE drafts SET body = ?, title = ?, updated_at = ? WHERE id = ?").run(body, title, nowIso(), id);
  } else {
    db.prepare("UPDATE drafts SET body = ?, updated_at = ? WHERE id = ?").run(body, nowIso(), id);
  }
}

// 초안 "수정 저장" - 본문과 첨부 미디어를 한 transaction으로 함께 바꾼다.
//
// 왜 한 함수인가: 본문만 저장되고 미디어 교체는 실패하는 "애매한 부분 성공"이 남지 않아야
// 한다. better-sqlite3는 동기 실행이라 이 transaction 중간에 다른 쓰기가 끼어들 수 없다.
//
// 왜 status 조건절이 붙는가: 예약된 글(scheduled)도 발행 전이면 수정할 수 있어야 하는데,
// 스케줄러가 claimDraftForPublishing()으로 status를 'publishing'으로 바꾸는 순간부터는
// 절대 건드리면 안 된다. claim과 똑같이 UPDATE ... WHERE status IN (...) 원자 조건으로
// 막아, 발행이 시작된 뒤의 수정은 changes=0이 되어 호출부가 실패로 처리한다.
//
// media를 생략하면(undefined) 미디어는 손대지 않는다. media.libraryAssetId === null이면
// 첨부를 떼어낸다(파일 자체는 미디어 보관함에 그대로 남는다 - 삭제하지 않는다).
export const DRAFT_EDITABLE_STATUSES = ["draft", "approved", "scheduled"] as const;

export function updateDraftContent(
  id: number,
  opts: { body?: string; title?: string; media?: { libraryAssetId: number | null } }
): boolean {
  const db = getDb();
  const statusList = DRAFT_EDITABLE_STATUSES.map(() => "?").join(", ");
  const txn = db.transaction(() => {
    let changed = false;
    if (opts.body !== undefined || opts.title !== undefined) {
      const sets: string[] = [];
      const args: unknown[] = [];
      if (opts.body !== undefined) { sets.push("body = ?"); args.push(opts.body); }
      if (opts.title !== undefined) { sets.push("title = ?"); args.push(opts.title); }
      sets.push("updated_at = ?");
      args.push(nowIso());
      const info = db
        .prepare(`UPDATE drafts SET ${sets.join(", ")} WHERE id = ? AND status IN (${statusList})`)
        .run(...args, id, ...DRAFT_EDITABLE_STATUSES);
      if (info.changes === 0) return false; // 발행 시작됨/삭제됨 - 아무것도 바꾸지 않고 실패
      changed = true;
    }
    if (opts.media !== undefined) {
      // 생성 미디어(job)와 업로드 asset은 상호배타다 - 한쪽을 세팅하면 다른 쪽은 비운다
      // (기존 setProductRadarLibraryAssetAttachment와 동일한 원칙).
      const info = db
        .prepare(
          `UPDATE drafts SET product_radar_library_asset_id = ?, product_radar_media_job_id = NULL, media_filename = NULL,
             media_type = NULL, media_mime = NULL, media_original_name = NULL, updated_at = ?
           WHERE id = ? AND status IN (${statusList})`
        )
        .run(opts.media.libraryAssetId, nowIso(), id, ...DRAFT_EDITABLE_STATUSES);
      if (info.changes === 0) return false;
      changed = true;
    }
    return changed;
  });
  return txn();
}

export function setDraftStatus(id: number, status: DraftStatus): void {
  getDb().prepare("UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), id);
}

// ---------- 초안함 비우기 (안전 삭제) ----------
// "안전하게 지울 수 있는 초안만" 정리합니다. 다른 이력이나 자식 데이터를 함께 지워서
// 초안을 억지로 삭제하지 않습니다(publish_log/미디어 job 기록은 그대로 보존).
//
// 삭제 대상: draft / rejected / (예약되지 않은) approved
// 보호 대상:
//   - scheduled / publishing            : 예약 대기·처리 중
//   - published / dry_run_done / failed : 발행 시도 이력이 있는 상태
//   - scheduled_at 값이 남아 있는 초안   : 예약과 연결됨
//   - publish_log가 참조 중              : FK(publish_log.draft_id → drafts.id, NO ACTION)
//   - product_radar_media_jobs가 참조 중 : FK(media_jobs.draft_id → drafts.id, NO ACTION)
// FK가 걸린 행을 지우려 하면 foreign_keys=ON 때문에 실패하므로, 애초에 후보에서 제외합니다.
const DRAFT_PURGE_ALLOWED_STATUSES = ["draft", "rejected", "approved"] as const;

export interface DraftPurgePreview {
  deletable: number[];
  protectedIds: number[];
  total: number;
}

export function findPurgeableDrafts(): DraftPurgePreview {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, status, scheduled_at FROM drafts ORDER BY id ASC")
    .all() as { id: number; status: string; scheduled_at: string | null }[];

  const referencedByLog = new Set(
    (db.prepare("SELECT DISTINCT draft_id FROM publish_log WHERE draft_id IS NOT NULL").all() as { draft_id: number }[])
      .map((r) => r.draft_id)
  );
  const referencedByMediaJob = new Set(
    (db.prepare("SELECT DISTINCT draft_id FROM product_radar_media_jobs WHERE draft_id IS NOT NULL").all() as { draft_id: number }[])
      .map((r) => r.draft_id)
  );

  const deletable: number[] = [];
  const protectedIds: number[] = [];
  for (const r of rows) {
    const statusOk = (DRAFT_PURGE_ALLOWED_STATUSES as readonly string[]).includes(r.status);
    const notScheduled = !r.scheduled_at;
    const noRefs = !referencedByLog.has(r.id) && !referencedByMediaJob.has(r.id);
    if (statusOk && notScheduled && noRefs) deletable.push(r.id);
    else protectedIds.push(r.id);
  }
  return { deletable, protectedIds, total: rows.length };
}

// 선택 삭제 - "초안함 비우기"와 완전히 같은 안전 정책(findPurgeableDrafts)을 재사용한다.
// 새 삭제 시스템을 만들지 않는다. 요청한 id 중 삭제 가능한 것만 지우고, 예약/발행 이력
// 등으로 보호된 id는 지우지 않고 그대로 돌려준다(임의 cascade delete 없음 - drafts 행
// 외에는 아무것도 건드리지 않는다).
export function deleteDraftsByIds(ids: readonly number[]): { deleted: number[]; blocked: number[]; notFound: number[] } {
  const db = getDb();
  const unique = [...new Set(ids)];
  const existing = new Set((db.prepare("SELECT id FROM drafts").all() as { id: number }[]).map((r) => r.id));
  const deletableSet = new Set(findPurgeableDrafts().deletable);
  const deleted: number[] = [];
  const blocked: number[] = [];
  const notFound: number[] = [];
  for (const id of unique) {
    if (!existing.has(id)) notFound.push(id);
    else if (deletableSet.has(id)) deleted.push(id);
    else blocked.push(id);
  }
  if (deleted.length > 0) {
    const del = db.prepare("DELETE FROM drafts WHERE id = ?");
    const txn = db.transaction((list: number[]) => {
      for (const id of list) del.run(id);
      // 직접 작성 초안이 지워졌으면 남은 것들의 순번을 1..N으로 다시 맞춘다.
      renumberManualSequences(db);
    });
    txn(deleted);
  }
  return { deleted, blocked, notFound };
}

export function purgeDrafts(): { deleted: number; kept: number } {
  const db = getDb();
  const { deletable, protectedIds } = findPurgeableDrafts();
  if (deletable.length === 0) return { deleted: 0, kept: protectedIds.length };

  const del = db.prepare("DELETE FROM drafts WHERE id = ?");
  const txn = db.transaction((ids: number[]) => {
    for (const id of ids) del.run(id);
    // 비우기로도 직접 작성 초안이 사라질 수 있다 - 남은 것들의 순번을 다시 맞춘다.
    renumberManualSequences(db);
  });
  txn(deletable);
  return { deleted: deletable.length, kept: protectedIds.length };
}

// 상품 레이더 Phase 12.5.3.3: draft에 media job을 "더 최신 job일 때만" 연결하는
// compare-and-set. product_radar_media_jobs.id는 AUTOINCREMENT라 생성 순서를 그대로
// 반영한다(먼저 시작한 generation일수록 job도 먼저 만들어져 더 작은 id를 갖는다) - 이
// 순서를 그대로 staleness 판정 기준으로 재사용해 별도 revision/token 컬럼을 추가하지
// 않는다. 현재 attach된 job이 없거나(NULL) 그보다 작은 id일 때만 교체한다 - 늦게
// 완료된 오래된 generation이 이미 attach된 더 새 generation의 결과를 덮어쓰지 못한다.
// false를 반환하면 draft가 없거나 Product Radar draft가 아니거나(자격 재확인) 이미 더
// 새 job이 attach돼 있다는 뜻이다 - 세 경우 모두 caller 관점에서는 "이 job은 attach되지
// 못했다"로 동일하게 취급한다(호출부가 이미 draft 존재/자격을 앞서 확인했으므로 실무적
// 으로는 항상 staleness를 뜻한다).
// Phase 12.5.3.6: "현재 draft가 쓰는 미디어"는 항상 정확히 하나다(요청서 21절) - generated
// job을 attach하면 uploaded library asset 쪽은 자동으로 지운다(반대 방향은
// setProductRadarLibraryAssetAttachment() 참고). CAS 조건(id가 더 클 때만) 자체는 기존
// Phase 12.5.3.3 semantics 그대로 - 이 SET절 추가가 그 보호를 약화시키지 않는다.
export function attachProductRadarMediaJobToDraftIfNewer(draftId: number, mediaJobId: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE drafts SET product_radar_media_job_id = ?, product_radar_library_asset_id = NULL, updated_at = ?
       WHERE id = ? AND source_type = 'product_radar'
         AND (product_radar_media_job_id IS NULL OR product_radar_media_job_id < ?)`
    )
    .run(mediaJobId, nowIso(), draftId, mediaJobId);
  return info.changes > 0;
}

// Phase 12.5.3.6: uploaded library asset을 draft에 attach - generated job과 달리 특정
// recommendation lineage에 묶여있지 않으므로(요청서 21절 - "이 asset이 이 draft에 적합한가"
// 라는 질문 자체가 성립하지 않는다) CAS가 필요 없다. draft가 존재하고 Product Radar draft일
// 때만 반영하며, 성공 시 job 쪽 attachment는 지운다(위 함수와 대칭).
export function setProductRadarLibraryAssetAttachment(draftId: number, libraryAssetId: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE drafts SET product_radar_library_asset_id = ?, product_radar_media_job_id = NULL, updated_at = ?
       WHERE id = ? AND source_type = 'product_radar'`
    )
    .run(libraryAssetId, nowIso(), draftId);
  return info.changes > 0;
}

// 사용자가 "링크 없이 예약"을 직접 고른 사실을 예약 데이터 자체에 남긴다.
// 이 값이 1이어야만 스케줄러의 최종 guard가 링크 없는 제휴글을 통과시킨다 - 프로그램을
// 재시작해도 승인이 유지되고, 승인 없이 scheduled 로 들어온 행은 발행되지 않는다.
export function setDraftAllowPublishWithoutAffiliateLink(id: number, allowed: boolean): void {
  getDb()
    .prepare("UPDATE drafts SET allow_publish_without_affiliate_link = ?, updated_at = ? WHERE id = ?")
    .run(allowed ? 1 : 0, nowIso(), id);
}

export function scheduleDraft(id: number, scheduledAtIso: string): void {
  getDb()
    .prepare("UPDATE drafts SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'")
    .run(scheduledAtIso, nowIso(), id);
}

// 예약 취소: scheduled -> approved로 되돌리고 scheduled_at을 비웁니다.
// 본문/출처/생성 정보(title, hook, body, topic, source_*, persona_version 등)는 전혀 건드리지 않아 그대로 보존됩니다.
// 조건절(status='scheduled' AND publish_log 없음)을 만족할 때만 바뀌므로, 이미 스케줄러가 처리 중(publishing)이거나
// 처리 기록이 남은 글은 절대 되돌리지 않습니다. changes로 실제 반영 여부를 돌려주어 호출부가 성공/실패를 구분할 수 있게 합니다.
export function cancelSchedule(id: number): boolean {
  const info = getDb()
    .prepare(
      `UPDATE drafts SET status = 'approved', scheduled_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'scheduled'
         AND NOT EXISTS (SELECT 1 FROM publish_log WHERE draft_id = drafts.id)`
    )
    .run(nowIso(), id);
  return info.changes > 0;
}

// 예약 시간 변경: 기존 예약을 취소하지 않고 scheduled_at만 새 값으로 직접 바꿉니다(status는 'scheduled' 유지).
// cancelSchedule과 동일한 조건절로 보호되어, 이미 처리 중이거나 처리 기록이 남은 글은 절대 바꾸지 않습니다.
export function rescheduleDraft(id: number, scheduledAtIso: string): boolean {
  const info = getDb()
    .prepare(
      `UPDATE drafts SET scheduled_at = ?, updated_at = ?
       WHERE id = ? AND status = 'scheduled'
         AND NOT EXISTS (SELECT 1 FROM publish_log WHERE draft_id = drafts.id)`
    )
    .run(scheduledAtIso, nowIso(), id);
  return info.changes > 0;
}

// 승인 글 일괄 자동배치(scheduleRoutine.ts)가 "이미 다른 글이 차지한 시각"과 "날짜별 사용 수"를
// 계산할 때 쓰는 원본 데이터입니다. 실제로 그 시각을 계속 점유하는 상태(예약됨/처리중/발행됨/
// 모의발행완료)만 포함하고, 취소되었거나(approved로 되돌아감) 거절/실패된 글은 제외합니다.
export function listOccupiedScheduleSlots(): string[] {
  const rows = getDb()
    .prepare("SELECT scheduled_at FROM drafts WHERE scheduled_at IS NOT NULL AND status IN ('scheduled','publishing','published','dry_run_done')")
    .all() as { scheduled_at: string }[];
  return rows.map((r) => r.scheduled_at);
}

export interface BatchScheduleItem {
  draftId: number;
  scheduledAtUtcIso: string;
}

// 일괄 예약 확정(요청서 4번)을 하나의 트랜잭션으로 처리합니다.
// - 각 UPDATE는 "지금 이 순간 status가 approved인지"를 WHERE 절로 다시 확인합니다(원자적 확인+반영).
//   changes가 1이 아니면(이미 다른 상태로 바뀌었으면) 즉시 예외를 던져 트랜잭션 전체가 롤백됩니다.
// - 같은 시각이 이미 다른 글에 쓰였는지도(동시 요청 등으로 인한 경합까지 대비) 트랜잭션 안에서
//   다시 확인합니다.
// - 성공하면 아무것도 돌려주지 않고, 실패(부분 실패 포함)하면 예외를 던져 전체가 자동 롤백됩니다
//   (better-sqlite3의 db.transaction은 콜백이 예외를 던지면 자동으로 ROLLBACK합니다).
export function confirmBatchScheduleAtomic(items: BatchScheduleItem[]): void {
  const db = getDb();
  const conflictStmt = db.prepare(
    "SELECT id FROM drafts WHERE scheduled_at = ? AND status IN ('scheduled','publishing','published','dry_run_done')"
  );
  const updateStmt = db.prepare("UPDATE drafts SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'");

  const txn = db.transaction((rows: BatchScheduleItem[]) => {
    const ts = nowIso();
    for (const item of rows) {
      const conflict = conflictStmt.get(item.scheduledAtUtcIso);
      if (conflict) {
        throw new Error(`시간(${item.scheduledAtUtcIso})이 이미 다른 글(#${(conflict as any).id})에 사용되었습니다.`);
      }
      const info = updateStmt.run(item.scheduledAtUtcIso, ts, item.draftId);
      if (info.changes !== 1) {
        throw new Error(`글 #${item.draftId}은(는) 더 이상 승인(approved) 상태가 아니어서 예약할 수 없습니다.`);
      }
    }
  });

  txn(items);
}

export function countDraftsToday(): number {
  const rows = getDb().prepare("SELECT created_at FROM drafts").all() as { created_at: string }[];
  return rows.filter((r) => dateKST(r.created_at) === todayKST()).length;
}

export function countByStatusToday(status: DraftStatus): number {
  const rows = getDb().prepare("SELECT status, updated_at FROM drafts WHERE status = ?").all(status) as any[];
  return rows.filter((r) => dateKST(r.updated_at) === todayKST()).length;
}

export function nextScheduledAt(): string | null {
  const row = getDb()
    .prepare("SELECT scheduled_at FROM drafts WHERE status = 'scheduled' AND scheduled_at IS NOT NULL ORDER BY scheduled_at ASC LIMIT 1")
    .get() as { scheduled_at: string } | undefined;
  return row ? row.scheduled_at : null;
}

export function listDueScheduledDrafts(nowIsoStr: string): any[] {
  return getDb()
    .prepare("SELECT * FROM drafts WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ? ORDER BY scheduled_at ASC")
    .all(nowIsoStr);
}

// 발행 직전 상태를 'publishing'으로 원자적으로 바꿔서 중복 처리를 막습니다.
// UPDATE ... WHERE status='scheduled' 조건이 있으므로, 이미 누군가 처리 중이면 changes가 0이 됩니다.
export function claimDraftForPublishing(id: number): boolean {
  const info = getDb()
    .prepare("UPDATE drafts SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'scheduled'")
    .run(nowIso(), id);
  return info.changes > 0;
}

export function markDraftPublished(id: number): void {
  getDb().prepare("UPDATE drafts SET status = 'published', updated_at = ? WHERE id = ?").run(nowIso(), id);
}

export function markDraftFailed(id: number): void {
  getDb().prepare("UPDATE drafts SET status = 'failed', updated_at = ? WHERE id = ?").run(nowIso(), id);
}

// DRY_RUN 모드에서 예약 처리를 "모의로" 끝낸 글의 상태를 바꿉니다.
// 상태가 더 이상 'scheduled'가 아니게 되므로, listDueScheduledDrafts/nextScheduledAt에서
// 자동으로 제외됩니다(= 다음 예약 목록에서 사라지고, 다시 처리되지도 않습니다).
export function markDraftDryRunDone(id: number): void {
  getDb().prepare("UPDATE drafts SET status = 'dry_run_done', updated_at = ? WHERE id = ?").run(nowIso(), id);
}

export function revertDraftToScheduledWithRetry(id: number): void {
  getDb()
    .prepare("UPDATE drafts SET status = 'scheduled', retry_count = retry_count + 1, updated_at = ? WHERE id = ?")
    .run(nowIso(), id);
}

// ---------- publish_log ----------
export interface PublishLogInput {
  draft_id: number;
  body: string;
  scheduled_at?: string | null;
  published_at?: string | null;
  threads_post_id?: string | null;
  success: boolean;
  dry_run: boolean;
  error_message?: string | null;
  sources?: string | null;
  persona_version?: number | null;
  // Phase 12.5.4: 이 시도의 media_type('TEXT'|'IMAGE'|'VIDEO'). 생략하면(기존 호출부 전부
  // 무변경) NULL로 저장됩니다 - 기존 호출부가 이 필드를 몰라도 그대로 동작합니다.
  media_type?: string | null;
}

// 발행 기록의 오류 문구는 구매자 화면에 그대로 보이는 유일한 실패 설명이다. Threads 상태
// 확인 API는 access_token을 쿼리스트링에 담아 호출하므로, 런타임이 오류 메시지에 URL을
// 통째로 넣으면 토큰이 기록에 남을 수 있다. 호출부마다 거르면 새 호출부가 생길 때 빠지므로,
// 기록에 쓰이는 이 한 곳에서 항상 걸러낸다.
function scrubSecretsForLog(message: string | null | undefined): string | null {
  if (!message) return null;
  let out = String(message);
  for (const secret of [config.THREADS_ACCESS_TOKEN]) {
    if (secret && secret.length >= 8) out = out.split(secret).join("***");
  }
  // 위 목록에 없는 토큰이 URL에 실려 온 경우까지 대비해 access_token 쿼리값 자체를 가린다.
  return out.replace(/access_token=[^&\s"']+/gi, "access_token=***");
}

export function insertPublishLog(p: PublishLogInput): number {
  const info = getDb()
    .prepare(
      `INSERT INTO publish_log
        (draft_id, body, scheduled_at, attempted_at, published_at, threads_post_id, success, dry_run, error_message, sources, persona_version, media_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.draft_id,
      p.body,
      p.scheduled_at || null,
      nowIso(),
      p.published_at || null,
      p.threads_post_id || null,
      p.success ? 1 : 0,
      p.dry_run ? 1 : 0,
      scrubSecretsForLog(p.error_message),
      p.sources || null,
      p.persona_version ?? null,
      p.media_type || null
    );
  return Number(info.lastInsertRowid);
}

export function hasPublishLogForDraft(draftId: number): boolean {
  const row = getDb().prepare("SELECT id FROM publish_log WHERE draft_id = ?").get(draftId);
  return !!row;
}

// 레거시 불일치 복구용: 특정 글의 publish_log 전체를 시간순으로 가져옵니다.
// (구버전 버그로 status는 'scheduled'인 채 남아있는데 로그만 있는 경우, 이 로그를 근거로 상태를 복구합니다)
export function getPublishLogsForDraft(draftId: number): any[] {
  return getDb().prepare("SELECT * FROM publish_log WHERE draft_id = ? ORDER BY id ASC").all(draftId);
}

// draft_source_type 을 함께 돌려준다 - 화면이 "참고 출처"(일반 글)와 "제휴링크"(쿠파스 글)를
// 구분해 표시하기 위한 값이다. publish_log 자체는 그대로이고 컬럼도 추가하지 않는다.
// 초안이 이미 삭제됐으면 null 이라 화면은 기존 표시로 되돌아간다(하위호환).
export function listPublishLog(limit = 200): any[] {
  return getDb()
    .prepare(
      `SELECT publish_log.*, drafts.source_type AS draft_source_type
         FROM publish_log LEFT JOIN drafts ON drafts.id = publish_log.draft_id
        ORDER BY publish_log.id DESC LIMIT ?`
    )
    .all(limit);
}

// 발행 기록 1건 삭제(사용자가 화면에서 기록을 정리할 때만 호출).
// 지우는 것은 이 프로그램 안의 이력 한 줄뿐입니다. Threads에 실제 게시된 글은 이 함수와
// 아무 관련이 없고 그대로 남습니다(삭제 API를 호출하지 않습니다).
// publish_log는 자식 테이블이라(FK: publish_log.draft_id -> drafts.id) 이 행을 지워도
// 초안/자료/예약/미디어/라이선스 쪽으로 연쇄 삭제가 일어나지 않습니다.
// id 하나만 조건으로 쓰고 바인딩 파라미터로 넘겨 다른 행이 지워질 여지를 두지 않습니다.
export function deletePublishLog(id: number): boolean {
  const info = getDb().prepare("DELETE FROM publish_log WHERE id = ?").run(id);
  return info.changes > 0;
}

export function countRealPublishedToday(): number {
  const rows = getDb().prepare("SELECT published_at FROM publish_log WHERE success = 1 AND dry_run = 0").all() as { published_at: string }[];
  return rows.filter((r) => dateKST(r.published_at) === todayKST()).length;
}

export function countDryRunProcessedToday(): number {
  const rows = getDb().prepare("SELECT attempted_at FROM publish_log WHERE dry_run = 1").all() as { attempted_at: string }[];
  return rows.filter((r) => dateKST(r.attempted_at) === todayKST()).length;
}

// ---------- 자동 발행(스케줄러) on/off ----------
export function isAutoPublishEnabled(): boolean {
  return getSetting("auto_publish", "off") === "on";
}

// ---------- (legacy) settings.dry_run ----------
// 과거에는 구매자 설정 화면의 "게시 모드"가 이 값을 저장하고 서버 시작 시 config.DRY_RUN을
// 덮어썼습니다. 지금은 runtime 게시 모드의 source of truth가 실행 환경(env/launch 정책)뿐이라
// 서버/라우트 어디에서도 이 값을 읽어 runtime에 반영하지 않습니다. 기존 사용자 DB에 남은
// legacy row를 지우는 migration은 하지 않으며(값이 남아 있어도 무해), 함수는 과거 데이터
// 확인/테스트용으로만 유지합니다.
// 자동 발행(auto_publish)과 완전히 같은 방식으로 기존 settings 키-값 테이블에 저장합니다.
// DRY_RUN은 비밀이 아니라 동작 스위치이므로 DB 저장이 적절합니다(토큰은 여기 저장하지
// 않고 src/threadsCredentials.ts의 별도 파일을 씁니다).
//
// 저장값이 없으면 null을 반환해, 호출부가 기존 .env/기본값(안전값 true)을 그대로 쓰도록
// 합니다 - 기존 설치/개발 환경의 동작이 바뀌지 않습니다.
const DRY_RUN_SETTING_KEY = "dry_run";

export function getStoredDryRun(): boolean | null {
  const raw = getSetting(DRY_RUN_SETTING_KEY, null);
  if (raw === "on") return true;
  if (raw === "off") return false;
  return null; // 저장된 적 없음 → 기존 기본값 사용
}

export function setStoredDryRun(enabled: boolean): void {
  setSetting(DRY_RUN_SETTING_KEY, enabled ? "on" : "off");
}

// ---------- claude failures ----------
export function insertClaudeFailure(rawResponse: string, errorMessage: string): number {
  const info = getDb()
    .prepare("INSERT INTO claude_failures (created_at, raw_response, error_message) VALUES (?, ?, ?)")
    .run(nowIso(), rawResponse, errorMessage);
  return Number(info.lastInsertRowid);
}

// ---------- material_candidates_log (자료 자동 선별 기록) ----------
export interface CandidateLogEntry {
  material_id: number;
  rank: number;
  score: number;
  reason: string;
  selected: boolean;
}

export function insertCandidateLog(batchId: string, entries: CandidateLogEntry[]): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO material_candidates_log (batch_id, material_id, rank, score, reason, selected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const ts = nowIso();
  const insertMany = db.transaction((rows: CandidateLogEntry[]) => {
    for (const r of rows) stmt.run(batchId, r.material_id, r.rank, r.score, r.reason, r.selected ? 1 : 0, ts);
  });
  insertMany(entries);
}

export function getCandidateLogByBatch(batchId: string): any[] {
  return getDb().prepare("SELECT * FROM material_candidates_log WHERE batch_id = ? ORDER BY rank ASC").all(batchId);
}

// ---------- 상품 레이더: 상품(product_radar_products) ----------
// MVP1-1 범위: "상품 직접 등록" 화면이 쓰는 단순 CRUD만 제공합니다. canonical URL 기준 중복
// 판정/갱신(upsert)은 MVP1-3에서 이 함수들을 감싸는 별도 함수로 추가될 예정이며, 지금은 매번
// 새 행을 삽입합니다. 자동 수집 adapter도 아직 없어 site_id는 항상 'manual'로 고정됩니다.
// 타입은 src/productRadar/types.ts의 정의를 그대로 재사용합니다(중복 정의 금지).
function rowToProductRadarProduct(row: any): ProductRadarProduct {
  return {
    id: row.id,
    siteId: row.site_id,
    adapterVersion: row.adapter_version,
    sourceUrl: row.source_url,
    canonicalUrl: row.canonical_url,
    productExternalId: row.product_external_id,
    sellerName: row.seller_name,
    productName: row.product_name,
    brand: row.brand,
    modelName: row.model_name,
    optionName: row.option_name,
    category: row.category,
    price: row.price,
    originalPrice: row.original_price,
    conditionalPrice: row.conditional_price,
    conditionalPriceLabel: row.conditional_price_label,
    shippingFee: row.shipping_fee,
    shippingType: row.shipping_type,
    shippingText: row.shipping_text,
    rating: row.rating,
    reviewCount: row.review_count,
    features: row.features_json ? JSON.parse(row.features_json) : [],
    reviewSummary: row.review_summary_json ? JSON.parse(row.review_summary_json) : null,
    representativeImageId: row.representative_image_id,
    rawSourceType: row.raw_source_type,
    userOverriddenFields: row.user_overridden_fields_json ? JSON.parse(row.user_overridden_fields_json) : [],
    status: row.status,
    affiliateUrl: row.affiliate_url ?? null,
    affiliateProductId: row.affiliate_product_id ?? null,
    affiliateVerifiedAt: row.affiliate_verified_at ?? null,
    firstCollectedAt: row.first_collected_at,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 이미 저장된 상품에 제휴링크를 채운다. affiliate_url이 아직 비어 있을 때만 쓴다 -
// 이미 검증된 링크를 나중 저장이 덮어쓰는 일이 없도록 조건절로 막는다(원자적 UPDATE).
export function setProductRadarProductAffiliateLink(
  id: number,
  affiliateUrl: string,
  affiliateProductId: string,
  verifiedAtIso: string
): boolean {
  const info = getDb()
    .prepare(
      `UPDATE product_radar_products
          SET affiliate_url = ?, affiliate_product_id = ?, affiliate_verified_at = ?, updated_at = ?
        WHERE id = ? AND affiliate_url IS NULL`
    )
    .run(affiliateUrl, affiliateProductId, verifiedAtIso, nowIso(), id);
  return info.changes > 0;
}

export function insertProductRadarProduct(input: ProductRadarProductManualInput): number {
  const db = getDb();
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO product_radar_products
        (site_id, adapter_version, source_url, canonical_url, product_external_id, seller_name, product_name,
         brand, model_name, option_name, category, price, original_price, shipping_fee, shipping_type,
         shipping_text, rating, review_count, features_json, representative_image_id, raw_source_type,
         user_overridden_fields_json, status, first_collected_at, last_checked_at, created_at, updated_at)
       VALUES ('manual', '1.0.0', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
               'user_input', NULL, 'active', ?, ?, ?, ?)`
    )
    .run(
      input.sourceUrl || "",
      input.sellerName ?? null,
      input.productName,
      input.brand ?? null,
      input.modelName ?? null,
      input.optionName ?? null,
      input.category ?? null,
      input.price ?? null,
      ts,
      ts,
      ts,
      ts
    );
  return Number(info.lastInsertRowid);
}

export function getProductRadarProduct(id: number): ProductRadarProduct | null {
  const row = getDb().prepare("SELECT * FROM product_radar_products WHERE id = ?").get(id);
  return row ? rowToProductRadarProduct(row) : null;
}

export function listProductRadarProducts(opts?: { status?: string }): ProductRadarProduct[] {
  const db = getDb();
  const rows = opts?.status
    ? db.prepare("SELECT * FROM product_radar_products WHERE status = ? ORDER BY id DESC").all(opts.status)
    : db.prepare("SELECT * FROM product_radar_products ORDER BY id DESC").all();
  return (rows as any[]).map(rowToProductRadarProduct);
}

// 필드 매핑: 요청 필드명(camelCase) -> DB 컬럼명. 사용자가 수정한 필드는 user_overridden_fields_json에
// 누적 기록합니다(설계서 14.2절 - 자동 수집값보다 사용자 수정값이 항상 우선한다는 원칙을 지금부터 적용).
const PRODUCT_PATCH_COLUMN_MAP: Record<string, string> = {
  productName: "product_name",
  sourceUrl: "source_url",
  brand: "brand",
  modelName: "model_name",
  optionName: "option_name",
  category: "category",
  price: "price",
  sellerName: "seller_name",
};

export function updateProductRadarProduct(id: number, patch: ProductRadarProductPatch): ProductRadarProduct | null {
  const db = getDb();
  const existing = getProductRadarProduct(id);
  if (!existing) return null;

  const changedKeys = Object.keys(patch).filter((k) => PRODUCT_PATCH_COLUMN_MAP[k] && (patch as any)[k] !== undefined);
  if (changedKeys.length === 0) return existing;

  const setClauses = changedKeys.map((k) => `${PRODUCT_PATCH_COLUMN_MAP[k]} = ?`);
  const values = changedKeys.map((k) => (patch as any)[k]);

  const overridden = new Set<string>(existing.userOverriddenFields || []);
  changedKeys.forEach((k) => overridden.add(k));

  const ts = nowIso();
  db.prepare(
    `UPDATE product_radar_products SET ${setClauses.join(", ")}, user_overridden_fields_json = ?, updated_at = ? WHERE id = ?`
  ).run(...values, JSON.stringify(Array.from(overridden)), ts, id);

  return getProductRadarProduct(id);
}

export function deleteProductRadarProduct(id: number): void {
  getDb().prepare("DELETE FROM product_radar_products WHERE id = ?").run(id);
}

// ---------- 상품 레이더 Phase 5: ProductRadarBrowser 저장 dedup 조회 ----------
// 설계서 13.1절/이번 요청서 7절 순서 그대로: canonical URL 완전 일치 -> siteId+
// productExternalId 완전 일치 -> 없으면 신규. canonicalUrl은 호출부(browserSave.ts)가 이미
// normalizeUrlLoose()로 정규화한 값을 넘깁니다(이 함수는 정규화하지 않고 그대로 비교).
export function getProductRadarProductByCanonicalUrl(canonicalUrl: string): ProductRadarProduct | null {
  const row = getDb().prepare("SELECT * FROM product_radar_products WHERE canonical_url = ?").get(canonicalUrl);
  return row ? rowToProductRadarProduct(row) : null;
}

export function getProductRadarProductBySiteExternalId(siteId: string, productExternalId: string): ProductRadarProduct | null {
  const row = getDb()
    .prepare("SELECT * FROM product_radar_products WHERE site_id = ? AND product_external_id = ? ORDER BY id DESC LIMIT 1")
    .get(siteId, productExternalId);
  return row ? rowToProductRadarProduct(row) : null;
}

export interface ProductRadarSnapshotBySaveJobResult {
  productId: number;
  snapshotId: number;
}

// saveJobId 멱등 조회 - 이미 저장된 적 있으면 그 결과(productId)를 재사용하고, 새로
// insert하지 않습니다(이번 요청서 10절).
export function getProductRadarSnapshotBySaveJobId(saveJobId: string): ProductRadarSnapshotBySaveJobResult | null {
  const row = getDb()
    .prepare("SELECT id, product_id FROM product_radar_product_snapshots WHERE save_job_id = ?")
    .get(saveJobId) as { id: number; product_id: number } | undefined;
  return row ? { snapshotId: row.id, productId: row.product_id } : null;
}

// ProductRadarBrowser가 실제로 수집한(=site_id가 'manual'이 아닌) 상품 저장. 대표 이미지는
// URL 문자열만 snapshot_json에 남기고 product_radar_images/representative_image_id는 건드리지
// 않습니다 - 이미지 파일 다운로드·리사이즈 파이프라인은 이번 Phase 범위 밖입니다(요청서 9절).
export interface ProductRadarCollectedProductInput {
  siteId: string;
  adapterVersion: string;
  sourceUrl: string;
  canonicalUrl: string | null; // 이미 정규화된 값
  productExternalId: string | null;
  sellerName: string | null;
  productName: string;
  // Phase 12.5.6D.2.1: JSON-LD 기반 저위험 필드(browserSave.ts가 이미 검증 완료한 값). 기존
  // product_radar_products 컬럼을 그대로 재사용한다 - 신규 컬럼 없음.
  brand: string | null;
  modelName: string | null;
  category: string | null;
  optionName: string | null;
  price: number | null;
  originalPrice: number | null;
  // Phase 12.5.6D.4.2.6: 검증된 Naver 대표 가격 영역의 조건부 가격("최대할인가" 등). price를
  // 절대 덮어쓰지 않는 완전히 독립된 필드 - browserSave.ts가 이미 교차검증/구조검증을 마친
  // 값만 넘긴다.
  conditionalPrice: number | null;
  conditionalPriceLabel: string | null;
  shippingFee: number | null;
  shippingType: string | null;
  shippingText: string | null;
  rating: number | null;
  reviewCount: number | null;
  // Phase 12.5.6D.4: 이미 JSON.stringify된 ProductRadarReviewSummary(없으면 null) - 리뷰
  // 원문/작성자는 절대 포함하지 않는다(browserSave.ts validateReviewSummary가 이미 검증 완료).
  reviewSummaryJson: string | null;
  // 쿠팡 파트너스 제휴링크 - browserSave.ts 가 affiliateLink.ts 로 검증에 성공했을 때만
  // 채워진다(검증 실패/클립보드 없음이면 셋 다 null 이고 상품 저장은 그대로 진행된다).
  affiliateUrl: string | null;
  affiliateProductId: string | null;
  affiliateVerifiedAt: string | null;
  rawSourceType: string;
  saveJobId: string;
  snapshotExtraJson: string; // pageSessionId/analysisRevision/representativeImageUrl/extractionSuccessFields 등 컬럼 없는 부가 정보
}

export interface ProductRadarCollectedProductResult {
  productId: number;
  snapshotId: number;
}

export function insertProductRadarCollectedProductWithSnapshot(
  input: ProductRadarCollectedProductInput
): ProductRadarCollectedProductResult {
  const db = getDb();
  const ts = nowIso();
  const txn = db.transaction((): ProductRadarCollectedProductResult => {
    const productInfo = db
      .prepare(
        `INSERT INTO product_radar_products
          (site_id, adapter_version, source_url, canonical_url, product_external_id, seller_name, product_name,
           brand, model_name, option_name, category, price, original_price, shipping_fee, shipping_type,
           shipping_text, rating, review_count, features_json, representative_image_id, raw_source_type,
           user_overridden_fields_json, status, first_collected_at, last_checked_at, created_at, updated_at,
           review_summary_json, conditional_price, conditional_price_label,
           affiliate_url, affiliate_product_id, affiliate_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?,
                 NULL, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.siteId,
        input.adapterVersion,
        input.sourceUrl,
        input.canonicalUrl,
        input.productExternalId,
        input.sellerName,
        input.productName,
        input.brand,
        input.modelName,
        input.optionName,
        input.category,
        input.price,
        input.originalPrice,
        input.shippingFee,
        input.shippingType,
        input.shippingText,
        input.rating,
        input.reviewCount,
        input.rawSourceType,
        ts,
        ts,
        ts,
        ts,
        input.reviewSummaryJson,
        input.conditionalPrice,
        input.conditionalPriceLabel,
        input.affiliateUrl,
        input.affiliateProductId,
        input.affiliateVerifiedAt
      );
    const productId = Number(productInfo.lastInsertRowid);

    const snapshotInfo = db
      .prepare(
        `INSERT INTO product_radar_product_snapshots
          (product_id, price, original_price, shipping_fee, rating, review_count, snapshot_json, captured_at, save_job_id,
           conditional_price, conditional_price_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        productId,
        input.price,
        input.originalPrice,
        input.shippingFee,
        input.rating,
        input.reviewCount,
        input.snapshotExtraJson,
        ts,
        input.saveJobId,
        input.conditionalPrice,
        input.conditionalPriceLabel
      );

    return { productId, snapshotId: Number(snapshotInfo.lastInsertRowid) };
  });
  return txn();
}

// ---------- 상품 레이더 Phase 8.3: Duplicate 상품 [정보 갱신] ----------
// updateProductRadarProduct(수동 편집 PATCH)와 의도적으로 분리된 별도 함수입니다: 그쪽은
// patch[key] !== undefined만 걸러 명시적 null도 그대로 덮어쓰고 user_overridden_fields_json에
// 누적하지만(요청서 6절과 반대), 이 함수는 (a) null/빈 문자열은 절대 기존 값을 지우지 않고
// (b) user_overridden_fields_json을 전혀 건드리지 않습니다(자동 재스캔 갱신 vs 사용자 수동
// 입력은 다른 의미). 대상 필드는 브라우저가 실제로 보내는(및 buildDiff가 비교하는) 것만:
// productName/price/originalPrice/sellerName/optionName/shippingFee/shippingType/shippingText.
// canonicalUrl/productExternalId/siteId 등 식별 필드는 이 함수가 절대 건드리지 않습니다(요청서 6절 -
// dedup/UNIQUE 구조를 이 경로로 절대 깨지 않기 위함).
export interface ProductRadarRefreshPatch {
  productName?: string | null;
  price?: number | null;
  originalPrice?: number | null;
  sellerName?: string | null;
  optionName?: string | null;
  shippingFee?: number | null;
  shippingType?: string | null;
  shippingText?: string | null;
  // Phase 12.5.6D.2.1: null/빈 문자열은 REFRESH_STRING_COLUMN_MAP/REFRESH_NUMBER_COLUMN_MAP의
  // 기존 필터(아래)에 의해 기존 master 값을 절대 지우지 않는다 - productName 등과 동일한 원칙.
  brand?: string | null;
  modelName?: string | null;
  category?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  // Phase 12.5.6D.4: 이미 JSON.stringify된 ProductRadarReviewSummary. null/빈 문자열은 기존
  // master의 non-null 값을 지우지 않는다(REFRESH_STRING_COLUMN_MAP과 동일한 원칙, 아래
  // refreshProductRadarProductFromSnapshot 참고) - 새로 유효한 summary가 있을 때만 갱신한다.
  reviewSummaryJson?: string | null;
  // Phase 12.5.6D.4.2.6: reviewSummaryJson과 동일한 원칙 - null/미검증 값은 기존 non-null
  // conditionalPrice를 지우지 않는다(요청서 11절). 새로 검증된 값이 있을 때만 갱신한다.
  conditionalPrice?: number | null;
  conditionalPriceLabel?: string | null;
}

export interface ProductRadarRefreshResult {
  product: ProductRadarProduct;
  changedFields: string[]; // camelCase 필드명 목록 - 성공 UX의 "가격 외 N개" 카운트에 그대로 씀
  snapshotId: number;
}

const REFRESH_STRING_COLUMN_MAP: Record<string, string> = {
  productName: "product_name",
  sellerName: "seller_name",
  optionName: "option_name",
  shippingType: "shipping_type",
  shippingText: "shipping_text",
  brand: "brand",
  modelName: "model_name",
  category: "category",
  // Phase 12.5.6D.4: 이미 JSON.stringify된 문자열이라 다른 문자열 필드와 동일한 "비어있지
  // 않은 문자열일 때만 갱신" 규칙이 그대로 맞는다 - null/빈 문자열은 기존 non-null summary를
  // 지우지 않는다(요청서 19절).
  reviewSummaryJson: "review_summary_json",
  // Phase 12.5.6D.4.2.6: conditionalPriceLabel도 review_summary_json과 동일한 "비어있지
  // 않은 문자열일 때만 갱신" 규칙을 그대로 따른다.
  conditionalPriceLabel: "conditional_price_label",
};
const REFRESH_NUMBER_COLUMN_MAP: Record<string, string> = {
  price: "price",
  originalPrice: "original_price",
  shippingFee: "shipping_fee",
  rating: "rating",
  reviewCount: "review_count",
  // Phase 12.5.6D.4.2.6: 새로 검증된 conditionalPrice가 있을 때만 갱신, null/미검증이면
  // 기존 non-null 값을 그대로 둔다(요청서 11절 - reviewSummary와 동일한 null-refresh 보호).
  conditionalPrice: "conditional_price",
};

// snapshotExtraJson: insertProductRadarCollectedProductWithSnapshot과 동일하게 호출부(browserUpdate.ts)가
// 만든 snapshot_json 원문을 그대로 받아 history에 남깁니다. save_job_id는 의도적으로 NULL -
// 이 갱신은 saveJobId 멱등 체계와 무관한 별도의 update-request-id로 멱등 처리되며(요청서 8절),
// save_job_id 컬럼의 partial UNIQUE 인덱스(WHERE save_job_id IS NOT NULL) 덕분에 NULL 여러 개가
// 아무 마이그레이션 없이 안전하게 공존합니다(Phase 5부터 있던 구조를 그대로 재사용).
export function refreshProductRadarProductFromSnapshot(
  id: number,
  patch: ProductRadarRefreshPatch,
  snapshotExtraJson: string
): ProductRadarRefreshResult | null {
  const db = getDb();
  const existing = getProductRadarProduct(id);
  if (!existing) return null;

  const changedFields: string[] = [];
  const setClauses: string[] = [];
  const values: any[] = [];

  for (const key of Object.keys(REFRESH_STRING_COLUMN_MAP)) {
    const v = (patch as any)[key];
    if (typeof v === "string" && v.trim() !== "") {
      setClauses.push(`${REFRESH_STRING_COLUMN_MAP[key]} = ?`);
      values.push(v);
      changedFields.push(key);
    }
  }
  for (const key of Object.keys(REFRESH_NUMBER_COLUMN_MAP)) {
    const v = (patch as any)[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      setClauses.push(`${REFRESH_NUMBER_COLUMN_MAP[key]} = ?`);
      values.push(v);
      changedFields.push(key);
    }
  }

  const ts = nowIso();
  const txn = db.transaction((): ProductRadarRefreshResult => {
    const sql =
      setClauses.length > 0
        ? `UPDATE product_radar_products SET ${setClauses.join(", ")}, last_checked_at = ?, updated_at = ? WHERE id = ?`
        : `UPDATE product_radar_products SET last_checked_at = ?, updated_at = ? WHERE id = ?`;
    db.prepare(sql).run(...values, ts, ts, id);

    const snapshotInfo = db
      .prepare(
        `INSERT INTO product_radar_product_snapshots
          (product_id, price, original_price, shipping_fee, rating, review_count, snapshot_json, captured_at, save_job_id,
           conditional_price, conditional_price_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(
        id,
        patch.price ?? null,
        patch.originalPrice ?? null,
        patch.shippingFee ?? null,
        patch.rating ?? null,
        patch.reviewCount ?? null,
        snapshotExtraJson,
        ts,
        patch.conditionalPrice ?? null,
        patch.conditionalPriceLabel ?? null
      );

    return {
      product: getProductRadarProduct(id) as ProductRadarProduct,
      changedFields,
      snapshotId: Number(snapshotInfo.lastInsertRowid),
    };
  });
  return txn();
}

// ---------- 상품 레이더 Phase 9.7: Comparison Group/Orchestration repository helper ----------
// 이 구간은 "저장/조회"만 담당합니다 - category/relation/compatibility 계산은 전혀 하지
// 않습니다(그건 src/productRadar/comparisonOrchestration.ts의 책임). 기존
// product_radar_compare_groups/product_radar_compare_items 테이블은 스키마만 있었고
// production insert/조회 함수가 없었던 부분을 채웁니다(schema 변경 없음).

export interface ProductRadarCompareGroupInsertInput {
  compareType: import("./productRadar/types").ProductRadarCompareType;
  productIds: number[]; // 이미 canonical(오름차순) 정렬된 상태로 받는다 - 여기서 재정렬하지 않는다
  infoAsOf: string;
}

// group 생성 + compare_items 생성을 하나의 transaction으로 묶는다(요청서 3-1절 -
// 중간 실패 시 group/item 일부만 남으면 안 됨). sort_order는 호출자가 넘긴
// productIds 순서를 그대로 기록한다(호출자가 canonical 정렬 책임을 짐 - 이 함수는
// "정렬된 목록을 그대로 저장"만 한다).
export function insertProductRadarCompareGroup(
  input: ProductRadarCompareGroupInsertInput
): { groupId: number; productIds: number[] } {
  const db = getDb();
  const ts = nowIso();
  const txn = db.transaction((): { groupId: number; productIds: number[] } => {
    const groupInfo = db
      .prepare(
        `INSERT INTO product_radar_compare_groups (compare_type, title, status, analysis_json, info_as_of, created_at, updated_at)
         VALUES (?, NULL, 'draft', NULL, ?, ?, ?)`
      )
      .run(input.compareType, input.infoAsOf, ts, ts);
    const groupId = Number(groupInfo.lastInsertRowid);

    const insertItem = db.prepare(
      `INSERT INTO product_radar_compare_items (compare_group_id, product_id, sort_order, analysis_json, created_at)
       VALUES (?, ?, ?, NULL, ?)`
    );
    input.productIds.forEach((productId, index) => {
      insertItem.run(groupId, productId, index, ts);
    });

    return { groupId, productIds: input.productIds };
  });
  return txn();
}

function rowToProductRadarCompareGroup(row: any): import("./productRadar/types").ProductRadarCompareGroup {
  return {
    id: row.id,
    compareType: row.compare_type,
    title: row.title,
    status: row.status,
    analysisJson: row.analysis_json,
    infoAsOf: row.info_as_of,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getProductRadarCompareGroup(id: number): import("./productRadar/types").ProductRadarCompareGroup | null {
  const row = getDb().prepare("SELECT * FROM product_radar_compare_groups WHERE id = ?").get(id);
  return row ? rowToProductRadarCompareGroup(row) : null;
}

// sort_order 오름차순(= 생성 시점에 기록한 순서, 이미 canonical) 그대로 반환한다.
export function listProductRadarCompareItemsByGroupId(compareGroupId: number): import("./productRadar/types").ProductRadarCompareItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM product_radar_compare_items WHERE compare_group_id = ? ORDER BY sort_order ASC")
    .all(compareGroupId) as any[];
  return rows.map((row) => ({
    id: row.id,
    compareGroupId: row.compare_group_id,
    productId: row.product_id,
    sortOrder: row.sort_order,
    analysisJson: row.analysis_json,
    createdAt: row.created_at,
  }));
}

// Phase 12.5.2.2.1: displayLabel 추가 - snapshot_json 안에 얼려진 사람이 읽는 상품명을
// 이 exact 행에서 그대로 꺼낸다(다른/최신 live row에서 가져오지 않음, 요청서 12절).
// Phase 12.5.2.3.1: sourceUrl/canonicalUrl 추가 - live product row의 현재 URL이 아니라
// "이 ProductSnapshot을 만든 capture event"에서 방문/정규화된 URL을 그대로 꺼낸다.
// Phase 12.5.3.1: representativeImageUrl 추가 - 이 exact 행의 capture 시점에 기록된
// 대표 이미지 reference URL을 그대로 꺼낸다(live product/product_radar_images 재조회 없음).
export interface ProductRadarProductSnapshotRef {
  id: number;
  productId: number;
  capturedAt: string;
  displayLabel: string | null;
  sourceUrl: string | null;
  canonicalUrl: string | null;
  representativeImageUrl: string | null;
}

// snapshot_json에서 displayLabel만 얕게 꺼낸다 - 값의 타입이 string/null이 아니어도
// (예: 저장이 손상되어 숫자/객체가 들어있는 경우) 여기서는 판단하지 않고 원문 그대로
// 반환한다 - "missing vs corrupt" 구분과 실제 거부는 comparisonSnapshot.ts의
// checkDisplayLabel()/isValidProductEvidence()가 domain 경계에서 담당한다(comparisonFields/
// normalizedMeasurements와 동일하게 이 파일은 순수 저장소 계층일 뿐 domain 검증을
// 하지 않는다는 기존 원칙 그대로). snapshot_json 자체가 파싱되지 않으면(정상 쓰기
// 경로에서는 발생하지 않음) 방어적으로 null로 취급한다.
function extractDisplayLabelFromSnapshotJson(snapshotJson: string): unknown {
  try {
    const parsed = JSON.parse(snapshotJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "displayLabel" in parsed) {
      return (parsed as Record<string, unknown>).displayLabel;
    }
    return null; // key 자체가 없음(legacy row) - null
  } catch {
    return null;
  }
}

// Phase 12.5.2.3.1: snapshot_json에서 sourceUrl/canonicalUrl을 얕게 꺼낸다(displayLabel과
// 동일 원칙 - 타입 판단/보정 없이 원문 그대로 반환, missing vs corrupt 판정은
// productSnapshotProvenance.ts의 checkFrozenProductSnapshotUrl()이 domain 경계에서 담당).
// 두 필드는 항상 같은 호출부(getLatestProductRadarProductSnapshot)에서 함께 쓰이므로
// 한 번의 JSON.parse로 같이 꺼내 중복 파싱을 피한다.
function extractProvenanceUrlsFromSnapshotJson(snapshotJson: string): { sourceUrl: unknown; canonicalUrl: unknown } {
  try {
    const parsed = JSON.parse(snapshotJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        sourceUrl: "sourceUrl" in obj ? obj.sourceUrl : null,
        canonicalUrl: "canonicalUrl" in obj ? obj.canonicalUrl : null,
      };
    }
    return { sourceUrl: null, canonicalUrl: null };
  } catch {
    return { sourceUrl: null, canonicalUrl: null };
  }
}

// Phase 12.5.3.1: snapshot_json에서 representativeImageUrl을 얕게 꺼낸다(displayLabel과
// 동일 원칙 - 타입 판단/보정 없이 원문 그대로 반환, missing vs corrupt 판정은
// productSnapshotProvenance.ts의 checkFrozenProductSnapshotUrl()이 domain 경계에서
// 담당한다 - sourceUrl/canonicalUrl과 같은 검증 함수를 재사용하지만 별도 개념(수집 경로
// URL이 아니라 상품 대표 이미지 URL)이므로 provenance 추출 함수에 섞지 않고 별도로 꺼낸다).
function extractRepresentativeImageUrlFromSnapshotJson(snapshotJson: string): unknown {
  try {
    const parsed = JSON.parse(snapshotJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "representativeImageUrl" in parsed) {
      return (parsed as Record<string, unknown>).representativeImageUrl;
    }
    return null; // key 자체가 없음(legacy row) - null
  } catch {
    return null;
  }
}

// 그 상품의 가장 최근 product_radar_product_snapshots 행(id, captured_at, displayLabel,
// sourceUrl, canonicalUrl, representativeImageUrl)만 확정한다 - 나머지 컬럼은
// orchestration에 필요 없으므로 읽지 않는다. 수동 등록 상품처럼 snapshot 행이 아예 없으면
// null(호출부가 domain error로 처리 - 요청서 8절, 이 함수가 추측하거나 자동 생성하지 않는다).
export function getLatestProductRadarProductSnapshot(productId: number): ProductRadarProductSnapshotRef | null {
  const row = getDb()
    .prepare("SELECT id, captured_at, snapshot_json FROM product_radar_product_snapshots WHERE product_id = ? ORDER BY id DESC LIMIT 1")
    .get(productId) as { id: number; captured_at: string; snapshot_json: string } | undefined;
  if (!row) return null;
  const provenance = extractProvenanceUrlsFromSnapshotJson(row.snapshot_json);
  return {
    id: row.id,
    productId,
    capturedAt: row.captured_at,
    displayLabel: extractDisplayLabelFromSnapshotJson(row.snapshot_json) as string | null,
    sourceUrl: provenance.sourceUrl as string | null,
    canonicalUrl: provenance.canonicalUrl as string | null,
    representativeImageUrl: extractRepresentativeImageUrlFromSnapshotJson(row.snapshot_json) as string | null,
  };
}

// ---------- 상품 레이더: 확장프로그램 연결 토큰(product_radar_extension_tokens) ----------
// MVP1-2 범위. 원문 토큰은 이 파일 어디에도 저장하지 않습니다(호출부가 해시만 넘겨줍니다).
export interface ProductRadarExtensionTokenRow {
  id: number;
  tokenHash: string;
  tokenPrefix: string | null;
  extensionVersion: string | null;
  browser: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
}

function rowToExtensionToken(row: any): ProductRadarExtensionTokenRow {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    extensionVersion: row.extension_version,
    browser: row.browser,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revoked: !!row.revoked,
    revokedAt: row.revoked_at,
  };
}

export interface InsertExtensionTokenInput {
  tokenHash: string;
  tokenPrefix: string;
  extensionVersion?: string | null;
  browser?: string | null;
}

// 이 로컬 단일 사용자 앱은 "한 번에 확장프로그램 하나만 연결됨"을 전제로 합니다. 새 토큰을
// 발급하기 전에 기존에 폐기되지 않은 토큰을 전부 폐기해, 재페어링(다른 브라우저로 전환,
// 확장프로그램 재설치 등) 시 이전 연결이 자동으로 끊어지도록 합니다. 하나의 트랜잭션으로
// 처리해 "이전 토큰은 폐기됐는데 새 토큰은 생성 실패" 같은 중간 상태를 방지합니다.
export function insertExtensionTokenAtomic(input: InsertExtensionTokenInput): number {
  const db = getDb();
  const ts = nowIso();
  const txn = db.transaction((): number => {
    db.prepare("UPDATE product_radar_extension_tokens SET revoked = 1, revoked_at = ? WHERE revoked = 0").run(ts);
    const info = db
      .prepare(
        `INSERT INTO product_radar_extension_tokens
          (token_hash, token_prefix, extension_version, browser, created_at, last_seen_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      )
      .run(input.tokenHash, input.tokenPrefix, input.extensionVersion ?? null, input.browser ?? null, ts, ts);
    return Number(info.lastInsertRowid);
  });
  return txn();
}

export function getExtensionTokenByHash(tokenHash: string): ProductRadarExtensionTokenRow | null {
  const row = getDb().prepare("SELECT * FROM product_radar_extension_tokens WHERE token_hash = ?").get(tokenHash);
  return row ? rowToExtensionToken(row) : null;
}

// 현재 폐기되지 않은(연결된) 토큰 1개(정상적으로는 항상 최대 1개 - insertExtensionTokenAtomic 참고).
export function getActiveExtensionToken(): ProductRadarExtensionTokenRow | null {
  const row = getDb().prepare("SELECT * FROM product_radar_extension_tokens WHERE revoked = 0 ORDER BY id DESC LIMIT 1").get();
  return row ? rowToExtensionToken(row) : null;
}

// "연결 이력이 한 번이라도 있었는가"(홈 화면 안내 카드 표시 여부 판정용) - 폐기 여부와 무관하게
// 행이 하나라도 있으면 true.
export function hasAnyExtensionToken(): boolean {
  const row = getDb().prepare("SELECT id FROM product_radar_extension_tokens LIMIT 1").get();
  return !!row;
}

export function touchExtensionTokenLastSeen(id: number): void {
  getDb().prepare("UPDATE product_radar_extension_tokens SET last_seen_at = ? WHERE id = ? AND revoked = 0").run(nowIso(), id);
}

// 확장프로그램이 스스로 "연결 해제"를 요청했을 때 자신의 토큰만 폐기합니다.
export function revokeExtensionTokenById(id: number): boolean {
  const info = getDb()
    .prepare("UPDATE product_radar_extension_tokens SET revoked = 1, revoked_at = ? WHERE id = ? AND revoked = 0")
    .run(nowIso(), id);
  return info.changes > 0;
}

// 앱 쪽에서 "연결 해제"를 누르면 어떤 토큰이 연결되어 있는지 알 필요 없이, 현재 폐기되지 않은
// 토큰을 전부 폐기합니다(정상 상태에서는 항상 최대 1건).
export function revokeAllActiveExtensionTokens(): number {
  const info = getDb().prepare("UPDATE product_radar_extension_tokens SET revoked = 1, revoked_at = ? WHERE revoked = 0").run(nowIso());
  return info.changes;
}

// ---------- 상품 레이더: 상품 자동 수집 ON/OFF ----------
// 새 테이블을 만들지 않고 기존 settings key-value 저장소를 재사용합니다(auto_publish와 동일한
// 패턴). 이 값이 단일 진실 공급원이며, 앱 화면과 확장프로그램 양쪽이 결국 이 값을 읽고 씁니다.
const PRODUCT_RADAR_COLLECTION_ENABLED_KEY = "product_radar_collection_enabled";

export function isProductRadarCollectionEnabled(): boolean {
  return getSetting(PRODUCT_RADAR_COLLECTION_ENABLED_KEY, "off") === "on";
}

export function setProductRadarCollectionEnabled(enabled: boolean): void {
  setSetting(PRODUCT_RADAR_COLLECTION_ENABLED_KEY, enabled ? "on" : "off");
}

// ---------- 상품 레이더: ProductRadarBrowser 전용 즐겨찾기(Phase 8.2) ----------
// 새 테이블을 만들지 않고 기존 settings key-value 저장소를 재사용합니다(schedule_routine과 동일한
// 패턴 - 단일 설정 키에 JSON 배열 하나를 통째로 저장). 개인 Edge/Chrome 즐겨찾기와는 완전히
// 별개이며, Node가 이 값의 유일한 persistence owner입니다(builtin 쿠팡/네이버 쇼핑은 C# 쪽에
// 하드코딩되어 여기 저장되지 않습니다 - Node가 죽어 있어도 표시되어야 하므로). 실제 검증/dedup은
// src/productRadar/browserBookmarks.ts가 담당하고, 이 함수들은 raw get/set만 합니다
// (getScheduleRoutine/setScheduleRoutine과 database.ts/scheduleRoutine.ts의 역할 분담과 동일).
const PRODUCT_RADAR_BROWSER_BOOKMARKS_KEY = "product_radar_browser_bookmarks";

export interface ProductRadarBrowserBookmarkRow {
  id: number;
  title: string;
  url: string;
  sortOrder: number;
  createdAt: string;
}

export function getProductRadarBrowserBookmarks(): ProductRadarBrowserBookmarkRow[] {
  const raw = getSetting(PRODUCT_RADAR_BROWSER_BOOKMARKS_KEY, null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setProductRadarBrowserBookmarks(bookmarks: ProductRadarBrowserBookmarkRow[]): void {
  setSetting(PRODUCT_RADAR_BROWSER_BOOKMARKS_KEY, JSON.stringify(bookmarks));
}

// ---------- 공장 전체 초기화 ----------
// "설정 > 데이터 관리 > 공장 전체 초기화" 전용. 사용자 생성 데이터(초안/자료/예약/발행 기록/
// 예약 루틴/사용자 설정/RSS 피드/페르소나/실패 로그)를 담은 테이블 전부를 하나의 트랜잭션으로
// 비웁니다 - 도중에 오류가 나면 better-sqlite3가 자동으로 전체 롤백하므로 일부만 삭제되는 일이
// 없습니다. DB 스키마(테이블 구조) 자체는 그대로 유지되고, feeds/persona_versions 재시딩과
// 업로드 파일 삭제, 감사 로그 기록은 이 함수를 호출하는 라우트(src/routes/settings.ts)가
// 이어서 처리합니다(라우트 계층에서 이미 export된 seedDefaultFeedsIfEmpty 등을 재사용).
export interface FactoryResetCounts {
  drafts: number;
  materials: number;
  materialCandidatesLog: number;
  publishLog: number;
  personaVersions: number;
  feeds: number;
  settings: number;
  claudeFailures: number;
  productRadarProducts: number;
  productRadarProductSnapshots: number;
  productRadarImages: number;
  productRadarCompareGroups: number;
  productRadarCompareItems: number;
  productRadarMediaJobs: number;
  productRadarMediaFiles: number;
  productRadarUploads: number;
  // 필드명에 "token"이 들어가지 않도록 의도적으로 명명합니다(감사 로그 비밀값 스캔 테스트가
  // "token"/"password"/"secret" 부분 문자열을 그대로 검사하므로, 실제 토큰 값이 아닌 단순
  // 건수(count) 필드라도 이름에 "token"이 들어가면 오탐이 발생합니다).
  productRadarExtensionPairings: number;
  // 상품 레이더 Phase 12.5.3.6: 찜/후보 + 미디어 보관함도 사용자 생성 데이터이므로 공장
  // 전체 초기화 대상에 포함한다.
  productRadarCurations: number;
  productRadarLibraryAssets: number;
  productRadarLibraryAssetFiles: number;
  productRadarMediaFavorites: number;
}

export function factoryResetClearAllTables(): FactoryResetCounts {
  const db = getDb();
  const countOf = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;

  const run = db.transaction((): FactoryResetCounts => {
    const counts: FactoryResetCounts = {
      drafts: countOf("drafts"),
      materials: countOf("materials"),
      materialCandidatesLog: countOf("material_candidates_log"),
      publishLog: countOf("publish_log"),
      personaVersions: countOf("persona_versions"),
      feeds: countOf("feeds"),
      settings: countOf("settings"),
      claudeFailures: countOf("claude_failures"),
      productRadarProducts: countOf("product_radar_products"),
      productRadarProductSnapshots: countOf("product_radar_product_snapshots"),
      productRadarImages: countOf("product_radar_images"),
      productRadarCompareGroups: countOf("product_radar_compare_groups"),
      productRadarCompareItems: countOf("product_radar_compare_items"),
      productRadarMediaJobs: countOf("product_radar_media_jobs"),
      productRadarMediaFiles: countOf("product_radar_media_files"),
      productRadarUploads: countOf("product_radar_uploads"),
      productRadarExtensionPairings: countOf("product_radar_extension_tokens"),
      productRadarCurations: countOf("product_radar_curations"),
      productRadarLibraryAssets: countOf("product_radar_library_assets"),
      productRadarLibraryAssetFiles: countOf("product_radar_library_asset_files"),
      productRadarMediaFavorites: countOf("product_radar_media_favorites"),
    };
    // 외래키(foreign_keys=ON)가 걸린 테이블은 자식을 먼저 비웁니다. product_radar_media_jobs가
    // drafts(id)를 참조하므로, 아래 drafts 삭제보다 반드시 먼저 비워야 합니다(순서를 바꾸면
    // 미디어 작업이 실제로 쌓인 뒤에는 이 트랜잭션 전체가 FK 위반으로 롤백됩니다).
    db.prepare("DELETE FROM product_radar_media_files").run();
    db.prepare("DELETE FROM product_radar_uploads").run();
    db.prepare("DELETE FROM product_radar_media_jobs").run();
    db.prepare("DELETE FROM product_radar_compare_items").run();
    db.prepare("DELETE FROM product_radar_compare_groups").run();
    db.prepare("DELETE FROM product_radar_product_snapshots").run();
    db.prepare("DELETE FROM product_radar_images").run();
    // Phase 12.5.3.6: curations는 product_radar_products(id)를 ON DELETE CASCADE로 참조하므로
    // 굳이 먼저 지우지 않아도 되지만, 다른 자식 테이블과 동일하게 명시적으로 비운다(count 리포팅
    // 목적 + 일관성). library asset files도 asset보다 먼저 비운다(CASCADE와 동일 이유).
    db.prepare("DELETE FROM product_radar_curations").run();
    db.prepare("DELETE FROM product_radar_library_asset_files").run();
    db.prepare("DELETE FROM product_radar_library_assets").run();
    db.prepare("DELETE FROM product_radar_media_favorites").run();
    db.prepare("DELETE FROM product_radar_products").run();
    db.prepare("DELETE FROM product_radar_extension_tokens").run();
    // publish_log.draft_id가 drafts를 참조하는 외래키라(foreign_keys=ON), 자식 테이블을 먼저 비웁니다.
    db.prepare("DELETE FROM publish_log").run();
    db.prepare("DELETE FROM drafts").run();
    db.prepare("DELETE FROM material_candidates_log").run();
    db.prepare("DELETE FROM materials").run();
    db.prepare("DELETE FROM persona_versions").run();
    db.prepare("DELETE FROM feeds").run();
    db.prepare("DELETE FROM settings").run();
    db.prepare("DELETE FROM claude_failures").run();
    return counts;
  });

  return run();
}

// ---------- 상품 레이더 탭별 "비우기" (안전 삭제) ----------
// purgeDrafts()와 정확히 같은 원칙이다: 다른 데이터를 함께 지워서 억지로 삭제하지 않는다.
// 탭마다 "비운다"의 의미가 실제 데이터 모델에서 서로 다르므로(임의 cascade 금지) 여기서
// 한 번만 정의하고 라우트/화면은 이 정의를 그대로 따른다.
//
//   products    상품 행 자체를 삭제. snapshots/images/curations는 ON DELETE CASCADE로 함께
//               정리되지만, compare_items / media_jobs는 NO ACTION이라 참조 중이면 삭제가
//               실패한다 -> 애초에 후보에서 제외한다(보호).
//   favorites   찜 해제 = product_radar_curations row 삭제. 상품 자체는 그대로 남는다.
//               (후보였던 상품도 함께 찜 해제된다 - 기존 unfavorite 계약과 동일)
//   shortlisted 후보 해제 = state를 'shortlisted' -> 'favorite'로 낮춘다. row/상품 모두 유지
//               (기존 "후보에서 제외" 계약과 동일 - 찜까지 지우지 않는다).
//   compare     비교 그룹 삭제. comparison/recommendation snapshot은 CASCADE로 함께 사라지지만
//               상품 원본은 건드리지 않는다. drafts가 참조 중인 recommendation snapshot이
//               있으면(NO ACTION) 그 그룹은 보호한다.
//   library     업로드한 미디어 asset 삭제(files는 CASCADE). 초안이 쓰고 있는 asset은 보호한다
//               (FK가 ON DELETE SET NULL이라 막아주지 않으므로 여기서 직접 제외한다).
//               "만들어진(generated) 미디어"는 이 목록에 함께 보이지만 media job 이력이라
//               비우기 대상이 아니다 - 항상 보호로 집계한다.
export type ProductRadarClearScope = "products" | "favorites" | "shortlisted" | "compare" | "library";

export const PRODUCT_RADAR_CLEAR_SCOPES: readonly ProductRadarClearScope[] = [
  "products",
  "favorites",
  "shortlisted",
  "compare",
  "library",
];

export function isProductRadarClearScope(v: unknown): v is ProductRadarClearScope {
  return typeof v === "string" && (PRODUCT_RADAR_CLEAR_SCOPES as readonly string[]).includes(v);
}

export interface ProductRadarClearPreview {
  clearable: string[];   // 이 탭에서 비울 수 있는 항목 id(문자열로 통일 - library는 assetKey)
  protectedIds: string[];
  total: number;
}

function idSet(rows: unknown[], key: string): Set<number> {
  return new Set((rows as Record<string, number>[]).map((r) => r[key]).filter((v) => v !== null && v !== undefined));
}

// 상품 목록 비우기의 보호 사유. 최종 계약: "비우기는 현재 탭 범위만 적용한다 - 다른 탭
// 데이터는 절대 건드리지 않는다." product_radar_curations는 ON DELETE CASCADE라 상품을 지우면
// 찜/후보가 함께 사라지므로, CASCADE를 실행할 대상 자체를 clearable에 넣지 않는다
// (FK/스키마는 그대로 둔다 - 고아 행을 만들지 않기 위해 CASCADE 자체는 옳다).
//
// snapshots/images는 상품 자체에 종속된 데이터라 CASCADE를 그대로 허용한다(다른 탭이 아니다).
export interface ProductRadarProductProtectionReasons {
  favorite: Set<number>;    // 찜한 상품 탭에 있음(state='favorite')
  shortlisted: Set<number>; // 후보 상품 탭에 있음(state='shortlisted')
  usage: Set<number>;       // 비교 / 미디어 작업에서 참조 중
}

export function productRadarProductProtectionReasons(): ProductRadarProductProtectionReasons {
  const db = getDb();
  return {
    favorite: idSet(
      db.prepare("SELECT product_id FROM product_radar_curations WHERE state = 'favorite'").all(),
      "product_id"
    ),
    shortlisted: idSet(
      db.prepare("SELECT product_id FROM product_radar_curations WHERE state = 'shortlisted'").all(),
      "product_id"
    ),
    usage: new Set<number>([
      ...idSet(db.prepare("SELECT DISTINCT product_id FROM product_radar_compare_items").all(), "product_id"),
      ...idSet(
        db.prepare("SELECT DISTINCT product_id FROM product_radar_media_jobs WHERE product_id IS NOT NULL").all(),
        "product_id"
      ),
    ]),
  };
}

export function isProductRadarProductProtected(reasons: ProductRadarProductProtectionReasons, id: number): boolean {
  return reasons.favorite.has(id) || reasons.shortlisted.has(id) || reasons.usage.has(id);
}

// 확인창이 "왜 남는지"를 말할 수 있게 사유별 개수를 센다. 한 상품이 여러 사유에 동시에
// 걸릴 수 있으므로 세 값의 합은 보호 상품 수와 다를 수 있다 - 그래서 unique 총계(protected)를
// 함께 돌려주고, 화면은 문장에 총계만 쓴다(합계로 오해되지 않게).
export function countProductRadarProductProtectionReasons(productIds: string[]): {
  protected: number;
  byFavorite: number;
  byShortlisted: number;
  byUsage: number;
} {
  const reasons = productRadarProductProtectionReasons();
  const ids = productIds.map((v) => parseInt(String(v), 10)).filter((n) => Number.isInteger(n));
  let byFavorite = 0;
  let byShortlisted = 0;
  let byUsage = 0;
  let total = 0;
  for (const id of ids) {
    const f = reasons.favorite.has(id);
    const s2 = reasons.shortlisted.has(id);
    const u = reasons.usage.has(id);
    if (f) byFavorite++;
    if (s2) byShortlisted++;
    if (u) byUsage++;
    if (f || s2 || u) total++;
  }
  return { protected: total, byFavorite, byShortlisted, byUsage };
}

// 찜 비우기에서 보호되는 이유는 하나뿐이다 - "후보 상품 탭의 데이터라서". 확인창이 그 개수를
// 그대로 말할 수 있게 서버가 세어 준다(화면이 추정하지 않는다).
export function countProductRadarFavoriteProtectionReasons(productIds: string[]): { protected: number; byShortlisted: number } {
  const ids = productIds.map((v) => parseInt(String(v), 10)).filter((n) => Number.isInteger(n));
  if (ids.length === 0) return { protected: 0, byShortlisted: 0 };
  const shortlisted = idSet(
    getDb().prepare("SELECT product_id FROM product_radar_curations WHERE state = 'shortlisted'").all(),
    "product_id"
  );
  let n = 0;
  for (const id of ids) if (shortlisted.has(id)) n++;
  return { protected: n, byShortlisted: n };
}

export function findClearableProductRadar(scope: ProductRadarClearScope): ProductRadarClearPreview {
  const db = getDb();
  const clearable: string[] = [];
  const protectedIds: string[] = [];

  if (scope === "products") {
    const rows = db.prepare("SELECT id FROM product_radar_products ORDER BY id ASC").all() as { id: number }[];
    const reasons = productRadarProductProtectionReasons();
    for (const r of rows) {
      if (isProductRadarProductProtected(reasons, r.id)) protectedIds.push(String(r.id));
      else clearable.push(String(r.id));
    }
    return { clearable, protectedIds, total: rows.length };
  }

  if (scope === "favorites") {
    // 찜 목록에는 후보(shortlisted)도 함께 보인다(계층형 상태). 하지만 후보는 "후보 상품" 탭의
    // 데이터이기도 하므로, 찜 비우기로 지우면 다른 탭이 함께 비는 cross-tab collateral이 된다.
    // 최종 계약("현재 탭 범위만 적용")에 따라 후보는 보호하고, 후보 해제는 후보 탭에서만 한다.
    const rows = db
      .prepare("SELECT product_id, state FROM product_radar_curations WHERE state IN ('favorite','shortlisted') ORDER BY product_id ASC")
      .all() as { product_id: number; state: string }[];
    for (const r of rows) {
      if (r.state === "shortlisted") protectedIds.push(String(r.product_id));
      else clearable.push(String(r.product_id));
    }
    return { clearable, protectedIds, total: rows.length };
  }

  if (scope === "shortlisted") {
    const rows = db
      .prepare("SELECT product_id FROM product_radar_curations WHERE state = 'shortlisted' ORDER BY product_id ASC")
      .all() as { product_id: number }[];
    for (const r of rows) clearable.push(String(r.product_id));
    return { clearable, protectedIds, total: rows.length };
  }

  if (scope === "compare") {
    const rows = db.prepare("SELECT id FROM product_radar_compare_groups ORDER BY id ASC").all() as { id: number }[];
    // 초안이 인용 중인 recommendation snapshot -> 그 snapshot이 속한 compare group을 보호한다.
    const usedGroups = idSet(
      db
        .prepare(
          `SELECT DISTINCT cs.compare_group_id AS compare_group_id
             FROM drafts d
             JOIN product_radar_recommendation_snapshots rs ON rs.id = d.product_radar_recommendation_snapshot_id
             JOIN product_radar_comparison_snapshots cs ON cs.id = rs.comparison_snapshot_id
            WHERE d.product_radar_recommendation_snapshot_id IS NOT NULL`
        )
        .all(),
      "compare_group_id"
    );
    for (const r of rows) {
      if (usedGroups.has(r.id)) protectedIds.push(String(r.id));
      else clearable.push(String(r.id));
    }
    return { clearable, protectedIds, total: rows.length };
  }

  // library: 업로드 asset만 대상. generated(media job)은 목록에 보이지만 항상 보호.
  const assets = db.prepare("SELECT id FROM product_radar_library_assets ORDER BY id ASC").all() as { id: number }[];
  const usedByDraft = idSet(
    db.prepare("SELECT DISTINCT product_radar_library_asset_id AS id FROM drafts WHERE product_radar_library_asset_id IS NOT NULL").all(),
    "id"
  );
  for (const a of assets) {
    if (usedByDraft.has(a.id)) protectedIds.push(`upload:${a.id}`);
    else clearable.push(`upload:${a.id}`);
  }
  const jobs = db.prepare("SELECT id FROM product_radar_media_jobs ORDER BY id ASC").all() as { id: number }[];
  for (const j of jobs) protectedIds.push(`job:${j.id}`);
  return { clearable, protectedIds, total: assets.length + jobs.length };
}

// ids를 주면 그 중 "비울 수 있는 것"만 처리하고, 주지 않으면 전체를 처리한다.
// 어느 경우에도 보호 대상은 절대 건드리지 않는다(화면이 보낸 id를 그대로 믿지 않는다).
export function clearProductRadar(
  scope: ProductRadarClearScope,
  ids?: string[]
): { cleared: number; kept: number } {
  const db = getDb();
  const { clearable, protectedIds } = findClearableProductRadar(scope);
  const requested = ids && ids.length > 0 ? new Set(ids.map(String)) : null;
  const targets = requested ? clearable.filter((id) => requested.has(id)) : clearable;
  const kept = protectedIds.length;
  if (targets.length === 0) return { cleared: 0, kept };

  const stmts: Record<ProductRadarClearScope, string> = {
    products: "DELETE FROM product_radar_products WHERE id = ?",
    // state 조건을 문장 자체에 박아 둔다 - 위의 clearable 필터가 바뀌더라도 후보 row가
    // 찜 비우기로 지워지는 일은 구조적으로 일어나지 않는다(이중 방어).
    favorites: "DELETE FROM product_radar_curations WHERE product_id = ? AND state = 'favorite'",
    shortlisted: "UPDATE product_radar_curations SET state = 'favorite', updated_at = ? WHERE product_id = ? AND state = 'shortlisted'",
    compare: "DELETE FROM product_radar_compare_groups WHERE id = ?",
    library: "DELETE FROM product_radar_library_assets WHERE id = ?",
  };
  const stmt = db.prepare(stmts[scope]);
  const now = nowIso();
  const txn = db.transaction((list: string[]) => {
    for (const id of list) {
      if (scope === "shortlisted") stmt.run(now, parseInt(id, 10));
      else if (scope === "library") stmt.run(parseInt(id.slice("upload:".length), 10));
      else stmt.run(parseInt(id, 10));
    }
  });
  txn(targets);
  return { cleared: targets.length, kept };
}


