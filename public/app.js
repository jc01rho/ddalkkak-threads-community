// public/app.js
// 순수 바닐라 JavaScript. 프레임워크 없이 fetch()로 백엔드 API를 호출합니다.

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

// meta는 선택적 out-param입니다(기존 호출부는 2개 인자만 넘기므로 반환값/동작이 전혀
// 바뀌지 않습니다). 호출자가 빈 객체를 넘기면 HTTP status를 담아 돌려줍니다 - 응답 body의
// domain error code만으로는 구분할 수 없는 "HTTP status까지 확인해야 하는" 판정(예:
// productRadar.js의 known transient 생성 실패 1회 자동 재시도)에서만 씁니다.
async function api(path, options, meta) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok && data && data.error === undefined) data.error = "요청 실패 (HTTP " + res.status + ")";
  if (meta) meta.status = res.status;
  return data;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------- P1.6(AUD-P1-002): 외부 URL 열기 공통 helper ----------------
// 수집된(외부가 통제하는) URL은 절대 inline onclick의 JS 문자열/HTML attribute에 삽입하지
// 않는다 - 카드에는 data-* id만 남기고, 리스너가 원본 객체에서 URL을 읽어 이 helper로 연다.
// 열기 직전에 scheme을 검증해 http/https만 허용한다(javascript:/data:/file: 등 전부 차단).
// Community Threads 연결 설명서 공식 게시 주소. 여기 한 곳에서만 정의한다
// (다른 JS/HTML 파일에 중복 하드코딩하지 않는다).
const THREADS_CONNECTION_GUIDE_URL = "https://pulse-audio.co.kr/pages/ddalkkak-threads-connect.html";

function isAllowedExternalUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function openExternalHttpUrl(raw) {
  if (!isAllowedExternalUrl(raw)) return false;
  window.open(String(raw), "_blank", "noopener,noreferrer");
  return true;
}

// Asia/Seoul 시간대와 UTC 저장 로직은 그대로 두고, 표시 형식만 현재 화면 언어에 맞춥니다.
function fmtDate(iso) {
  if (!iso) return "-";
  try {
    const lang = currentLang();
    const locale = lang === "ko" ? "ko-KR" : "en-US";
    return new Intl.DateTimeFormat(locale, {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: lang === "ko" ? "numeric" : "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// 발행 예정 시각 표시용 - 초 단위는 의미가 없어 빼고 분까지만 보여 줍니다.
// 저장 값(UTC ISO)과 예약 API는 그대로이고 표시 형식만 다릅니다.
function fmtDateMinute(iso) {
  if (!iso) return "-";
  try {
    const lang = currentLang();
    return new Intl.DateTimeFormat(lang === "ko" ? "ko-KR" : "en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: lang === "ko" ? "numeric" : "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// UTC ISO 문자열을 <input type="datetime-local">에 넣을 수 있는 "Asia/Seoul 기준" 값("YYYY-MM-DDTHH:mm")으로 변환합니다.
function toSeoulDatetimeLocalValue(iso) {
  if (!iso) return "";
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(new Date(iso)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return "";
  }
}

// ---------------- 네비게이션 ----------------
function initNav() {
  $all(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => showView(btn.dataset.view));
  });
  // 상단 상태바 로고와 사이드바 상단 로고 둘 다 누르면 대시보드로 이동합니다(상태 배지는 별도
  // 요소라 클릭 영역에 포함되지 않음). <button>이라 Tab 이동과 Enter 입력으로도 동일하게 동작하고,
  // 새로고침/서버 재시작 없이 기존 showView() SPA 전환을 그대로 사용합니다.
  // P1.3: 브랜드/로고 클릭은 v1.1 시작/메인 화면으로 복귀한다(대시보드 경로 0개 정책 유지).
  $("#brandHomeBtn").addEventListener("click", () => showView("home"));
  $("#sidebarBrandBtn")?.addEventListener("click", () => showView("home"));
  // .qa-btn: data-view 속성으로 이동할 화면을 지정하는 범용 이동 버튼입니다(기존 nav-item과
  // 동일한 방식) - 예: "+ 스마트 에디터", 스마트 에디터 안의 "자료 수집 화면에서 자료 선택하기".
  // data-goto-subtab이 있으면 예약 관리 화면 진입 후 해당 서브탭까지 바로 전환합니다(현재
  // 사용하는 버튼은 없지만, 특정 서브탭으로 바로 이동하는 진입점이 다시 필요해지면 재사용 가능).
  $all(".qa-btn[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      showView(btn.dataset.view);
      if (btn.dataset.gotoSubtab) switchSchedMgmtTab(btn.dataset.gotoSubtab);
    });
  });
}

function showView(name) {
  // P1.1: 구매자가 dashboard 화면으로 이동할 수 있는 경로는 0개다. 과거 저장값/legacy 호출이
  // dashboard를 넘겨도 메인 화면으로 sanitize한다(대시보드 DOM/집계 API는 상단 상태바용으로만 존치).
  if (name === "dashboard") name = "home"; // P1.3: legacy dashboard 목적지는 메인 화면으로
  $all(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $all(".view").forEach((v) => v.classList.remove("active"));
  const el = $("#view-" + name);
  if (el) el.classList.add("active");
  closeSidebar(); // 좁은 화면에서 메뉴 이동 시 사이드바를 자동으로 닫습니다(데스크톱에서는 영향 없음).
  // 예약 관리를 벗어나면 자동 갱신을 즉시 멈춘다(다른 화면에서 background 요청 0).
  if (name !== "schedulemgmt") stopSchedMgmtAutoRefresh();
  // P0.5: 설정 화면을 벗어나면 Threads OAuth 상태 폴링도 멈춘다(서버 세션은 계속 진행되며
  // 다시 들어오면 loadThreadsSettings가 현재 상태를 읽어 폴링을 재개한다).
  if (name !== "settings") stopThreadsOAuthStatusPolling();

  if (name === "dashboard") loadDashboard();
  if (name === "editor") loadEditorView();
  if (name === "collect") loadCollectView();
  if (name === "materials") loadMaterials();

  if (name === "schedulemgmt") {
    // P2.0(19): 자동배치 미리보기는 "지금 계산한 결과"라서 화면을 떠났다 돌아오면 근거가
    // 사라진다. 재진입 시 항상 닫고, 새로 [예약 루틴으로 자동배치]를 눌렀을 때만 다시 연다.
    cancelBatchPreview();
    loadScheduleRoutine(); loadApprovedSelectionList(); loadSchedule(); loadPublishLog();
    startSchedMgmtAutoRefresh(); // 화면이 열려 있는 동안만 30초마다 두 목록을 다시 읽는다
  }
  if (name === "settings") loadSettingsView();
}

// P1.4: 사이드바 NEXT 점등 시스템(P1~P1.2의 workflow next localStorage 상태)은
// 제거됐다. 원칙: "사이드바는 메뉴판, 화면 안 버튼이 길 안내" - 다음 단계는 각 화면의
// CTA([자료 보관함에서 보기 →], [초안 확인 →] 등)가 담당한다. 기존 사용자 브라우저에
// 옛 key 값이 남아 있어도 어디서도 읽지 않으므로 무해하다(migration 불필요).

// ---------------- P1.2 공통: 콘텐츠 생성 → 초안함 자동 저장 성공 UX ----------------
// 출발점(상품 레이더/스마트 에디터/자료 보관함) 공통 계약:
// 생성+draft DB 저장까지 성공 → 현재 화면 유지 + 성공 문구 + [초안 확인 →] CTA.
// CTA는 저장 버튼이 아니라 "이동 전용"이다(글은 이미 초안함에 있다).
// 생성 실패도 성공과 같은 자리(각 화면의 상태 영역)에 남긴다. 예전에는 blocking alert로
// 띄우면서 서버가 준 원문(예: "claude 종료 코드 1")까지 붙여 보여줬는데, 구매자에게는
// 종료 코드가 아무 의미가 없고 화면까지 멈춘다. 서버는 이제 항상 구매자용 문장만 주므로
// 여기서는 그 문장을 그대로 보여주고, 화면은 그대로 두어 바로 다시 시도할 수 있게 한다.
function showGenerateFailure(containerEl, r) {
  if (!containerEl) return;
  // 서버가 주는 구매자 문구에 이미 "잠시 후 다시 시도" 안내가 들어 있다. canRetry는 서버가
  // 계속 내려주는 계약이지만, 같은 말을 두 번 붙이지 않는다(문구가 없을 때만 보완한다).
  const message = (r && r.error) || t("errUnknown");
  const needsHint = !!(r && r.canRetry) && !/다시 시도|try again/i.test(message);
  containerEl.innerHTML = "";
  const msg = document.createElement("span");
  msg.className = "gen-error";
  msg.textContent = needsHint ? message + " " + t("retryInlineHint") : message;
  containerEl.appendChild(msg);
}

function showDraftsSavedCta(containerEl, count) {
  if (!containerEl) return;
  containerEl.innerHTML = "";
  const msg = document.createElement("span");
  msg.textContent = "✓ " + (count === 1 ? t("draftSavedOne") : t("draftSavedMany", { n: count }));
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "next-cta";
  btn.textContent = t("btnViewDrafts");
  btn.addEventListener("click", () => {
    // P1.3: CTA의 목적은 "방금 만든 초안 확인" - 필터를 전체로 복원해 신규 draft(검토중)가
    // 반드시 보이게 한다(사용자가 다른 필터를 봐 두었더라도 이 명시적 진입에서는 예측 가능성이 우선).
    draftStatusFilterValue = "";
    renderDraftFilterChips();
    showView("drafts");
  });
  containerEl.appendChild(msg);
  containerEl.appendChild(document.createTextNode(" "));
  containerEl.appendChild(btn);
}
// ---------------- 스마트 에디터 탭 (일반 글 작성 / 제휴 마케팅) ----------------
function initEditorTabs() {
  $all(".editor-tab[data-editor-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchEditorTab(btn.dataset.editorTab));
  });
}
function switchEditorTab(name) {
  $all(".editor-tab[data-editor-tab]").forEach((b) => b.classList.toggle("active", b.dataset.editorTab === name));
  $all(".editor-panel[data-editor-panel]").forEach((p) => p.classList.toggle("active", p.dataset.editorPanel === name));
  // 탭을 바꾸면 이전 탭에서 만든 성공/실패 안내가 따라오지 않게 한다(요청서 E절).
  clearEditorTransientState();
  if (name === "affiliate") loadAffiliateView();
}

// ---------------- 예약 관리 서브탭 (예약 루틴 설정 / 승인 글 자동배치 / 예약된 글 / 발행 기록) ----------------
function initSchedMgmtTabs() {
  $all(".editor-tab[data-schedmgmt-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchSchedMgmtTab(btn.dataset.schedmgmtTab));
  });
}
function switchSchedMgmtTab(name) {
  $all(".editor-tab[data-schedmgmt-tab]").forEach((b) => b.classList.toggle("active", b.dataset.schedmgmtTab === name));
  $all(".editor-panel[data-schedmgmt-panel]").forEach((p) => p.classList.toggle("active", p.dataset.schedmgmtPanel === name));
}

// ---------------- 좁은 화면 사이드바 열기/닫기 ----------------
function openSidebar() {
  $("#sideNav")?.classList.add("open");
  $("#sidebarBackdrop")?.classList.add("show");
  $("#mobileSidebarToggle")?.setAttribute("aria-expanded", "true");
}
function closeSidebar() {
  $("#sideNav")?.classList.remove("open");
  $("#sidebarBackdrop")?.classList.remove("show");
  $("#mobileSidebarToggle")?.setAttribute("aria-expanded", "false");
}
function initSidebarToggle() {
  $("#mobileSidebarToggle")?.addEventListener("click", () => {
    if ($("#sideNav").classList.contains("open")) closeSidebar(); else openSidebar();
  });
  $("#sidebarBackdrop")?.addEventListener("click", closeSidebar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("#sideNav")?.classList.contains("open")) closeSidebar();
  });
}

// 상태바는 배지가 줄바꿈되면 높이가 바뀔 수 있어(좁은 화면 등), 실제 렌더링된 높이를 측정해
// --topbar-height CSS 변수에 반영합니다. 사이드바/본문 영역이 항상 상태바 아래부터 정확히
// 시작하고, 본문만 독립적으로 스크롤되도록 하기 위함입니다.
function initTopbarHeightSync() {
  const bar = $("#statusBar");
  if (!bar) return;
  const sync = () => document.documentElement.style.setProperty("--topbar-height", bar.getBoundingClientRect().height + "px");
  sync();
  if (window.ResizeObserver) new ResizeObserver(sync).observe(bar);
  else window.addEventListener("resize", sync);
}

// ---------------- 화면 테마 (자동/라이트/다크) ----------------
const THEME_STORAGE_KEY = "ttalkkak_theme_pref";

function resolveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function getThemePref() {
  try { return localStorage.getItem(THEME_STORAGE_KEY) || "auto"; } catch { return "auto"; }
}
function applyTheme(pref) {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}
function setThemePref(pref) {
  try { localStorage.setItem(THEME_STORAGE_KEY, pref); } catch { /* 저장 실패 시 이번 세션에서만 적용됩니다 */ }
  applyTheme(pref);
}
function initTheme() {
  const pref = getThemePref();
  applyTheme(pref);
  $all('input[name="themeChoice"]').forEach((r) => {
    r.checked = r.value === pref;
    r.addEventListener("change", (e) => { if (e.target.checked) setThemePref(e.target.value); });
  });
  // "자동" 선택 상태에서 OS 테마가 바뀌면 새로고침 없이 즉시 반영합니다.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (getThemePref() === "auto") applyTheme("auto");
    });
  }
}

// ---------------- 화면 언어 (자동/한국어/English) ----------------
// i18n.js(app.js보다 먼저 로드됨)가 제공하는 I18N/t()/currentLang()/i18nApplyLangAttr() 등을 사용합니다.
function translateStaticDom(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.getAttribute("data-i18n")); });
  scope.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.getAttribute("data-i18n-placeholder")); });
  scope.querySelectorAll("[data-i18n-aria-label]").forEach((el) => { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label"))); });
  scope.querySelectorAll("[data-i18n-weekday]").forEach((el) => { el.textContent = tWeekdayShort(parseInt(el.getAttribute("data-i18n-weekday"), 10)); });
  document.title = t("pageTitle");
}

// 언어를 바꾼 뒤, 현재 화면에 이미 그려진 동적 콘텐츠(카드/목록/모달 등)도 다시 그려 새 언어를
// 즉시 반영합니다. 현재 화면·탭·스크롤 위치는 그대로 두고(showView를 호출하지 않음) 데이터만 다시 불러옵니다.
function refreshDynamicContentForLanguage() {
  loadDashboard();
  renderDraftFilterChips(); // P1.3: 언어 변경 시 filter chip 문구 갱신(선택 상태 유지)
  const activeView = document.querySelector(".view.active");
  const name = activeView ? activeView.id.replace("view-", "") : "";
  if (name === "editor") loadAffiliateView();
  if (name === "collect") { loadCollectView(); }
  if (name === "materials") loadMaterials();
  if (name === "drafts") loadDrafts();
  if (name === "schedulemgmt") { loadScheduleRoutine(); loadApprovedSelectionList(); loadSchedule(); loadPublishLog(); loadDashboard(); }
  // 설정 화면에 들어올 때도 자동 발행 카드를 서버 값으로 맞춘다.
  if (name === "settings") loadDashboard();
  if (name === "settings") loadSettingsView();
}

function applyLanguage(lang) {
  i18nApplyLangAttr(lang);
  translateStaticDom(document);
  refreshDynamicContentForLanguage();
}

function initLanguage() {
  const pref = i18nGetPref();
  const lang = i18nResolveLanguage(pref);
  i18nApplyLangAttr(lang); // <head>의 인라인 스크립트가 이미 적용했지만, 동일 로직으로 다시 한번 정확히 동기화합니다.
  translateStaticDom(document);
  $all('input[name="languageChoice"]').forEach((r) => {
    r.checked = r.value === pref;
    r.addEventListener("change", (e) => {
      if (!e.target.checked) return;
      i18nSetPref(e.target.value);
      applyLanguage(i18nResolveLanguage(e.target.value));
    });
  });
}

// ---------------- 상단 상태바 + 대시보드 ----------------
// /api/status 응답을 세 가지로 분류하는 순수 함수입니다(test-runner가 직접 검증).
// - "license_rejected": HTTP 403 + { success:false, error, code } 형태의 거절 응답.
//   이 body를 정상 dashboard로 렌더링하면 안 됩니다.
// - "ok": 정상 dashboard payload(claude/threads 필드가 실제 존재).
// - "load_failed": 그 외 전부(네트워크로 body가 null, 500 등). 기존 "상태를 불러오지
//   못했습니다" 경로를 그대로 유지합니다.
function classifyDashboardStatusResponse(httpStatus, body) {
  if (httpStatus === 403 && body && body.success === false) return "license_rejected";
  if (body && body.claude && body.threads) return "ok";
  return "load_failed";
}

async function loadDashboard() {
  const meta = {};
  const s = await api("/status", undefined, meta);
  const kind = classifyDashboardStatusResponse(meta.status, s);

  const body = $("#dashboardBody");
  // dashboard payload가 아닌 응답(403 거절 body, 500, 네트워크 실패 등)은 절대 dashboard로
  // 렌더링하지 않고 기존 "상태를 불러오지 못했습니다" 경로로 보냅니다.
  if (kind !== "ok") {
    renderStatusBar(null); // 기존 !s 경로와 동일하게 상태바는 건드리지 않음(내부에서 no-op)
    body.textContent = t("statusLoadFailed");
    return;
  }

  renderStatusBar(s);
  // P1.6: 예약 관리의 자동 발행 조작 카드 + 미디어 발행 구성 안내도 같은 /api/status 주기로 갱신.
  mediaPublishConfigured = typeof s.mediaPublishConfigured === "boolean" ? s.mediaPublishConfigured : null;
  renderAutoPublishControl(s);
  renderMediaPublishPreflightNote();

  // 표현만 카드 4개로 나눕니다(연결 상태 / 오늘 작업 현황 / 발행 상태 / 다음 예약) -
  // /api/status 응답 필드와 계산 방식은 기존과 완전히 동일합니다.
  body.innerHTML = `
    <div class="dashboard-cards">
      <div class="dash-card">
        <h4>${t("dashCardConnection")}</h4>
        <div class="kv">
          <div>${t("labelClaudeCode")}</div><div>${s.claude.available ? "✅ " + t("valConnected") + " (" + escapeHtml(s.claude.version) + ")" : "❌ " + t("valDisconnected") + " - " + escapeHtml(s.claude.error || "")}</div>
          <div>${t("labelThreadsApi")}</div><div>${s.threads.connected ? "✅ " + t("valConnected") + " (@" + escapeHtml(s.threads.username || "") + ")" : (s.threads.configured ? "❌ " + t("valConnFailed") + " - " + escapeHtml(s.threads.error || "") : "⚙️ " + t("valNotConfigured"))}</div>
        </div>
      </div>
      <div class="dash-card">
        <h4>${t("dashCardTodayStatus")}</h4>
        <div class="kv">
          <div>${t("labelDraftsCreatedToday")}</div><div>${s.draftsCreatedToday}${t("unitCount")}</div>
          <div>${t("labelApprovedToday")}</div><div>${s.approvedToday}${t("unitCount")}</div>
        </div>
      </div>
      <div class="dash-card">
        <h4>${t("dashCardPublishStatus")}</h4>
        <div class="kv">
          <div>${t("labelAutoPublish")}</div><div>
            <label><input type="checkbox" id="autoPublishToggle" ${s.autoPublish ? "checked" : ""}/> ${s.autoPublish ? t("onLabel") : t("offLabel")}</label>
          </div>
          <div>${t("labelPublishedToday")}</div><div>${s.publishedToday}${t("unitCount")} / ${t("labelDailyMaxPublish")} ${s.dailyMaxPublish}</div>
        </div>
        <p class="muted">${t("autoPublishHint")}</p>
      </div>
      <div class="dash-card">
        <h4>${t("dashCardNextSchedule")}</h4>
        <div class="kv">
          <div>${t("labelNextScheduleTime")}</div><div>${s.scheduledCountNext ? fmtDate(s.scheduledCountNext) : t("noScheduledDrafts")}</div>
          <div>${t("labelServerTime")}</div><div>${fmtDate(s.serverTime)} (${s.timezone})</div>
        </div>
      </div>
    </div>
  `;

  $("#autoPublishToggle")?.addEventListener("change", async (e) => {
    await api("/status/auto-publish", { method: "POST", body: JSON.stringify({ enabled: e.target.checked }) });
    loadDashboard();
  });
}

function renderStatusBar(s) {
  if (!s) return;
  const set = (id, text, cls) => {
    const el = $(id);
    el.textContent = text;
    el.className = "chip" + (cls ? " " + cls : "");
  };
  set("#chipClaude", t("labelClaudeCode") + ": " + (s.claude.available ? t("valConnected") : t("valDisconnected")), s.claude.available ? "ok" : "bad");
  set("#chipThreads", t("labelThreadsApi") + ": " + (s.threads.connected ? t("valConnected") : s.threads.configured ? t("valError") : t("valNotConfigured")), s.threads.connected ? "ok" : "warn");
  set("#chipAuto", t("labelAutoPublish") + ": " + (s.autoPublish ? t("onLabel") : t("offLabel")), s.autoPublish ? "ok" : "");
  set("#chipCreated", t("chipCreated") + ": " + s.draftsCreatedToday + t("unitCount"), "");
  set("#chipPublished", t("chipPublished") + ": " + s.publishedToday + t("unitCount"), "");
  set("#chipNext", t("chipNext") + ": " + (s.scheduledCountNext ? fmtDate(s.scheduledCountNext) : t("none")), "");
}

// ---------------- P1.6(AUD-P0-001): 예약 관리의 자동 발행 ON/OFF 조작 UI ----------------
// 대시보드 화면 제거로 구매자가 auto_publish 스위치에 접근할 수 없던 P0의 복구.
// 역할 분리: 상단 상태바 chip = 상태 "표시" 전용, 예약 관리 카드 = 실제 "조작"(canonical).
// 서버는 기존 POST /api/status/auto-publish 하나만 그대로 재사용한다(신규 API 없음).
// AUD-P1-003: 미디어 발행 구성이 없는 설치본에서는 예약 전에 preflight 안내를 함께 보여준다.
let mediaPublishConfigured = null; // /api/status.mediaPublishConfigured - 아직 조회 전이면 null(안내 표시 안 함)

// 자동 발행 상태를 쓰는 화면 세 곳(설정 카드 · 예약 관리 표시 · 상단 chip)을 한 값으로
// 함께 갱신한다. 조작은 설정 카드 한 곳만 하고, 나머지는 표시 전용이다.
function renderAutoPublishControl(s) {
  const on = !!(s && s.autoPublish);
  const label = on ? t("onLabel") : t("offLabel");
  const desc = on ? t("autoPublishDescOn") : t("autoPublishDescOff");

  // 설정 화면 - 실제 조작 위치(canonical)
  const settingsToggle = $("#autoPublishSettingsToggle");
  if (settingsToggle) settingsToggle.checked = on;
  const settingsState = $("#autoPublishSettingsState");
  if (settingsState) settingsState.textContent = label;
  const settingsDesc = $("#autoPublishSettingsDesc");
  if (settingsDesc) settingsDesc.textContent = desc;

  // 예약 관리 화면 - 상태 표시만(스위치 없음, 설정으로 보내는 버튼만 있음)
  const stateEl = $("#autoPublishControlState");
  if (stateEl) stateEl.textContent = label;
  const descEl = $("#autoPublishControlDesc");
  if (descEl) descEl.textContent = desc;
}

// 초안 카드/미디어 상세/설정에 쓰는 미디어 발행 안내 문구. 구성이 명시적으로 "안 됨"일 때만
// 미연결 안내로 바꾸고, 구성됨/미확인이면 기존 "함께 발행됩니다" 문구를 유지한다(AUD-P1-003 -
// release 구성과 실제 기능이 일치할 때만 단정 문구 유지).
function mediaPublishNoteText() {
  return mediaPublishConfigured === false ? t("mediaPublishNotConfigured") : t("mediaNotPublishedWarning");
}

function renderMediaPublishPreflightNote() {
  const el = $("#mediaPublishPreflightNote");
  if (!el) return;
  const show = mediaPublishConfigured === false; // 명시적으로 "미구성"일 때만 - 구성됨/미확인이면 숨김
  el.style.display = show ? "" : "none";
  el.textContent = show ? t("mediaPublishNotConfigured") : "";
}

function initAutoPublishControl() {
  // 조작은 설정 화면의 이 토글 하나뿐이다(예약 관리 카드는 표시 전용).
  $("#autoPublishSettingsToggle")?.addEventListener("change", async (e) => {
    const toggle = e.target;
    toggle.disabled = true; // 요청 중 중복 조작 방지
    await api("/status/auto-publish", { method: "POST", body: JSON.stringify({ enabled: toggle.checked }) });
    toggle.disabled = false;
    loadDashboard(); // 설정 카드 · 예약 관리 표시 · 상단 chip 을 서버 값으로 함께 갱신
  });
  // 상단 chip 은 표시 전용이지만, 눌렀을 때 조작 위치로 데려다 준다(값은 바꾸지 않는다).
  const chip = $("#chipAuto");
  if (chip) {
    chip.style.cursor = "pointer";
    chip.title = t("chipAutoGotoSettings");
    chip.addEventListener("click", () => showView("settings"));
  }
}

// ---------------- 스마트 에디터 "일반 글 작성" 탭의 자동 생성 버튼 ----------------
// (기존 파란 버튼 행의 "① 자료 수집"/"쿠파스 만들기"는 사이드바 nav-item과 스마트 에디터
// 탭으로 기능이 그대로 이동했으므로, 여기서는 #btnGenerate 하나만 초기화합니다.)
function initMainButtons() {
  $("#btnGenerate").addEventListener("click", async () => {
    setBtnLoading("#btnGenerate", t("generatingBtn"));
    const r = await api("/drafts/generate", { method: "POST", body: JSON.stringify({ count: 6 }) });
    resetBtn("#btnGenerate", t("btnGenerateAuto"));
    if (r && r.success) {
      // P1.2: 강제 이동 대신 현재 화면 유지 + 성공 안내 + [초안 확인 →].
      showDraftsSavedCta($("#generateAutoStatus"), r.count);
    } else if (r && r.overBudget) {
      // 예산 초과: 일부만 잘라 전달하지 않고 생성을 중단했으므로, 사용자가 직접 자료를 줄일 수 있도록
      // 자료 후보 검수 화면으로 안내합니다.
      alert(t("overBudgetAlert", { cand: r.candidateCount || 0, est: (r.estimatedChars || 0).toLocaleString(), max: (r.maxTotalChars || 0).toLocaleString() }));
      showView("collect");
    } else {
      showGenerateFailure($("#generateAutoStatus"), r);
    }
  });

}

function setBtnLoading(sel, text) {
  const b = $(sel);
  b.disabled = true;
  b.dataset.origText = b.textContent;
  b.textContent = text;
}
function resetBtn(sel, fallback) {
  const b = $(sel);
  b.disabled = false;
  b.textContent = b.dataset.origText || fallback;
}

// ---------------- 쿠파스 상품 홍보 글 만들기 ----------------
// 경제적 이해관계 고지문은 제휴 프로그램마다 공식 문구가 다르다. 여기 값은 "처음 채워 넣는
// 기본값"일 뿐이고, 사용자가 고친 문구는 절대 덮어쓰지 않는다. 최종 판정은 서버가 저장된
// 상품의 siteId 로 다시 한다(src/affiliatePromo.ts).
const AFFILIATE_DISCLOSURE_BY_SITE = {
  coupang: "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.",
  brandconnect: "이 포스팅은 네이버 쇼핑 커넥트 활동의 일환으로, 판매 발생 시 수수료를 제공받습니다.",
};
const DEFAULT_DISCLOSURE_TEXT = AFFILIATE_DISCLOSURE_BY_SITE.coupang;

// 알 수 없는 siteId는 기존 동작 그대로 쿠팡 문구다.
function affiliateDisclosureForSite(siteId) {
  return AFFILIATE_DISCLOSURE_BY_SITE[siteId] || DEFAULT_DISCLOSURE_TEXT;
}

// 지금 고지문 칸에 들어 있는 값이 "사용자가 직접 고친 문구"인지 판단한다.
// 비어 있거나 어느 프로그램의 기본 문구 그대로면 사용자가 손대지 않은 것으로 본다.
function isUntouchedDisclosure(value) {
  const v = String(value || "").trim();
  if (!v) return true;
  return Object.keys(AFFILIATE_DISCLOSURE_BY_SITE).some((k) => AFFILIATE_DISCLOSURE_BY_SITE[k] === v);
}

// 서버(src/affiliatePromo.ts)의 PROMOTION_STYLE_LABELS와 동일한 값을 화면 표시용으로 둡니다.
const PROMOTION_STYLE_LABELS = {
  empathy: "생활 불편 공감형",
  curiosity: "첫 줄 궁금증형",
  solution: "문제 해결형",
  persona_fit: "이런 사람에게 맞는 상품형",
  honest: "장점과 주의점을 함께 쓰는 솔직형",
  short_punch: "짧은 한 방형",
};

// style.css의 #afDisclosure 규칙과 반드시 같은 값이어야 한다(둘 중 하나만 바꾸면 어긋난다).
const AF_DISCLOSURE_MIN_HEIGHT = 120;
const AF_DISCLOSURE_MAX_HEIGHT = 220;

// 고지 문구 입력칸을 내용 높이에 맞춘다. 짧으면 최소 높이, 길면 최대 높이까지 늘어나고,
// 그 이상일 때만 입력칸 안에서 스크롤된다.
// box-sizing이 border-box라서 scrollHeight(내용+안쪽 여백)에 위아래 테두리를 더해야
// 실제로 스크롤이 생기지 않는 height가 된다. 측정 중에는 CSS min-height를 잠시 비워
// 내용 자체의 높이를 읽는다(그래야 글을 지웠을 때 다시 작아진다).
function autosizeAffiliateDisclosure() {
  const el = $("#afDisclosure");
  if (!el) return;
  el.style.minHeight = "0";
  el.style.height = "auto";
  const cs = getComputedStyle(el);
  const borders = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const wanted = el.scrollHeight + borders;
  el.style.minHeight = "";
  el.style.height = Math.min(Math.max(wanted, AF_DISCLOSURE_MIN_HEIGHT), AF_DISCLOSURE_MAX_HEIGHT) + "px";
}

// 스마트 에디터 화면에 들어올 때마다 지난 생성의 성공/실패 문구와 CTA를 닫는다.
// 초안 자체(서버 데이터)는 건드리지 않는다 - 지우는 것은 화면에 남은 안내뿐이다.
function clearEditorTransientState() {
  ["#generateAutoStatus", "#affiliateGenerateStatus", "#affiliateFormError"].forEach((sel) => {
    const el = $(sel);
    if (el) el.innerHTML = "";
  });
}

function loadEditorView() {
  clearEditorTransientState();
  loadAffiliateView();
}

function loadAffiliateView() {
  const disclosureEl = $("#afDisclosure");
  if (disclosureEl && !disclosureEl.value.trim()) disclosureEl.value = DEFAULT_DISCLOSURE_TEXT;
  // 화면에 처음 들어왔을 때(기본 문구든, 이미 길게 고쳐 둔 문구든) 바로 맞는 높이로 보이게 한다.
  autosizeAffiliateDisclosure();
}

// 첨부는 선택사항입니다(요청서 4번) - null이면 기존 텍스트 전용 흐름과 완전히 동일하게 동작합니다.
let attachedMedia = null; // { filename, type, mime, originalName, objectUrl }

function initAffiliateView() {
  $("#btnGenerateAffiliate").addEventListener("click", generateAffiliatePromo);
  // 글을 더하거나 지울 때, 그리고 창 폭이 바뀌어 줄바꿈이 달라질 때 높이를 다시 맞춘다.
  $("#afDisclosure")?.addEventListener("input", autosizeAffiliateDisclosure);
  window.addEventListener("resize", autosizeAffiliateDisclosure);
  $("#afMediaInput").addEventListener("change", onAffiliateMediaSelected);
  $("#btnRemoveAfMedia").addEventListener("click", removeAttachedMedia);
}

const AF_MEDIA_MAX_BYTES = 50 * 1024 * 1024; // 서버 기본값(50MB)과 동일 - 화면에서 먼저 대략 확인용
const AF_MEDIA_ACCEPT_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/quicktime", "video/webm",
]);

