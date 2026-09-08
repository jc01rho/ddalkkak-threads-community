// src/routes/persona.ts
import { Router } from "express";
import fs from "fs";
import path from "path";
import { getCurrentPersona, saveNewPersonaVersion, PersonaData } from "../database";
import { stripHtmlTags } from "../affiliatePromo";

const router = Router();

const DEFAULT_PERSONA_PATH = path.join(__dirname, "..", "..", "data", "default-persona.json");

export function loadDefaultPersona(): PersonaData {
  const raw = fs.readFileSync(DEFAULT_PERSONA_PATH, "utf-8");
  return JSON.parse(raw);
}

router.get("/", (_req, res) => {
  let current = getCurrentPersona();
  if (!current) {
    // 최초 실행 시 기본값으로 1버전을 만들어둔다.
    const defaults = loadDefaultPersona();
    current = saveNewPersonaVersion(defaults);
  }
  res.json({ persona: current });
});

// P1.8 입력 안전성: 페르소나 값은 사용자가 자유롭게 쓰는 텍스트이므로, 제휴 입력과 동일한
// 기존 관례(stripHtmlTags + 필드별 길이 상한)를 그대로 재사용한다. 여기서 정리된 값만
// 저장되고, 그 값이 그대로 생성 프롬프트에 들어간다(화면 표시는 textarea value라 별도 위험 없음).
// 상한은 실사용을 해치지 않는 넉넉한 값이며, 넘으면 잘라서 저장한다(저장 자체를 막지 않음).
export const MAX_PERSONA_SHORT_CHARS = 200;   // 글 길이 선호 / 이모지 사용 정도 같은 짧은 값
export const MAX_PERSONA_LONG_CHARS = 2000;   // 스타일 이름 / 말투 / 독자 / 글 특징 / 피할 표현

function cleanPersonaText(value: unknown, maxChars: number, fallback = ""): string {
  const raw = typeof value === "string" ? value : "";
  const cleaned = stripHtmlTags(raw).trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxChars);
}

router.post("/", (req, res) => {
  const body = req.body || {};
  const data: PersonaData = {
    channel_identity: cleanPersonaText(body.channel_identity, MAX_PERSONA_LONG_CHARS),
    audience: cleanPersonaText(body.audience, MAX_PERSONA_LONG_CHARS),
    tone_description: cleanPersonaText(body.tone_description, MAX_PERSONA_LONG_CHARS),
    common_phrases: cleanPersonaText(body.common_phrases, MAX_PERSONA_LONG_CHARS),
    banned_phrases: cleanPersonaText(body.banned_phrases, MAX_PERSONA_LONG_CHARS),
    length_preference: cleanPersonaText(body.length_preference, MAX_PERSONA_SHORT_CHARS, "200~450자"),
    emoji_level: cleanPersonaText(body.emoji_level, MAX_PERSONA_SHORT_CHARS, "적음"),
    allow_question_ending: !!body.allow_question_ending,
    allow_external_links: !!body.allow_external_links,
  };
  const saved = saveNewPersonaVersion(data);
  res.json({ success: true, persona: saved });
});

// P1.8: "기본 스타일로 되돌리기". 페르소나(내 글 스타일)만 기본값 한 벌로 새로 저장한다.
// 초안/자료/상품/예약/발행 기록/Threads 자격증명/라이선스는 전혀 건드리지 않는다 - 이
// 라우트는 persona_versions에만 쓰고, 과거 버전도 지우지 않는다(새 버전으로 쌓는 기존 방식).
router.post("/reset", (_req, res) => {
  const saved = saveNewPersonaVersion(loadDefaultPersona());
  res.json({ success: true, persona: saved });
});

export default router;
