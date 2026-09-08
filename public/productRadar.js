// public/productRadar.js
// 초안함/미디어 보관함이 쓰는 공용 미디어 뷰어(Common Viewer)만 담고 있습니다.
// app.js보다 먼저 로드되어야 하며, app.js가 openProductRadarLibraryViewer()와
// buildProductRadarLibraryZipUrl()을 직접 호출합니다.

let prLibraryViewerItemIndex = null; // prViewerList의 index | null(닫힘)
let prLibraryViewerSlideIndex = 0;
let prViewerList = null;

function buildProductRadarMediaPreviewUrl(filename) {
  return `/api/product-radar/media/${encodeURIComponent(filename)}`;
}

function buildProductRadarLibraryZipUrl(assetKey) {
  return `/api/product-radar/library/assets/${encodeURIComponent(assetKey)}/zip`;
}

function closeProductRadarLibraryViewer() {
  if (prLibraryViewerItemIndex === null) return;
  prLibraryViewerItemIndex = null;
  prViewerList = null;
  const el = $("#prLibraryViewerOverlay");
  if (el) el.remove();
  document.removeEventListener("keydown", onProductRadarLibraryViewerKeydown);
}

function onProductRadarLibraryViewerKeydown(e) {
  if (e.key === "Escape") {
    closeProductRadarLibraryViewer();
  } else if (e.key === "ArrowLeft") {
    moveProductRadarLibraryViewerSlide(-1);
  } else if (e.key === "ArrowRight") {
    moveProductRadarLibraryViewerSlide(1);
  }
}

// list는 { files: [{filename, slideIndex, width, height, available}], category }[] shape만
// 갖추면 어디서든 재사용 가능하다(요청서 23절) - 미디어 보관함/캐러셀 candidate 둘 다 이 shape로
// 맞춰서 넘긴다(변환 로직은 각 호출부 책임, viewer 자체는 출처를 모른다).
function openProductRadarLibraryViewer(list, itemIndex, slideIndex) {
  const item = list && list[itemIndex];
  if (!item) return;
  prViewerList = list;
  prLibraryViewerItemIndex = itemIndex;
  prLibraryViewerSlideIndex = slideIndex || 0;
  renderProductRadarLibraryViewer();
  document.addEventListener("keydown", onProductRadarLibraryViewerKeydown);
}

// left/right bounds(요청서 24절) - 범위를 벗어나는 이동은 그냥 무시한다(순환하지 않음).
function moveProductRadarLibraryViewerSlide(delta) {
  const item = prViewerList && prViewerList[prLibraryViewerItemIndex];
  if (!item) return;
  const next = prLibraryViewerSlideIndex + delta;
  if (next < 0 || next >= item.files.length) return;
  prLibraryViewerSlideIndex = next;
  renderProductRadarLibraryViewer();
}

function renderProductRadarLibraryViewer() {
  const item = prViewerList && prViewerList[prLibraryViewerItemIndex];
  if (!item) return;
  let overlay = $("#prLibraryViewerOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "prLibraryViewerOverlay";
    overlay.className = "pr-viewer-overlay";
    document.body.appendChild(overlay);
    // backdrop click(요청서 24절) - overlay 자기 자신을 클릭했을 때만 닫는다(내부 콘텐츠 클릭은 무시).
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeProductRadarLibraryViewer();
    });
  }
  const file = item.files[prLibraryViewerSlideIndex];
  const missing = !file || !file.available;
  const counterHtml = item.files.length > 1 ? `<div class="pr-viewer-counter">${prLibraryViewerSlideIndex + 1} / ${item.files.length}</div>` : "";
  const arrowsHtml =
    item.files.length > 1
      ? `
    <button type="button" class="pr-viewer-arrow pr-viewer-arrow-left" id="btnPrViewerPrev" aria-label="${escapeHtml(t("productRadar.library.viewer.prev"))}" ${prLibraryViewerSlideIndex === 0 ? "disabled" : ""}>‹</button>
    <button type="button" class="pr-viewer-arrow pr-viewer-arrow-right" id="btnPrViewerNext" aria-label="${escapeHtml(t("productRadar.library.viewer.next"))}" ${prLibraryViewerSlideIndex === item.files.length - 1 ? "disabled" : ""}>›</button>
  `
      : "";
  const mediaHtml = missing
    ? `<p class="pr-status-line pr-bad">${t("productRadar.library.error.missing")}</p>`
    : item.category === "video"
      ? `<video class="pr-viewer-media" controls></video>`
      : `<img class="pr-viewer-media" alt="" />`;

  overlay.innerHTML = `
    <div class="pr-viewer-content">
      <button type="button" class="pr-viewer-close" id="btnPrViewerClose" aria-label="${escapeHtml(t("productRadar.library.viewer.close"))}">×</button>
      ${mediaHtml}
      ${counterHtml}
      ${arrowsHtml}
    </div>
  `;
  if (!missing) {
    const mediaEl = overlay.querySelector(".pr-viewer-media");
    // file.url이 있으면(초안함이 origin에 맞는 서빙 경로를 미리 계산해 넣어준 경우) 그걸
    // 그대로 쓰고, 없으면 기존 Product Radar 전용 경로로 fallback한다(기존 호출부는 file에
    // url 필드가 없으므로 전과 동일하게 동작 - 하위호환).
    if (mediaEl) mediaEl.src = file.url || buildProductRadarMediaPreviewUrl(file.filename); // DOM property(요청서 25절)
  }
  $("#btnPrViewerClose")?.addEventListener("click", closeProductRadarLibraryViewer);
  $("#btnPrViewerPrev")?.addEventListener("click", () => moveProductRadarLibraryViewerSlide(-1));
  $("#btnPrViewerNext")?.addEventListener("click", () => moveProductRadarLibraryViewerSlide(1));
}