async function onAffiliateMediaSelected(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const errorEl = $("#affiliateFormError");
  errorEl.textContent = "";

  // 화면에서 빠르게 먼저 확인(최종 판정은 항상 서버가 확장자·MIME·파일 내용까지 다시 검증합니다).
  if (file.size > AF_MEDIA_MAX_BYTES) {
    errorEl.textContent = t("mediaTooLarge", { mb: Math.floor(AF_MEDIA_MAX_BYTES / 1024 / 1024) });
    $("#afMediaInput").value = "";
    return;
  }
  if (file.type && !AF_MEDIA_ACCEPT_TYPES.has(file.type)) {
    errorEl.textContent = t("mediaTypeUnsupported");
    $("#afMediaInput").value = "";
    return;
  }

  // 이전에 첨부했던 파일이 있으면(교체하는 경우) 먼저 서버에서 정리합니다.
  if (attachedMedia) await removeAttachedMedia({ keepInputValue: true });

  $("#afMediaStatus").textContent = t("uploadingBtn");
  $("#afMediaPreviewBox").style.display = "";

  const form = new FormData();
  form.append("media", file);
  let data = null;
  try {
    const res = await fetch("/api/affiliate/media", { method: "POST", body: form });
    data = await res.json().catch(() => null);
  } catch (err) {
    data = { success: false, error: t("mediaUploadFail") + err.message };
  }

  if (!data || !data.success) {
    $("#afMediaStatus").textContent = "";
    $("#afMediaPreviewBox").style.display = "none";
    $("#afMediaInput").value = "";
    errorEl.textContent = t("mediaUploadFail") + (data?.error || t("errUnknown"));
    return;
  }

  const objectUrl = URL.createObjectURL(file);
  attachedMedia = { filename: data.mediaFilename, type: data.mediaType, mime: data.mediaMime, originalName: data.originalName, objectUrl };
  renderAffiliateMediaPreview();
}

function renderAffiliateMediaPreview() {
  const content = $("#afMediaPreviewContent");
  if (!attachedMedia) {
    content.innerHTML = "";
    return;
  }
  content.innerHTML =
    attachedMedia.type === "video"
      ? `<video src="${attachedMedia.objectUrl}" controls style="max-width:100%;max-height:240px;"></video>`
      : `<div class="af-media-preview-cell"><img class="af-media-preview-thumb" src="${attachedMedia.objectUrl}" /></div>`;
  // 이미지 미리보기 클릭 → 확대(직접 글 작성과 같은 Common Viewer). 업로드/삭제 흐름은 그대로.
  if (attachedMedia.type !== "video") {
    bindLocalImageZoom(content.querySelector(".af-media-preview-cell"), [attachedMedia.objectUrl], 0, [attachedMedia.originalName]);
  }
  $("#afMediaStatus").textContent = `${t("mediaAttached")}${attachedMedia.originalName}`;
}

// keepInputValue: 파일을 교체하는 중이라 <input type=file>의 value를 이미 곧 새로 채울 예정이면
// 여기서 굳이 비우지 않습니다(자연스러운 교체 흐름).
async function removeAttachedMedia(opts) {
  if (!attachedMedia) return;
  const filename = attachedMedia.filename;
  if (attachedMedia.objectUrl) URL.revokeObjectURL(attachedMedia.objectUrl);
  attachedMedia = null;
  $("#afMediaPreviewBox").style.display = "none";
  $("#afMediaPreviewContent").innerHTML = "";
  $("#afMediaStatus").textContent = "";
  if (!(opts && opts.keepInputValue)) $("#afMediaInput").value = "";
  try {
    await fetch("/api/affiliate/media/" + encodeURIComponent(filename), { method: "DELETE" });
  } catch {
    // 정리 실패는 조용히 무시합니다(서버가 주기적으로 사용하지 않는 파일을 정리함).
  }
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// 서버 쪽 검증(src/affiliatePromo.ts의 validateAffiliateInput)과 동일한 기준으로, 요청을 보내기
// 전에 화면에서 먼저 빠르게 확인합니다(최종 판정은 항상 서버가 합니다).
function validateAffiliateFormClient(values) {
  if (!values.productName) return t("productNameRequired");
  // 상품 레이더에서 고른 경우 상품명/링크는 서버가 DB에서 직접 읽으므로 화면 값은 확인하지 않는다.
  if (!values.productRadarProductId) {
    if (!values.affiliateUrl) return t("affiliateUrlRequired");
    if (!isHttpUrl(values.affiliateUrl)) return t("affiliateUrlInvalid");
  }
  if (!values.features) return t("featuresRequired");
  if (values.usageStatus !== "used" && values.usageStatus !== "not_used") return t("usageStatusRequired");
  return null;
}

function readAffiliateFormValues() {
  const usageStatusEl = document.querySelector('input[name="afUsageStatus"]:checked');
  return {
    // Community에는 상품 레이더에서 불러오는 경로가 없으므로 항상 직접 입력값을 쓴다.
    productRadarProductId: null,
    productName: $("#afProductName").value.trim(),
    affiliateUrl: $("#afAffiliateUrl").value.trim(),
    features: $("#afFeatures").value.trim(),
    targetAudience: $("#afTargetAudience").value.trim(),
    caveats: $("#afCaveats").value.trim(),
    usageStatus: usageStatusEl ? usageStatusEl.value : "",
    extraNote: $("#afExtraNote").value.trim(),
    disclosureText: $("#afDisclosure").value.trim() || affiliateDisclosureForSite(null),
    // 미첨부면 둘 다 빈 문자열 - 서버는 mediaFilename이 없으면 기존과 동일하게 동작합니다.
    mediaFilename: attachedMedia ? attachedMedia.filename : "",
    mediaOriginalName: attachedMedia ? attachedMedia.originalName : "",
  };
}

let affiliateGenerateBusy = false;
async function generateAffiliatePromo() {
  if (affiliateGenerateBusy) return; // 중복 클릭 방지
  const errorEl = $("#affiliateFormError");
  errorEl.textContent = "";

  const values = readAffiliateFormValues();
  const clientError = validateAffiliateFormClient(values);
  if (clientError) {
    errorEl.textContent = clientError;
    return;
  }

  affiliateGenerateBusy = true;
  setBtnLoading("#btnGenerateAffiliate", t("generatingBtn"));
  const r = await api("/affiliate/generate", { method: "POST", body: JSON.stringify(values) });
  resetBtn("#btnGenerateAffiliate", t("btnGenerateAffiliate"));
  affiliateGenerateBusy = false;

  if (r && r.success) {
    // 첨부 파일은 이제 방금 생성된 6개 초안이 참조하고 있으므로, 여기서 서버 파일을 지우지 않고
    // 화면 상태만 다음 입력을 위해 초기화합니다.
    if (attachedMedia && attachedMedia.objectUrl) URL.revokeObjectURL(attachedMedia.objectUrl);
    attachedMedia = null;
    $("#afMediaInput").value = "";
    $("#afMediaPreviewBox").style.display = "none";
    $("#afMediaPreviewContent").innerHTML = "";
    $("#afMediaStatus").textContent = "";
    // P1.2: 강제 이동 대신 현재 화면 유지 + 성공 안내 + [초안 확인 →].
    showDraftsSavedCta($("#affiliateGenerateStatus"), r.count);
  } else {
    // 실패 시에는 첨부를 그대로 유지해, 다시 업로드하지 않고도 재시도할 수 있게 합니다.
    errorEl.textContent = "";
    showGenerateFailure($("#affiliateGenerateStatus"), r);
  }
}

// ---------------- ① 오늘 자료 수집 ----------------
const MAX_SELECTABLE_FOR_GENERATION = 8;
const MAX_URLS_PER_REQUEST = 20;

const COLLECT_PRESETS = {
  ai: { keywords: "AI, 자동화, 생산성, 온라인 도구, 업무 효율", exclude: "", note: "" },
  youtube: { keywords: "유튜브, 콘텐츠 제작, 영상 편집, 썸네일, 채널 운영", exclude: "", note: "" },
  solo: { keywords: "1인 사업자, 프리랜서, 디지털 상품, 반복 업무, 생산성", exclude: "", note: "" },
};

const COLLECT_MODE_DESC_KEYS = { auto: "collectDescAuto", keyword: "collectDescKeyword", url: "collectDescUrl", mixed: "collectDescMixed" };

let collectMode = "auto";
let reviewItems = [];
let selectedMaterialIds = new Set();
let lastUrlResults = [];
let collectBusy = false;
// 이번 수집 실행으로 새로 추가된 자료 수(null = 아직 이번 화면에서 수집한 적 없음).
// 누적 후보 목록과 "방금 수집한 결과"를 구분해 보여주기 위한 표시 전용 값이다.
let lastCollectNewCount = null;

function initCollectView() {
  $all(".mode-tab").forEach((btn) => {
    btn.addEventListener("click", () => setCollectMode(btn.dataset.mode));
  });
  $all(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });
  $("#btnStartCollect").addEventListener("click", startCollect);
  $("#btnResetCollectForm").addEventListener("click", resetCollectForm);
  $("#btnRetryFailedUrls").addEventListener("click", retryFailedUrls);

  $("#btnSelectAll").addEventListener("click", () => { visibleCandidateIds().forEach((id) => selectedMaterialIds.add(id)); renderCandidateList(); });
  $("#btnSelectNone").addEventListener("click", () => { selectedMaterialIds.clear(); renderCandidateList(); });
  $("#btnSelectOk").addEventListener("click", () => {
    selectedMaterialIds.clear();
    visibleCandidateIds(true).forEach((id) => selectedMaterialIds.add(id));
    renderCandidateList();
  });
  $("#btnDeleteSelected").addEventListener("click", deleteSelectedCandidates);
  $("#chkHideFailed").addEventListener("change", renderCandidateList);
  $("#chkHideDuplicate").addEventListener("change", renderCandidateList);
  $("#candidateSort").addEventListener("change", renderCandidateList);
  $("#candidateSourceFilter").addEventListener("change", renderCandidateList);
  $("#btnGenerateFromCandidates").addEventListener("click", generateFromCandidates);
}

async function loadCollectView() {
  const r = await api("/materials/input-prefs");
  const prefs = (r && r.prefs) || { lastMode: "auto", includeKeywords: "", excludeKeywords: "", note: "", candidateCount: 3, recentUrls: [] };
  $("#kwInclude").value = prefs.includeKeywords || "";
  $("#kwExclude").value = prefs.excludeKeywords || "";
  $("#kwNote").value = prefs.note || "";
  $("#kwCandidateCount").value = prefs.candidateCount || 3;
  $("#urlBulkInput").value = (prefs.recentUrls || []).join("\n");
  setCollectMode(prefs.lastMode || "auto");
  // 화면에 들어오기만 했을 때는 지난 실행의 후보 카드를 보여주지 않는다("데이터는 남고,
  // 작업 화면의 찌꺼기는 남지 않는다"). 누적 자료는 자료 보관함에서 본다 - 여기서 지우는 것은
  // 화면 표시뿐이고 DB의 materials는 그대로다.
  clearCollectResultState();
}

function setCollectMode(mode) {
  // P1.9(§12): 모드를 바꾸면 이전 모드의 일회성 상태(안내 문구·URL 결과)를 정리한다.
  // 자동 수집 화면에 "핵심 키워드를 입력해주세요" 같은 옛 오류가 남던 문제를 여기서 닫는다.
  // 누적 자료 목록(후보 검수)은 이번 수집분이 아니라 자료함 전체이므로 지우지 않는다.
  if (collectMode !== mode) clearCollectTransientState();
  collectMode = mode;
  $all(".mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#collectModeDesc").textContent = COLLECT_MODE_DESC_KEYS[mode] ? t(COLLECT_MODE_DESC_KEYS[mode]) : "";
  $("#collectBlockAuto").style.display = mode === "auto" || mode === "mixed" ? "" : "none";
  $("#collectBlockKeyword").style.display = mode === "keyword" || mode === "mixed" ? "" : "none";
  $("#collectBlockUrl").style.display = mode === "url" || mode === "mixed" ? "" : "none";
}

// 수집 화면의 "이번 실행" 표시만 지운다(입력값과 누적 자료는 유지).
function clearCollectTransientState() {
  const statusEl = $("#collectStatusText");
  if (statusEl) statusEl.textContent = "";
  const urlResults = $("#urlResultsList");
  if (urlResults) urlResults.innerHTML = "";
  const retryBtn = $("#btnRetryFailedUrls");
  if (retryBtn) retryBtn.style.display = "none";
  lastUrlResults = [];
  // 모드를 바꾸면 이전 모드로 실행한 결과 카드도 함께 닫는다(요청서 B-3).
  clearCollectResultState();
}

// 이번 실행 결과 UI만 닫는다. 서버/DB는 건드리지 않는다 - 다시 [수집 시작]을 누르면
// loadCandidateReview()가 이번 실행 결과를 다시 채운다.
function clearCollectResultState() {
  reviewItems = [];
  selectedMaterialIds.clear();
  lastCollectNewCount = null;
  totalMaterialCount = null;
  const section = $("#candidateReviewSection");
  if (section) section.style.display = "none";
  const list = $("#candidateList");
  if (list) list.innerHTML = "";
  const emptyEl = $("#collectNoResultNote");
  if (emptyEl) emptyEl.style.display = "";
}

function applyPreset(name) {
  const preset = COLLECT_PRESETS[name];
  if (!preset) return;
  const hasExisting = $("#kwInclude").value.trim().length > 0;
  if (hasExisting && !confirm(t("confirmPresetOverwrite"))) return;
  $("#kwInclude").value = preset.keywords;
  if (preset.exclude) $("#kwExclude").value = preset.exclude;
  if (preset.note) $("#kwNote").value = preset.note;
}

function resetCollectForm() {
  $("#kwInclude").value = "";
  $("#kwExclude").value = "";
  $("#kwNote").value = "";
  $("#kwCandidateCount").value = 3;
  $("#urlBulkInput").value = "";
  $("#urlResultsList").innerHTML = "";
  $("#btnRetryFailedUrls").style.display = "none";
  lastUrlResults = [];
}

function parseKeywordListClient(raw) {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).forEach((k) => {
    if (k.length > 50) return;
    const key = k.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(k);
  });
  return out;
}

function parseUrlListClient(raw) {
  return (raw || "").split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, MAX_URLS_PER_REQUEST);
}

async function saveCollectPrefs() {
  await api("/materials/input-prefs", {
    method: "POST",
    body: JSON.stringify({
      lastMode: collectMode,
      includeKeywords: $("#kwInclude").value,
      excludeKeywords: $("#kwExclude").value,
      note: $("#kwNote").value,
      candidateCount: parseInt($("#kwCandidateCount").value, 10) || 3,
      recentUrls: parseUrlListClient($("#urlBulkInput").value),
    }),
  });
}

async function startCollect() {
  if (collectBusy) return; // 중복 클릭 방지
  collectBusy = true;
  setBtnLoading("#btnStartCollect", t("collectingBtn"));
  clearCollectTransientState(); // 이전 실행의 안내/URL 결과가 이번 결과와 섞이지 않게 먼저 비운다
  let newThisRun = 0; // 이번 실행으로 실제로 늘어난 자료 수(자동/키워드/URL 합계)

  const messages = [];
  let collectHadSuccess = false; // P1: 하나라도 성공하면 다음 단계(자료 보관함) 안내 점등
  try {
    if (collectMode === "auto" || collectMode === "mixed") {
      const r = await api("/materials/collect", { method: "POST" });
      if (r && r.success) { collectHadSuccess = true; newThisRun += r.summary.collected; messages.push(t("msgAutoCollected", { n: r.summary.collected, dup: r.summary.skippedDuplicate })); }
      else messages.push(t("msgAutoCollectFail", { err: r?.error || t("errUnknown") }));
    }

    if (collectMode === "keyword" || collectMode === "mixed") {
      const keywords = parseKeywordListClient($("#kwInclude").value);
      if (keywords.length > 0) {
        const r = await api("/materials/keywords", {
          method: "POST",
          body: JSON.stringify({
            keywords: $("#kwInclude").value,
            excludeKeywords: $("#kwExclude").value,
            note: $("#kwNote").value,
            candidateCount: parseInt($("#kwCandidateCount").value, 10) || 3,
          }),
        });
        if (r && r.success) { collectHadSuccess = true; newThisRun += r.createdCount; messages.push(t("msgKeywordRegistered", { n: r.createdCount, dup: r.skippedDuplicate })); }
        else messages.push(t("msgKeywordFail", { err: r?.error || t("errUnknown") }));
      } else if (collectMode === "keyword") {
        messages.push(t("kwRequired"));
      }
    }

    if (collectMode === "url" || collectMode === "mixed") {
      const urls = parseUrlListClient($("#urlBulkInput").value);
      if (urls.length > 0) {
        const refresh = $("#urlRefreshExisting")?.checked === true;
        const r = await api("/materials/urls", { method: "POST", body: JSON.stringify({ urls, refresh }) });
        if (r && r.success) {
          lastUrlResults = r.results;
          renderUrlResults(r.results);
          const okCount = r.results.filter((x) => x.status === "extracted" || x.status === "refreshed").length;
          if (okCount > 0) collectHadSuccess = true;
          newThisRun += r.results.filter((x) => x.status === "extracted").length;
          messages.push(summarizeUrlResults(r.results));
        } else {
          messages.push(t("msgUrlFail", { err: r?.error || t("errUnknown") }));
        }
      } else if (collectMode === "url") {
        messages.push(t("urlRequired"));
      }
    }

    lastCollectNewCount = newThisRun; // 누적 후보 목록과 구분해 표시하기 위한 이번 실행 결과
    $("#collectStatusText").textContent = messages.join(" · ");
    // P1.4: 수집 성공 → 화면 내 CTA가 다음 길을 안내한다(사이드바 점등 없음).
    if (collectHadSuccess) {
      const goBtn = document.createElement("button");
      goBtn.type = "button";
      goBtn.className = "next-cta"; // P1.1: 다음 공정 버튼 - blue outline + 행 오른쪽 끝 정렬
      goBtn.id = "btnGoMaterialsAfterCollect";
      goBtn.textContent = t("btnGoMaterialsAfterCollect");
      goBtn.addEventListener("click", () => showView("materials"));
      $("#collectStatusText").appendChild(document.createTextNode(" "));
      $("#collectStatusText").appendChild(goBtn);
    }
    await saveCollectPrefs();
    await loadCandidateReview();
  } finally {
    collectBusy = false;
    resetBtn("#btnStartCollect", t("btnStartCollect"));
  }
}

