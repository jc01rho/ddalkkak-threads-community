// src/routes/health.ts — GET /health
// 민감 정보 없이 "이 Worker가 살아있다"만 확인하는 용도(요청서: 필요하면 비민감 health
// endpoint는 허용). binding/secret 값을 검사하거나 노출하지 않습니다.

export function handleHealth(): { ok: true } {
  return { ok: true };
}
