// src/productRadar/ffmpegRuntime.ts
// 상품 레이더 Phase 12.5.3.9: LGPL FFmpeg(h264_mf) 실행 wrapper. 이 파일만 실제로 ffmpeg.exe/
// ffprobe.exe를 spawn한다 - 나머지 파일(motionOrchestration.ts)은 이 파일의 함수만 호출한다.
//
// 보안(요청서 9절): execFile + 인자 배열만 사용한다(shell 옵션 사용 금지, 문자열 커맨드 조립 금지).
// 사용자 입력(draftId/sourceMediaJobId/outputType)은 파일 경로/필터 표현식 어디에도 직접
// 삽입되지 않는다 - 실제로 spawn에 전달되는 모든 경로는 서버가 UUID로 새로 생성한 파일명
// (resolveMediaPath 검증 통과)뿐이고, 필터 표현식은 motionPresets.ts가 숫자 상수로만 조립한다.
//
// FFmpeg 바이너리는 Windows에서는 third-party\ffmpeg\(env.ts FFMPEG_EXE_CANDIDATES)에서만 찾는다 -
// PATH 전역 탐색을 하지 않는다(요청서 8절, browserLaunch.ts의 고정 후보 경로 원칙과 동일).
// Windows가 아닌 OS(Linux/macOS)에는 번들 ffmpeg.exe가 없으므로 고정 후보가 없을 때만 PATH의
// ffmpeg/ffprobe(패키지 관리자로 설치한 것)를 쓴다.
//
// 인코더: Windows 번들(LGPL)은 h264_mf(Media Foundation)만 있고, Linux/macOS 배포판 ffmpeg에는
// h264_mf가 없다. preflight가 H264_ENCODER_PREFERENCE 순서로 실제 사용 가능한 인코더를 골라
// 돌려주고, 인코딩은 그 인코더로 한다. 출력 계약(h264 mp4, yuv420p, 무음)은 인코더와 무관하게 같다.

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { config } from "../env";
import { ProductRadarMotionPreset, buildClipFilterChain } from "./motionPresets";

const ENCODE_TIMEOUT_MS = 120_000; // 요청서 9·17절: runaway process 방지 - 이 시간을 넘기면 강제 종료
const PROBE_TIMEOUT_MS = 15_000;