async function retryFailedUrls() {
  const failedUrls = lastUrlResults.filter((r) => r.status !== "extracted" && r.status !== "refreshed" && r.status !== "duplicate_existing" && r.status !== "duplicate_input").map((r) => r.url);
  if (failedUrls.length === 0) { alert(t("alertNoRetryUrls")); return; }
  setBtnLoading("#btnRetryFailedUrls", t("retryingBtn"));
  const refresh = $("#urlRefreshExisting")?.checked === true;
  const r = await api("/materials/urls", { method: "POST", body: JSON.stringify({ urls: failedUrls, refresh }) });
  resetBtn("#btnRetryFailedUrls", t("btnRetryFailedUrls"));
  if (r && r.success) {
    // 성공한 URL은 결과를 갱신하고, 실패한 URL만 새 결과로 교체한다.
    const retriedMap = new Map(r.results.map((x) => [x.url, x]));
    lastUrlResults = lastUrlResults.map((old) => retriedMap.get(old.url) || old);
    renderUrlResults(lastUrlResults);
    await loadCandidateReview();
  } else {
    alert(t("retryFail") + (r?.error || t("errUnknown")));
  }
}

function renderUrlResults(results) {
  const el = $("#urlResultsList");
  if (!results || results.length === 0) { el.innerHTML = ""; $("#btnRetryFailedUrls").style.display = "none"; return; }
  const hasFailed = results.some((r) => r.status !== "extracted" && r.status !== "refreshed" && r.status !== "duplicate_existing" && r.status !== "duplicate_input");
  $("#btnRetryFailedUrls").style.display = hasFailed ? "" : "none";

  el.innerHTML = results.map((r, i) => {
    const cls = r.status === "extracted" || r.status === "refreshed" ? "status-ok" : (r.status === "duplicate_existing" || r.status === "duplicate_input" ? "status-dup" : "status-fail");
    // P1.9(§7): 이미 수집한 주소는 막다른 길이 아니다 - 그 자리에서 다시 수집해 최신 내용으로
    // 갱신할 수 있음을 버튼으로 분명히 보여준다(중복 자료를 새로 만들지 않고 기존 자료를 갱신).
    const canRecollect = r.status === "duplicate_existing";
    return `
      <div class="item-card url-result-item">
        <div class="url-text">${escapeHtml(r.url)}${r.title ? "<br/><strong>" + escapeHtml(r.title) + "</strong>" : ""}</div>
        <div>
          <span class="status-badge ${cls}">${escapeHtml(r.statusLabel)}</span>
          ${r.error ? `<div class="muted">${escapeHtml(r.error)}</div>` : ""}
          ${canRecollect ? `<button type="button" class="secondary" data-recollect-index="${i}">${t("btnRecollectUrl")}</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  el.querySelectorAll("[data-recollect-index]").forEach((btn) => {
    btn.addEventListener("click", () => recollectUrl(results[parseInt(btn.dataset.recollectIndex, 10)].url, btn));
  });
}

// 이미 수집한 주소 하나만 다시 가져와 기존 자료를 최신 내용으로 갱신한다(새 자료를 만들지 않음).
async function recollectUrl(url, btn) {
  if (!url) return;
  if (btn) btn.disabled = true;
  const r = await api("/materials/urls", { method: "POST", body: JSON.stringify({ urls: [url], refresh: true }) });
  if (btn) btn.disabled = false;
  if (!r || !r.success || !Array.isArray(r.results)) return;
  const updated = r.results[0];
  // 방금 다시 수집한 항목만 결과 목록에서 교체하고, 나머지 결과는 그대로 둔다.
  lastUrlResults = lastUrlResults.map((old) => (old.url === url ? updated : old));
  renderUrlResults(lastUrlResults);
  $("#collectStatusText").textContent = summarizeUrlResults([updated]);
  await loadCandidateReview();
}

// P1.9(§13): 방금 실행한 수집이 무엇을 했는지 구매자가 알 수 있게 신규/갱신/이미 수집됨/실패로
// 나눠 보여준다(서버가 이미 내려주는 status 값만 세는 것이라 API 변경 없음).
function summarizeUrlResults(results) {
  const list = Array.isArray(results) ? results : [];
  const added = list.filter((r) => r.status === "extracted").length;
  const refreshed = list.filter((r) => r.status === "refreshed").length;
  const duplicate = list.filter((r) => r.status === "duplicate_existing" || r.status === "duplicate_input").length;
  const failed = list.length - added - refreshed - duplicate;
  return t("msgUrlSummary", { added, refreshed, dup: duplicate, failed });
}

// ---------------- 자료 후보 검수 ----------------
// 자료함 전체 건수. 후보 목록(최대 20건)과 헷갈리지 않도록 별도로 들고 있는다.
let totalMaterialCount = null;
async function loadCandidateReview() {
  const includeKeywords = parseKeywordListClient($("#kwInclude").value).join(",");
  const excludeKeywords = parseKeywordListClient($("#kwExclude").value).join(",");
  const qs = new URLSearchParams({ includeKeywords, excludeKeywords }).toString();
  const r = await api("/materials/review-list?" + qs);
  if (!r) return;
  reviewItems = r.items || [];
  // 자료함 전체 건수(후보 20건과 구분해서 안내하기 위한 값).
  totalMaterialCount = typeof r.totalCollected === "number" ? r.totalCollected : null;
  // 정상 자료만 남기고 선택 상태를 정리(삭제되었거나 목록에서 사라진 자료의 선택은 제거)
  const validIds = new Set(reviewItems.map((it) => it.id));
  selectedMaterialIds.forEach((id) => { if (!validIds.has(id)) selectedMaterialIds.delete(id); });

  const hasResult = reviewItems.length > 0;
  $("#candidateReviewSection").style.display = hasResult ? "" : "none";
  const emptyEl = $("#collectNoResultNote");
  if (emptyEl) emptyEl.style.display = hasResult ? "none" : "";
  renderCandidateList();
}

// 후보는 최대 20건만 보여주므로, 자료함 전체가 몇 건인지와 전체를 보러 가는 길을 함께 안내한다.
// 숫자는 서버 응답(totalCollected)만 쓰고 하드코딩하지 않는다.
function renderCandidateLibraryNote(shownCount) {
  const el = $("#candidateLibraryNote");
  if (!el) return;
  if (totalMaterialCount === null) { el.textContent = ""; return; }
  el.textContent = t("candidateLibraryNote", { shown: shownCount, total: totalMaterialCount });
}

function visibleCandidateIds(okOnly) {
  return getFilteredSortedItems().filter((it) => !okOnly || it.ok).map((it) => it.id);
}

function getFilteredSortedItems() {
  let items = [...reviewItems];
  if ($("#chkHideFailed").checked) items = items.filter((it) => it.ok);
  if ($("#chkHideDuplicate").checked) items = items.filter((it) => !it.duplicateSuspect);
  const sourceFilter = $("#candidateSourceFilter").value;
  if (sourceFilter) items = items.filter((it) => it.source_type === sourceFilter);
  const sort = $("#candidateSort").value;
  if (sort === "recent") items.sort((a, b) => new Date(b.collected_at).getTime() - new Date(a.collected_at).getTime());
  else items.sort((a, b) => b.score - a.score);
  return items;
}

function renderCandidateList() {
  const items = getFilteredSortedItems();
  renderCandidateLibraryNote(items.length);
  // P1.9(§14): 이 목록은 "이번 수집분"이 아니라 자료함 전체 누적이다. 방금 수집으로 새로
  // 늘어난 건수를 따로 붙여, 누적 수를 이번 수집 결과로 오해하지 않게 한다.
  const base = t("candidateCountLabel", { sel: selectedMaterialIds.size, total: reviewItems.length, shown: items.length });
  $("#candidateCountLabel").textContent = lastCollectNewCount === null ? base : base + " · " + t("candidateNewThisRun", { n: lastCollectNewCount });

  const list = $("#candidateList");
  if (items.length === 0) {
    list.innerHTML = `<p class="muted">${t("noCandidatesToShow")}</p>`;
  } else {
    list.innerHTML = items.map((it) => {
      const checked = selectedMaterialIds.has(it.id) ? "checked" : "";
      const statusBadge = it.ok
        ? `<span class="status-badge status-ok">${t("candidateOk")}</span>`
        : `<span class="status-badge status-fail">${escapeHtml(it.excludedReason || t("candidateExcluded"))}</span>`;
      const dupBadge = it.duplicateSuspect ? `<span class="status-badge status-dup">${t("dupSuspect")}</span>` : "";
      return `
        <div class="item-card candidate-item ${it.ok ? "" : "candidate-disabled"}">
          <input type="checkbox" data-id="${it.id}" ${checked} onchange="toggleCandidateSelection(${it.id}, this.checked)" />
          <div class="candidate-body">
            <div class="meta">
              [${escapeHtml(it.source_type)}] ${escapeHtml(it.source_name || "")} · ${t("labelCollectedAt")} ${fmtDate(it.collected_at)} · ${t("labelScore")} ${it.score}
              ${statusBadge} ${dupBadge}
            </div>
            <strong>${escapeHtml(it.title)}</strong>
            <div class="body-text">${escapeHtml(it.contentPreview || "")}</div>
            <div class="muted">${t("labelReason")}${escapeHtml(it.reason)}</div>
            ${it.duplicateSuspectReason ? `<div class="muted">${t("labelDupReason")}${escapeHtml(it.duplicateSuspectReason)}</div>` : ""}
            ${it.keywords ? `<div class="muted">${t("labelRelatedKeywords")}${escapeHtml(it.keywords.join(", "))}</div>` : ""}
            <div class="actions">
              ${it.source_url ? `<button class="secondary" data-open-source-id="${it.id}">${t("btnOpenSource")}</button>` : ""}
              <button class="danger" onclick="deleteCandidateMaterial(${it.id})">${t("btnDelete")}</button>
            </div>
          </div>
        </div>
      `;
    }).join("");
    // P1.6(AUD-P1-002): 외부 source_url은 HTML에 넣지 않고, id로 원본 item을 찾아
    // scheme 검증(openExternalHttpUrl)을 거쳐 연다.
    list.querySelectorAll("[data-open-source-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = items.find((x) => String(x.id) === btn.dataset.openSourceId);
        if (item) openExternalHttpUrl(item.source_url);
      });
    });
  }

  updateGenerateButtonState();
}

function toggleCandidateSelection(id, checked) {
  if (checked) selectedMaterialIds.add(id); else selectedMaterialIds.delete(id);
  renderCandidateList();
}

async function deleteCandidateMaterial(id) {
  if (!confirm(t("confirmDeleteMaterial"))) return;
  await api("/materials/" + id, { method: "DELETE" });
  selectedMaterialIds.delete(id);
  await loadCandidateReview();
}

async function deleteSelectedCandidates() {
  if (selectedMaterialIds.size === 0) { alert(t("alertSelectFirst")); return; }
  if (!confirm(t("confirmDeleteSelected", { n: selectedMaterialIds.size }))) return;
  const ids = Array.from(selectedMaterialIds);
  for (const id of ids) {
    await api("/materials/" + id, { method: "DELETE" });
  }
  selectedMaterialIds.clear();
  await loadCandidateReview();
}

function updateGenerateButtonState() {
  const btn = $("#btnGenerateFromCandidates");
  const reasonEl = $("#generateDisabledReason");
  const n = selectedMaterialIds.size;
  if (n === 0) {
    btn.disabled = true;
    reasonEl.textContent = t("genReasonNone");
  } else if (n > MAX_SELECTABLE_FOR_GENERATION) {
    btn.disabled = true;
    reasonEl.textContent = t("genReasonTooMany", { n, max: MAX_SELECTABLE_FOR_GENERATION });
  } else {
    btn.disabled = false;
    reasonEl.textContent = t("genReasonOk", { n, max: MAX_SELECTABLE_FOR_GENERATION });
  }
}

let generateBusy = false;
async function generateFromCandidates() {
  if (generateBusy) return; // 중복 클릭 방지
  generateBusy = true;
  setBtnLoading("#btnGenerateFromCandidates", t("generatingBtn"));
  const count = parseInt($("#genCountInput").value, 10) || 6;
  const materialIds = Array.from(selectedMaterialIds);
  const r = await api("/drafts/generate", { method: "POST", body: JSON.stringify({ materialIds, count }) });
  resetBtn("#btnGenerateFromCandidates", t("btnGenerateFromCandidates"));
  generateBusy = false;
  updateGenerateButtonState();
  if (r && r.success) {
    // P1.2: 강제 이동 대신 현재 화면 유지 + 성공 안내 + [초안 확인 →].
    showDraftsSavedCta($("#candidateGenerateStatus"), r.count);
  } else {
    showGenerateFailure($("#candidateGenerateStatus"), r);
  }
}

// ---------------- 자료함 ----------------
async function loadMaterials() {
  const [r, c] = await Promise.all([api("/materials?limit=200"), api("/materials/candidates")]);
  renderMaterialsSummary(c);

  const list = $("#materialsList");
  if (!r || !r.materials || r.materials.length === 0) { list.innerHTML = `<p class="muted">${t("noMaterials")}</p>`; return; }

  const candidateInfo = new Map((c?.candidates || []).map((x) => [x.id, x]));
  list.innerHTML = r.materials.map((m) => {
    const info = candidateInfo.get(m.id);
    return `
    <div class="item-card">
      <div class="meta">
        [${escapeHtml(m.source_type)}] ${escapeHtml(m.source_name || "")} · ${t("labelCollectedAt")} ${fmtDate(m.collected_at)} ${m.published_at ? "· " + t("labelPublishedAt") + fmtDate(m.published_at) : ""}
        ${info ? `<span class="status-badge status-approved">${t("labelGenCandidate", { score: info.score })}</span>` : ""}
      </div>
      <strong>${escapeHtml(m.title)}</strong>
      <div class="body-text">${escapeHtml((m.content || "").slice(0, 300))}${(m.content || "").length > 300 ? "..." : ""}</div>
      ${info ? `<div class="muted">${t("labelReason")}${escapeHtml(info.reason)}</div>` : ""}
      <div class="actions">
        ${m.source_url ? `<button class="secondary" data-open-source-id="${m.id}">${t("btnOpenSource")}</button>` : ""}
        <button class="danger" onclick="deleteMaterial(${m.id})">${t("btnDelete")}</button>
      </div>
    </div>
  `;
  }).join("");
  // P1.6(AUD-P1-002): 외부 source_url은 HTML에 넣지 않고 id 조회 + scheme 검증으로 연다.
  const materialsById = new Map(r.materials.map((m) => [String(m.id), m]));
  list.querySelectorAll("[data-open-source-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = materialsById.get(btn.dataset.openSourceId);
      if (m) openExternalHttpUrl(m.source_url);
    });
  });
}

function renderMaterialsSummary(c) {
  const el = $("#materialsSummary");
  if (!el) return;
  if (!c) { el.textContent = t("materialsLoadFail"); return; }
  el.innerHTML = `
    <div class="kv">
      <div>${t("labelTotalCollected")}</div><div>${c.totalCollected}${t("unitCount")}</div>
      <div>${t("labelCandidatePool")}</div><div>${c.candidateCount}${t("labelCandidatePoolSuffix")}</div>
      <div>${t("labelDeliverOnGenerate")}</div><div>${t("genLimitSummary", { max: MAX_SELECTABLE_FOR_GENERATION })}</div>
      <div>${t("labelExcludedShort")}</div><div>${c.excludedTooShort}${t("unitCount")}</div>
      <div>${t("labelExcludedDup")}</div><div>${c.excludedDuplicate}${t("unitCount")}</div>
    </div>
  `;
}

async function deleteMaterial(id) {
  if (!confirm(t("confirmDeleteMaterial"))) return;
  await api("/materials/" + id, { method: "DELETE" });
  loadMaterials();
}

function initMaterialsForm() {
  $("#btnAddUrl").addEventListener("click", async () => {
    const url = $("#urlInput").value.trim();
    if (!url) return;
    const r = await api("/materials/url", { method: "POST", body: JSON.stringify({ url }) });
    if (r && r.success) { $("#urlInput").value = ""; loadMaterials(); }
    else alert(t("deleteFail") + (r?.error || ""));
  });
  $("#btnAddText").addEventListener("click", async () => {
    const text = $("#textInput").value.trim();
    const title = $("#textTitleInput").value.trim();
    if (!text) return;
    const r = await api("/materials/text", { method: "POST", body: JSON.stringify({ text, title }) });
    if (r && r.success) { $("#textInput").value = ""; $("#textTitleInput").value = ""; loadMaterials(); }
    else alert(t("deleteFail") + (r?.error || ""));
  });
}

// ---------------- 예약 루틴 설정 + 승인 글 일괄 예약 ----------------
let routineTimesDraft = [];
let selectedApprovedIds = new Set(); // Set은 삽입 순서를 보존하므로, 클릭한 순서가 곧 배치 순서가 됩니다.
let approvedDraftsList = [];

function initScheduleRoutineUI() {
  $("#btnAddRoutineTime").addEventListener("click", () => addRoutineTimeRow(""));
  $("#btnSaveRoutine").addEventListener("click", saveScheduleRoutine);
  $("#btnSelectAllApproved").addEventListener("click", () => {
    approvedDraftsList.forEach((d) => selectedApprovedIds.add(d.id));
    renderApprovedSelectionList();
  });
  $("#btnSelectNoneApproved").addEventListener("click", () => {
    selectedApprovedIds.clear();
    renderApprovedSelectionList();
  });
  $("#btnPreviewBatchSchedule").addEventListener("click", previewBatchSchedule);
  $("#btnConfirmBatchSchedule").addEventListener("click", confirmBatchSchedule);
  $("#btnCancelBatchPreview").addEventListener("click", cancelBatchPreview);
}

async function loadScheduleRoutine() {
  const r = await api("/schedule-routine");
  const routine = (r && r.routine) || { times: ["09:00"], weekdays: [0, 1, 2, 3, 4, 5, 6], dailyLimit: 6 };
  routineTimesDraft = routine.times.length ? [...routine.times] : [""];
  renderRoutineTimeRows();
  $all(".routine-weekday").forEach((cb) => { cb.checked = routine.weekdays.includes(parseInt(cb.value, 10)); });
  $("#routineDailyLimit").value = routine.dailyLimit;
}

function renderRoutineTimeRows() {
  const list = $("#routineTimesList");
  if (routineTimesDraft.length === 0) {
    list.innerHTML = `<p class="muted">${t("noRoutineTimes")}</p>`;
    return;
  }
  list.innerHTML = routineTimesDraft
    .map(
      (timeVal, i) => `
    <div class="item-card routine-time-row">
      <input type="time" class="routine-time-input" data-idx="${i}" value="${escapeHtml(timeVal)}" />
      <button type="button" class="danger" onclick="removeRoutineTimeRow(${i})">${t("btnDeleteRoutineTime")}</button>
    </div>
  `
    )
    .join("");
}

function addRoutineTimeRow(value) {
  // 화면에서 직접 입력 중인 값을 먼저 반영한 뒤 새 빈 행을 추가합니다(입력값 유실 방지).
  routineTimesDraft = collectRoutineTimesFromDom(true);
  routineTimesDraft.push(value);
  renderRoutineTimeRows();
}

function removeRoutineTimeRow(idx) {
  routineTimesDraft = collectRoutineTimesFromDom(true);
  routineTimesDraft.splice(idx, 1);
  renderRoutineTimeRows();
}

// keepEmpty: 저장 시에는 빈 입력을 제외하지만(collectRoutineTimesFromDom(false)), 행 추가/삭제
// 중에는 사용자가 아직 입력 중인 빈 행도 유지해야 하므로 keepEmpty=true로 호출합니다.
function collectRoutineTimesFromDom(keepEmpty) {
  return $all(".routine-time-input")
    .map((el) => el.value)
    .filter((v) => keepEmpty || v);
}

async function saveScheduleRoutine() {
  const times = collectRoutineTimesFromDom(false);
  const weekdays = $all(".routine-weekday:checked").map((cb) => parseInt(cb.value, 10));
  const dailyLimit = parseInt($("#routineDailyLimit").value, 10);
  const statusEl = $("#routineSaveStatus");
  statusEl.textContent = t("savingBtn");
  const r = await api("/schedule-routine", { method: "PUT", body: JSON.stringify({ times, weekdays, dailyLimit }) });
  if (r && r.success) {
    statusEl.textContent = t("routineSavedStatus", { n: r.routine.times.length, limit: r.routine.dailyLimit });
    routineTimesDraft = [...r.routine.times];
    renderRoutineTimeRows();
    $all(".routine-weekday").forEach((cb) => { cb.checked = r.routine.weekdays.includes(parseInt(cb.value, 10)); });
    $("#routineDailyLimit").value = r.routine.dailyLimit;
  } else {
    statusEl.textContent = t("saveFail") + (r?.error || t("errUnknown"));
  }
}

async function loadApprovedSelectionList() {
  const r = await api("/drafts?status=approved");
  const drafts = (r && r.drafts) || [];
  // 기본 정렬: 생성 시각이 오래된 글부터(요청서 2번). 서버는 최신순(id DESC)으로 주므로 재정렬합니다.
  approvedDraftsList = [...drafts].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const validIds = new Set(approvedDraftsList.map((d) => d.id));
  Array.from(selectedApprovedIds).forEach((id) => { if (!validIds.has(id)) selectedApprovedIds.delete(id); });
  renderApprovedSelectionList();
}

function renderApprovedSelectionList() {
  const list = $("#approvedSelectionList");
  if (approvedDraftsList.length === 0) {
    list.innerHTML = `<p class="muted">${t("noApprovedDrafts")}</p>`;
  } else {
    list.innerHTML = approvedDraftsList
      .map((d) => {
        const checked = selectedApprovedIds.has(d.id) ? "checked" : "";
        const isAffiliate = d.source_type === "affiliate_product";
        return `
        <div class="item-card candidate-item">
          <input type="checkbox" data-id="${d.id}" ${checked} onchange="toggleApprovedSelection(${d.id}, this.checked)" />
          <div class="candidate-body">
            <div class="meta">
              ${isAffiliate ? `<span class="status-badge status-affiliate">${t("affiliateBadge")}</span> · ` : ""}${t("labelCreated")}: ${fmtDate(d.created_at)}
            </div>
            <strong>${escapeHtml(d.title || t("noTitle"))}</strong>
            <div class="muted">${escapeHtml((d.body || "").slice(0, 100))}${(d.body || "").length > 100 ? "..." : ""}</div>
          </div>
        </div>`;
      })
      .join("");
  }
  $("#approvedSelectionCountLabel").textContent = t("approvedSelectionCount", { sel: selectedApprovedIds.size, total: approvedDraftsList.length });
  $("#btnPreviewBatchSchedule").disabled = selectedApprovedIds.size === 0;
}

function toggleApprovedSelection(id, checked) {
  if (checked) selectedApprovedIds.add(id); else selectedApprovedIds.delete(id);
  renderApprovedSelectionList();
}

