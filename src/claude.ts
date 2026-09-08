// src/claude.ts
// 이 컴퓨터에 로그인된 Claude Code CLI를 호출해서 Threads 글 초안을 만듭니다.
// 중요(보안): 셸 문자열을 직접 조합하지 않고, spawn에 인자를 "배열"로 전달해서 명령어 삽입 위험을 막습니다.
// Claude에게 파일 수정이나 명령 실행 권한을 주지 않고, 오직 JSON 글 초안만 받습니다.

import { spawn } from "child_process";
import { PersonaData } from "./database";
import { config } from "./env";

export interface ClaudeCliStatus {
  available: boolean;
  version?: string;
  error?: string;
}

// claude --version 으로 설치/로그인 여부를 확인합니다.
export function checkClaudeCli(): Promise<ClaudeCliStatus> {
  // 문서(설명서) 캡처 전용 모드: 실제 CLI를 호출하지 않고 고정된 가상 연결 상태만 반환합니다.
  if (config.DOCS_MODE) {
    return Promise.resolve({ available: true, version: "(DOCS_MODE 가상 연결) Claude Code CLI" });
  }
  return new Promise((resolve) => {
    let settled = false;
    const proc = spawn(config.CLAUDE_BIN, ["--version"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve({ available: false, error: "claude --version 응답 시간 초과(10초)" });
      }
    }, 10000);

    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    // --version은 입력이 필요 없으므로, stdin을 열어둔 채 두지 않고 즉시 닫아 EOF를 알립니다
    // (열어두면 claude CLI가 "stdin 데이터를 기다렸다가 진행" 경고와 함께 불필요하게 지연됨).
    proc.stdin.on("error", () => {
      // 이미 종료된 프로세스에 stdin을 닫으려다 발생하는 EPIPE 등은 무시합니다(아래 close에서 판정).
    });
    proc.stdin.end();
    proc.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ available: false, error: `claude 명령을 찾을 수 없습니다: ${e.message}` });
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && out.trim()) {
        resolve({ available: true, version: out.trim() });
      } else {
        resolve({ available: false, error: err.trim() || `claude --version 종료 코드 ${code}` });
      }
    });
  });
}

export interface DraftFromClaude {
  title: string;
  hook: string;
  body: string;
  topic: string;
  source_title: string;
  source_url: string;
  source_summary: string;
  confidence: "high" | "medium" | "low";
  risk_notes: string;
}

export interface ClaudeInvocationDiagnostics {
  method: "stdin";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutChars: number;
  stderrChars: number;
}

export interface ClaudeGenerateResult {
  success: boolean;
  posts?: DraftFromClaude[];
  rawResponse?: string;
  error?: string;
  diagnostics?: ClaudeInvocationDiagnostics;
}

// source_backed: URL 또는 자동 수집 원문이 있어 사실 확인 근거가 있는 자료
// user_topic: 사용자가 입력한 주제/키워드만 있고 근거 URL이 없는 자료
export type FactBasis = "source_backed" | "user_topic";

export interface MaterialForPrompt {
  title: string;
  source_name?: string | null;
  source_url?: string | null;
  content?: string | null;
  sourceType?: string | null; // 'rss' | 'url' | 'text' | 'keyword'
  userKeywords?: string[] | null;
  note?: string | null; // 참고 설명 또는 관점
  factBasis?: FactBasis;
}

const TOPIC_DIRECTIONS = ["AI", "자동화", "생산성", "온라인 도구", "실제 사용 후기", "수익화 실험", "기술 변화"];

const SOURCE_TYPE_LABELS: Record<string, string> = {
  rss: "자동 수집(RSS)",
  url: "사용자 입력 URL",
  text: "사용자 직접 입력 텍스트",
  keyword: "사용자 제공 키워드/주제",
};

function resolveFactBasis(m: MaterialForPrompt): FactBasis {
  if (m.factBasis) return m.factBasis;
  return m.source_url ? "source_backed" : "user_topic";
}

export type PersonaStyleField = keyof PersonaData;

