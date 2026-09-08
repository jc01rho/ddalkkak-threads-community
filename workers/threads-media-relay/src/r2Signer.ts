// src/r2Signer.ts
// Cloudflare 공식 R2 presigned URL 예제와 호환되는 방식(aws4fetch)만 사용합니다(요청서
// 7절 - 자체 AWS SigV4 구현 금지: canonical request 처리가 보안 민감·복잡해 유지보수
// 위험이 큽니다). service=s3, region=auto, R2 S3 API endpoint를 정확히 사용합니다.
//
// presigned URL은 custom domain에서 동작하지 않으므로(Cloudflare 공식 문서 확인 완료,
// docs/design/threads-media-production-relay-design.md 5절) 항상
// https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key> 형태의 R2 native S3 API
// hostname을 사용합니다.

import { AwsClient } from "aws4fetch";

export interface R2SignerOptions {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PresignedUrlResult {
  url: string;
  expiresAt: number; // epoch seconds
}

export class R2Signer {
  private readonly client: AwsClient;
  private readonly endpointBase: string;

  constructor(private readonly opts: R2SignerOptions) {
    this.client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.endpointBase = `https://${opts.accountId}.r2.cloudflarestorage.com/${opts.bucketName}`;
  }

  // PUT은 반드시 특정 object key 1개 + 정확한 Content-Type만 서명합니다 - client가 PUT 시
  // 다른 Content-Type을 보내면 서명이 깨져 업로드가 거부됩니다(요청서 19절 "signature
  // mismatch가 나도록"). bucket 전체 write capability를 넘기지 않습니다(정확히 이 key만).
  //
  // 주의(테스트로 실측 확인한 aws4fetch 동작): aws4fetch는 기본적으로 content-type을
  // UNSIGNABLE_HEADERS에 포함시켜 서명에서 제외합니다(presigned URL이 임의 Content-Type의
  // 업로드도 받아들일 수 있게 하는 기본값). 이 프로젝트는 Content-Type을 서명에 강제로
  // 포함시키길 원하므로 { allHeaders: true }를 명시적으로 넘겨 UNSIGNABLE_HEADERS 필터를
  // 우회합니다 - 이렇게 해야 X-Amz-SignedHeaders에 content-type이 포함되고, R2가 실제 PUT
  // 요청의 Content-Type을 서명 재계산에 반영해 다른 값이면 거부합니다.
  async presignPut(objectKey: string, contentType: string, ttlSeconds: number): Promise<PresignedUrlResult> {
    const url = new URL(`${this.endpointBase}/${objectKey}`);
    url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
    const req = new Request(url.toString(), { method: "PUT", headers: { "Content-Type": contentType } });
    const signed = await this.client.sign(req, { aws: { signQuery: true, allHeaders: true } });
    return { url: signed.url, expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds };
  }

  // GET은 Meta fetch용입니다 - Content-Type을 서명에 강제하지 않습니다(Meta 요청 자체에는
  // Content-Type 헤더가 없습니다).
  async presignGet(objectKey: string, ttlSeconds: number): Promise<PresignedUrlResult> {
    const url = new URL(`${this.endpointBase}/${objectKey}`);
    url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
    const req = new Request(url.toString(), { method: "GET" });
    const signed = await this.client.sign(req, { aws: { signQuery: true } });
    return { url: signed.url, expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds };
  }
}

// crypto.getRandomValues 기반 난수 object key 생성(요청서 16절): 원본 filename/license id/
// machine hash를 절대 포함하지 않고, 순차적으로 예측 가능한 값도 아닙니다. 날짜 prefix만
// 포함해 개인 식별 정보 없이도 운영자가 대략적인 생성 시점을 가늠할 수 있게 합니다.
export function generateObjectKey(prefix: string, ext: string): string {
  const datePrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const random = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}/${datePrefix}/${random}.${ext}`;
}

export function extForContentType(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "video/mp4") return "mp4";
  return "bin";
}