function firstExisting(paths: readonly string[]): string | null {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// Windows가 아닌 OS 전용: PATH에서 실행 가능한 파일을 찾는다(Windows에서는 호출하지 않는다).
function findOnPath(name: string): string | null {
  if (process.platform === "win32") return null;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

export function resolveFfmpegExePath(): string | null {
  if (config.FFMPEG_EXE_PATH_OVERRIDE && fs.existsSync(config.FFMPEG_EXE_PATH_OVERRIDE)) return config.FFMPEG_EXE_PATH_OVERRIDE;
  return firstExisting(config.FFMPEG_EXE_CANDIDATES) ?? findOnPath("ffmpeg");
}
export function resolveFfprobeExePath(): string | null {
  if (config.FFPROBE_EXE_PATH_OVERRIDE && fs.existsSync(config.FFPROBE_EXE_PATH_OVERRIDE)) return config.FFPROBE_EXE_PATH_OVERRIDE;
  return firstExisting(config.FFPROBE_EXE_CANDIDATES) ?? findOnPath("ffprobe");
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// 순수 의존성 주입 지점(browserLaunch.ts의 BrowserSpawner와 동일 원칙) - 운영 코드는 항상
// 인자 없이 호출해 실제 execFile을 쓰고, 테스트만 이 자리에 가짜 구현을 넣는다.
export type FfmpegExecutor = (exePath: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

function realExecutor(exePath: string, args: readonly string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(exePath, args as string[], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: String(stdout || ""), stderr: String(stderr || error.message || "") });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

export interface FfmpegTestOverrides {
  ffmpegPath?: string;
  ffprobePath?: string;
  executor?: FfmpegExecutor;
}

// ---- preflight(요청서 6절) - 프로세스 생애주기 동안 1회만 확인하면 충분하다(바이너리/OS
// 환경은 서버 실행 중 바뀌지 않는다). encoder=<name> 도움말 조회는 실제 인코딩을 전혀
// 하지 않는 read-only 확인이다. ----
export type FfmpegPreflightFailure = "ffmpeg_missing" | "encoder_missing";
export type H264Encoder = "h264_mf" | "libx264" | "libopenh264";
export const H264_ENCODER_PREFERENCE: readonly H264Encoder[] = ["h264_mf", "libx264", "libopenh264"];
// undefined = 아직 확인 안 함, null = 사용할 수 있는 인코더 없음
let cachedEncoder: H264Encoder | null | undefined;

export async function preflightFfmpegEncoder(
  testOverrides?: FfmpegTestOverrides
): Promise<{ ok: true; encoder: H264Encoder } | { ok: false; reason: FfmpegPreflightFailure }> {
  if (!testOverrides && cachedEncoder !== undefined) {
    return cachedEncoder ? { ok: true, encoder: cachedEncoder } : { ok: false, reason: "encoder_missing" };
  }
  const executor = testOverrides?.executor ?? realExecutor;
  const ffmpegPath = testOverrides?.ffmpegPath ?? resolveFfmpegExePath();
  if (!ffmpegPath) {
    if (!testOverrides) cachedEncoder = null;
    return { ok: false, reason: "ffmpeg_missing" };
  }
  let found: H264Encoder | null = null;
  for (const encoder of H264_ENCODER_PREFERENCE) {
    const result = await executor(ffmpegPath, ["-hide_banner", "-h", `encoder=${encoder}`], PROBE_TIMEOUT_MS);
    if (result.ok && result.stdout.includes(`Encoder ${encoder} `)) {
      found = encoder;
      break;
    }
  }
  if (!testOverrides) cachedEncoder = found;
  return found ? { ok: true, encoder: found } : { ok: false, reason: "encoder_missing" };
}

// 인코더별 품질 인자 - 출력 형식 인자(-pix_fmt/-an/-movflags/-f)는 공통이라 여기 넣지 않는다.
function encoderQualityArgs(encoder: H264Encoder): string[] {
  switch (encoder) {
    case "h264_mf":
      return ["-rate_control", "quality", "-quality", "80"];
    case "libx264":
      return ["-preset", "medium", "-crf", "20"];
    case "libopenh264":
      return ["-b:v", "6M"];
  }
}

// ==================================================================================
// 인코딩 - motionPresets.ts가 계산한 결정론적 필터 표현식만 조립한다(이 파일에서 새로운
// 애니메이션 로직을 발명하지 않는다).
// ==================================================================================
export interface EncodeVideoInput {
  pngPaths: readonly string[]; // 1~3개, 이미 존재가 확인된 절대 경로만(caller 책임)
  outPath: string;
  preset: ProductRadarMotionPreset;
  totalDurationSeconds: number;
  width: number;
  height: number;
  fps: number;
  encoder?: H264Encoder; // preflightFfmpegEncoder()가 고른 값. 생략하면 h264_mf(기존 Windows 동작)
}

function buildFilterComplex(pngCount: number, preset: ProductRadarMotionPreset, width: number, height: number, fps: number, perClipFrames: number): string {
  const branches: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < pngCount; i++) {
    const chain = buildClipFilterChain(preset, width, height, fps, perClipFrames);
    branches.push(`[${i}:v]${chain}[v${i}]`);
    labels.push(`[v${i}]`);
  }
  branches.push(`${labels.join("")}concat=n=${pngCount}:v=1:a=0[outv]`);
  return branches.join(";");
}

export async function encodeMotionVideo(input: EncodeVideoInput, testOverrides?: FfmpegTestOverrides): Promise<{ ok: true } | { ok: false; reason: "ffmpeg_missing" | "encode_failed" }> {
  const executor = testOverrides?.executor ?? realExecutor;
  const ffmpegPath = testOverrides?.ffmpegPath ?? resolveFfmpegExePath();
  if (!ffmpegPath) return { ok: false, reason: "ffmpeg_missing" };

  const perClipSeconds = input.totalDurationSeconds / input.pngPaths.length;
  const perClipFrames = Math.round(perClipSeconds * input.fps);
  const filterComplex = buildFilterComplex(input.pngPaths.length, input.preset, input.width, input.height, input.fps, perClipFrames);

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const p of input.pngPaths) {
    args.push("-r", String(input.fps), "-loop", "1", "-t", String(perClipSeconds), "-i", p);
  }
  args.push(
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-r",
    String(input.fps),
    "-c:v",
    input.encoder ?? "h264_mf",
    ...encoderQualityArgs(input.encoder ?? "h264_mf"),
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    input.outPath
  );

  const result = await executor(ffmpegPath, args, ENCODE_TIMEOUT_MS);
  return result.ok ? { ok: true } : { ok: false, reason: "encode_failed" };
}

export interface EncodeGifInput {
  pngPaths: readonly string[];
  outPath: string;
  preset: ProductRadarMotionPreset;
  totalDurationSeconds: number;
  width: number;
  height: number;
  fps: number;
}

export async function encodeMotionGif(input: EncodeGifInput, testOverrides?: FfmpegTestOverrides): Promise<{ ok: true } | { ok: false; reason: "ffmpeg_missing" | "encode_failed" }> {
  const executor = testOverrides?.executor ?? realExecutor;
  const ffmpegPath = testOverrides?.ffmpegPath ?? resolveFfmpegExePath();
  if (!ffmpegPath) return { ok: false, reason: "ffmpeg_missing" };

  const perClipSeconds = input.totalDurationSeconds / input.pngPaths.length;
  const perClipFrames = Math.round(perClipSeconds * input.fps);
  const branches: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < input.pngPaths.length; i++) {
    const chain = buildClipFilterChain(input.preset, input.width, input.height, input.fps, perClipFrames);
    branches.push(`[${i}:v]${chain}[v${i}]`);
    labels.push(`[v${i}]`);
  }
  // 팔레트 최적화(요청서 10절) - concat 결과 하나를 split해 palettegen/paletteuse에 각각 먹인다.
  branches.push(`${labels.join("")}concat=n=${input.pngPaths.length}:v=1:a=0,split[pa][pb]`);
  branches.push(`[pa]palettegen=stats_mode=diff[plt]`);
  branches.push(`[pb][plt]paletteuse=dither=bayer[outv]`);
  const filterComplex = branches.join(";");

  const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
  for (const p of input.pngPaths) {
    args.push("-r", String(input.fps), "-loop", "1", "-t", String(perClipSeconds), "-i", p);
  }
  // -loop 0(요청서 10절 "무한 loop") - GIF 표준 loop 옵션(무한 반복).
  args.push("-filter_complex", filterComplex, "-map", "[outv]", "-r", String(input.fps), "-loop", "0", "-f", "gif", input.outPath);

  const result = await executor(ffmpegPath, args, ENCODE_TIMEOUT_MS);
  return result.ok ? { ok: true } : { ok: false, reason: "encode_failed" };
}

// ==================================================================================
// output validation(요청서 19절) - "exit code 0만 믿지 않는다": ffprobe로 실제 스트림/
// duration/dimension을 다시 확인한다. 허용 오차: duration은 인코더 프레임 반올림으로 수 ms
// 어긋날 수 있어 ±0.5초까지 허용한다(과도한 정밀 일치를 요구하지 않는다).
// ==================================================================================
interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  nb_frames?: string;
}
interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