// P1.8: 사용자가 설정한 "내 글 스타일"(페르소나)을 프롬프트에 넣는 canonical 블록.
// 모든 생성 경로(일반/자료 기반/Trend/제휴/상품 레이더)가 이 한 곳을 공유해, 경로마다
// 다른 문장으로 스타일이 흐려지지 않게 한다. 항상 "생성 직전에 읽은 최신 값"을 받는다.
export function buildPersonaStyleBlock(persona: PersonaData, options?: { omit?: PersonaStyleField[] }): string {
  const omit = new Set(options?.omit ?? []);
  const lines: string[] = [];
  if (!omit.has("channel_identity")) lines.push(`- 채널 정체성: ${persona.channel_identity}`);
  if (!omit.has("audience")) lines.push(`- 독자층: ${persona.audience}`);
  if (!omit.has("tone_description")) lines.push(`- 말투 설명: ${persona.tone_description}`);
  if (!omit.has("common_phrases")) lines.push(`- 자주 쓰는 표현: ${persona.common_phrases}`);
  if (!omit.has("banned_phrases")) lines.push(`- 사용 금지 표현: ${persona.banned_phrases}`);
  if (!omit.has("length_preference")) lines.push(`- 글 길이 선호: ${persona.length_preference}`);
  if (!omit.has("emoji_level")) lines.push(`- 이모지 사용 정도: ${persona.emoji_level}`);
  if (!omit.has("allow_question_ending")) lines.push(`- 질문형 마무리 허용: ${persona.allow_question_ending ? "허용" : "비허용"}`);
  if (!omit.has("allow_external_links")) lines.push(`- 외부 링크 사용: ${persona.allow_external_links ? "허용(사용자가 선택한 경우만)" : "비허용"}`);
  return ["[채널 말투 설정]", ...lines].join("\n");
}