async function previewBatchSchedule() {
  const draftIds = Array.from(selectedApprovedIds);
  const errorEl = $("#batchScheduleError");
  errorEl.textContent = "";
  setBtnLoading("#btnPreviewBatchSchedule", "미리보기 계산 중...");
  const r = await api("/drafts/batch-schedule/preview", { method: "POST", body: JSON.stringify({ draftIds }) });
  resetBtn("#btnPreviewBatchSchedule", t("btnPreviewBatchSchedule"));
  if (r && r.success) {
    renderBatchPreviewTable(r.assignments);
    $("#batchPreviewCard").style.display = "";
    $("#batchPreviewCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else {
    alert(t("previewFail") + (r?.error || t("errUnknown")));
  }
}

function renderBatchPreviewTable(assignments) {
  const table = $("#batchPreviewTable");
  table.innerHTML = `
    <thead><tr><th>${t("thDraft")}</th><th>${t("thDate")}</th><th>${t("thTime")}</th></tr></thead>
    <tbody>
      ${assignments
        .map(
          // 시스템 draft id는 화면에 쓰지 않는다(초안함 카드와 동일 정책) - 글은 제목으로 알아본다.
          // 내부 식별은 그대로 a.draftId를 쓰고, 확정 요청도 selectedApprovedIds로 보낸다.
          (a) => `<tr><td>${escapeHtml((a.title || "").slice(0, 30) || t("noTitle"))}</td><td>${escapeHtml(a.dateKST)}</td><td>${escapeHtml(a.timeKST)}</td></tr>`
        )
        .join("")}
    </tbody>
  `;
}

// 미리보기는 DB를 전혀 바꾸지 않았으므로, 취소는 화면만 닫으면 됩니다(서버 호출 없음).
function cancelBatchPreview() {
  $("#batchPreviewCard").style.display = "none";
  $("#batchPreviewTable").innerHTML = "";
}

async function confirmBatchSchedule() {
  const draftIds = Array.from(selectedApprovedIds);
  const errorEl = $("#batchScheduleError");
  errorEl.textContent = "";
  setBtnLoading("#btnConfirmBatchSchedule", t("confirmingScheduleBtn"));
  const r = await postScheduleWithLinkConfirm({ url: "/drafts/batch-schedule/confirm", method: "POST" }, { draftIds });
  resetBtn("#btnConfirmBatchSchedule", t("btnConfirmBatchSchedule"));
  if (r === null) return; // 사용자가 확인창에서 취소 - 버튼은 위에서 이미 되돌렸다
  if (r && r.success) {
    alert(t("scheduledCountDone", { n: r.scheduled }));
    selectedApprovedIds.clear();
    cancelBatchPreview();
    await loadApprovedSelectionList();
    refreshAfterScheduleChange(); // 예약함 + 상단 "다음 예약" 정보 즉시 갱신
  } else {
    errorEl.textContent = t("confirmScheduleFail") + (r?.error || t("errUnknown"));
  }
}

// ---------------- 초안함 ----------------
// P1.3: 초안함 = "만든 글을 확인·수정·승인하는 곳". 구매자 filter는 chip 4개
// (전체/검토중/승인됨/거절됨)뿐이고, 예약 이후 downstream 상태(scheduled/publishing/
// published/failed 등)는 예약 관리 담당이라 목록에서 표시하지 않는다.
// DB 상태값/row/서버 상태 머신은 전혀 바꾸지 않는다 - 표시만 제한한다.
const DRAFTBOX_STATUSES = ["draft", "approved", "rejected"]; // [전체]가 의미하는 초안함 관리 상태

// 초안함 선택 삭제용 선택 상태(draft id). 목록을 다시 그릴 때마다 비운다 - 필터를 바꾸면
// 화면에 없는 초안이 선택된 채 남아 "안 보이는 글이 지워지는" 사고를 막는다.
let draftSelection = new Set();
// 현재 화면에 실제로 표시 중인 초안 id(전체 선택의 범위 = 딱 이 목록).
let draftVisibleIds = [];

// 초안함 표시 순서: 직접 작성 초안만 작업 순번(01,02,03...) 오름차순으로 보여 준다.
//
// 목록 자체는 서버가 기존 정책(id DESC = 최신 우선) 그대로 내려주고, 여기서는 "manual 초안이
// 이미 차지하고 있는 자리"에만 순번 오름차순으로 다시 채워 넣는다. AI 생성 초안은 인덱스가
// 하나도 움직이지 않으므로 기존 정렬 정책이 그대로 유지된다(그룹을 새로 나누지 않는다).
// listDrafts()의 SQL은 scheduler/예약 관리/발행 기록이 함께 쓰므로 건드리지 않는다.
function orderDraftboxList(list) {
  const slots = [];
  const manuals = [];
  list.forEach((d, i) => {
    if (d && d.source_type === "manual") {
      slots.push(i);
      manuals.push(d);
    }
  });
  if (manuals.length < 2) return list; // 0~1개면 재배치할 것이 없다
  const seqOf = (d) => (Number.isFinite(d.manual_sequence) ? d.manual_sequence : Number.MAX_SAFE_INTEGER);
  // 순번이 같거나(정상적으로는 없음) 비어 있으면 id 오름차순으로 안정적으로 정렬한다.
  manuals.sort((a, b) => seqOf(a) - seqOf(b) || a.id - b.id);
  const out = list.slice();
  slots.forEach((slot, i) => {
    out[slot] = manuals[i];
  });
  return out;
}

// 직접 작성 순번 표시. 최소 2자리 zero-padding이고 100 이상은 그대로 3자리로 늘어난다.
function formatManualSequence(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return String(Math.floor(v)).padStart(2, "0");
}
let draftStatusFilterValue = ""; // "" = 전체(위 3종)
const DRAFT_FILTER_CHIPS = [
  ["", "statusAll"],
  ["draft", "statusDraft"], // 구매자 표시명 "검토중"(DB 값 rename 아님)
  ["approved", "statusApproved"],
  ["rejected", "statusRejected"],
];

function renderDraftFilterChips() {
  const el = $("#draftFilterChips");
  if (!el) return;
  el.innerHTML = DRAFT_FILTER_CHIPS.map(
    ([v, key]) =>
      `<button type="button" class="draft-filter-chip${draftStatusFilterValue === v ? " chip-active" : ""}" data-draft-filter="${v}" aria-pressed="${draftStatusFilterValue === v}">${t(key)}</button>`
  ).join("");
  el.querySelectorAll("[data-draft-filter]").forEach((b) => {
    b.addEventListener("click", () => {
      draftStatusFilterValue = b.dataset.draftFilter;
      renderDraftFilterChips();
      loadDrafts();
    });
  });
}

async function loadDrafts() {
  // adversarial 리뷰 발견: draftMediaDetailCache가 재부착(예: "미디어 다시 선택" 후 새
  // job/asset attach) 뒤에도 무효화되지 않아, 같은 세션에서 "미디어 보기"를 다시 열면 예전
  // 미디어 상세를 그대로 보여줄 수 있었다(카드 배지는 최신인데 상세만 예전 것) - 목록을
  // 다시 불러올 때(탭 재진입/승인·거절 후/필터 변경 등, 이 함수가 호출되는 모든 지점)마다
  // 캐시를 비워 다음 "미디어 보기" 클릭 시 항상 서버에서 다시 조회하게 한다.
  draftMediaDetailCache.clear();
  const status = draftStatusFilterValue;
  const r = await api("/drafts" + (status ? "?status=" + status : ""));
  const list = $("#draftsList");
  // 비울 수 있는 초안이 0건이면 [초안함 비우기]를 눌러볼 수 없게 한다(요청서 D-2).
  refreshPurgeDraftsButtonState();
  // 승인 글 선택/일괄 자동배치 UI는 "예약 관리" 화면으로 이동했으므로, 여기서는 더 이상 갱신하지 않습니다.
  const all = r && r.drafts ? r.drafts : [];
  // [전체]는 DB 전체가 아니라 "초안함이 관리하는 상태"다 - downstream(예약/발행)은 제외.
  // 필터를 먼저 적용한 뒤 재배치한다 - 전체/검토중/승인됨/거절됨 어느 필터에서도
  // 화면에 보이는 직접 작성 초안이 항상 01, 02, 03 … 순서로 나온다.
  const visible = orderDraftboxList(
    status ? all.filter((d) => d.status === status) : all.filter((d) => DRAFTBOX_STATUSES.includes(d.status))
  );
  // 목록을 새로 그리면 선택은 항상 초기화한다(필터 이동/삭제/승인 후 모두 이 경로를 지난다).
  // 빈 목록으로 끝나는 경우(예: 선택 삭제로 마지막 초안까지 지운 직후)에도 반드시 지나야
  // 하므로 아래 early return보다 앞에 둔다 - 그러지 않으면 [선택 삭제 (n)]이 지워진 초안
  // 개수를 그대로 달고 활성 상태로 남는다.
  draftSelection = new Set();
  draftVisibleIds = visible.map((d) => d.id);
  refreshDraftSelectionUi();
  if (visible.length === 0) {
    // P1.3 빈 상태: 특정 생성 방식만 안내하지 않는다 - 글을 만들면 자동 저장됨을 알리고
    // 대표 진입점으로 연결한다(기존 showView 재사용).
    list.innerHTML = `
      <div class="card">
        <p class="muted">${t("draftsEmptyTitle")}</p>
        <p class="muted">${t("draftsEmptyDesc")}</p>
        <div class="actions">
          <button type="button" class="secondary" onclick="showView('editor')">${t("home.cardEditorTitle")}</button>
          <button type="button" class="secondary" onclick="showView('materials')">${t("navMaterials")}</button>
        </div>
      </div>`;
    return;
  }
  list.innerHTML = visible.map((d) => draftCardHtml(d, { selectable: true })).join("");
  bindDraftSourceOpenButtons(list, visible);
  bindDraftSelectionCheckboxes(list);
  bindDraftCardMedia(list, visible);
  releaseDraftMediaEditsForList(list); // 이 목록을 새로 그렸으므로 이 목록의 미저장 선택만 버린다
  bindDraftMediaEditControls(list);
  refreshDraftSelectionUi();
}

// ==================================================================================
// 초안 선택 삭제 - 삭제 자체는 기존 "초안함 비우기"와 같은 서버 정책(findPurgeableDrafts)을
// 재사용하는 POST /drafts/delete-selected 하나만 쓴다. 새 삭제 시스템을 만들지 않는다.
// ==================================================================================
function bindDraftSelectionCheckboxes(listEl) {
  listEl.querySelectorAll("[data-draft-select]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = Number(cb.dataset.draftSelect);
      if (cb.checked) draftSelection.add(id);
      else draftSelection.delete(id);
      refreshDraftSelectionUi();
    });
  });
}

function refreshDraftSelectionUi() {
  const bar = $("#draftSelectionBar");
  if (bar) bar.style.display = draftVisibleIds.length > 0 ? "" : "none";
  const delBtn = $("#btnDeleteSelectedDrafts");
  if (delBtn) {
    delBtn.textContent = t("draftSelect.deleteButton", { n: draftSelection.size });
    delBtn.disabled = draftSelection.size === 0;
  }
  const allBtn = $("#btnSelectAllDrafts");
  if (allBtn) {
    // 화면에 보이는 것이 전부 선택돼 있으면 같은 버튼이 [선택 해제]로 동작한다.
    const allSelected = draftVisibleIds.length > 0 && draftVisibleIds.every((id) => draftSelection.has(id));
    allBtn.textContent = allSelected ? t("draftSelect.clearAll") : t("draftSelect.selectAll");
    allBtn.dataset.mode = allSelected ? "clear" : "select";
  }
}

function toggleSelectAllDrafts() {
  const allBtn = $("#btnSelectAllDrafts");
  const clearing = allBtn && allBtn.dataset.mode === "clear";
  // 범위는 "현재 필터에서 화면에 보이는 초안"뿐이다 - 숨겨진 상태의 초안은 절대 포함하지 않는다.
  draftSelection = clearing ? new Set() : new Set(draftVisibleIds);
  document.querySelectorAll("[data-draft-select]").forEach((cb) => {
    cb.checked = draftSelection.has(Number(cb.dataset.draftSelect));
  });
  refreshDraftSelectionUi();
}

async function deleteSelectedDrafts() {
  const ids = [...draftSelection];
  if (ids.length === 0) return;
  if (!confirm(t("draftSelect.confirmDelete", { n: ids.length }))) return;
  const resp = await api("/drafts/delete-selected", { method: "POST", body: JSON.stringify({ ids }) });
  const feedback = $("#draftsPurgeFeedback");
  if (!resp || !resp.ok) {
    if (feedback) {
      feedback.style.display = "";
      feedback.textContent = t("draftSelect.deleteFail");
    }
    return;
  }
  if (feedback) {
    feedback.style.display = "";
    // 예약/발행 이력으로 보호된 초안이 섞여 있었으면 이유를 화면에 그대로 알린다.
    feedback.textContent =
      resp.blocked && resp.blocked.length > 0
        ? t("draftSelect.deletedWithBlocked", { n: resp.deleted, b: resp.blocked.length })
        : t("draftSelect.deleted", { n: resp.deleted });
  }
  draftSelection = new Set(); // loadDrafts()도 비우지만, 실패 경로와 무관하게 여기서도 확실히 0으로.
  loadDrafts();
}

// P1.6(AUD-P1-002): draftCardHtml을 쓰는 두 목록(초안함/예약 관리의 예약된 글)이 공유하는
// [원문 열기] 바인딩. 외부 source_url을 inline handler에 넣지 않고 여기서 scheme 검증 후 연다.
function bindDraftSourceOpenButtons(listEl, drafts) {
  const byId = new Map(drafts.map((d) => [String(d.id), d]));
  listEl.querySelectorAll("[data-open-source-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = byId.get(btn.dataset.openSourceId);
      if (d) openExternalHttpUrl(d.source_url);
    });
  });
}

const STATUS_LABEL_KEYS = {
  draft: "statusDraft",
  approved: "statusApproved",
  scheduled: "statusScheduled",
  publishing: "statusPublishing",
  published: "statusPublished",
  failed: "statusFailed",
  rejected: "statusRejected",
  dry_run_done: "statusDryRunDone",
};
function statusLabel(status) {
  return STATUS_LABEL_KEYS[status] ? t(STATUS_LABEL_KEYS[status]) : status;
}

function draftCardHtml(d, opts) {
  const isAffiliate = d.source_type === "affiliate_product";
  // 체크박스는 초안함에서만 보인다(같은 카드 렌더러를 쓰는 "예약 관리"에는 붙이지 않는다).
  const selectable = !!(opts && opts.selectable);
  // 직접 작성 순번: manual 초안에만 있다. AI 생성 초안은 manual_sequence가 NULL이라 자동으로 빠진다.
  const manualSeq = formatManualSequence(d.manual_sequence);
  // 직접 쓴 글에는 주제/신뢰도/말투 데이터 자체가 없어 전부 "-"로만 찍힌다 - 화면에서만 숨긴다
  // (DB/API 값은 그대로 두고 렌더링 조건만 바꾼다). AI 생성 초안은 기존 표시 그대로다.
  const isManual = d.source_type === "manual";
  return `
    <div class="item-card" id="draft-${d.id}">
      <div class="meta">
        ${selectable ? `<input type="checkbox" class="draft-select" data-draft-select="${d.id}" aria-label="${escapeHtml(t("draftSelect.checkboxLabel", { id: d.id }))}" />` : ""}
        <span class="status-badge status-${d.status}">${statusLabel(d.status)}</span>
        ${isAffiliate ? `<span class="status-badge status-affiliate">${t("affiliateBadge")}</span>` : ""}
        ${manualSeq ? `<span class="status-badge status-manual">${escapeHtml(t("draftManualSeqBadge", { n: manualSeq }))}</span>` : ""}
        ${isManual ? "" : `${t("labelTopic")}: ${escapeHtml(d.topic || "-")} · ${t("labelConfidence")}: ${escapeHtml(d.confidence || "-")} · ${t("labelPersonaVer")}${d.persona_version ?? "-"} · `}${t("labelCreated")}: ${fmtDate(d.created_at)}
        ${d.scheduled_at ? "· " + t("labelPublishAt") + ": " + fmtDateMinute(d.scheduled_at) : ""}
      </div>
      <textarea class="edit-body" id="body-${d.id}" ${DRAFT_MEDIA_EDITABLE_STATUSES.includes(d.status) ? "" : "readonly"}>${escapeHtml(d.body)}</textarea>
      ${d.risk_notes ? `<div class="muted">${t("riskNotesLabel")}${escapeHtml(d.risk_notes)}</div>` : ""}
      ${isAffiliate ? `
        <div class="affiliate-meta">
          ${d.media_filename ? `
            <div class="media-preview">
              ${d.media_type === "video"
                ? `<video src="/api/affiliate/media/${encodeURIComponent(d.media_filename)}" controls style="max-width:100%;max-height:240px;"></video>`
                : `<img src="/api/affiliate/media/${encodeURIComponent(d.media_filename)}" style="max-width:100%;max-height:240px;" />`}
              <div class="muted">${mediaPublishNoteText()}</div>
            </div>
          ` : ""}
          <div class="kv">
            <div>${t("labelProductNameShort")}</div><div>${escapeHtml(d.product_name || "-")}</div>
            <div>${t("labelUsageStatusShort")}</div><div>${d.usage_status === "used" ? t("usageUsed") : t("usageNotUsed")}</div>
            <div>${t("labelAffiliateLinkShort")}</div><div style="word-break:break-all;">${escapeHtml(d.affiliate_url || "-")}</div>
            <div>${t("labelDisclosureShort")}</div><div>${escapeHtml(d.disclosure_text || "-")}</div>
            <div>${t("labelGenType")}</div><div>${escapeHtml(PROMOTION_STYLE_LABELS[d.promotion_style] || d.promotion_style || "-")}</div>
          </div>
        </div>
      ` : `
        <div class="muted">
          ${t("referenceMaterial")}${d.source_title ? escapeHtml(d.source_title) : t("noSpecificMaterial")}
          ${d.source_material_id ? `<span class="status-badge status-approved">${t("materialLibraryBadge")}${d.source_material_id}</span>` : ""}
        </div>
      `}
      ${buildDraftMediaSectionHtml(d)}
      <div class="actions">
        ${DRAFT_MEDIA_EDITABLE_STATUSES.includes(d.status) ? `<button class="secondary" onclick="saveDraftBody(${d.id}, this)">${t("btnSaveEdit")}</button>` : ""}
        ${d.status === "draft" ? `<button class="success" onclick="approveDraft(${d.id})">${t("btnApprove")}</button>` : ""}
        ${d.status === "draft" ? `<button class="danger" onclick="rejectDraft(${d.id})">${t("btnReject")}</button>` : ""}
        ${d.status === "draft" && !isAffiliate ? `<button class="secondary" onclick="regenerateDraft(${d.id})">${t("btnRegenerate")}</button>` : ""}
        <button class="secondary" onclick="copyDraft(${d.id}, this)">${t("btnCopy")}</button>
        ${d.source_url && !isAffiliate ? `<button class="secondary" data-open-source-id="${d.id}">${t("btnOpenSource")}</button>` : ""}
        ${d.status === "approved" ? `
          <input type="datetime-local" id="sched-${d.id}" />
          <button class="success" onclick="scheduleDraft(${d.id})">${t("btnScheduleThis")}</button>
        ` : ""}
        ${d.status === "scheduled" ? `<button class="secondary" onclick="toggleRescheduleBox(${d.id}, true)">${t("btnChangeSchedule")}</button>` : ""}
        ${d.status === "scheduled" ? `<button class="danger" onclick="cancelDraftSchedule(${d.id})">${t("btnCancelSchedule")}</button>` : ""}
      </div>
      ${d.status === "scheduled" ? `
        <div class="reschedule-box" id="reschedule-box-${d.id}" style="display:none;">
          <input type="datetime-local" id="resched-${d.id}" value="${toSeoulDatetimeLocalValue(d.scheduled_at)}" />
          <button class="success" onclick="saveReschedule(${d.id})">${t("btnSaveReschedule")}</button>
          <button class="secondary" onclick="toggleRescheduleBox(${d.id}, false)">${t("btnClose")}</button>
        </div>
      ` : ""}
    </div>
  `;
}


// ==================================================================================
// 초안 카드 미디어 편집 - 첨부 없음이면 [파일 선택], 있으면 [파일 변경]/[미디어 제거].
// 고른 파일은 [수정 저장]을 누를 때까지 화면에만 있다(서버/DB 무변경). 저장 시에만
// 기존 미디어 보관함 업로드로 올려 assetKey를 받고, PATCH 한 번으로 본문과 함께 반영한다.
// 카테고리(이미지/영상/캐러셀)는 고른 파일에서 자동 판정한다 - 카드에 별도 선택 UI를
// 만들지 않기 위해서다.
// ==================================================================================
// 화면(view)은 숨겨질 뿐 DOM에서 지워지지 않는다. 그래서 초안함을 본 뒤 그 글이 예약되면
// 초안함에는 옛 카드가, 예약 목록에는 현재 카드가 "같은 draft id로" 동시에 남는다.
// 상태 키를 목록까지 포함해 나눠야 한 쪽에서 파일을 고를 때 다른 쪽 카드의 objectURL을
// 해제해 미리보기를 깨뜨리는 일이 없다. 키는 "<목록 element id>:<draftId>"다.
const draftMediaEdits = new Map(); // "listId:draftId" -> { files: File[]|null, remove: bool, urls: string[] }

// 카드 안의 아무 element에서든 그 카드가 속한 목록을 찾아 상태 키를 만든다.
// 목록을 못 찾으면(테스트 등 분리된 DOM) draftId만으로 키를 만들어 기존 동작을 유지한다.
function draftMediaEditKeyFor(el, id) {
  const list = el && el.closest ? el.closest("#draftsList, #scheduleList") : null;
  return (list && list.id ? list.id : "list") + ":" + id;
}

function getDraftMediaEdit(key) {
  let e = draftMediaEdits.get(key);
  if (!e) { e = { files: null, remove: false, urls: [] }; draftMediaEdits.set(key, e); }
  return e;
}

function releaseDraftMediaEdit(key) {
  const e = draftMediaEdits.get(key);
  if (!e) return;
  for (const u of e.urls) { try { URL.revokeObjectURL(u); } catch { /* 이미 해제됨 */ } }
  draftMediaEdits.delete(key);
}

// 목록 하나를 다시 그릴 때는 그 목록의 편집 상태만 버린다. 다른 목록에서 사용자가 고르고 있던
// 파일은 건드리지 않는다(예약 관리 30초 자동 갱신이 초안함 선택을 지우던 문제도 함께 사라진다).
function releaseDraftMediaEditsForList(listEl) {
  const prefix = (listEl && listEl.id ? listEl.id : "list") + ":";
  for (const key of [...draftMediaEdits.keys()]) {
    if (key.startsWith(prefix)) releaseDraftMediaEdit(key);
  }
}

// 그 목록에 아직 저장하지 않은 미디어 선택이 남아 있는지(자동 갱신으로 지우면 안 되는 상태).
function hasPendingDraftMediaEdits(listEl) {
  const prefix = (listEl && listEl.id ? listEl.id : "list") + ":";
  for (const [key, e] of draftMediaEdits) {
    if (key.startsWith(prefix) && (e.files || e.remove)) return true;
  }
  return false;
}

// 고른 파일로 카테고리를 판정한다. 지원 범위를 벗어나면 null(호출부가 안내를 띄운다).
function classifyPickedMedia(files) {
  if (!files || files.length === 0) return null;
  const images = files.filter((f) => (f.type || "").startsWith("image/"));
  const videos = files.filter((f) => (f.type || "").startsWith("video/"));
  if (videos.length === 1 && files.length === 1) return "video";
  if (images.length === 1 && files.length === 1) return "image";
  if (images.length === files.length && files.length >= 2 && files.length <= 3) return "carousel";
  return null;
}

