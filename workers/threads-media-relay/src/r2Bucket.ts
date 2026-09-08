// src/r2Bucket.ts
// R2Bucket binding(HEAD/DELETE 전용 - presigned URL 서명과는 역할 분리, 요청서 6절)에 대한
// 최소 interface abstraction. 과도한 DI framework 없이 "간단한 interface/function seam"만
// 둡니다(요청서 36절) - production은 실제 Cloudflare R2Bucket binding을 감싸고, 테스트는
// in-memory fake로 교체합니다.

export interface RelayBucketObjectInfo {
  size: number;
  contentType: string | null;
}

export interface RelayBucket {
  head(key: string): Promise<RelayBucketObjectInfo | null>;
  delete(keys: string[]): Promise<number>; // 반환값 = 실제로 존재해서 삭제 시도한 key 수(idempotent 응답 조립용)
}

export class R2BucketAdapter implements RelayBucket {
  constructor(private readonly bucket: R2Bucket) {}

  async head(key: string): Promise<RelayBucketObjectInfo | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return { size: obj.size, contentType: obj.httpMetadata?.contentType ?? null };
  }

  async delete(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    // R2Bucket.delete()는 존재하지 않는 key를 넘겨도 에러를 던지지 않습니다(idempotent) -
    // 이미 삭제된 object에 다시 cleanup을 호출해도 안전하게 성공 처리됩니다(요청서 24절).
    await this.bucket.delete(keys);
    return keys.length;
  }
}