export function buildGenerationPrompt(materials: MaterialForPrompt[], persona: PersonaData, count: number): string {
  const materialsText =
    materials.length > 0
      ? materials
          .map((m, i) => {
            const factBasis = resolveFactBasis(m);
            const lines = [
              `${i + 1}. 제목: ${m.title}`,
              `   출처: ${m.source_name || "미상"}`,
              `   URL: ${m.source_url || "없음"}`,
              `   수집 방식: ${SOURCE_TYPE_LABELS[m.sourceType || ""] || "알 수 없음"}`,
            ];
            if (m.userKeywords && m.userKeywords.length > 0) lines.push(`   사용자 키워드: ${m.userKeywords.join(", ")}`);
            if (m.note) lines.push(`   참고 설명/관점: ${m.note}`);
            lines.push(`   사실 근거 수준: ${factBasis === "source_backed" ? "source_backed (원문 근거 있음 - 왜곡 금지, 장문 인용 금지)" : "user_topic (근거 URL 없음 - 사실/통계/사건 창작 금지, 경험·의견·질문·일반 조언 형태로만 작성)"}`);
            lines.push(`   내용요약: ${(m.content || "").slice(0, 2000)}`);
            return lines.join("\n");
          })
          .join("\n\n")
      : "(등록된 자료 없음 - 이번에는 일반적인 AI/자동화/생산성 관련 주제로, 과장 없이 신중하게 작성)";

  return `당신은 한국어 Threads(스레드) 채널 운영자를 돕는 콘텐츠 작가입니다.
아래 조건을 반드시 지켜서 Threads 게시글 초안 ${count}개를 JSON으로만 응답하세요. 설명이나 인사말, 코드블록 표시(\`\`\`) 없이 순수 JSON 객체 하나만 출력합니다.

${buildPersonaStyleBlock(persona)}

[기본 글 방향 - 아래 중에서 다양하게 섞어서 ${count}개를 만드세요]
${TOPIC_DIRECTIONS.map((t) => "- " + t).join("\n")}

[참고 자료 목록]
${materialsText}

[글 작성 원칙 - 반드시 준수]
1. 한국어로 작성한다.
2. 한 글에 하나의 핵심 주장만 담는다.
3. 첫 문장(hook)은 짧고 강하게 쓴다.
4. 확인되지 않은 수익이나 성공을 보장하는 표현을 쓰지 않는다.
5. 참고 자료가 직접 뒷받침하지 않는 숫자/통계는 절대 만들어내지 않는다.
6. 사실과 의견을 분명히 구분한다.
7. 참고 자료의 문장을 그대로 복사해서 재사용하지 않고 반드시 새로 표현한다.
8. 해시태그를 과도하게 달지 않는다(0~2개 이내 권장).
9. 외부 링크는 persona 설정에서 허용한 경우에만, 그리고 실제 참고 자료 URL이 있을 때만 포함한다.
10. 본문 길이는 200~450자를 기본으로 하되 persona의 길이 선호를 반영한다.
11. source_title/source_url/source_summary는 위 [참고 자료 목록]에 실제로 있는 항목을 근거로 채운다. 근거가 부실하면 confidence를 "low"로 낮추고 risk_notes에 사실 확인이 필요하다고 명시한다.
12. 자료의 "사실 근거 수준"이 source_backed인 경우: 원문 내용을 왜곡하지 않고, 원문 문장을 그대로 길게 인용/복사하지 않는다.
13. 자료의 "사실 근거 수준"이 user_topic인 경우: 확인되지 않은 사실, 통계, 정책, 최신 사건을 만들어내지 않는다. 경험, 의견, 질문, 일반적인 조언 형태로만 작성한다.
14. 여러 자료의 내용이 서로 충돌하면 어느 한쪽이 맞다고 단정하지 않는다.
15. 위 [참고 자료 목록]에 없는 자료(선택되지 않은 자료)는 절대 사용하지 않는다.
16. 광고, 과장, 수익을 보장하는 듯한 표현을 임의로 넣지 않는다.
17. 되묻지 않는다. 질문, 확인 요청, 제안, 거절, 사과 등 어떤 형태의 대화문도 출력하지 않는다.
18. 참고 자료가 위 [기본 글 방향]과 잘 맞지 않더라도 작업을 중단하지 않는다. 그럴 때는 자료를
    억지로 채널 주제에 끼워 맞추지 말고, 자료가 실제로 말하는 내용 그대로를 소재로 삼아
    말투 설정만 지켜서 쓴다. 확신이 약하면 confidence를 "low"로 낮추고 risk_notes에 이유를 적는다.

[출력 형식 - 이 JSON 스키마를 정확히 따르세요]
{
  "posts": [
    {
      "title": "관리용 제목(내부 식별용, 짧게)",
      "hook": "첫 문장",
      "body": "Threads 본문 전체",
      "topic": "위 글 방향 중 하나",
      "source_title": "참고 자료 제목",
      "source_url": "원문 URL 또는 빈 문자열",
      "source_summary": "이 글의 근거가 된 요약",
      "confidence": "high 또는 medium 또는 low",
      "risk_notes": "과장/사실확인 관련 주의사항. 없으면 빈 문자열"
    }
  ]
}

posts 배열에는 정확히 ${count}개의 서로 다른 글을 담으세요.

[출력 규칙 - 위반 시 응답 전체가 버려집니다]
- 위 스키마의 JSON 객체 하나만 출력합니다.
- JSON 앞뒤에 설명, 인사말, 요약, 질문, 사과를 붙이지 않습니다.
- 마크다운 코드블록 표시(\`\`\`, \`\`\`json)를 사용하지 않습니다.
- posts 항목 수는 정확히 ${count}개이며, 각 항목은 위 9개 필드를 모두 포함합니다.
- body는 절대 비워 두지 않습니다.`;
}