// wrap(그 카드의 미디어 편집 영역)을 반드시 인자로 받는다. 예전에는 document 전체에서
// [data-draft-media-edit="<id>"]를 찾았는데, 같은 draft가 두 목록 DOM에 있으면 문서 순서상
// 앞선(초안함) 카드를 잡아 예약 목록 카드의 버튼 라벨이 비어 있는 채로 남았다.
function renderDraftMediaEditState(key, wrap) {
  if (!wrap) return;
  const e = draftMediaEdits.get(key);
  const picked = e && e.files ? e.files : null;
  const removing = !!(e && e.remove);
  const hasServerMedia = wrap.dataset.hasMedia === "1";

  const pickBtn = wrap.querySelector("[data-draft-media-pick]");
  const removeBtn = wrap.querySelector("[data-draft-media-remove]");
  const note = wrap.querySelector("[data-draft-media-note]");
  const box = wrap.querySelector("[data-draft-media-pending]");

  // 첨부가 하나도 없게 될 상태면 [파일 선택], 아니면 [파일 변경]
  const willHaveMedia = picked ? true : removing ? false : hasServerMedia;
  if (pickBtn) pickBtn.textContent = willHaveMedia ? t("media.change") : t("media.pick");
  if (removeBtn) removeBtn.style.display = willHaveMedia ? "" : "none";

  if (note) {
    note.textContent = picked
      ? t("media.pendingReplace", { n: picked.length })
      : removing
        ? t("media.pendingRemove")
        : "";
    note.style.display = picked || removing ? "" : "none";
  }

  // 선택한 새 파일 미리보기(저장 전 로컬 전용)
  if (box) {
    for (const u of (e ? e.urls : [])) { try { URL.revokeObjectURL(u); } catch { /* ok */ } }
    if (e) e.urls = [];
    box.innerHTML = "";
    if (picked) {
      const cat = classifyPickedMedia(picked);
      box.classList.toggle("is-carousel", cat === "carousel");
      box.classList.toggle("is-single", cat !== "carousel");
      if (cat === "video") {
        const url = URL.createObjectURL(picked[0]);
        e.urls.push(url);
        const v = document.createElement("video");
        v.src = url; v.controls = true; v.preload = "metadata";
        v.className = "draft-card-media-item";
        box.appendChild(v);
      } else {
        picked.forEach((f, i) => {
          const url = URL.createObjectURL(f);
          e.urls.push(url);
          const cell = document.createElement("div");
          cell.className = "draft-card-media-cell";
          const img = document.createElement("img");
          img.src = url; img.alt = f.name; img.className = "draft-card-media-item";
          cell.appendChild(img);
          if (cat === "carousel") {
            const badge = document.createElement("span");
            badge.className = "draft-card-media-index";
            badge.textContent = String(i + 1);
            cell.appendChild(badge);
          }
          box.appendChild(cell);
        });
        // 새로 고른 파일의 썸네일도 클릭하면 확대(직접 글 작성과 같은 Common Viewer 경로).
        // e.urls 는 위 루프가 순서대로 채운 object URL 배열이다. 순서/삭제/저장 로직에는 손대지 않는다.
        const pickedNames = picked.map((f) => f.name);
        box.querySelectorAll(".draft-card-media-cell").forEach((cell, i) => bindLocalImageZoom(cell, e.urls, i, pickedNames));
      }
    }
  }

  // 저장 전까지는 서버 미디어를 그대로 보여 주되, 교체/제거 예정이면 흐리게 표시한다.
  const current = wrap.parentElement ? wrap.parentElement.querySelector(".draft-card-media-grid:not([data-draft-media-pending])") : null;
  if (current) current.classList.toggle("is-superseded", !!picked || removing);
}

function bindDraftMediaEditControls(listEl) {
  listEl.querySelectorAll("[data-draft-media-edit]").forEach((wrap) => {
    const id = Number(wrap.dataset.draftMediaEdit);
    const key = draftMediaEditKeyFor(wrap, id); // 이 카드가 속한 목록까지 포함한 키
    const input = wrap.querySelector("[data-draft-media-input]");
    wrap.querySelector("[data-draft-media-pick]")?.addEventListener("click", () => input && input.click());
    input?.addEventListener("change", (ev) => {
      const picked = Array.from(ev.target.files || []);
      if (picked.length === 0) return; // picker 취소 - 이전 상태 유지
      if (!classifyPickedMedia(picked)) {
        alert(t("media.pickInvalid"));
        input.value = "";
        return;
      }
      const e = getDraftMediaEdit(key);
      e.files = picked;
      e.remove = false;
      renderDraftMediaEditState(key, wrap);
    });
    wrap.querySelector("[data-draft-media-remove]")?.addEventListener("click", () => {
      const e = getDraftMediaEdit(key);
      e.files = null;
      e.remove = true;
      if (input) input.value = "";
      renderDraftMediaEditState(key, wrap);
    });
    // 초기 렌더는 "상태 없음"으로 그린다 - 여기서 제거 상태를 만들지 않는다.
    renderDraftMediaEditState(key, wrap);
  });
}

// [수정 저장]이 부를 업로드 - 실패하면 null을 돌려주어 본문 저장까지 중단시킨다
// (본문만 바뀌고 미디어는 그대로인 어중간한 상태를 만들지 않는다).
async function uploadDraftMediaEdit(files) {
  const category = classifyPickedMedia(files);
  if (!category) return null;
  const form = new FormData();
  form.append("category", category);
  for (const f of files) form.append("files", f);
  try {
    const res = await fetch("/api/product-radar/library/assets/upload", { method: "POST", body: form });
    const up = await res.json().catch(() => null);
    return up && up.ok && up.assetKey ? up.assetKey : null;
  } catch {
    return null;
  }
}

// ==================================================================================
// Phase 12.5.3.8: 초안함 미디어 최종 검토(요청서 전체) - 승인 전에 "글 + 현재 attached
// media"를 한 화면에서 확인할 수 있게 한다. 목록 응답의 d.prMediaSummary(가벼운 요약,
// drafts.ts GET /가 N+1 없이 batch 조회해 함께 내려줌)로 배지만 즉시 그리고, 실제 파일
// 배열은 사용자가 "미디어 보기"를 눌러야만 GET /drafts/:id/media로 조회한다(요청서 4·22절
// - 목록 로드 시 전체 media를 미리 fetch하지 않음). Common Viewer(productRadar.js)를
// 그대로 재사용한다(index.html이 productRadar.js를 app.js보다 먼저 로드하므로 이 시점에
// 이미 전역에 있다) - 중복 lightbox를 새로 만들지 않는다(요청서 7절).
// ==================================================================================
const draftMediaDetailCache = new Map(); // draftId -> GET /drafts/:id/media 응답(재조회 방지)
const draftMediaFetchInFlight = new Set(); // 열기/닫기를 빠르게 반복해도 같은 draftId를 중복 fetch하지 않기 위한 가드

function buildDraftMediaBadgeHtml(summary) {
  if (!summary || !summary.hasMedia) {
    return `<span class="status-badge status-manual">${t("draftMedia.none")}</span>`;
  }
  if (summary.category === "carousel") return `<span class="status-badge status-manual">${escapeHtml(t("draftMedia.badgeCarousel", { count: summary.slideCount }))}</span>`;
  if (summary.category === "video") return `<span class="status-badge status-manual">${t("draftMedia.badgeVideo")}</span>`;
  if (summary.category === "gif") return `<span class="status-badge status-manual">${t("draftMedia.badgeGif")}</span>`;
  return `<span class="status-badge status-manual">${t("draftMedia.badgeImage")}</span>`;
}

// 요청서 9절: draftId/recommendation lineage가 있는 Product Radar draft에서만 "미디어 다시
// 선택" 버튼을 보여준다 - 제휴 마케팅/일반 Threads draft에는 절대 표시하지 않는다.
// 초안 카드 안의 상시 미리보기. 목록 응답의 prMediaSummary.files를 그대로 쓴다 - 카드마다
// 추가 요청을 보내지 않는다(N+1 없음). filename은 여기서 문자열로 붙이지 않고 렌더 후
// bindDraftCardMedia()가 DOM property(src)로 대입한다(기존 상세 뷰와 같은 관례).
function buildDraftCardMediaPreviewHtml(d) {
  const s = d.prMediaSummary;
  if (!s || !s.hasMedia || !Array.isArray(s.files) || s.files.length === 0) return "";
  if (!s.files.some((f) => f.available)) return ""; // 파일이 전부 사라졌으면 깨진 <img>를 만들지 않는다
  if (s.category === "video") {
    return `<div class="draft-card-media-grid"><div class="draft-card-media-cell"><video class="draft-card-media-item" controls preload="metadata"></video></div></div>`;
  }
  const isCarousel = s.category === "carousel";
  // slideIndex 순서 = 표시 순서. 배지 숫자도 이 순서를 그대로 따른다.
  const cells = s.files
    .map((f, i) =>
      f.available
        ? `<div class="draft-card-media-cell" data-draft-media-open="${d.id}" data-draft-media-slide="${i}" role="button" tabindex="0" aria-label="${escapeHtml(t("productRadar.library.viewButton"))}">
             <img class="draft-card-media-item" loading="lazy" alt="" />
             ${isCarousel ? `<span class="draft-card-media-index">${i + 1}</span>` : ""}
           </div>`
        : ""
    )
    .join("");
  return `<div class="draft-card-media-grid${isCarousel ? " is-carousel" : ""}">${cells}</div>`;
}

// 미디어 편집 UI. 발행 전(검토중/승인됨/예약됨) 글에만 붙인다 - 이미 발행됐거나 발행 중인
// 글은 서버가 수정을 거부하므로 화면에도 내보내지 않는다.
const DRAFT_MEDIA_EDITABLE_STATUSES = ["draft", "approved", "scheduled"];

function buildDraftMediaEditHtml(d) {
  if (!DRAFT_MEDIA_EDITABLE_STATUSES.includes(d.status)) return "";
  const hasMedia = !!(d.prMediaSummary && d.prMediaSummary.hasMedia);
  return `
    <div class="draft-media-edit" data-draft-media-edit="${d.id}" data-has-media="${hasMedia ? "1" : "0"}">
      <input type="file" class="hidden-file-input" data-draft-media-input="${d.id}" multiple accept="image/*,video/*" />
      <div class="media-actions">
        <button type="button" class="secondary" data-draft-media-pick="${d.id}"></button>
        <button type="button" class="secondary" data-draft-media-remove="${d.id}">${t("media.remove")}</button>
      </div>
      <p class="muted" data-draft-media-note="${d.id}" style="display:none;"></p>
      <div class="draft-card-media-grid" data-draft-media-pending="${d.id}"></div>
    </div>
  `;
}

function buildDraftMediaSectionHtml(d) {
  const hasMedia = !!(d.prMediaSummary && d.prMediaSummary.hasMedia);
  const editHtml = buildDraftMediaEditHtml(d);
  // 첨부도 없고 편집도 불가한 글(이미 발행됨 등)에만 미디어 영역을 아예 만들지 않는다.
  if (!hasMedia && !editHtml) return "";
  return `
    <div class="pr-draft-media" data-pr-draft-media="${d.id}">
      <strong>${hasMedia ? t("draftMedia.currentTitle") : t("draftMedia.noneTitle")}</strong>
      ${hasMedia ? buildDraftMediaBadgeHtml(d.prMediaSummary) : ""}
      ${hasMedia ? buildDraftCardMediaPreviewHtml(d) : ""}
      ${editHtml}
      ${hasMedia ? `
      <div class="actions">
        <button type="button" class="secondary" data-pr-draft-media-toggle="${d.id}" onclick="toggleDraftMediaSection(${d.id}, this)">${t("draftMedia.viewButton")}</button>
      </div>` : ""}
      <div class="pr-draft-media-body" id="pr-draft-media-body-${d.id}" style="display:none;"></div>
    </div>
  `;
}

// origin에 따라 안전 서빙 route가 다르다(요청서 8절, 새 route 없음 - 기존 두 route 재사용) -
// generated/user_upload는 Product Radar 전용 route, legacy(제휴 마케팅 첨부)는 기존
// affiliate route를 그대로 쓴다(둘 다 같은 UPLOAD_DIR을 안전하게 서빙할 뿐 - mediaUpload.ts
// 재사용).
function buildDraftMediaFileUrl(origin, filename) {
  const base = origin === "legacy" ? "/api/affiliate/media/" : "/api/product-radar/media/";
  return base + encodeURIComponent(filename);
}

// 카드 상시 미리보기의 src 대입과 클릭 확대 바인딩. filename을 HTML 문자열로 붙이지 않고
// 여기서 DOM property로 넣는다(기존 상세 뷰와 동일한 관례).
function bindDraftCardMedia(listEl, drafts) {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  listEl.querySelectorAll("[data-pr-draft-media]").forEach((section) => {
    const d = byId.get(Number(section.dataset.prDraftMedia));
    const s = d && d.prMediaSummary;
    if (!s || !s.hasMedia || !Array.isArray(s.files)) return;
    const origin = s.origin;

    if (s.category === "video") {
      const v = section.querySelector("video.draft-card-media-item");
      const first = s.files.find((f) => f.available);
      if (v && first) v.src = buildDraftMediaFileUrl(origin, first.filename);
      return;
    }

    section.querySelectorAll("[data-draft-media-open]").forEach((cell) => {
      const idx = Number(cell.dataset.draftMediaSlide);
      const file = s.files[idx];
      const img = cell.querySelector("img.draft-card-media-item");
      if (img && file) img.src = buildDraftMediaFileUrl(origin, file.filename);
      const open = () => openDraftMediaViewerAt(Number(cell.dataset.draftMediaOpen), idx);
      cell.addEventListener("click", open);
      cell.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    });
  });
}

// 카드 썸네일 클릭 확대. 새 Lightbox를 만들지 않고 기존 Common Viewer 경로
// (openDraftMediaViewer)를 그대로 쓰되, 상세가 아직 캐시에 없으면 그때 한 번만
// GET /drafts/:id/media를 부른다(목록 로드 시점에는 절대 부르지 않는다).
async function openDraftMediaViewerAt(draftId, startIndex) {
  if (!draftMediaDetailCache.has(draftId)) {
    if (draftMediaFetchInFlight.has(draftId)) return;
    draftMediaFetchInFlight.add(draftId);
    let resp;
    try {
      resp = await api(`/drafts/${draftId}/media`);
    } finally {
      draftMediaFetchInFlight.delete(draftId);
    }
    if (!resp || !resp.ok) return;
    draftMediaDetailCache.set(draftId, resp);
  }
  openDraftMediaViewer(draftId, startIndex);
}

async function toggleDraftMediaSection(draftId, clickedBtn) {
  // id가 중복될 수 있으므로(같은 draft가 두 목록 DOM에 존재) 누른 버튼이 속한 카드 안에서 찾는다.
  const card = clickedBtn && clickedBtn.closest ? clickedBtn.closest(".item-card") : null;
  const body = (card && card.querySelector('[id="pr-draft-media-body-' + draftId + '"]')) || document.getElementById("pr-draft-media-body-" + draftId);
  const btn = clickedBtn || (card && card.querySelector('[data-pr-draft-media-toggle="' + draftId + '"]')) || document.querySelector('[data-pr-draft-media-toggle="' + draftId + '"]');
  if (!body) return;
  const opening = body.style.display === "none";
  if (!opening) {
    body.style.display = "none";
    if (btn) btn.textContent = t("draftMedia.viewButton");
    return;
  }
  body.style.display = "";
  if (btn) btn.textContent = t("draftMedia.hideButton");

  if (!draftMediaDetailCache.has(draftId)) {
    if (draftMediaFetchInFlight.has(draftId)) return; // 이미 요청 중 - 열기/닫기 빠른 반복으로 인한 중복 fetch 방지
    draftMediaFetchInFlight.add(draftId);
    body.innerHTML = `<p class="muted">${t("loading")}</p>`;
    let resp;
    try {
      resp = await api(`/drafts/${draftId}/media`);
    } finally {
      // api()가 네트워크 예외로 reject되는 경우까지 포함해 항상 in-flight 표시를 지운다 -
      // 그렇지 않으면 그 draftId는 이후 영원히 다시 fetch를 시도할 수 없게 된다.
      draftMediaFetchInFlight.delete(draftId);
    }
    // 토글이 열려 있는 동안(await 중) 사용자가 다시 닫았을 수 있다 - 그 경우 방금 받은
    // 응답으로 다시 열어버리지 않는다(요청서 어디에도 명시는 없지만 다른 Product Radar
    // 비동기 핸들러와 동일한 stale 방지 관례를 그대로 따른다).
    if (body.style.display === "none") return;
    if (!resp || !resp.ok) {
      body.innerHTML = `<p class="pr-status-line pr-bad">${t("draftMedia.loadError")}</p>`;
      return;
    }
    draftMediaDetailCache.set(draftId, resp);
  }
  renderDraftMediaDetailBody(draftId, body);
}

function renderDraftMediaDetailBody(draftId, bodyEl) {
  const detail = draftMediaDetailCache.get(draftId);
  if (!detail || !detail.ok) {
    bodyEl.innerHTML = `<p class="pr-status-line pr-bad">${t("draftMedia.loadError")}</p>`;
    return;
  }
  if (!detail.hasMedia) {
    bodyEl.innerHTML = `<p class="muted">${t("draftMedia.noneDetail")}</p>`;
    return;
  }

  const originBadge =
    detail.origin === "legacy"
      ? ""
      : `<span class="status-badge status-manual">${t(detail.origin === "generated" ? "productRadar.library.origin.generated" : "productRadar.library.origin.user_upload")}</span>`;
  const categoryBadge = `<span class="status-badge status-manual">${t("productRadar.library.category." + detail.category)}</span>`;
  // adversarial 리뷰 발견: carousel에서 files[0](첫 slide) 하나만으로 전체 가용성을 판단하면
  // 첫 slide만 지워져도 나머지 2·3번째 slide가 멀쩡히 남아있어도 전부 숨겨진다 - "적어도
  // 하나라도 available한지"로 판단하고, 개별 slide의 missing 여부는 기존 Common Viewer가
  // 이미 하는 것처럼 뷰어 안에서 slide별로 처리한다(요청서 5·10절 - 일부만 사라져도 안전하게).
  const hasAnyAvailable = detail.files.some((f) => f.available);
  const thumbnailFile = detail.files.find((f) => f.available) || detail.files[0];
  const missingHtml = !hasAnyAvailable ? `<p class="pr-status-line pr-bad">${t("productRadar.library.error.missing")}</p>` : "";
  const isVideo = detail.category === "video";
  const mediaHtml = !hasAnyAvailable
    ? ""
    : isVideo
      ? `<video class="pr-draft-media-video" controls preload="metadata"></video>`
      : `<div class="pr-draft-media-thumb-wrap" data-pr-draft-media-open="${draftId}" role="button" tabindex="0" aria-label="${escapeHtml(t("productRadar.library.viewButton"))}"><img class="pr-library-thumb" alt="" /></div>`;
  const downloadHtml = !hasAnyAvailable
    ? ""
    : detail.files.length > 1 && detail.assetKey
      ? `<a class="secondary" href="${buildProductRadarLibraryZipUrl(detail.assetKey)}" download>${t("productRadar.library.downloadButton")}</a>`
      : `<a class="secondary" href="${buildDraftMediaFileUrl(detail.origin, thumbnailFile.filename)}" download>${t("productRadar.library.downloadButton")}</a>`;

  bodyEl.innerHTML = `
    ${originBadge} ${categoryBadge}
    ${missingHtml}
    ${mediaHtml}
    <p class="muted">${mediaPublishNoteText()}</p>
    <div class="actions">
      ${!isVideo && hasAnyAvailable ? `<button type="button" class="secondary" onclick="openDraftMediaViewer(${draftId})">${t("productRadar.library.viewButton")}</button>` : ""}
      ${downloadHtml}
    </div>
  `;

  // filename을 raw HTML 문자열로 concat하지 않고 DOM property로 대입한다(요청서 23절).
  if (hasAnyAvailable) {
    const mediaEl = bodyEl.querySelector(isVideo ? ".pr-draft-media-video" : ".pr-library-thumb");
    if (mediaEl) mediaEl.src = buildDraftMediaFileUrl(detail.origin, thumbnailFile.filename);
    if (!isVideo) {
      const openEl = bodyEl.querySelector("[data-pr-draft-media-open]");
      if (openEl) {
        const open = () => openDraftMediaViewer(draftId);
        openEl.addEventListener("click", open);
        openEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        });
      }
    }
  }
}

// Common Viewer(productRadar.js) 재사용 - carousel/image/gif만 대상(video는 위에서 이미
// <video controls> 인라인 플레이어로 표시하므로 별도 큰 viewer를 열지 않는다, 요청서 7절).
// adversarial 리뷰 발견: Common Viewer 본체(openProductRadarLibraryViewer)는 항상
// buildProductRadarMediaPreviewUrl(Product Radar 전용 서빙 경로)로 파일 URL을 만드는데,
// legacy(제휴 마케팅) 첨부는 실제로는 /api/affiliate/media/ 경로를 써야 한다(현재는 두
// 경로 구현이 우연히 동일해서 깨지지 않을 뿐, 설계상 옳지 않다) - 각 file에 origin에 맞는
// url을 미리 계산해 넣어서 뷰어가 그 값을 우선 쓰도록 한다(뷰어 쪽 fallback은 무변경이라
// 기존 호출부는 전혀 영향 없음).
function openDraftMediaViewer(draftId, requestedIndex) {
  const detail = draftMediaDetailCache.get(draftId);
  if (!detail || !detail.ok || !detail.hasMedia || detail.category === "video") return;
  const files = detail.files.map((f) => ({ ...f, url: buildDraftMediaFileUrl(detail.origin, f.filename) }));
  // 카드에서 특정 슬라이드를 눌렀으면 그 슬라이드부터 연다. 그 슬라이드가 사라졌거나
  // 범위를 벗어나면 기존 동작대로 "available한 첫 파일"로 되돌린다.
  const requested = Number(requestedIndex);
  const useRequested = Number.isInteger(requested) && requested >= 0 && requested < files.length && files[requested].available;
  const startIndex = useRequested
    ? requested
    : Math.max(
        files.findIndex((f) => f.available),
        0
      );
  const list = [{ category: detail.category, files }];
  openProductRadarLibraryViewer(list, 0, startIndex);
}

function toggleRescheduleBox(id, show) {
  const box = $("#reschedule-box-" + id);
  if (box) box.style.display = show ? "flex" : "none";
}

// 예약 취소/시간 변경 후에는 현재 보고 있는 목록(초안함/예약 관리)과 상단 상태바(다음 예약 시간 등)를 즉시 갱신합니다.
// "예약된 글"은 이제 예약 관리 화면의 서브탭이라, 예약 관리 화면이 열려 있으면 서브탭과 무관하게
// 예약된 글 목록과 승인 글 선택 목록(취소 시 approved로 돌아가므로) 둘 다 갱신합니다.
function refreshAfterScheduleChange() {
  loadDashboard();
  const draftsView = $("#view-drafts");
  const schedMgmtView = $("#view-schedulemgmt");
  if (draftsView && draftsView.classList.contains("active")) loadDrafts();
  if (schedMgmtView && schedMgmtView.classList.contains("active")) {
    loadSchedule();
    loadApprovedSelectionList();
  }
}

async function cancelDraftSchedule(id) {
  if (!confirm(t("confirmCancelSchedule"))) return;
  const r = await api(`/drafts/${id}/cancel-schedule`, { method: "POST" });
  if (r && r.success) refreshAfterScheduleChange();
  else alert(t("cancelScheduleFail") + (r?.error || ""));
}

async function saveReschedule(id) {
  const input = $("#resched-" + id);
  if (!input || !input.value) { alert(t("alertSelectTimeRequired")); return; }
  const r = await postScheduleWithLinkConfirm({ url: `/drafts/${id}/reschedule`, method: "PATCH" }, { scheduled_at: input.value });
  if (r === null) return; // 사용자가 확인창에서 취소
  if (r && r.success) { toggleRescheduleBox(id, false); refreshAfterScheduleChange(); }
  else alert(t("rescheduleFail") + (r?.error || ""));
}

// [수정 저장] - 본문과 미디어 변경을 한 번에 반영한다.
// 새 파일을 골랐으면 먼저 미디어 보관함에 업로드해 assetKey를 받고, 그 다음 PATCH 한 번으로
// 본문과 함께 보낸다(서버가 한 transaction으로 처리). 업로드가 실패하면 PATCH를 아예 보내지
// 않으므로 "본문만 바뀌고 미디어는 그대로"인 어중간한 상태가 생기지 않는다.
async function saveDraftBody(id, btn) {
  // 같은 draft가 두 목록 DOM에 동시에 있으면 #body-<id>가 중복이라 document 조회는 옛 카드의
  // textarea를 잡는다. 누른 버튼이 속한 카드 안에서만 찾는다(못 찾으면 기존 경로로 폴백).
  const card = btn && btn.closest ? btn.closest(".item-card") : null;
  const textarea = (card && card.querySelector("textarea.edit-body")) || $("#body-" + id);
  if (!textarea) return;
  const body = textarea.value;
  const key = draftMediaEditKeyFor(card || textarea, id);
  const edit = draftMediaEdits.get(key);
  const payload = { body };

  if (edit && edit.files) {
    const assetKey = await uploadDraftMediaEdit(edit.files);
    if (!assetKey) {
      alert(t("media.uploadFail"));
      return; // 본문도 저장하지 않는다
    }
    payload.assetKey = assetKey;
  } else if (edit && edit.remove) {
    payload.assetKey = null;
  }

  const r = await api("/drafts/" + id, { method: "PATCH", body: JSON.stringify(payload) });
  if (r && r.success) {
    releaseDraftMediaEdit(key);
    alert(t("saveSuccess"));
    // 바뀐 미디어를 카드에 즉시 반영한다. 예약 목록에서 저장했으면 그 목록을 다시 읽는다
    // (예약 상태/발행 예정 시각은 서버가 그대로 두므로 목록에서 사라지지 않는다).
    if (key.startsWith("scheduleList:")) loadSchedule();
    else loadDrafts();
  } else {
    alert(t("saveFail") + (r?.error || ""));
  }
}
async function approveDraft(id) {
  const r = await api(`/drafts/${id}/approve`, { method: "POST" });
  if (r && r.success) loadDrafts(); else alert(t("approveFail") + (r?.error || ""));
}
async function rejectDraft(id) {
  const r = await api(`/drafts/${id}/reject`, { method: "POST" });
  if (r && r.success) loadDrafts(); else alert(t("rejectFail") + (r?.error || ""));
}
async function regenerateDraft(id) {
  if (!confirm(t("confirmRegenerate"))) return;
  const r = await api(`/drafts/${id}/regenerate`, { method: "POST" });
  if (r && r.success) loadDrafts(); else alert(t("regenerateFail") + (r?.error || ""));
}
async function copyDraft(id, btn) {
  const card = btn && btn.closest ? btn.closest(".item-card") : null;
  const textarea = (card && card.querySelector("textarea.edit-body")) || $("#body-" + id);
  if (!textarea) return;
  const text = textarea.value;
  try {
    await navigator.clipboard.writeText(text);
    alert(t("copySuccess"));
  } catch {
    alert(t("copyFail"));
  }
}
// 서버가 needsConfirm 을 돌려주면(제휴글인데 본문에 링크가 없음) 한 번 확인받고,
// 사용자가 "링크 없이 예약"을 고르면 같은 요청에 승인 플래그만 붙여 다시 보낸다.
// 승인하지 않으면 아무 일도 일어나지 않는다(예약되지 않음).
async function postScheduleWithLinkConfirm(path, payload) {
  let r = await api(path.url, { method: path.method, body: JSON.stringify(payload) });
  if (r && r.needsConfirm) {
    if (!confirm(`${r.error}\n\n[확인] 링크 없이 예약  ·  [취소] 예약하지 않음`)) return null;
    r = await api(path.url, { method: path.method, body: JSON.stringify({ ...payload, allowWithoutAffiliateLink: true }) });
  }
  return r;
}

