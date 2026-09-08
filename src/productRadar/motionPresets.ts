// src/productRadar/motionPresets.ts
// 상품 레이더 Phase 12.5.3.9: 짧은 영상/GIF 후보 A/B/C의 결정론적 모션 프리셋. 이 파일은
// ffmpeg zoompan 필터 표현식 문자열만 계산하는 순수 함수다(spawn/파일 I/O 없음 -
// mediaCardRenderer.ts/mediaCarouselRenderer.ts와 동일한 "렌더러는 순수 계산" 원칙).
//
// Math.random/Date.now/crypto.randomUUID를 레이아웃 결정에 쓰지 않는다(요청서 6절) - 이
// 파일의 모든 함수는 같은 인자를 넣으면 항상 같은 문자열을 반환한다. 실제 인코딩 결과가
// byte-for-byte 동일한지는 h264_mf/GIF 인코더 자체의 컨테이너 메타데이터(encoder 버전
// 문자열 등)에 달려 있고, 이 파일이 만드는 필터 그래프/타이밍 자체는 항상 결정론적이다.
//
// 카드셀(2~3 slide) motion은 crossfade 없이 hard-cut(순서대로 이어붙임)한다 - 이유:
// (1) 전환 자체를 사용자가 고르지 않는다는 요구사항(원 스펙 15절)은 이미 만족하고,
// (2) crossfade(xfade)를 쓰면 겹침 구간만큼 duration 계약(10/12/15초, 4/6/8초)이 어긋나지
// 않도록 매 preset·slide 수마다 overlap 보정 수식이 필요해 필터 그래프가 크게 복잡해지고
// 검증 리스크가 커진다. hard-cut은 duration이 슬라이드별 clip 길이의 정확한 합이 되어
// 계약을 가장 단순하고 확실하게 지킨다(예: A안 스펙의 "carousel은 부드러운 crossfade"는
// 예시(예:)였을 뿐 필수 요구사항이 아니었다).

export type ProductRadarMotionPreset = "smooth" | "slide" | "punch";
export const PRODUCT_RADAR_MOTION_PRESETS: readonly ProductRadarMotionPreset[] = ["smooth", "slide", "punch"];

// smooth: 초당 +2.4%p 줌인, punch: 초반 25% 구간에서 빠르게 1.15배까지 줌인 후 유지,
// slide: 고정 1.15배 줌 상태로 좌->우 pan. 세 프리셋 모두 zoompan의 `on`(0-based 출력 프레임
// 번호)만 사용한다 - `on`은 각 clip 안에서 항상 0부터 시작하므로(zoompan은 clip 단위로 다시
// 실행된다) 전부 그 clip 자신의 frameCount 기준으로만 계산하면 된다.
const SMOOTH_ZOOM_PER_SECOND = 0.024;
const SMOOTH_MAX_ZOOM = 1.08;
const SLIDE_ZOOM = 1.15;
const PUNCH_MAX_ZOOM = 1.15;
const PUNCH_RAMP_FRACTION = 0.25;

// frameCount는 해당 clip의 정확한 총 출력 프레임 수(fps * clipDurationSeconds, 호출부가
// 미리 반올림해서 넘긴다) - 이 값 자체가 "언제 최대 줌에 도달하는지"의 기준이 된다.
export function buildZoompanExpr(preset: ProductRadarMotionPreset, width: number, height: number, fps: number, frameCount: number): string {
  const n = Math.max(2, Math.round(frameCount)); // on의 분모가 0이 되지 않도록 최소 2프레임 보장
  if (preset === "smooth") {
    const perFrame = SMOOTH_ZOOM_PER_SECOND / fps;
    return `zoompan=z='min(1+${perFrame}*on,${SMOOTH_MAX_ZOOM})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
  }
  if (preset === "slide") {
    return `zoompan=z='${SLIDE_ZOOM}':d=1:x='(iw-iw/zoom)*(on/${n - 1})':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
  }
  // punch
  const rampFrames = Math.max(1, Math.round(n * PUNCH_RAMP_FRACTION));
  const perFrame = (PUNCH_MAX_ZOOM - 1) / rampFrames;
  return `zoompan=z='if(lte(on,${rampFrames}),1+${perFrame}*on,${PUNCH_MAX_ZOOM})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
}

// 각 clip의 -vf 체인 전체("scale -> zoompan -> format") - 실제 스트림 라벨 접두사는 호출부
// (ffmpegRuntime.ts)가 filter_complex 조립 시 붙인다.
export function buildClipFilterChain(preset: ProductRadarMotionPreset, width: number, height: number, fps: number, frameCount: number): string {
  return `scale=${width}:${height},${buildZoompanExpr(preset, width, height, fps, frameCount)}`;
}

// ==================================================================================
// duration contract(요청서 확정본) - 사용자는 절대 선택하지 않는다, 서버가 source slide
// 수만으로 결정한다.
// ==================================================================================
export const PRODUCT_RADAR_MOTION_VIDEO_WIDTH = 1080;
export const PRODUCT_RADAR_MOTION_VIDEO_HEIGHT = 1350;
export const PRODUCT_RADAR_MOTION_VIDEO_FPS = 30;
const VIDEO_TOTAL_DURATION_BY_SLIDE_COUNT: Record<number, number> = { 1: 10, 2: 12, 3: 15 };

export const PRODUCT_RADAR_MOTION_GIF_WIDTH = 720;
export const PRODUCT_RADAR_MOTION_GIF_HEIGHT = 900;
export const PRODUCT_RADAR_MOTION_GIF_FPS = 12;
const GIF_TOTAL_DURATION_BY_SLIDE_COUNT: Record<number, number> = { 1: 4, 2: 6, 3: 8 };

export function videoTotalDurationSeconds(slideCount: number): number | null {
  return VIDEO_TOTAL_DURATION_BY_SLIDE_COUNT[slideCount] ?? null;
}
export function gifTotalDurationSeconds(slideCount: number): number | null {
  return GIF_TOTAL_DURATION_BY_SLIDE_COUNT[slideCount] ?? null;
}

// 슬라이드 1장당 clip 길이(초) - 총 duration을 slideCount로 균등 분할한다(hard-cut이므로
// overlap 보정 없이 정확히 합이 total과 같다).
export function perClipDurationSeconds(totalDurationSeconds: number, slideCount: number): number {
  return totalDurationSeconds / slideCount;
}