// application schema(Threads posts, 상품 레이더 recommendation 등)와 무관한 raw Claude CLI
// invocation 결과. success는 오직 "CLI process invocation 자체가 정상 완료되고 raw stdout을
// 얻었는가"만 의미한다 - application JSON이 어떤 스키마인지, 그 안에 posts가 있는지 products가
// 있는지는 이 레이어의 관심사가 아니다. success:false는 CLI 없음/spawn 실패/timeout/non-zero
// exit/signal 종료 같은 execution 실패만을 뜻한다(상품 레이더 Phase 12.3 조사에서, 기존
// runClaudePrompt()가 이 execution 성공 여부와 "posts 스키마 매칭 성공 여부"를 하나의 success
// 필드에 합쳐놓아, products 스키마의 정상 응답이 posts가 없다는 이유만으로 success:false가
// 되는 문제가 발견되어 이 레이어를 분리했다).
export interface ClaudeRawPromptResult {
  success: boolean;
  rawResponse?: string;
  error?: string;
  diagnostics?: ClaudeInvocationDiagnostics;
}

// claude -p 를 비대화형 모드로 호출합니다. 인자는 항상 배열로 전달합니다(셸 인젝션 방지).
//
// 프롬프트는 -p 인자에 직접 넣지 않고 반드시 stdin으로만 전달합니다(두 방식을 혼용하지 않음).
// 실제 Windows PC에서 프롬프트를 -p 인자로 넘겼을 때 stderr에 "Warning: no stdin data received
// in 3s, proceeding without it"가 찍히고, 뒤이어 claude가 도구 사용(Write)을 시도했다가 권한이
// 거부되어 max_turns를 초과해 실패하는 것이 실제로 관측되었습니다. claude를 npm으로 설치하면
// .cmd 셸 스크립트가 되어 shell:false로 spawn해도 내부적으로 cmd.exe를 거치며 명령행 길이
// 제한(약 8,191자)에 걸릴 수도 있습니다 - 자료 여러 건이 포함된 프롬프트는 이 제한을 쉽게
// 넘습니다. 두 문제 모두, 프롬프트를 명령행 인자가 아니라 길이 제한이 사실상 없는 stdin으로
// 전달하고, spawn 직후 즉시 쓰고 곧바로 닫아(EOF) claude가 "혹시 더 들어올 입력"을 기다리지
// 않게 하면 재현되지 않습니다. stdin.end(prompt)는 "쓰기 + 닫기"를 한 번의 호출로 처리하므로
// 이 함수 안에서 stdin.end()가 정확히 한 번만 호출됨이 보장됩니다.
//
// generateDraftsWithClaude(일반 자료 기반 생성)와 쿠파스 상품 홍보 모드(src/affiliatePromo.ts),
// 그리고 상품 레이더 Recommendation(src/productRadar/recommendationClaude.ts)이 완성된 프롬프트
// 문자열 하나만 다르게 만들고, 그 문자열을 실제로 claude CLI에 전달하는 아래 spawn/stdin/timeout
// 로직은 이 함수 하나만 공유합니다(spawn 중복 없음, single source).
// 글 생성이 실패했을 때 구매자 화면에 보이는 유일한 문장이다. 내부 원인(종료 코드/파싱/
// 타임아웃)은 실패 로그 파일에만 남기고, 여기서는 지금 할 수 있는 행동만 말한다.
export const CLAUDE_BUYER_FAILURE_MESSAGE =
  "글을 만들지 못했습니다. 잠시 후 다시 시도하거나, 다른 자료를 선택해 주세요.";