async function scheduleDraft(id) {
  const input = $("#sched-" + id);
  if (!input || !input.value) { alert(t("alertSelectTimeRequired")); return; }
  const r = await postScheduleWithLinkConfirm({ url: `/drafts/${id}/schedule`, method: "POST" }, { scheduled_at: input.value });
  if (r === null) return; // 사용자가 확인창에서 취소
  if (r && r.success) { alert(t("alertScheduled")); loadDrafts(); } else alert(t("scheduleFail") + (r?.error || ""));
}

// ---------------- 예약 관리 자동 갱신 ----------------
// 예약 관리 화면을 열어둔 채 예약 시각이 지나면, 서버는 발행을 끝냈는데 화면은 진입 시점
// 그대로 멈춰 있어 "발행이 안 됐다"고 오해하기 쉽다. 그 오해가 수동 재게시로 이어지면
// 같은 글이 두 번 올라가므로, 이 화면이 열려 있는 동안만 목록을 다시 읽는다.
// 새 폴링 구조를 만들지 않고 기존 loadSchedule()/loadPublishLog()를 그대로 재사용한다.
const SCHEDMGMT_REFRESH_INTERVAL_MS = 30000;
let schedMgmtRefreshTimer = null;
let schedMgmtRefreshBusy = false; // 이전 갱신이 끝나기 전에 다음 회차가 겹쳐 도는 것을 막는다

function startSchedMgmtAutoRefresh() {
  if (schedMgmtRefreshTimer) return; // 화면을 여러 번 열어도 타이머는 항상 1개
  schedMgmtRefreshTimer = setInterval(refreshSchedMgmtLists, SCHEDMGMT_REFRESH_INTERVAL_MS);
}

function stopSchedMgmtAutoRefresh() {
  if (schedMgmtRefreshTimer) clearInterval(schedMgmtRefreshTimer);
  schedMgmtRefreshTimer = null;
  schedMgmtRefreshBusy = false;
}

// 예약 시각을 고치는 중이면 그 입력칸이 목록 재렌더로 사라진다. 편집이 끝날 때까지 미룬다.
function isRescheduleBoxOpen() {
  return Array.from(document.querySelectorAll(".reschedule-box")).some((box) => box.style.display !== "none");
}

async function refreshSchedMgmtLists() {
  if (schedMgmtRefreshBusy) return;
  if (!$("#view-schedulemgmt")?.classList.contains("active")) return; // 화면을 벗어났으면 아무 것도 하지 않는다
  if (isRescheduleBoxOpen()) return;
  // 예약 목록에서 파일을 고르고 아직 [수정 저장]을 누르지 않았다면 목록을 다시 그리지 않는다
  // (다시 그리면 그 선택이 사라진다). 시간 변경 입력칸을 미루는 기존 규칙과 같은 이유다.
  if (hasPendingDraftMediaEdits($("#scheduleList"))) return;
  schedMgmtRefreshBusy = true;
  try {
    // 갱신 대상은 서버가 스스로 바꾸는 두 목록뿐이다. 예약 루틴 입력값, 승인 글 선택,
    // 자동배치 미리보기는 사용자가 작업 중인 상태라 절대 덮어쓰지 않는다.
    await loadSchedule();
    await loadPublishLog();
  } finally {
    schedMgmtRefreshBusy = false;
  }
}

// ---------------- 예약함 ----------------
async function loadSchedule() {
  const r = await api("/schedule");
  const list = $("#scheduleList");
  if (!r || !r.scheduled || r.scheduled.length === 0) { list.innerHTML = `<p class="muted">${t("noScheduled")}</p>`; return; }
  // .map(draftCardHtml)로 넘기면 배열 index가 두 번째 인자로 들어간다 - 예약 관리에는
  // 선택 체크박스를 붙이지 않으므로 인자를 명시적으로 하나만 넘긴다.
  // 실제 발행 순서대로 확인할 수 있게 발행 예정 시각 오름차순으로 보여 준다.
  // 공용 listDrafts SQL과 scheduler 처리 순서는 건드리지 않고 렌더 직전에만 정렬한다.
  const ordered = [...r.scheduled].sort((a, b) => {
    const ta = a.scheduled_at ? Date.parse(a.scheduled_at) : Number.MAX_SAFE_INTEGER;
    const tb = b.scheduled_at ? Date.parse(b.scheduled_at) : Number.MAX_SAFE_INTEGER;
    return ta - tb || a.id - b.id;
  });
  list.innerHTML = ordered.map((d) => draftCardHtml(d)).join("");
  bindDraftSourceOpenButtons(list, ordered); // P1.6: 초안함과 동일한 안전 바인딩
  bindDraftCardMedia(list, ordered);
  releaseDraftMediaEditsForList(list); // 예약 목록을 새로 그려도 초안함 선택은 건드리지 않는다
  bindDraftMediaEditControls(list);
}

// ---------------- 발행 기록 ----------------
// 구매자용 발행 기록 = "실제 발행 시도 기록"이다. legacy dry_run=1(모의 처리) 행은
// 목록에 표시하지 않는다 - 실제 성공으로 위장하지도, 개발 용어를 노출하지도 않는다.
// DB row는 삭제하지 않으며(schema/기록 보존) 개발·테스트에서는 계속 조회할 수 있다.
// P2.0(17): 기록이 쌓이면 실패한 건만 빠르게 보고 싶다. 이미 받아온 목록을 그대로
// 걸러내므로 서버 호출도 새 API도 필요 없다. 값: "all" | "success" | "fail".
let publishLogFilter = "all";
let publishLogCache = [];

function setPublishLogFilter(value) {
  publishLogFilter = value;
  renderPublishLogList();
}

// 글 유형은 publish_log.media_type에 이미 저장돼 있다(TEXT/IMAGE/VIDEO/CAROUSEL).
// 옛 기록은 NULL이라 그 경우에만 표시를 생략한다.
function publishLogTypeBadge(mediaType) {
  if (!mediaType) return "";
  return `<span class="status-badge status-manual">${escapeHtml(String(mediaType))}</span>`;
}

function renderPublishLogList() {
  const list = $("#publishLogList");
  const counts = { all: publishLogCache.length, success: 0, fail: 0 };
  publishLogCache.forEach((l) => { if (l.success) counts.success++; else counts.fail++; });
  const tabs = [["all", t("publishLogFilterAll")], ["success", t("publishLogFilterSuccess")], ["fail", t("publishLogFilterFail")]]
    .map(([key, label]) => `<button type="button" class="secondary${publishLogFilter === key ? " active" : ""}" data-publishlog-filter="${key}">${label} (${counts[key]})</button>`)
    .join("");
  const filterBar = publishLogCache.length > 0 ? `<div class="candidate-toolbar" id="publishLogFilterBar">${tabs}</div>` : "";

  const shown = publishLogCache.filter((l) => publishLogFilter === "all" || (publishLogFilter === "success" ? !!l.success : !l.success));

  if (publishLogCache.length === 0) {
    // P2.0(18): 개발 용어를 쓰지 않고, 언제 이 목록이 채워지는지 알려준다.
    list.innerHTML = `<p class="muted">${t("noPublishLogTitle")}</p><p class="muted">${t("noPublishLogDesc")}</p>`;
    return;
  }
  if (shown.length === 0) {
    list.innerHTML = filterBar + `<p class="muted">${t("noPublishLogForFilter")}</p>`;
    bindPublishLogFilterButtons(list);
    return;
  }

  list.innerHTML = filterBar + shown.map((l) => `
    <div class="item-card">
      <div class="meta">
        ${l.success ? `<span class="status-badge status-published">${t("validateSuccess")}</span>` : `<span class="status-badge status-failed">${t("validateFail")}</span>`}
        ${publishLogTypeBadge(l.media_type)}
        ${t("draftLabel")}${l.draft_id} · ${t("labelAttempt")}${fmtDate(l.attempted_at)} ${l.published_at ? t("labelPublishedAt") + fmtDate(l.published_at) : ""}
        ${l.threads_post_id ? t("labelPostId") + escapeHtml(l.threads_post_id) : ""}
      </div>
      <div class="body-text">${escapeHtml((l.body || "").slice(0, 200))}</div>
      ${l.error_message ? `<div class="muted">${escapeHtml(l.error_message)}</div>` : ""}
      ${l.sources ? `<div class="muted">${l.draft_source_type === "affiliate_product" ? t("labelAffiliateLinkShort") + ": " : t("labelSources")}${escapeHtml(l.sources)}</div>` : ""}
      <div class="muted">${t("labelToneVersion")}${l.persona_version ?? "-"}</div>
      <div class="actions">
        <button class="danger" onclick="deletePublishLog(${l.id})">${t("btnDeletePublishLog")}</button>
      </div>
    </div>
  `).join("");
  bindPublishLogFilterButtons(list);
}

function bindPublishLogFilterButtons(container) {
  container.querySelectorAll("[data-publishlog-filter]").forEach((btn) => {
    btn.addEventListener("click", () => setPublishLogFilter(btn.dataset.publishlogFilter));
  });
}

// 구매자용 발행 기록 = "실제 발행 시도 기록"이다. legacy dry_run=1(모의 처리) 행은
// 목록에 표시하지 않는다 - 실제 성공으로 위장하지도, 개발 용어를 노출하지도 않는다.
// DB row는 삭제하지 않으며(schema/기록 보존) 개발·테스트에서는 계속 조회할 수 있다.
async function loadPublishLog() {
  const r = await api("/publish-log?limit=200");
  publishLogCache = (r && r.logs ? r.logs : []).filter((l) => !l.dry_run);
  renderPublishLogList();
}

// 발행 기록 1건 삭제. 프로그램 안의 이력만 지우며 Threads 게시물은 그대로 남습니다.
// 실패했을 때 화면에서 먼저 카드를 지우지 않도록, 성공 응답(ok:true)을 받은 뒤에만 목록을 새로 불러옵니다.
async function deletePublishLog(id) {
  if (!confirm(t("confirmDeletePublishLog"))) return;
  const r = await api("/publish-log/" + id, { method: "DELETE" });
  if (!r || r.ok !== true) {
    alert(t("deletePublishLogFail") + (r && r.error ? " (" + r.error + ")" : ""));
    return;
  }
  loadPublishLog();
}

// ---------------- 말투 설정 ----------------
async function loadPersona() {
  // P1.8: 화면에 들어올 때마다 저장된 값을 서버에서 다시 읽어 표시한다(저장하지 않은 옛 DOM
  // 값이 DB 값보다 우선하지 않게). 이전 저장/오류 안내도 함께 지워 stale 문구가 남지 않는다.
  const statusEl = $("#personaSaveStatus");
  if (statusEl) statusEl.textContent = "";
  const r = await api("/persona");
  if (!r || !r.persona) return;
  const p = r.persona.data;
  $("#p_channel_identity").value = p.channel_identity || "";
  $("#p_audience").value = p.audience || "";
  $("#p_tone_description").value = p.tone_description || "";
  $("#p_common_phrases").value = p.common_phrases || "";
  $("#p_banned_phrases").value = p.banned_phrases || "";
  $("#p_length_preference").value = p.length_preference || "";
  $("#p_emoji_level").value = p.emoji_level || "";
  $("#p_allow_question_ending").checked = !!p.allow_question_ending;
  $("#p_allow_external_links").checked = !!p.allow_external_links;
  $("#personaVersionLabel").textContent = t("labelCurrentVersion") + r.persona.version;
}

function initPersonaForm() {
  $("#btnSavePersona").addEventListener("click", async () => {
    const statusEl = $("#personaSaveStatus");
    const data = {
      channel_identity: $("#p_channel_identity").value,
      audience: $("#p_audience").value,
      tone_description: $("#p_tone_description").value,
      common_phrases: $("#p_common_phrases").value,
      banned_phrases: $("#p_banned_phrases").value,
      length_preference: $("#p_length_preference").value,
      emoji_level: $("#p_emoji_level").value,
      allow_question_ending: $("#p_allow_question_ending").checked,
      allow_external_links: $("#p_allow_external_links").checked,
    };
    if (statusEl) statusEl.textContent = t("savingBtn");
    const r = await api("/persona", { method: "POST", body: JSON.stringify(data) });
    if (r && r.success) {
      // 저장된 값을 서버에서 다시 읽어 화면에 반영한 뒤 성공 안내를 남긴다(재조회가 안내를
      // 지우지 않도록 순서를 지킨다). 실패 시에는 화면의 기존 입력값을 그대로 둔다.
      await loadPersona();
      if (statusEl) statusEl.textContent = t("personaSaved");
    } else if (statusEl) {
      statusEl.textContent = t("saveFail") + (r?.error || "");
    }
  });

  // 기본 스타일로 되돌리기: 내 글 스타일만 초기화한다(초안/자료/상품/예약/발행 기록/연결
  // 정보는 건드리지 않는다 - 서버 /persona/reset이 persona_versions에만 새 버전을 쌓는다).
  $("#btnResetPersona")?.addEventListener("click", () => {
    showModal({
      title: t("personaResetConfirmTitle"),
      bodyHtml: `<p class="muted">${t("personaResetConfirmBody")}</p>`,
      actions: [
        { label: t("btnCancel"), className: "secondary", onClick: hideModal },
        {
          label: t("btnResetPersona"),
          onClick: async () => {
            const r = await api("/persona/reset", { method: "POST" });
            hideModal();
            const statusEl = $("#personaSaveStatus");
            if (r && r.success) {
              await loadPersona();
              if (statusEl) statusEl.textContent = t("personaResetDone");
            } else if (statusEl) {
              statusEl.textContent = t("saveFail") + (r?.error || "");
            }
          },
        },
      ],
    });
  });
}

// ---------------- 자료 출처 설정 ----------------
// 자료 출처 목록. 기본(built-in) 자료원은 프로그램이 자동 관리하므로 개별 카드/사용함/삭제를
// 노출하지 않고 요약 한 줄만 보여주고, 사용자가 직접 추가한 자료원만 펼쳐서 관리한다.
// built-in 판정은 서버가 내려주는 builtIn 플래그를 그대로 신뢰한다(화면이 URL을 다시 판정하지 않음).
let customFeedsExpanded = false;

async function loadFeeds() {
  const r = await api("/feeds");
  const list = $("#feedsList");
  const summaryEl = $("#builtInFeedSummary");
  const toggleBtn = $("#btnToggleCustomFeeds");
  if (!list) return;
  if (!r || !r.feeds) {
    list.innerHTML = "";
    if (summaryEl) summaryEl.textContent = "";
    if (toggleBtn) toggleBtn.style.display = "none";
    return;
  }

  const builtIns = r.feeds.filter((f) => f.builtIn);
  const customs = r.feeds.filter((f) => !f.builtIn);

  if (summaryEl) summaryEl.textContent = builtIns.length > 0 ? t("feedBuiltInSummary", { n: builtIns.length }) : "";

  if (toggleBtn) {
    if (customs.length === 0) {
      // 추가한 자료원이 없으면 펼칠 것도 없다 - 안내 한 줄만 남긴다.
      toggleBtn.style.display = "none";
      customFeedsExpanded = false;
      list.style.display = "";
      list.innerHTML = `<p class="muted">${t("feedCustomNone")}</p>`;
      return;
    }
    toggleBtn.style.display = "";
    toggleBtn.textContent = t("feedCustomToggle", { n: customs.length }) + " " + (customFeedsExpanded ? t("feedCollapse") : t("feedExpand"));
    toggleBtn.setAttribute("aria-expanded", String(customFeedsExpanded));
  }

  list.style.display = customFeedsExpanded ? "" : "none";
  list.innerHTML = customs.map((f) => `
    <div class="item-card">
      <div class="meta">${t("labelRegisteredAt")}${fmtDate(f.created_at)}</div>
      <strong>${escapeHtml(f.name)}</strong>
      <div class="body-text">${escapeHtml(f.url)}</div>
      <div class="actions">
        <label><input type="checkbox" ${f.enabled ? "checked" : ""} onchange="toggleFeed(${f.id}, this.checked)"/> ${t("labelEnabled")}</label>
        <button class="danger" onclick="deleteFeed(${f.id})">${t("btnDelete")}</button>
      </div>
    </div>
  `).join("");
}

async function toggleFeed(id, enabled) {
  await api("/feeds/" + id, { method: "PATCH", body: JSON.stringify({ enabled }) });
}
async function deleteFeed(id) {
  if (!confirm(t("confirmDeleteFeed"))) return;
  await api("/feeds/" + id, { method: "DELETE" });
  loadFeeds();
}
function initFeedsForm() {
  $("#btnToggleCustomFeeds")?.addEventListener("click", () => {
    customFeedsExpanded = !customFeedsExpanded;
    loadFeeds();
  });
  $("#btnAddFeed").addEventListener("click", async () => {
    const name = $("#feedNameInput").value.trim();
    const url = $("#feedUrlInput").value.trim();
    const statusEl = $("#feedAddStatus");
    if (!name || !url) return;
    // 중복/유효성 판정은 전부 서버가 한다(정규화 URL 비교 + 실제 RSS 확인) - 화면은 code로
    // 구매자 문구만 고른다. 서버 원문 오류 메시지는 노출하지 않는다.
    const btn = $("#btnAddFeed");
    btn.disabled = true;
    if (statusEl) statusEl.textContent = t("savingBtn");
    const r = await api("/feeds", { method: "POST", body: JSON.stringify({ name, url }) });
    btn.disabled = false;
    if (r && r.success) {
      $("#feedNameInput").value = "";
      $("#feedUrlInput").value = "";
      if (statusEl) statusEl.textContent = t("feedAdded");
      customFeedsExpanded = true; // 방금 추가한 자료원이 바로 보이게 펼친다
      loadFeeds();
      return;
    }
    const codeMessages = {
      DUPLICATE_FEED: "feedDuplicate",
      INVALID_URL: "feedInvalidUrl",
      FEED_UNREACHABLE: "feedUnreachable",
      FEED_EMPTY: "feedEmpty",
    };
    if (statusEl) statusEl.textContent = t(codeMessages[r && r.code] || "feedAddFailed");
  });
}

// ---------------- 발행 설정 (하루 최대 발행 수) ----------------
// 하루 최대 발행 수는 예약 루틴과 같은 저장 위치(schedule-routine)를 쓴다. 스케줄러가 매 tick
// 마다 이 값을 다시 읽으므로 저장 즉시 다음 발행부터 반영되고, 서버를 재시작해도 유지된다.
// 범위 검증(1~20)은 서버의 기존 validateScheduleRoutineInput을 그대로 재사용한다.
async function loadPublishSettings() {
  const r = await api("/schedule-routine");
  const input = $("#dailyMaxPublishInput");
  if (input && r && r.routine) input.value = r.routine.dailyLimit;
}


function initPublishSettings() {
  $("#btnSaveDailyMaxPublish")?.addEventListener("click", async () => {
    const input = $("#dailyMaxPublishInput");
    const statusEl = $("#dailyMaxPublishStatus");
    const value = parseInt(input.value, 10);
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      if (statusEl) statusEl.textContent = t("dailyMaxPublishInvalid");
      return;
    }
    // 기존 루틴(시간/요일)을 그대로 두고 dailyLimit만 바꾼다 - 다른 설정을 덮어쓰지 않는다.
    const current = await api("/schedule-routine");
    const routine = (current && current.routine) || null;
    if (!routine) {
      if (statusEl) statusEl.textContent = t("saveFail");
      return;
    }
    const r = await api("/schedule-routine", {
      method: "PUT",
      body: JSON.stringify({ times: routine.times, weekdays: routine.weekdays, dailyLimit: value }),
    });
    if (r && r.success) {
      if (statusEl) statusEl.textContent = t("dailyMaxPublishSaved");
      loadPublishSettings();
      loadScheduleRoutine(); // 예약 관리 화면의 같은 값도 함께 최신화
    } else if (statusEl) {
      statusEl.textContent = t("dailyMaxPublishInvalid");
    }
  });
}

// ---------------- Threads API 설정 ----------------
// 설정 화면에서 "Threads 연결"과 "발행 설정"으로 시각적으로 나눠 보여주지만, 둘 다 동일한
// /api/threads-settings 응답 하나를 그대로 나눠 렌더링할 뿐 새 API를 호출하지 않습니다.
// ---------------- Threads 계정 연결(P0.5 BYO OAuth) ----------------
// 연결 상태 카드 하나가 미연결/연결 중/연결됨/불일치/만료를 전부 담당한다. 숫자 User ID·토큰·
// App ID는 일반 화면에 표시하지 않는다. OAuth 진행 중에는 /oauth/status만 2초 간격으로 조회한다
// (App Secret은 시작 요청 1회로만 전달하고 프런트에 보관하지 않는다).
let threadsSettingsSnapshot = null; // GET /threads-settings 응답(토큰 원문 없음)
let threadsOAuthStatusTimer = null;
let threadsOAuthBusy = false;
let threadsLastOAuthStatus = null; // 마지막 /oauth/status.status (실패/불일치/만료 카드 유지용)

function stopThreadsOAuthStatusPolling() {
  if (threadsOAuthStatusTimer) clearInterval(threadsOAuthStatusTimer);
  threadsOAuthStatusTimer = null;
}

function startThreadsOAuthStatusPolling() {
  if (threadsOAuthStatusTimer) return; // 타이머 1개
  threadsOAuthStatusTimer = setInterval(pollThreadsOAuthStatus, 2000);
}

function threadsOAuthInProgress(status) {
  return status === "starting" || status === "waiting_for_user" || status === "polling" || status === "exchanging" || status === "validating";
}

function threadsFailureMessage(code) {
  switch (code) {
    case "DENIED": return t("threadsStatusDenied");
    case "EXPIRED": return t("threadsStatusExpired");
    case "VALIDATE_EXPIRED": return t("threadsStatusValidateExpired");
    case "APP_INFO_INVALID": return t("threadsStatusAppInfoInvalid");
    case "LICENSE_INVALID": return t("threadsStatusLicenseInvalid");
    case "RELAY_UNAVAILABLE": return t("threadsStatusRelayUnavailable");
    default: return t("threadsStatusGenericFail");
  }
}

function threadsDaysLeft(expiresAtIso) {
  if (!expiresAtIso) return null;
  const ms = Date.parse(expiresAtIso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 86400000));
}

// 상태 카드 렌더. snapshot(저장된 연결) + oauth(진행 중/직전 결과)를 합쳐 하나의 화면을 만든다.
// 연결설명서 버튼은 Threads 연결 상태(미연결/진행 중/불일치/실패·만료/연결됨)와 무관하게
// 항상 표시한다. 기존 버튼 그룹은 왼쪽 그대로 두고 이 버튼만 같은 행 오른쪽 끝에 붙인다.
function threadsGuideButtonHtml() {
  return `<button type="button" class="secondary" id="btnThreadsConnectionGuide" style="margin-left:auto">${t("btnThreadsConnectionGuide")}</button>`;
}
function bindThreadsGuideButton() {
  // 앱 내부 WebView 화면을 만들지 않고 기존 공통 helper로 기본 외부 브라우저에서 연다.
  $("#btnThreadsConnectionGuide")?.addEventListener("click", () => openExternalHttpUrl(THREADS_CONNECTION_GUIDE_URL));
}

