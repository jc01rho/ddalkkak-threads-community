// src/builtInFeeds.ts
// 기본(무료) 자료원 팩. 프로그램이 자동 관리하는 built-in RSS/Atom feed 목록의 유일한
// 관리처다(data/default-feeds.json은 이 목록에서 파생된 이름/URL만 담는 최초 설치용
// 사본이며, test-runner가 두 목록의 일치를 계약으로 고정한다).
//
// 등재 원칙:
//   - 공개 접근 가능한 정식 RSS/Atom endpoint만(로그인/유료 API/robots 우회/HTML scraping 금지)
//   - 실제 HTTP GET으로 200 + parse 성공 + 최근 item 존재를 확인한 것만 등재
//   - 한국 사용자에게 의미 있는 국내 매체 우선, 부족한 분야를 해외 전문 매체로 보완
//   - 숫자를 채우기 위한 저품질/광고 feed 금지
//
// affinity = "이 feed가 주로 다루는 분야"라는 힌트일 뿐이며 최종 판정이 아니다. Community
// 코어는 name/url만 사용하고(자료원 동기화 + built-in 판정), affinity를 해석하지 않는다.
// 이 필드는 데이터 원형을 보존하기 위해 그대로 둔다.

// built-in feed의 분야 분류 문자열 집합이다. 외부 모듈에 의존하지 않고
// 여기서 독립적으로 정의한다.
export type BuiltInFeedCategory =
  | "product"
  | "life"
  | "content"
  | "culture"
  | "food"
  | "fashion"
  | "travel"
  | "tech"
  | "issue";

export interface BuiltInFeed {
  name: string; // feeds.name 및 materials.source_name과 정확히 같은 문자열
  url: string;
  affinity: BuiltInFeedCategory[];
}

// 2026-08-20 실측 검증 통과 목록(응답 200 + rss-parser 파싱 성공 + 최근 item 존재).
export const BUILT_IN_FEEDS: BuiltInFeed[] = [
  // ---- 테크(기존 6개 유지: 기존 사용자 DB에 이미 등록돼 있다) ----
  { name: "Hacker News (Front Page)", url: "https://news.ycombinator.com/rss", affinity: ["tech"] },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", affinity: ["tech", "product"] },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", affinity: ["tech", "product"] },
  { name: "MIT Technology Review", url: "https://www.technologyreview.com/feed/", affinity: ["tech"] },
  { name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/", affinity: ["tech"] },
  { name: "GeekNews (긱뉴스)", url: "https://feeds.feedburner.com/geeknews-feed", affinity: ["tech"] },
  { name: "전자신문", url: "https://rss.etnews.com/Section901.xml", affinity: ["tech", "product"] },

  // ---- 이슈(종합 뉴스) ----
  { name: "연합뉴스", url: "https://www.yna.co.kr/rss/news.xml", affinity: ["issue"] },
  { name: "경향신문", url: "https://www.khan.co.kr/rss/rssdata/total_news.xml", affinity: ["issue"] },
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", affinity: ["issue"] },

  // ---- 제품/생활 ----
  { name: "아시아경제 유통", url: "https://www.asiae.co.kr/rss/economy.htm", affinity: ["product", "life"] },
  { name: "한국경제 생활", url: "https://www.hankyung.com/feed/life", affinity: ["life", "product"] },
  { name: "Guardian Life and style", url: "https://www.theguardian.com/lifeandstyle/rss", affinity: ["life", "culture"] },

  // ---- 먹거리 ----
  { name: "식품음료신문", url: "https://www.thinkfood.co.kr/rss/allArticle.xml", affinity: ["food", "product"] },
  { name: "Guardian Food", url: "https://www.theguardian.com/food/rss", affinity: ["food"] },
  { name: "Eater", url: "https://www.eater.com/rss/index.xml", affinity: ["food"] },

  // ---- 패션 ----
  { name: "보그 코리아", url: "https://www.vogue.co.kr/feed/", affinity: ["fashion"] },
  { name: "Guardian Fashion", url: "https://www.theguardian.com/fashion/rss", affinity: ["fashion"] },
  { name: "Hypebeast", url: "https://hypebeast.com/feed", affinity: ["fashion", "product"] },

  // ---- 여행 ----
  { name: "여행신문", url: "https://www.traveltimes.co.kr/rss/allArticle.xml", affinity: ["travel"] },
  { name: "트래비 매거진", url: "https://www.travie.com/rss/allArticle.xml", affinity: ["travel"] },
  { name: "Guardian Travel", url: "https://www.theguardian.com/travel/rss", affinity: ["travel"] },

  // ---- 문화/콘텐츠 ----
  { name: "Guardian Culture", url: "https://www.theguardian.com/culture/rss", affinity: ["culture", "content"] },
  { name: "한국경제 연예", url: "https://www.hankyung.com/feed/entertainment", affinity: ["content", "culture"] },
  { name: "Guardian Media", url: "https://www.theguardian.com/media/rss", affinity: ["content"] },
];