export function runClaudeRawPrompt(prompt: string): Promise<ClaudeRawPromptResult> {
  return new Promise((resolve) => {
    // 실제 Windows 환경에서 재시험하는 과정에서, stdin 수정 이후에도 stop_reason:"tool_use" +
    // terminal_reason:"max_turns"로 실패하는 경우가 관측되었습니다(Claude가 최종 JSON을 답하기
    // 전에 내부적으로 한 턴을 더 필요로 함 - 파일 쓰기 등 실제 도구 실행 권한을 준 것은 아니며,
    // 여전히 파일 수정/명령 실행 권한은 주지 않습니다). --max-turns를 1 → 2로 늘려 이 여유 턴을
    // 확보한 뒤 재시험에서 정상적으로 JSON 초안을 받는 것을 확인했습니다.
    // CLAUDE_ARGS_PREFIX는 테스트에서만 쓰이는 값으로, 운영에서는 항상 빈 배열입니다.
    //
    // --tools "" : Claude Code의 built-in 도구를 전부 끕니다.
    //   실제 구매자 PC(Fresh Install)에서 CLI 2.1.226이 초안 본문을 다 만든 뒤에도
    //   "글자 수를 세겠다"며 Bash 도구를 호출하려 했고(cat > /tmp/... + wc -m), 앱이 권한을
    //   거부하자 다시 시도하다 --max-turns 2를 소진해 exit 1로 끝났습니다(3회/3회 재현,
    //   subtype=error_max_turns / stop_reason=tool_use / permission_denials=[Bash]).
    //   이 함수의 호출자는 넷 다 "완성된 프롬프트를 주고 텍스트/JSON 응답만 받는" 순수
    //   completion이라 도구가 필요 없습니다(claude.ts / recommendationClaude.ts /
    //   threadsCopyClaude.ts 등).
    //   --allowedTools는 "허용(자동 승인) 목록"이라 도구를 끄는 용도가 아닙니다. 도구를 끄는
    //   공식 방법은 CLI --help가 명시한 --tools "" 뿐입니다.
    //   synthetic 재현: 적용 전 exit 1 / turns 3 / permission_denials=[Bash],
    //                   적용 후 exit 0 / turns 1 / denials 0 / JSON 정상.
    //   spawn 인자 배열로 두 개의 인자("--tools", "")를 넘깁니다(셸 문자열 조립 없음).
    //
    // --strict-mcp-config : 사용자/프로젝트에 설정된 MCP 서버를 이 호출에 전혀 로드하지 않습니다.
    //   --tools ""는 CLI --help가 명시하듯 "the built-in set"만 제어합니다. MCP 서버 도구는
    //   별도 경로로 실려서 그대로 남고, 실제로 이 PC(headroom MCP 설치)에서 모델이
    //   mcp__headroom__headroom_compress를 호출하려다 거부되고 --max-turns 2를 소진해
    //   exit 1로 죽는 일이 재발했습니다(3회 중 1회, subtype=error_max_turns / stop_reason=tool_use
    //   / permission_denials=[mcp__headroom__…]). --tools ""만으로는 P0가 완전히 닫히지 않습니다.
    //   --strict-mcp-config는 "--mcp-config로 준 MCP 서버만 쓰고 나머지 MCP 설정은 전부 무시"라
    //   --mcp-config를 주지 않는 이 호출에서는 MCP 서버가 0개가 됩니다. 사용자의 MCP 설정 파일은
    //   읽지도 바꾸지도 않습니다(이 호출에만 적용).
    //   실측: 추가 후 동일 프롬프트 5/5 exit 0 / turns 1 / denials 0.
    const args = [
      ...config.CLAUDE_ARGS_PREFIX,
      "-p",
      "--output-format",
      "json",
      "--max-turns",
      "2",
      "--tools",
      "",
      "--strict-mcp-config",
    ];

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const proc = spawn(config.CLAUDE_BIN, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let stdinError: Error | null = null;

    const finish = (result: ClaudeRawPromptResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // 실제 자료(최대 8개, 최대 15,000자)를 넣고 글 6개를 생성해보면 120초를 넘기는 경우가
    // 실제로 관측되어(도구 사용 등 없이 정상적으로 응답 생성 중이었음, exit=null/SIGTERM으로 확인)
    // 240초로 늘렸습니다.
    timer = setTimeout(() => {
      proc.kill();
      finish({ success: false, error: "claude 응답 시간 초과(240초)" });
    }, 240000);

    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));

    // 프로세스 자체를 아예 못 띄운 경우(예: claude 명령을 찾을 수 없음).
    proc.on("error", (e) => {
      finish({ success: false, error: `claude CLI 실행 실패: ${e.message}` });
    });

    // stdin 파이프 오류(EPIPE 등 - CLI가 이미 종료돼서 더 이상 stdin을 읽지 않을 때 발생)를
    // 리스너 없이 두면 Node가 이 오류를 그대로 던져 서버 프로세스 전체가 죽습니다. 여기서는
    // 곧바로 실패를 확정하지 않고(정상 종료와 동시에 발생할 수 있으므로) close 핸들러의 exit
    // code 판정에 참고 정보로만 넘깁니다.
    proc.stdin.on("error", (e) => {
      stdinError = e;
    });

    proc.on("close", (code, signal) => {
      // 로그에는 실행 방식/종료 코드/글자 수만 남기고, 라이선스 키·토큰이 섞일 수 있는 전체
      // 프롬프트나 stdout 원문은 여기서 출력하지 않습니다(원문은 실패 시 파일로 별도 저장됨).
      console.log(`[claude] 실행 방식=stdin, exit=${code ?? "null"}, signal=${signal ?? "none"}, stdout=${out.length}자, stderr=${err.length}자`);

      const diagnostics: ClaudeInvocationDiagnostics = {
        method: "stdin",
        exitCode: code,
        signal,
        stdoutChars: out.length,
        stderrChars: err.length,
      };

      // exit code가 0이 아니면 무조건 실패로 처리합니다. stderr에 실질적인 오류 메시지가 없으면
      // (예: 위 stdin 오류만 있는 경우) 그 정보를 대신 사용합니다. raw stdout(out)은 실패 시에도
      // 참고용으로 그대로 반환합니다 - application 레이어가 다시 해석하지는 않지만 진단에는 쓸 수
      // 있습니다.
      if (code !== 0) {
        const reason = err.trim() || (stdinError ? `stdin 오류: ${stdinError.message}` : `claude 종료 코드 ${code}`);
        finish({ success: false, error: reason, rawResponse: out, diagnostics });
        return;
      }

      // exit code가 0이면, stderr에 경고 문구가 섞여 있어도(예: 과거 "no stdin data received"
      // 경고) 실패로 취급하지 않습니다. raw invocation은 여기서 성공으로 확정합니다 - stdout이
      // 어떤 application 스키마인지는 이 레이어가 판단하지 않습니다.
      finish({ success: true, rawResponse: out, diagnostics });
    });

    // 프롬프트를 stdin으로 즉시 쓰고 곧바로 닫습니다. -p 인자에는 프롬프트를 절대 함께 넣지 않습니다.
    proc.stdin.end(prompt);
  });
}