function renderThreadsConnectionCard(oauth) {
  const card = $("#threadsConnectionCard");
  const form = $("#threadsOAuthForm");
  if (!card) return;
  const snap = threadsSettingsSnapshot || {};
  const st = oauth ? oauth.status : "idle";
  threadsLastOAuthStatus = st;

  // 1) 진행 중
  if (threadsOAuthInProgress(st)) {
    if (form) form.style.display = "none";
    const waiting = st === "waiting_for_user" || st === "polling" || st === "starting";
    card.innerHTML = `
      <p><span class="status-badge status-manual">${escapeHtml(waiting ? t("threadsStatusWaiting") : t("threadsStatusExchanging"))}</span></p>
      ${waiting ? `<p class="muted">${escapeHtml(t("threadsStatusWaitingHint"))}</p>` : ""}
      <div class="actions">
        ${waiting && oauth.canReopen ? `<button type="button" class="secondary" id="btnThreadsReopen">${t("btnThreadsReopenBrowser")}</button>` : ""}
        <button type="button" class="secondary" id="btnThreadsCancelOAuth">${t("btnThreadsCancelOAuth")}</button>
        ${threadsGuideButtonHtml()}
      </div>`;
    bindThreadsGuideButton();
    $("#btnThreadsReopen")?.addEventListener("click", async () => { await api("/threads-settings/oauth/reopen", { method: "POST" }); });
    $("#btnThreadsCancelOAuth")?.addEventListener("click", async () => {
      await api("/threads-settings/oauth/cancel", { method: "POST" });
      stopThreadsOAuthStatusPolling();
      await loadThreadsSettings();
    });
    return;
  }

  // 2) 계정 불일치(저장 0, 기존 연결 유지)
  if (st === "failed" && oauth.failureCode === "ACCOUNT_MISMATCH") {
    if (form) form.style.display = "";
    card.innerHTML = `
      <p><span class="status-badge status-failed">⚠ ${escapeHtml(t("threadsStatusMismatchTitle"))}</span></p>
      <div class="kv">
        <div>${t("threadsStatusMismatchTarget")}</div><div>@${escapeHtml(oauth.targetUsername || "")}</div>
        <div>${t("threadsStatusMismatchActual")}</div><div>@${escapeHtml(oauth.actualUsername || "")}</div>
      </div>
      <p class="muted">${escapeHtml(t("btnThreadsReconnect"))} ↓</p>
      <div class="actions">
        ${threadsGuideButtonHtml()}
      </div>`;
    bindThreadsGuideButton();
    return;
  }

  // 3) 취소/만료/실패
  if (st === "denied" || st === "expired" || st === "failed") {
    if (form) form.style.display = "";
    card.innerHTML = `
      <p><span class="status-badge status-failed">⚠ ${escapeHtml(threadsFailureMessage(oauth.failureCode))}</span></p>
      <p class="muted">${escapeHtml(t("btnThreadsReconnect"))} ↓</p>
      <div class="actions">
        ${threadsGuideButtonHtml()}
      </div>`;
    bindThreadsGuideButton();
    return;
  }

  // 4) 연결됨(방금 성공했거나 저장된 연결이 있음)
  const connectedName = (st === "success" && oauth.connectedUsername) || snap.username || null;
  if (snap.hasToken && snap.hasUserId) {
    if (form) form.style.display = "none";
    const days = threadsDaysLeft(snap.expiresAtIso);
    card.innerHTML = `
      <p><span class="status-badge status-published">🟢 ${escapeHtml(t("threadsStatusConnected"))}</span> <strong>${connectedName ? "@" + escapeHtml(connectedName) : ""}</strong></p>
      ${days !== null ? `<p class="muted">${escapeHtml(t("threadsExpiresNote", { days }))}</p>` : ""}
      ${snap.hasStoredAppSecret ? `<p class="muted">${escapeHtml(t("threadsAppSecretStored"))}</p>` : ""}
      <p class="muted">${mediaPublishConfigured === false ? escapeHtml(t("mediaPublishNotConfigured")) : escapeHtml(t("mediaFutureNote"))}</p>
      <div class="actions">
        <button type="button" class="secondary" id="btnValidateThreads">${t("btnValidateThreads")}</button>
        <button type="button" class="secondary" id="btnThreadsShowReconnect">${t("btnThreadsReconnect")}</button>
        <button type="button" class="secondary" id="btnThreadsConnectOther">${t("btnThreadsConnectOther")}</button>
        <button type="button" class="danger" id="btnThreadsDisconnect">${t("btnThreadsDisconnect")}</button>
        ${threadsGuideButtonHtml()}
      </div>`;
    $("#btnValidateThreads")?.addEventListener("click", validateThreadsConnection);
    // P0.5B: 저장된 App ID/username/보호된 secret이 있으면 입력 폼 없이 바로 OAuth(승인 화면만).
    // 없거나 복호화 실패면 reconnectThreadsAccount()가 폼을 prefill로 열어 secret만 다시 받는다.
    $("#btnThreadsShowReconnect")?.addEventListener("click", reconnectThreadsAccount);
    // [다른 계정 연결]: 자동 재연결과 구분되는 명시적 경로 - 저장값을 재사용하지 않고 빈 폼(App ID/Secret/@username)을 연다.
    $("#btnThreadsConnectOther")?.addEventListener("click", () => showThreadsFormWithPrefill(null, "", true));
    $("#btnThreadsDisconnect")?.addEventListener("click", disconnectThreadsAccount);
    bindThreadsGuideButton();
    return;
  }

  // 5) 미연결
  if (form) form.style.display = "";
  card.innerHTML = `<p class="muted">${escapeHtml(t("threadsStatusNotConnected"))}</p>
    <div class="actions">
      ${threadsGuideButtonHtml()}
    </div>`;
  bindThreadsGuideButton();
}

async function loadThreadsSettings() {
  const r = await api("/threads-settings");
  threadsSettingsSnapshot = r || null;
  const body = $("#threadsSettingsBody");
  if (!r) {
    const card = $("#threadsConnectionCard");
    if (card) card.textContent = t("loadFailed");
    if (body) body.textContent = t("loadFailed");
    return;
  }
  // 고급 설정 안의 기존 요약(토큰 마스킹/ID/API Base)은 고급 사용자용으로만 남긴다.
  if (body) {
    body.innerHTML = `
      <div class="kv">
        <div>${t("labelTokenSet")}</div><div>${r.hasToken ? t("valueSet") + " (" + escapeHtml(r.maskedToken) + ")" : t("valueNotSet")}</div>
        <div>${t("labelUserId")}</div><div>${r.hasUserId ? escapeHtml(r.userId) : t("valueNotSet")}</div>
        <div>${t("labelApiBase")}</div><div>${escapeHtml(r.graphBase)}</div>
      </div>`;
  }
  renderThreadsCallbackUrl(r.oauthCallbackUrl);
  // 진행 중인 OAuth가 있으면 그 상태를, 아니면 저장된 연결 상태를 그린다.
  const s = await api("/threads-settings/oauth/status");
  const oauth = s && s.status ? s.status : { status: "idle", canReopen: false };
  renderThreadsConnectionCard(oauth);
  if (threadsOAuthInProgress(oauth.status)) startThreadsOAuthStatusPolling();
  else stopThreadsOAuthStatusPolling();
}

async function pollThreadsOAuthStatus() {
  if (!$("#view-settings")?.classList.contains("active")) { stopThreadsOAuthStatusPolling(); return; }
  const s = await api("/threads-settings/oauth/status");
  if (!s || !s.status) return;
  const oauth = s.status;
  if (threadsOAuthInProgress(oauth.status)) { renderThreadsConnectionCard(oauth); return; }
  // 종료 상태: 폴링을 멈추고 저장된 연결 상태를 다시 읽어 최종 카드를 그린다.
  stopThreadsOAuthStatusPolling();
  const r = await api("/threads-settings");
  threadsSettingsSnapshot = r || threadsSettingsSnapshot;
  renderThreadsConnectionCard(oauth);
  if (oauth.status === "success") loadDashboard();
}

async function startThreadsOAuthFromForm() {
  if (threadsOAuthBusy) return;
  const errEl = $("#threadsOAuthFormError");
  const appIdEl = $("#threadsAppIdInput");
  const secretEl = $("#threadsAppSecretInput");
  const userEl = $("#threadsTargetUsernameInput");
  const appId = (appIdEl?.value || "").trim();
  const appSecret = (secretEl?.value || "").trim();
  const targetUsername = (userEl?.value || "").trim().replace(/^@+/, "");
  if (errEl) errEl.textContent = "";
  const noticeEl = $("#threadsOAuthFormNotice");
  if (noticeEl) { noticeEl.textContent = ""; noticeEl.style.display = "none"; }
  if (!appId || !appSecret || !targetUsername) { if (errEl) errEl.textContent = t("threadsOAuthInputRequired"); return; }
  if (!/^\d{6,32}$/.test(appId)) { if (errEl) errEl.textContent = t("threadsOAuthAppIdInvalid"); return; }

  threadsOAuthBusy = true;
  setBtnLoading("#btnThreadsOAuthStart", t("btnThreadsOAuthStartBusy"));
  let r;
  try {
    r = await api("/threads-settings/oauth/start", { method: "POST", body: JSON.stringify({ appId, appSecret, targetUsername }) });
  } catch { r = null; }
  threadsOAuthBusy = false;
  resetBtn("#btnThreadsOAuthStart", t("btnThreadsOAuthStart"));
  // App Secret은 요청 직후 입력칸에서 지운다(프런트에 남기지 않음). 실패해도 다시 붙여넣게 한다.
  if (secretEl) secretEl.value = "";
  if (!r || !r.ok) {
    if (errEl) errEl.textContent = (r && r.error) || t("threadsStatusGenericFail");
    return;
  }
  renderThreadsConnectionCard(r.status);
  startThreadsOAuthStatusPolling();
}

// [연결 다시 확인]: 결과는 연결 상태 카드 하나만 갱신한다. 카드 안에 두 번째 배지/username 행을
// append하면 "🟢 연결되었습니다"가 2개 보이는 버그가 된다(P0.5 QA에서 재현). 성공이면 카드를
// 처음부터 다시 그리고(loadThreadsSettings), 실패면 같은 카드를 실패 상태로 교체한다.
let threadsValidateBusy = false;
async function validateThreadsConnection() {
  if (threadsValidateBusy) return;
  threadsValidateBusy = true;
  let r;
  try {
    r = await api("/threads-settings/validate", { method: "POST" });
  } finally {
    threadsValidateBusy = false;
  }
  if (r && r.valid) {
    await loadThreadsSettings(); // 저장된 연결 상태를 다시 읽어 단일 카드로 렌더(배지 1개)
  } else {
    renderThreadsConnectionCard({ status: "failed", failureCode: "VALIDATE_EXPIRED", canReopen: false });
  }
}

// P0.5B: 재연결 폼을 prefill(App ID/username - 비밀 아님)과 안내 문구로 연다. App Secret 칸은 항상 비운다.
// clearAll=true면 [다른 계정 연결] 경로: 저장값을 재사용하지 않고 세 칸을 전부 비운다.
function showThreadsFormWithPrefill(prefill, noticeText, clearAll) {
  const form = $("#threadsOAuthForm");
  if (form) form.style.display = "";
  const appIdEl = $("#threadsAppIdInput");
  const userEl = $("#threadsTargetUsernameInput");
  const secretEl = $("#threadsAppSecretInput");
  if (clearAll) { if (appIdEl) appIdEl.value = ""; if (userEl) userEl.value = ""; }
  if (appIdEl && prefill && prefill.appId && !appIdEl.value) appIdEl.value = prefill.appId;
  if (userEl && prefill && prefill.username && !userEl.value) userEl.value = prefill.username;
  if (secretEl) secretEl.value = "";
  const notice = $("#threadsOAuthFormNotice");
  if (notice) { notice.textContent = noticeText || ""; notice.style.display = noticeText ? "" : "none"; }
  (secretEl || appIdEl)?.focus();
}

let threadsReconnectBusy = false;
// [Threads 다시 연결하기]: 서버가 저장된 appId + username + Windows 보안 저장 secret으로 바로 OAuth를
// 시작한다(입력 폼 생략). 저장값이 없거나 복호화 실패(다른 PC/다른 Windows 계정/손상)면 409
// SECRET_UNAVAILABLE + prefill → 폼을 열어 secret만 다시 받는다. 기존 연결은 그대로 유지된다.
async function reconnectThreadsAccount() {
  if (threadsReconnectBusy) return;
  threadsReconnectBusy = true;
  let r;
  try {
    r = await api("/threads-settings/oauth/reconnect", { method: "POST" });
  } catch { r = null; }
  threadsReconnectBusy = false;
  if (r && r.ok) {
    renderThreadsConnectionCard(r.status);
    startThreadsOAuthStatusPolling();
    return;
  }
  const prefill = (r && r.prefill) || { appId: threadsSettingsSnapshot?.appId || null, username: threadsSettingsSnapshot?.username || null };
  const notice = r && r.code === "SECRET_UNAVAILABLE" ? t("threadsReconnectSecretUnavailable") : (r && r.error) || t("threadsStatusGenericFail");
  showThreadsFormWithPrefill(prefill, notice);
}

async function disconnectThreadsAccount() {
  if (!confirm(t("threadsDisconnectConfirm"))) return;
  const r = await api("/threads-settings/disconnect", { method: "POST" });
  if (!r || !r.ok) { alert(t("errUnknown")); return; }
  stopThreadsOAuthStatusPolling();
  await loadThreadsSettings();
  loadDashboard();
}

// 서버가 준 콜백 URL만 화면에 표시한다. 값을 프런트에서 조립하거나 localStorage/sessionStorage에
// 저장하지 않는다(설정이 바뀌면 다음 조회에서 그대로 따라간다).
function renderThreadsCallbackUrl(url) {
  const row = $("#threadsCallbackRow");
  const input = $("#threadsCallbackUrlInput");
  if (!row || !input) return;
  const value = typeof url === "string" ? url.trim() : "";
  if (!value) {
    row.style.display = "none";
    input.value = "";
    return;
  }
  input.value = value;
  row.style.display = "";
}

let callbackCopyStatusTimer = null;
function showCallbackCopyStatus(message) {
  const el = $("#threadsCallbackCopyStatus");
  if (!el) return;
  el.textContent = message;
  el.style.display = "";
  if (callbackCopyStatusTimer) clearTimeout(callbackCopyStatusTimer);
  callbackCopyStatusTimer = setTimeout(() => {
    el.textContent = "";
    el.style.display = "none";
    callbackCopyStatusTimer = null;
  }, 2500);
}

// Clipboard API를 먼저 쓰고, 브라우저가 막거나 실패하면 입력칸을 선택해 execCommand로 대체한다.
// 둘 다 실패하면 주소를 선택한 상태로 남겨 사용자가 직접 복사할 수 있게 한다.
async function copyThreadsCallbackUrl() {
  const input = $("#threadsCallbackUrlInput");
  const value = (input?.value || "").trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showCallbackCopyStatus(t("callbackUrlCopied"));
    return;
  } catch {
    /* 아래 fallback으로 이어진다 */
  }
  try {
    input.focus();
    input.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    showCallbackCopyStatus(ok ? t("callbackUrlCopied") : t("callbackUrlCopyFail"));
  } catch {
    showCallbackCopyStatus(t("callbackUrlCopyFail"));
  }
}

let threadsSaveBusy = false;
function initThreadsSettings() {
  // ---- BYO OAuth 연결 ----
  $("#btnThreadsOAuthStart")?.addEventListener("click", startThreadsOAuthFromForm);
  $("#btnCopyThreadsCallbackUrl")?.addEventListener("click", copyThreadsCallbackUrl);
  $("#btnToggleThreadsAppSecret")?.addEventListener("click", () => {
    const input = $("#threadsAppSecretInput");
    const btn = $("#btnToggleThreadsAppSecret");
    if (!input || !btn) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? t("btnHideSecret") : t("btnShowSecret");
  });

  // ---- 고급 연결 설정(수동 fallback): 서버가 "검증 성공 → 저장 → 런타임 반영" 순서로 처리.
  // 실패하면 아무것도 저장되지 않으므로 기존 연결이 그대로 유지된다. userId는 선택값이다.
  const saveBtn = $("#btnSaveThreads");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      if (threadsSaveBusy) return;
      const tokenEl = $("#threadsTokenInput");
      const userIdEl = $("#threadsUserIdInput");
      const el = $("#threadsValidateResult");
      const accessToken = (tokenEl?.value || "").trim();
      const userId = (userIdEl?.value || "").trim();
      if (!accessToken) {
        el.innerHTML = `<span class="status-badge status-failed">${t("threadsSaveFail")}</span> ${escapeHtml(t("threadsInputRequired"))}`;
        return;
      }
      threadsSaveBusy = true;
      const originalLabel = saveBtn.textContent;
      saveBtn.disabled = true;
      saveBtn.textContent = t("btnSaveThreadsBusy");
      let r;
      try {
        r = await api("/threads-settings", { method: "POST", body: JSON.stringify({ accessToken, userId }) });
      } catch {
        r = null;
      }
      threadsSaveBusy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;

      if (r && r.saved && r.valid) {
        // 저장 성공 시 입력값을 즉시 비웁니다(전체 토큰을 화면에 남겨두지 않음).
        if (tokenEl) tokenEl.value = "";
        el.innerHTML =
          `<span class="status-badge status-published">${t("threadsSaveSuccess")}</span> @${escapeHtml(r.username || "")}` +
          `<p class="muted">${escapeHtml(t("threadsTokenKeepNote"))}</p>`;
        await loadThreadsSettings();
        loadDashboard();
      } else {
        el.innerHTML = `<span class="status-badge status-failed">${t("threadsSaveFail")}</span> ${escapeHtml(r?.error || t("errUnknown"))}`;
      }
    });
  }
}

// ---------------- 설정 화면 (Threads 연결 + Claude Code 상태 + 페르소나 + 자료 출처 + 발행 설정 + 테마) ----------------
async function loadSettingsClaudeStatus() {
  const s = await api("/status");
  const body = $("#settingsClaudeStatusBody");
  if (!body) return;
  if (!s) { body.textContent = t("statusLoadFailed"); return; }
  body.innerHTML = `
    <div class="kv">
      <div>${t("labelClaudeCode")}</div><div>${s.claude.available ? "✅ " + t("valConnected") + " (" + escapeHtml(s.claude.version) + ")" : "❌ " + t("valDisconnected") + " - " + escapeHtml(s.claude.error || "")}</div>
    </div>
  `;
}
function loadSettingsView() {
  loadThreadsSettings();
  loadPublishSettings();
  loadSettingsClaudeStatus();
  loadPersona();
  loadFeeds();
}

// ---------------- 모달(초기화 확인용 최소 구현) ----------------
// ==================================================================================
// 직접 글 작성(수동 초안) - 외부에서 이미 쓴 글을 붙여넣어 초안함에 넣는다.
// 새 초안 시스템을 만들지 않는다: 저장은 POST /api/drafts/manual 하나뿐이고, 미디어는
// 기존 미디어 보관함 업로드 엔드포인트를 그대로 재사용해 받은 assetKey만 넘긴다.
// 글 여러 개를 연달아 넣는 것이 목적이라, 저장 후 모달을 닫지 않고 입력만 비운다.
// ==================================================================================

const MANUAL_DRAFT_CATEGORY_RULES = {
  image: { min: 1, max: 1, accept: "image/*", labelKey: "manualDraft.catImage" },
  video: { min: 1, max: 1, accept: "video/*", labelKey: "manualDraft.catVideo" },
  carousel: { min: 2, max: 3, accept: "image/*", labelKey: "manualDraft.catCarousel" },
};
let manualDraftCategory = "image";
let manualDraftFiles = [];
let manualDraftBusy = false;
let manualDraftSavedCount = 0;
// 미리보기용 object URL 목록. 파일이 바뀌거나 폼이 초기화될 때마다 반드시 revoke해서
// 메모리 누수를 막는다(FileReader보다 큰 파일에서 훨씬 가볍고 코드도 짧다).
let manualDraftPreviewUrls = [];

function releaseManualDraftPreviews() {
  for (const u of manualDraftPreviewUrls) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* 이미 해제된 URL은 무시 */
    }
  }
  manualDraftPreviewUrls = [];
  const box = document.getElementById("manualDraftPreview");
  // 레이아웃 클래스도 같이 비운다. 영상 경로는 아래 toggle 전에 return 하므로, 이걸 지우지
  // 않으면 캐러셀 -> 영상으로 바꿨을 때 영상이 캐러셀 썸네일 크기(104px)로 찌그러진다.
  if (box) { box.innerHTML = ""; box.classList.remove("is-carousel", "is-single"); }
}

// 로컬 미리보기 썸네일(object URL) 클릭 → 확대 보기.
// 새 lightbox 를 만들지 않고, 초안 카드가 이미 쓰는 Common Viewer(openProductRadarLibraryViewer,
// productRadar.js)를 그대로 연다. 그 뷰어는 backdrop 클릭·X 버튼·ESC 로 닫히고, 여러 장이면
// 좌우 이동이 되며, file.url 에 object URL 을 그대로 넣을 수 있다.
// 첨부/삭제/저장 로직과는 무관하다 - 셀에 열기 동작만 붙인다. 영상에는 붙이지 않는다.
function bindLocalImageZoom(cell, urls, index, names) {
  if (!cell) return;
  const open = () => {
    const files = urls.map((u, i) => ({ filename: (names && names[i]) || "", slideIndex: i, available: true, url: u }));
    if (files.length === 0) return;
    openProductRadarLibraryViewer([{ category: files.length > 1 ? "carousel" : "image", files }], 0, index);
  };
  cell.classList.add("is-zoomable");
  cell.setAttribute("role", "button");
  cell.tabIndex = 0;
  cell.title = t("media.zoomHint");
  cell.setAttribute("aria-label", t("media.zoomHint"));
  cell.addEventListener("click", open);
  cell.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });
}

// 선택한 파일을 로컬에서 그대로 보여 준다 - 업로드는 [초안 저장]을 눌러야 일어나므로
// 이 단계에서는 서버로 아무것도 보내지 않는다.
function renderManualDraftPreview() {
  releaseManualDraftPreviews();
  const box = document.getElementById("manualDraftPreview");
  if (!box || manualDraftFiles.length === 0) return;

  if (manualDraftCategory === "video") {
    const url = URL.createObjectURL(manualDraftFiles[0]);
    manualDraftPreviewUrls.push(url);
    const v = document.createElement("video");
    v.src = url;
    v.controls = true;
    v.preload = "metadata";
    v.className = "manual-draft-preview-item";
    box.appendChild(v);
    return;
  }

  // image(1장) / carousel(2~3장) 모두 같은 그리드에 순서대로 넣는다 -
  // 배열 순서가 곧 업로드 순서이고 서버가 그 순서를 slideIndex로 보존한다.
  // 1장이든 캐러셀이든 인라인은 작은 썸네일만 보여 준다. 크게 보기는 썸네일 클릭 →
  // 공통 뷰어(Lightbox)가 맡는다(작성 모달 안에서 원본 크기로 펼치지 않는다).
  box.classList.toggle("is-carousel", manualDraftCategory === "carousel");
  box.classList.toggle("is-single", manualDraftCategory !== "carousel");
  const cells = [];
  manualDraftFiles.forEach((f, i) => {
    const url = URL.createObjectURL(f);
    manualDraftPreviewUrls.push(url);
    const wrap = document.createElement("div");
    wrap.className = "manual-draft-preview-cell";
    const img = document.createElement("img");
    img.src = url;
    img.alt = f.name;
    img.className = "manual-draft-preview-item";
    wrap.appendChild(img);
    if (manualDraftCategory === "carousel") {
      const badge = document.createElement("span");
      badge.className = "manual-draft-preview-index";
      badge.textContent = String(i + 1);
      wrap.appendChild(badge);
    }
    box.appendChild(wrap);
    cells.push(wrap);
  });
  // 썸네일 클릭 → 확대 보기(Common Viewer). 캐러셀은 누른 장부터 열리고 좌우로 넘길 수 있다.
  // manualDraftPreviewUrls 는 위 루프가 채운 그 배열(순서 = 업로드 순서)이라 그대로 넘긴다.
  const names = manualDraftFiles.map((f) => f.name);
  cells.forEach((cell, i) => bindLocalImageZoom(cell, manualDraftPreviewUrls, i, names));
}

function manualDraftCategoryButtonsHtml() {
  return Object.keys(MANUAL_DRAFT_CATEGORY_RULES)
    .map((key) => {
      const on = key === manualDraftCategory;
      return `<button type="button" class="${on ? "chip chip-on" : "chip"}" data-manual-cat="${key}">${t(MANUAL_DRAFT_CATEGORY_RULES[key].labelKey)}</button>`;
    })
    .join("");
}

