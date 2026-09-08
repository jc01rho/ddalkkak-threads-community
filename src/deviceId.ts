// src/deviceId.ts
// 이 PC를 안정적으로 식별하는 값을 만듭니다.
//
// 상용 라이선스 계층(src/license/)에 있던 계산 로직을 그대로 옮겨온 것입니다 - salt·정규화·
// 해시·출력 형식이 모두 동일하므로 같은 PC에서는 기존과 완전히 같은 값이 나옵니다.
// 새 기기식별 알고리즘을 만들지 않았습니다.
//
// 원문(MachineGuid)은 저장/전송/로그에 남기지 않고, 아래 해시 결과만 사용합니다:
//   sha256("DDALKKAK_THREADS_FACTORY_DEVICE_SALT_V1" + normalize(MachineGuid))
// 해시값은 소문자 hexadecimal로 통일합니다.
//
// MachineGuid를 읽지 못하면 "불안정한 랜덤값으로 대체"하지 않고 명확한 오류를 던집니다.
// 무작위 대체 ID는 재설치/재부팅마다 값이 바뀌어 매번 새 기기로 오인식됩니다.
//
// 테스트 방식: 환경변수 분기를 코드에 남기지 않고, computeMachineHash()가 "원문을 읽는
// 함수"를 매개변수로 받도록 설계돼 있습니다. 운영 코드는 항상 인자 없이 호출합니다.

import { execFileSync } from "child_process";
import crypto from "crypto";

// 기기 식별 해시에 함께 섞는 제품 구분용 salt. 비밀번호가 아니라 "이 제품이 만든 해시"라는
// 구분값입니다. 코드에 고정되어 있어도 보안상 문제되지 않으며, 기존 설치와 같은 값을
// 내려면 반드시 이 문자열이어야 합니다.
const DEVICE_HASH_SALT = "DDALKKAK_THREADS_FACTORY_DEVICE_SALT_V1";

export class DeviceIdError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DeviceIdError";
    this.code = code;
  }
}

// 실제 레지스트리 조회 함수. computeMachineHash()의 기본 인자로만 쓰입니다.
export type RawGuidReader = () => string;

export function readMachineGuidFromRegistry(): string {
  // reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid
  // 출력 예: "    MachineGuid    REG_SZ    550e8400-e29b-41d4-a716-446655440000"
  let out: string;
  try {
    out = execFileSync(
      "reg",
      ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { encoding: "utf-8", windowsHide: true, timeout: 5000 }
    );
  } catch (e: any) {
    throw new DeviceIdError("MACHINE_GUID_READ_FAILED", `MachineGuid를 확인할 수 없습니다: ${e.message}`);
  }
  const line = out.split(/\r?\n/).find((l) => l.includes("MachineGuid"));
  if (!line) throw new DeviceIdError("MACHINE_GUID_NOT_FOUND", "레지스트리 출력에서 MachineGuid 값을 찾을 수 없습니다.");
  const parts = line.trim().split(/\s+/);
  const value = parts[parts.length - 1];
  if (!value || value.length < 8) throw new DeviceIdError("MACHINE_GUID_EMPTY", "MachineGuid 값이 비어있거나 형식이 올바르지 않습니다.");
  return value;
}

function normalizeGuid(raw: string): string {
  return raw.trim().toLowerCase();
}

// 이미 확보한 원문 문자열로부터 해시만 계산하는 순수 함수(레지스트리 접근 없음).
export function computeMachineHashFromRaw(raw: string): string {
  const normalized = normalizeGuid(raw);
  return crypto.createHash("sha256").update(DEVICE_HASH_SALT + normalized, "utf-8").digest("hex");
}

// 해시된 기기 ID를 계산합니다. 반환값만 저장/전송하며, 원문은 이 함수의 지역 변수 밖으로
// 절대 나가지 않습니다.
export function computeMachineHash(reader: RawGuidReader = readMachineGuidFromRegistry): string {
  const raw = reader();
  return computeMachineHashFromRaw(raw);
}