// 기존 runClaudePrompt() 외부 signature/반환 contract는 그대로 유지합니다(Threads 초안 생성
// 코드와 테스트를 한 글자도 건드리지 않기 위함) - 내부적으로는 이제 runClaudeRawPrompt()에
// process invocation을 위임하고, 이 함수는 그 결과에 기존 posts 파싱(extractPostsJson)만
// 덧씌웁니다. observable behavior(에러 메시지/rawResponse/diagnostics/실패 판정 순서)는
// 리팩터 전과 동일합니다.
export function runClaudePrompt(prompt: string): Promise<ClaudeGenerateResult> {
  return runClaudeRawPrompt(prompt).then((raw) => {
    // raw.rawResponse/raw.diagnostics를 항상 명시적으로 넣지 않고, 원래 값이 있을 때만
    // key 자체를 포함합니다 - 리팩터 전 각 finish() 호출이 만들던 object literal의 key
    // 존재 여부(예: timeout/spawn 실패 시 rawResponse/diagnostics key 자체가 없었음)를
    // 그대로 재현하기 위함입니다(Object.keys()/hasOwnProperty 기반 검사가 있다면 그 결과도
    // 리팩터 전후 동일하게 유지됩니다).
    if (!raw.success) {
      return {
        success: false,
        // CLI 실행 자체가 실패한 경우(exit code/timeout/spawn 실패)에도 구매자에게는 아래 파싱
        // 실패 경로와 똑같은 문장만 보여준다. 예전에는 raw.error("claude 종료 코드 1")가 그대로
        // 화면까지 올라가 구매자가 종료 코드를 읽는 상황이 실제로 발생했다(Fresh Install QA).
        // 원인은 rawResponse(=CLI가 낸 JSON. subtype/errors/permission_denials 포함)와
        // diagnostics(exit code 등)에 그대로 남아 실패 로그 파일에 기록된다.
        error: CLAUDE_BUYER_FAILURE_MESSAGE,
        ...(raw.rawResponse !== undefined ? { rawResponse: raw.rawResponse } : {}),
        ...(raw.diagnostics !== undefined ? { diagnostics: raw.diagnostics } : {}),
      };
    }

    const posts = extractPostsJson(raw.rawResponse || "");
    if (!posts || posts.length === 0) {
      return {
        success: false,
        // 구매자 화면에 그대로 보이는 문장이다. 내부 원인(응답 형식/파싱)은 실패 로그 파일에만
        // 남기고, 여기서는 사용자가 지금 할 수 있는 행동만 말한다.
        error: CLAUDE_BUYER_FAILURE_MESSAGE,
        ...(raw.rawResponse !== undefined ? { rawResponse: raw.rawResponse } : {}),
        ...(raw.diagnostics !== undefined ? { diagnostics: raw.diagnostics } : {}),
      };
    }

    return {
      success: true,
      posts,
      ...(raw.rawResponse !== undefined ? { rawResponse: raw.rawResponse } : {}),
      ...(raw.diagnostics !== undefined ? { diagnostics: raw.diagnostics } : {}),
    };
  });
}

