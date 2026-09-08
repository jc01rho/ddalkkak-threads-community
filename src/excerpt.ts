// src/excerpt.ts
// 자료 원문(본문)은 DB에 그대로 보존하지만, Claude 프롬프트에는 전체를 보내지 않고
// 제목/키워드/사용자 관점과 관련성이 높은 문단만 우선 발췌해서 전달합니다.
// 단순히 앞부분을 자르는 대신, 각 문단에 관련 키워드가 얼마나 포함됐는지로 점수를 매깁니다.

function tokenize(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter((t) => t.length >= 2);
}

function splitParagraphs(content: string): string[] {
  const raw = (content || "").trim();
  if (!raw) return [];
  // 줄바꿈이 있으면 그대로 문단 단위로 쪼개고, 없으면(RSS 요약 등 한 덩어리) 문장 부호 기준으로 묶는다.
  let parts = raw.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const sentences = raw.split(/(?<=[.!?。!?])\s+/).map((s) => s.trim()).filter(Boolean);
    parts = [];
    for (let i = 0; i < sentences.length; i += 3) {
      parts.push(sentences.slice(i, i + 3).join(" "));
    }
    if (parts.length === 0) parts = [raw];
  }
  return parts;
}

export interface ExcerptOptions {
  title?: string;
  keywords?: string[];
  note?: string;
  maxChars: number;
}

// 관련성이 높은 문단을 우선 선택해 maxChars 예산 안에서 이어붙입니다.
// 관련 키워드가 전혀 없거나 매칭되는 문단이 없으면, 원문 앞부분부터 예산만큼 사용합니다(안전한 대체 동작).
export function extractRelevantExcerpt(content: string, opts: ExcerptOptions): string {
  const raw = (content || "").trim();
  if (!raw) return "";
  if (raw.length <= opts.maxChars) return raw;

  const queryTerms = new Set([
    ...tokenize(opts.title || ""),
    ...tokenize((opts.keywords || []).join(" ")),
    ...tokenize(opts.note || ""),
  ]);

  const paragraphs = splitParagraphs(raw);
  if (paragraphs.length === 0) return raw.slice(0, opts.maxChars);

  if (queryTerms.size === 0) {
    // 참고할 키워드가 없으면 앞에서부터 문단을 채운다(기존 동작과 유사).
    return joinWithinBudget(paragraphs.map((text, idx) => ({ text, idx, score: 0 })), opts.maxChars, true);
  }

  const scored = paragraphs.map((text, idx) => {
    const tokens = tokenize(text);
    let score = 0;
    for (const t of tokens) if (queryTerms.has(t)) score++;
    return { text, idx, score };
  });

  const anyMatch = scored.some((s) => s.score > 0);
  if (!anyMatch) {
    return joinWithinBudget(scored, opts.maxChars, true);
  }

  // 점수 높은 순으로 정렬(동점이면 원문 순서 유지), 예산 안에서 채택한 뒤 원문 순서로 다시 정렬해 이어붙인다.
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.idx - b.idx);
  const picked: typeof scored = [];
  let used = 0;
  for (const p of ranked) {
    if (p.score <= 0 && picked.length > 0) break; // 관련 문단을 우선 채택, 관련 없는 문단은 여유가 있을 때만 뒤에서 보충
    if (used + p.text.length > opts.maxChars) {
      if (used === 0) {
        picked.push({ ...p, text: p.text.slice(0, opts.maxChars) });
        used = opts.maxChars;
      }
      break;
    }
    picked.push(p);
    used += p.text.length + 1;
  }
  picked.sort((a, b) => a.idx - b.idx);
  return picked.map((p) => p.text).join(" ").slice(0, opts.maxChars);
}

function joinWithinBudget(items: { text: string; idx: number }[], maxChars: number, fromStart: boolean): string {
  const ordered = fromStart ? items : items;
  let out = "";
  for (const it of ordered) {
    if (out.length >= maxChars) break;
    const remain = maxChars - out.length;
    out += (out ? " " : "") + it.text.slice(0, remain);
  }
  return out.slice(0, maxChars);
}