function renderManualDraftMediaState() {
  const picker = document.getElementById("manualDraftCatPicker");
  if (picker) picker.innerHTML = manualDraftCategoryButtonsHtml();
  picker?.querySelectorAll("[data-manual-cat]").forEach((b) => {
    b.addEventListener("click", () => {
      manualDraftCategory = b.dataset.manualCat;
      manualDraftFiles = [];
      releaseManualDraftPreviews();
      const input = document.getElementById("manualDraftFileInput");
      if (input) input.value = "";
      renderManualDraftMediaState();
    });
  });
  // file input을 현재 카테고리에 맞춰 항상 다시 맞춘다. 예전에는 칩을 눌렀을 때만 맞춰서,
  // 모달을 처음 연 기본 상태(이미지)에서는 multiple 이 아예 설정되지 않았다 - 그래서 Windows
  // 파일 선택창이 단일 선택으로 열려 Ctrl/Shift 다중 선택이 되지 않았다.
  // 이미지 계열은 항상 여러 장 고를 수 있게 열고(캐러셀 2~3장), 고른 장수로 카테고리를 다시
  // 판정한다. 영상은 기존대로 1개만 고를 수 있다.
  const fileInput = document.getElementById("manualDraftFileInput");
  if (fileInput) {
    fileInput.accept = MANUAL_DRAFT_CATEGORY_RULES[manualDraftCategory].accept;
    fileInput.multiple = manualDraftCategory !== "video";
  }
  const status = document.getElementById("manualDraftMediaStatus");
  if (status) {
    status.textContent = manualDraftFiles.length
      ? manualDraftFiles.map((f) => f.name).join(", ")
      : t("manualDraft.mediaNone");
  }
  // 첨부 전에는 [파일 선택], 첨부 후에는 [파일 변경] + [첨부 지우기].
  const pick = document.getElementById("manualDraftPickMedia");
  if (pick) pick.textContent = manualDraftFiles.length ? t("media.change") : t("media.pick");
  const clear = document.getElementById("manualDraftClearMedia");
  if (clear) clear.style.display = manualDraftFiles.length ? "" : "none";
  renderManualDraftPreview();
}

function manualDraftModalBodyHtml() {
  return `
    <p class="muted">${t("manualDraft.desc")}</p>
    <label class="field">
      <span>${t("manualDraft.bodyLabel")}</span>
      <textarea id="manualDraftBody" rows="10" placeholder="${t("manualDraft.bodyPlaceholder")}"></textarea>
    </label>
    <div class="field">
      <span>${t("manualDraft.mediaLabel")}</span>
      <p class="muted">${t("manualDraft.mediaHint")}</p>
      <div id="manualDraftCatPicker" class="chips"></div>
      <!-- 실제 file input은 숨기고 버튼으로 연다 - 첨부 전/후에 따라 문구가 달라져야
           "다시 골라 바꿀 수 있다"는 것이 버튼만 봐도 보이기 때문이다. -->
      <input type="file" id="manualDraftFileInput" accept="image/*" class="hidden-file-input" />
      <div class="media-actions">
        <button type="button" class="secondary" id="manualDraftPickMedia"></button>
        <button type="button" class="secondary" id="manualDraftClearMedia">${t("manualDraft.mediaClear")}</button>
      </div>
      <p class="muted" id="manualDraftMediaStatus"></p>
      <div id="manualDraftPreview" class="manual-draft-preview"></div>
    </div>
    <p class="muted" id="manualDraftFeedback"></p>`;
}

// 모달 제목의 "N번째"는 항상 서버(DB)가 알려준 값이다 - 클라이언트에서 +1로 추측하지 않는다.
async function refreshManualDraftSequenceLabel() {
  const el = document.getElementById("modalTitle");
  if (!el) return;
  const r = await api("/drafts/manual/next-sequence");
  const seq = r && r.ok ? formatManualSequence(r.next) : null;
  // 조회 실패 시에는 번호 없이 기본 제목만 둔다(저장 자체를 막지 않는다).
  el.textContent = seq ? t("manualDraft.titleWithSeq", { n: seq }) : t("manualDraft.title");
}

function openManualDraftModal() {
  manualDraftCategory = "image";
  manualDraftFiles = [];
  releaseManualDraftPreviews();
  manualDraftBusy = false;
  manualDraftSavedCount = 0;
  showModal({
    title: t("manualDraft.title"),
    bodyHtml: manualDraftModalBodyHtml(),
    // ESC/바깥 배경 클릭도 [취소]와 같은 종료 처리를 지나게 한다(목록 갱신 + 미리보기 해제).
    onDismiss: closeManualDraftModal,
    actions: [
      { label: t("btnCancel"), className: "secondary", onClick: closeManualDraftModal },
      { label: t("manualDraft.submit"), className: "big-btn", id: "manualDraftSubmitBtn", onClick: submitManualDraft },
    ],
  });
  renderManualDraftMediaState();
  refreshManualDraftSequenceLabel();
  // [파일 선택] / [파일 변경] 둘 다 같은 file input을 다시 연다. 새로 고른 파일이
  // 이전 선택을 그대로 대체하며(교체), 저장을 누르기 전에는 서버/DB를 건드리지 않는다.
  document.getElementById("manualDraftPickMedia")?.addEventListener("click", () => {
    document.getElementById("manualDraftFileInput")?.click();
  });
  document.getElementById("manualDraftFileInput")?.addEventListener("change", (e) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length === 0) return; // picker를 취소하면 이전 선택을 유지한다
    // 고른 파일이 곧 카테고리다(이미지 1장 / 캐러셀 2~3장 / 영상 1개) - 초안 카드 편집과 같은
    // 판정 함수를 쓴다. 덕분에 [캐러셀] 칩을 먼저 누르지 않아도 이미지 2~3장을 바로 고를 수
    // 있고, 4장 이상이나 혼합 선택은 기존 안내대로 받지 않는다(한 번에 최대 3장).
    const cat = classifyPickedMedia(picked);
    const feedback = document.getElementById("manualDraftFeedback");
    if (!cat) {
      if (feedback) feedback.textContent = t("media.pickInvalid");
      e.target.value = "";
      return; // 이전 선택 유지
    }
    if (feedback) feedback.textContent = "";
    manualDraftCategory = cat;
    manualDraftFiles = picked;
    renderManualDraftMediaState();
  });
  document.getElementById("manualDraftClearMedia")?.addEventListener("click", () => {
    manualDraftFiles = [];
    const input = document.getElementById("manualDraftFileInput");
    if (input) input.value = "";
    renderManualDraftMediaState();
  });
  document.getElementById("manualDraftBody")?.focus();
}

// 취소/닫기: 이번 세션에서 하나라도 저장했으면 목록을 새로 읽어 반영한다.
function closeManualDraftModal() {
  const saved = manualDraftSavedCount;
  manualDraftFiles = [];
  releaseManualDraftPreviews();
  manualDraftSavedCount = 0;
  hideModal();
  if (saved > 0) loadDrafts();
}

async function submitManualDraft() {
  if (manualDraftBusy) return; // 중복 클릭 방지 - 첫 await 전에 busy=true
  const feedback = document.getElementById("manualDraftFeedback");
  const bodyEl = document.getElementById("manualDraftBody");
  const bodyText = bodyEl ? bodyEl.value : "";
  if (!bodyText.trim()) {
    if (feedback) feedback.textContent = t("manualDraft.errorEmpty");
    return;
  }
  const rule = MANUAL_DRAFT_CATEGORY_RULES[manualDraftCategory];
  if (manualDraftFiles.length > 0 && (manualDraftFiles.length < rule.min || manualDraftFiles.length > rule.max)) {
    if (feedback) feedback.textContent = t("manualDraft.errorFileCount");
    return;
  }

  manualDraftBusy = true;
  const submitBtn = document.getElementById("manualDraftSubmitBtn");
  if (submitBtn) submitBtn.disabled = true;
  if (feedback) feedback.textContent = "";

  // 1) 미디어가 있으면 기존 보관함 업로드로 먼저 올려 assetKey를 받는다.
  let assetKey = null;
  if (manualDraftFiles.length > 0) {
    const form = new FormData();
    form.append("category", manualDraftCategory);
    for (const f of manualDraftFiles) form.append("files", f);
    let up = null;
    try {
      const res = await fetch("/api/product-radar/library/assets/upload", { method: "POST", body: form });
      up = await res.json().catch(() => null);
    } catch {
      up = null;
    }
    if (!up || !up.ok || !up.assetKey) {
      manualDraftBusy = false;
      if (submitBtn) submitBtn.disabled = false;
      if (feedback) feedback.textContent = t("manualDraft.errorUpload");
      return;
    }
    assetKey = up.assetKey;
  }

  // 2) 초안 저장 - 본문은 원문 그대로 보낸다(trim하지 않음).
  const payload = { body: bodyText };
  if (assetKey) payload.assetKey = assetKey;
  const resp = await api("/drafts/manual", { method: "POST", body: JSON.stringify(payload) });

  manualDraftBusy = false;
  if (submitBtn) submitBtn.disabled = false;

  if (!resp || !resp.ok) {
    if (feedback) feedback.textContent = t("manualDraft.errorSave");
    return;
  }

  // 3) 저장 성공 - 모달을 닫지 않고 입력만 비워 바로 다음 글을 쓸 수 있게 한다(연속 작성).
  manualDraftSavedCount += 1;
  manualDraftFiles = [];
  releaseManualDraftPreviews();
  // 모달을 닫지 않으므로, 뒤에 깔린 초안함 목록을 여기서 바로 갱신한다. 예전에는 모달을
  // 닫을 때만 갱신해서, 저장 직후에는 제목 번호만 올라가고 뒤 목록은 그대로였다 - 그래서
  // "저장이 안 되고 다음 화면으로 넘어갔다"고 오해하게 만들었다(실제로는 DB에 저장됨).
  loadDrafts();
  if (bodyEl) {
    bodyEl.value = "";
    bodyEl.focus();
  }
  const input = document.getElementById("manualDraftFileInput");
  if (input) input.value = "";
  renderManualDraftMediaState();
  refreshManualDraftSequenceLabel(); // 저장 후에도 DB가 알려주는 실제 다음 번호로 갱신
  // 방금 저장한 글이 몇 번째인지 서버가 알려준 값으로 말해 준다(제목은 이미 다음 번호라,
  // 번호를 함께 보여 줘야 무엇이 저장됐는지 분명해진다).
  const savedSeq = formatManualSequence(resp.manualSequence);
  if (feedback) feedback.textContent = savedSeq ? t("manualDraft.savedWithSeq", { n: savedSeq }) : t("manualDraft.saved");
}

// 모달을 [취소]가 아니라 ESC/바깥 배경 클릭으로 닫을 때 실행할 정리 함수.
// showModal 을 부를 때 onDismiss 로 넘기면 세 닫기 경로가 모두 같은 처리를 지난다
// (직접 글 작성처럼 닫을 때 목록 갱신·미리보기 해제가 필요한 모달을 위한 것).
let modalDismissHandler = null;

function showModal({ title, bodyHtml, actions, onDismiss }) {
  modalDismissHandler = onDismiss || null;
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  const actionsEl = $("#modalActions");
  actionsEl.innerHTML = "";
  actions.forEach((a) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = a.label;
    if (a.className) btn.className = a.className;
    if (a.id) btn.id = a.id;
    if (a.disabled) btn.disabled = true;
    btn.addEventListener("click", a.onClick);
    actionsEl.appendChild(btn);
  });
  $("#modalOverlay").style.display = "flex";
  const first = actionsEl.querySelector("button:not(:disabled)");
  if (first) first.focus();
}
function hideModal() {
  modalDismissHandler = null;
  $("#modalOverlay").style.display = "none";
  $("#modalTitle").textContent = "";
  $("#modalBody").innerHTML = "";
  $("#modalActions").innerHTML = "";
}
// ESC / 바깥 배경 클릭 전용 진입점. 등록된 정리 함수가 있으면 그쪽으로 보내고(그 함수가
// 안에서 hideModal 을 부른다), 없으면 예전처럼 바로 닫는다. 핸들러를 먼저 비워 재귀를 막는다.
function dismissModal() {
  const handler = modalDismissHandler;
  modalDismissHandler = null;
  if (handler) handler();
  else hideModal();
}
function initModal() {
  $("#modalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "modalOverlay") dismissModal();
  });
  document.addEventListener("keydown", (e) => {
    // 확대 보기(공통 뷰어)가 열려 있으면 ESC는 뷰어만 닫는다 - 아래 모달(직접 글 작성 등)은 유지
    if (e.key === "Escape" && !$("#prLibraryViewerOverlay") && $("#modalOverlay").style.display !== "none") dismissModal();
  });
}

// ---------------- 초안함 비우기 ----------------
// 안전하게 삭제 가능한 초안(작성 중/거절/예약 안 된 승인)만 정리합니다.
// 예약·발행 중이거나 발행 이력이 있는 초안은 서버가 보호합니다.
// 비울 수 있는 초안이 0건이면 버튼을 눌러볼 필요조차 없게 미리 잠근다(요청서 D-2).
async function refreshPurgeDraftsButtonState() {
  const btn = $("#btnPurgeDrafts");
  if (!btn) return;
  const pv = await api("/drafts/purge/preview");
  btn.disabled = !pv || pv.deletable === 0;
}

async function openPurgeDraftsModal() {
  const pv = await api("/drafts/purge/preview");
  if (!pv) return;
  if (pv.total === 0 || pv.deletable === 0) {
    showModal({
      title: t("purgeDraftsTitle"),
      bodyHtml: `<p>${t("purgeDraftsNothing")}</p>`,
      actions: [{ label: t("btnClose"), onClick: hideModal }],
    });
    return;
  }
  showModal({
    title: t("purgeDraftsTitle"),
    bodyHtml:
      // 질문 자체에 "몇 건을 비우는지"를 넣는다 - 개수를 확인하지 않고 누르는 일이 없게.
      `<p>${t("purgeDraftsQuestion", { n: pv.deletable })}</p>` +
      `<p>${t("purgeDraftsBody")}</p>` +
      `<p class="muted">${t("purgeDraftsCounts", { del: pv.deletable, keep: pv.protected })}</p>`,
    actions: [
      { label: t("btnCancel"), onClick: hideModal },
      {
        label: t("btnPurgeDrafts"),
        className: "danger",
        onClick: async () => {
          const r = await api("/drafts/purge", { method: "POST" });
          hideModal();
          if (!r || !r.success) return;
          await loadDrafts();
          // P1.6(AUD-P1-001): 선언된 적 없는 전역 함수를 부르던 옛 상태 갱신 호출을 제거했다 -
          // ReferenceError로 아래 완료 안내 모달이 절대 뜨지 않던 버그. 전역 상태는 30초 주기
          // loadDashboard가 갱신한다.
          const msg = r.kept > 0
            ? t("purgeDraftsDonePartial", { del: r.deleted, keep: r.kept })
            : t("purgeDraftsDone", { del: r.deleted });
          // 완료는 모달을 한 번 더 띄우지 않고 초안함 화면 안에 남긴다(개별 삭제와 동일한 자리).
          showDraftsPurgeFeedback(msg);
        },
      },
    ],
  });
}

// 초안함 상단에 결과 한 줄만 남긴다. 다음 렌더(loadDrafts)에서 자연히 사라지지 않도록
// 별도 영역에 넣고, 화면을 떠났다 오면 초기화된다(transient UI 원칙).
function showDraftsPurgeFeedback(message) {
  const el = $("#draftsPurgeFeedback");
  if (!el) return;
  el.textContent = message;
  el.style.display = "";
}

function clearDraftsPurgeFeedback() {
  const el = $("#draftsPurgeFeedback");
  if (!el) return;
  el.textContent = "";
  el.style.display = "none";
}

// ---------------- 데이터 관리 (화면 설정 초기화 / 공장 전체 초기화) ----------------
const FACTORY_RESET_CONFIRM_TEXT = "초기화";

function initDataManagement() {
  $("#btnResetScreenPrefs")?.addEventListener("click", openResetScreenPrefsModal);
  $("#btnFactoryReset")?.addEventListener("click", openFactoryResetModal);
}

function openResetScreenPrefsModal() {
  showModal({
    title: t("modalResetScreenTitle"),
    bodyHtml: `<p>${t("modalResetScreenBody1")}</p>
      <p class="muted">${t("modalResetScreenBody2")}</p>`,
    actions: [
      { label: t("btnCancel"), className: "secondary", onClick: hideModal },
      { label: t("resetConfirmWord"), className: "success", onClick: runResetScreenPrefs },
    ],
  });
}

// localStorage에 실제로 저장되는 화면 설정은 테마 하나뿐입니다(필터·정렬·임시 입력값은
// 애초에 저장되지 않고 화면 전환마다 남아있는 DOM 상태일 뿐이라, 여기서 함께 기본값으로
// 되돌려도 서버나 DB에는 아무 영향이 없습니다).
function runResetScreenPrefs() {
  try { localStorage.removeItem(THEME_STORAGE_KEY); } catch { /* 저장소 접근 불가 시 무시 */ }
  applyTheme("auto");
  $all('input[name="themeChoice"]').forEach((r) => { r.checked = r.value === "auto"; });

  // P1.3: chip filter 기본값(전체) 복원 - 기존 화면 설정 초기화 계약 그대로.
  draftStatusFilterValue = "";
  renderDraftFilterChips();
  const candSort = $("#candidateSort");
  if (candSort) candSort.value = "score";
  const candSourceFilter = $("#candidateSourceFilter");
  if (candSourceFilter) candSourceFilter.value = "";
  const hideFailed = $("#chkHideFailed");
  if (hideFailed) hideFailed.checked = false;
  const hideDup = $("#chkHideDuplicate");
  if (hideDup) hideDup.checked = false;

  hideModal();
  showView("home"); // P1.3: 화면 초기화 완료 → 메인 화면
}

function openFactoryResetModal() {
  showModal({
    title: t("modalFactoryResetTitle"),
    bodyHtml: `
      <p class="muted">${t("modalFactoryResetIntro")}</p>
      <div class="reset-columns">
        <div>
          <strong>${t("modalDeleted")}</strong>
          <ul>
            <li>${t("resetDeleteDrafts")}</li>
            <li>${t("resetDeleteMaterials")}</li>
            <li>${t("resetDeletePublishLog")}</li>
            <li>${t("resetDeleteRoutine")}</li>
            <li>${t("resetDeleteSettings")}</li>
            <li>${t("resetDeleteFeeds")}</li>
            <li>${t("resetDeletePersona")}</li>
            <li>${t("resetDeleteMedia")}</li>
            <li>${t("resetDeleteFailureLogs")}</li>
            <li>${t("resetDeleteProductRadar")}</li>
          </ul>
        </div>
        <div>
          <strong>${t("modalKept")}</strong>
          <ul>
            <li>${t("resetKeepSchema")}</li>
            <li>${t("resetKeepEnv")}</li>
            <li>${t("resetKeepSource")}</li>
          </ul>
        </div>
      </div>
      <label>${t("modalConfirmInputLabel", { word: FACTORY_RESET_CONFIRM_TEXT })}
        <input type="text" id="factoryResetConfirmInput" autocomplete="off" />
      </label>
      <div id="factoryResetError" class="muted"></div>
    `,
    actions: [
      { label: t("btnCancel"), className: "secondary", onClick: hideModal },
      { label: t("modalFactoryResetExec"), className: "danger", id: "factoryResetExecBtn", disabled: true, onClick: runFactoryReset },
    ],
  });
  const confirmInput = $("#factoryResetConfirmInput");
  confirmInput?.addEventListener("input", () => {
    const execBtn = $("#factoryResetExecBtn");
    if (execBtn) execBtn.disabled = confirmInput.value.trim() !== FACTORY_RESET_CONFIRM_TEXT;
  });
  confirmInput?.focus();
}

let factoryResetBusy = false;
async function runFactoryReset() {
  if (factoryResetBusy) return; // 중복 클릭 방지
  const confirmInput = $("#factoryResetConfirmInput");
  const errorEl = $("#factoryResetError");
  if (!confirmInput || confirmInput.value.trim() !== FACTORY_RESET_CONFIRM_TEXT) {
    if (errorEl) errorEl.textContent = t("factoryResetWrongConfirm", { word: FACTORY_RESET_CONFIRM_TEXT });
    return;
  }
  factoryResetBusy = true;
  if (errorEl) errorEl.textContent = t("factoryResetInProgress");
  const r = await api("/settings/factory-reset", { method: "POST", body: JSON.stringify({ confirmText: confirmInput.value.trim() }) });
  factoryResetBusy = false;
  if (r && r.success) {
    hideModal();
    const warnNote = r.warnings && r.warnings.length ? t("factoryResetWarnNote", { n: r.warnings.length }) : "";
    alert(t("factoryResetDone") + warnNote);
    showView("home"); // P1.3: 공장 전체 초기화 완료 → 메인 화면(데이터 계약은 기존 그대로)
  } else if (errorEl) {
    errorEl.textContent = t("factoryResetFail") + (r?.error || t("errUnknown"));
  }
}

// 부팅 오버레이는 "초기화가 끝났다"는 신호가 있을 때만 걷는다.
function hideStartupOverlay() {
  if (typeof document === "undefined") return; // Node 테스트가 이 파일을 require할 때
  document.getElementById("startupOverlay")?.classList.add("is-hidden");
}

// 안전장치: 초기화가 어떤 이유로든 끝나지 않더라도 오버레이가 영원히 화면을 막고 있지
// 않게 한다. 브라우저에서만 예약한다 - 파일 아래 DOMContentLoaded 등록과 같은 가드 방식이다.
const STARTUP_OVERLAY_MAX_MS = 15000;
if (typeof document !== "undefined") setTimeout(hideStartupOverlay, STARTUP_OVERLAY_MAX_MS);

// ---------------- 초기화 ----------------
// 본편 화면을 초기화합니다. 부팅 시 1회가 정상이며, initMainApp을 통째로 다시 실행하면
// 이벤트 리스너/30초 폴링이 중복 등록되므로 두 번째부터는 대시보드 새로고침만 수행합니다.
let mainAppInitialized = false;
function initMainAppOnce() {
  if (mainAppInitialized) {
    loadDashboard();
    return;
  }
  mainAppInitialized = true;
  initMainApp();
}

function initMainApp() {
  initNav();
  initEditorTabs();
  initSchedMgmtTabs();
  initSidebarToggle();
  initTopbarHeightSync();
  initTheme();
  initModal();
  initDataManagement();
  initAutoPublishControl(); // P1.6: 예약 관리의 자동 발행 조작 카드(정적 DOM이라 1회 바인딩)
  initMainButtons();
  initCollectView();
  initAffiliateView();
  initScheduleRoutineUI();
  initMaterialsForm();
  initPersonaForm();
  initFeedsForm();
  initPublishSettings();
  initThreadsSettings();
  renderDraftFilterChips(); // P1.3: 상태 select 대신 filter chip
  $("#btnPurgeDrafts")?.addEventListener("click", openPurgeDraftsModal);
  $("#btnManualDraft")?.addEventListener("click", openManualDraftModal);
  $("#btnSelectAllDrafts")?.addEventListener("click", toggleSelectAllDrafts);
  $("#btnDeleteSelectedDrafts")?.addEventListener("click", deleteSelectedDrafts);

  loadDashboard(); // 대시보드 메뉴는 제거됐지만 상단 상태바(전역 상태)는 이 집계를 계속 사용한다
  setInterval(loadDashboard, 30000); // 30초마다 상단 상태바 자동 갱신
  // P1.3: 기본 진입은 정적 메인 화면(view-home)이라 별도 데이터 로드가 없다.
  // 각 화면은 사용자가 이동할 때 showView() 훅에서 로드된다.

}

// 브라우저에는 항상 document가 있으므로 실제 동작은 그대로다 - 이 가드는 Node 테스트가
// (아래 module.exports로) app.js를 require해 순수 함수를 실제로 실행 검증할 수 있게 하기
// 위한 것뿐이다(Node에는 DOM이 없어 이 최상위 호출이 없으면 require 자체가 즉시 죽는다).
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    initLanguage(); // 다른 init보다 먼저: 정적 문구 번역을 초기 렌더링 전에 끝냅니다.
    // 사이드바 핸들러를 붙이는 initMainApp()까지 끝난 뒤에 오버레이를 걷는다.
    // (걷힌 화면은 곧바로 첫 클릭이 먹는 상태여야 한다)
    initMainAppOnce();
    hideStartupOverlay();
  });
}

// 브라우저에서는 module이 없어 아래 블록이 전혀 실행되지 않습니다(productRadar.js와 동일한
// 관례) - Node 테스트가 순수 로직만 실제 배포 파일 그대로 검증할 수 있도록 최소로 내보냅니다.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    statusLabel,
    draftCardHtml,
    orderDraftboxList,
    classifyPickedMedia,
    buildDraftMediaBadgeHtml,
    buildDraftMediaSectionHtml,
    buildDraftCardMediaPreviewHtml,
    buildDraftMediaFileUrl,
    formatManualSequence,
    classifyDashboardStatusResponse,
    // P1.6(AUD-P1-002): 외부 URL scheme 검증 순수 함수 - test-runner가 직접 실행 검증.
    isAllowedExternalUrl,
  };
}
