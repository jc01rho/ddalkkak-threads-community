// src/windowsDpapi.ts
// P0.5B: Windows DPAPI(Data Protection API, DataProtectionScope.CurrentUser)로 작은 비밀값을
// 암호화/복호화합니다. 새 native addon 없이 기존 설치본 구성(node.exe + Windows PowerShell)만으로
// 동작합니다 - .NET의 System.Security.Cryptography.ProtectedData를 PowerShell 안에서 호출합니다.
//
// 보안 원칙(요청서 2절):
//   - 평문 secret은 명령행 인수/환경변수/스크립트 문자열 어디에도 넣지 않는다 → stdin pipe로만 전달.
//   - PowerShell 스크립트 본문은 고정 문자열이며 -EncodedCommand로 넘긴다(인용/이스케이프 문제 차단).
//   - 콘솔 창을 띄우지 않는다(windowsHide + -NonInteractive).
//   - stdout에는 암호문(base64)만, 복호화 시 stdout에는 평문의 base64만 흐르며 Node 메모리에서 받는다.
//   - 실패 시 원본 PowerShell/.NET 오류 문자열을 호출부/구매자에게 올리지 않는다(코드화된 오류만).
//
// CurrentUser scope: 같은 Windows 사용자 계정에서만 복호화되고, 파일을 다른 PC/다른 계정으로 옮기면
// 복호화에 실패합니다. 딸깍은 1PC 라이선스 Windows 전용 제품이라 이것이 기본 정책입니다.
// LocalMachine scope는 쓰지 않습니다.

import { spawn, SpawnOptions } from "child_process";

export type DpapiErrorCode = "DPAPI_UNAVAILABLE" | "DPAPI_PROTECT_FAILED" | "DPAPI_UNPROTECT_FAILED" | "DPAPI_INVALID_INPUT";

export class DpapiError extends Error {
  readonly code: DpapiErrorCode;
  constructor(code: DpapiErrorCode) {
    super(code);
    this.name = "DpapiError";
    this.code = code;
  }
}

// 스크립트는 stdin 전체를 읽어 base64 → bytes → Protect/Unprotect → base64를 stdout으로 씁니다.
// 평문은 스크립트 본문에 절대 들어가지 않습니다(본문은 아래 두 상수로 고정).
const PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$in=[Console]::In.ReadToEnd().Trim()",
  "$bytes=[Convert]::FromBase64String($in)",
  "$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($out))",
].join("; ");

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$in=[Console]::In.ReadToEnd().Trim()",
  "$bytes=[Convert]::FromBase64String($in)",
  "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($out))",
].join("; ");

const DPAPI_TIMEOUT_MS = 15000;
const MAX_SECRET_BYTES = 8 * 1024; // App Secret은 수십 바이트 - 비정상 입력 차단

export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;

export interface DpapiDeps {
  spawnImpl?: SpawnLike;
  platform?: string;
}

function encodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

// PowerShell을 한 번 실행해 stdin(base64) → stdout(base64) 변환을 수행합니다.
function runPowerShellStdinToStdout(script: string, stdinBase64: string, deps: DpapiDeps, failCode: DpapiErrorCode): Promise<string> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return Promise.reject(new DpapiError("DPAPI_UNAVAILABLE"));
  const spawnImpl = deps.spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(script)], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // 자식 프로세스 환경에 비밀값을 싣지 않는다(현재 process.env만 그대로 상속, 추가 없음)
        env: process.env,
      });
    } catch {
      reject(new DpapiError("DPAPI_UNAVAILABLE"));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      done(() => reject(new DpapiError(failCode)));
    }, DPAPI_TIMEOUT_MS);
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr?.on("data", () => { /* 원문 오류를 보관/노출하지 않는다 */ });
    child.on("error", () => { clearTimeout(timer); done(() => reject(new DpapiError("DPAPI_UNAVAILABLE"))); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const trimmed = out.trim();
      if (code !== 0 || !trimmed) {
        done(() => reject(new DpapiError(failCode)));
        return;
      }
      done(() => resolve(trimmed));
    });
    try {
      child.stdin?.write(stdinBase64);
      child.stdin?.end();
    } catch {
      clearTimeout(timer);
      done(() => reject(new DpapiError(failCode)));
    }
  });
}

// 평문 → DPAPI 암호문(base64). 저장 가능한 문자열만 돌려줍니다.
export async function protectSecret(plainText: string, deps: DpapiDeps = {}): Promise<string> {
  if (typeof plainText !== "string" || plainText.length === 0) throw new DpapiError("DPAPI_INVALID_INPUT");
  const bytes = Buffer.from(plainText, "utf8");
  if (bytes.length > MAX_SECRET_BYTES) throw new DpapiError("DPAPI_INVALID_INPUT");
  const protectedB64 = await runPowerShellStdinToStdout(PROTECT_SCRIPT, bytes.toString("base64"), deps, "DPAPI_PROTECT_FAILED");
  // 암호문이 평문과 같은 값이면 보호되지 않은 것 - 방어적으로 거부
  if (protectedB64 === bytes.toString("base64")) throw new DpapiError("DPAPI_PROTECT_FAILED");
  return protectedB64;
}

// DPAPI 암호문(base64) → 평문. 다른 사용자/다른 PC/손상 blob은 DPAPI_UNPROTECT_FAILED.
export async function unprotectSecret(protectedBlob: string, deps: DpapiDeps = {}): Promise<string> {
  if (typeof protectedBlob !== "string" || protectedBlob.trim().length === 0) throw new DpapiError("DPAPI_INVALID_INPUT");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(protectedBlob)) throw new DpapiError("DPAPI_INVALID_INPUT");
  const plainB64 = await runPowerShellStdinToStdout(UNPROTECT_SCRIPT, protectedBlob.trim(), deps, "DPAPI_UNPROTECT_FAILED");
  try {
    const plain = Buffer.from(plainB64, "base64").toString("utf8");
    if (!plain) throw new Error("empty");
    return plain;
  } catch {
    throw new DpapiError("DPAPI_UNPROTECT_FAILED");
  }
}

export function isDpapiAvailable(platform: string = process.platform): boolean {
  return platform === "win32";
}