// 일반 자료 기반 글 생성(기존 동작 그대로). 프롬프트만 만들고 실행은 runClaudePrompt에 위임합니다.
export function generateDraftsWithClaude(materials: MaterialForPrompt[], persona: PersonaData, count = 6): Promise<ClaudeGenerateResult> {
  const prompt = buildGenerationPrompt(materials, persona, count);
  return runClaudePrompt(prompt);
}

// claude -p --output-format json 은 { "type": "result", "result": "...실제 텍스트..." } 형태로 감싸서 응답하는 경우가 많습니다.
// 이 함수는 그 바깥 포장을 벗기고, 우리가 요청한 { "posts": [...] } 형태의 JSON을 최대한 안전하게 뽑아냅니다.
// 테스트에서 가짜 응답을 넣어 검증할 수 있도록 export 합니다.
// 모델이 습관적으로 붙이는 마크다운 코드블록 표시만 벗긴다. 내용은 한 글자도 바꾸지 않으며,
// 펜스가 없으면 원문 그대로 돌려준다(깨진 JSON을 추측해서 고치는 일은 하지 않는다).
export function stripCodeFence(text: string): string {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

export function extractPostsJson(raw: string): DraftFromClaude[] | null {
  const tryParsePostsFrom = (rawText: string): DraftFromClaude[] | null => {
    const text = stripCodeFence(rawText);
    try {
      const data = JSON.parse(text);
      if (data && Array.isArray(data.posts)) return data.posts as DraftFromClaude[];
    } catch {
      // 순수 JSON이 아니면 본문 중 첫 { 부터 마지막 } 까지를 잘라서 다시 시도.
      // 여기서 성공하지 못하면 그대로 실패다 - 잘린 JSON을 이어붙이거나 빠진 필드를
      // 채워 넣지 않는다(구조적으로 유효하지 않으면 실패로 남겨야 한다).
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const data = JSON.parse(match[0]);
          if (data && Array.isArray(data.posts)) return data.posts as DraftFromClaude[];
        } catch {
          return null;
        }
      }
    }
    return null;
  };

  // 1) claude CLI의 outer JSON 포장을 먼저 시도
  try {
    const outer = JSON.parse(raw);
    if (outer && typeof outer === "object") {
      const inner = typeof outer.result === "string" ? outer.result : raw;
      const fromInner = tryParsePostsFrom(inner);
      if (fromInner) return fromInner;
      // outer 자체가 이미 {posts:[...]} 형태일 수도 있음
      if (Array.isArray((outer as any).posts)) return (outer as any).posts;
    }
  } catch {
    // outer가 JSON이 아니면 raw 자체에서 바로 시도
  }

  return tryParsePostsFrom(raw);
}