async function probeFile(ffprobePath: string, filePath: string, executor: FfmpegExecutor): Promise<ProbeOutput | null> {
  const result = await executor(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath], PROBE_TIMEOUT_MS);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout) as ProbeOutput;
  } catch {
    return null;
  }
}

export interface ValidateVideoExpectation {
  width: number;
  height: number;
  durationSeconds: number;
}

export async function validateMotionMp4(filePath: string, expected: ValidateVideoExpectation, testOverrides?: FfmpegTestOverrides): Promise<{ ok: true } | { ok: false }> {
  if (!fs.existsSync(filePath)) return { ok: false };
  if (fs.statSync(filePath).size <= 0) return { ok: false };
  const executor = testOverrides?.executor ?? realExecutor;
  const ffprobePath = testOverrides?.ffprobePath ?? resolveFfprobeExePath();
  if (!ffprobePath) return { ok: false };
  const probed = await probeFile(ffprobePath, filePath, executor);
  if (!probed || !probed.streams || !probed.format) return { ok: false };
  const videoStreams = probed.streams.filter((s) => s.codec_type === "video");
  const audioStreams = probed.streams.filter((s) => s.codec_type === "audio");
  if (videoStreams.length !== 1 || audioStreams.length !== 0) return { ok: false };
  const v = videoStreams[0];
  if (v.codec_name !== "h264") return { ok: false };
  if (v.width !== expected.width || v.height !== expected.height) return { ok: false };
  const duration = Number(probed.format.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - expected.durationSeconds) > 0.5) return { ok: false };
  return { ok: true };
}

export interface ValidateGifExpectation {
  width: number;
  height: number;
  durationSeconds: number;
}

export async function validateMotionGif(filePath: string, expected: ValidateGifExpectation, testOverrides?: FfmpegTestOverrides): Promise<{ ok: true } | { ok: false }> {
  if (!fs.existsSync(filePath)) return { ok: false };
  const buf = fs.readFileSync(filePath, { flag: "r" }).subarray(0, 6);
  const magic = buf.toString("ascii");
  if (magic !== "GIF87a" && magic !== "GIF89a") return { ok: false };
  const executor = testOverrides?.executor ?? realExecutor;
  const ffprobePath = testOverrides?.ffprobePath ?? resolveFfprobeExePath();
  if (!ffprobePath) return { ok: false };
  const probed = await probeFile(ffprobePath, filePath, executor);
  if (!probed || !probed.streams || !probed.format) return { ok: false };
  const videoStreams = probed.streams.filter((s) => s.codec_type === "video");
  if (videoStreams.length !== 1) return { ok: false };
  const v = videoStreams[0];
  if (v.width !== expected.width || v.height !== expected.height) return { ok: false };
  const nbFrames = Number(v.nb_frames);
  if (!Number.isFinite(nbFrames) || nbFrames <= 1) return { ok: false };
  const duration = Number(probed.format.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - expected.durationSeconds) > 0.5) return { ok: false };
  return { ok: true };
}
