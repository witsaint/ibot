import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Object storage for chat media (uploads, screenshots, recordings, artifacts).
 * Backed by Cloudflare R2 (S3-compatible, $0 egress). Binary bytes NEVER go in
 * Postgres — the DB stores only the object key + metadata; this returns presigned
 * URLs for browser upload (PUT) and read (GET).
 *
 * R2 config: endpoint = https://<account>.r2.cloudflarestorage.com, region "auto".
 */
export interface StorageConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
}

export interface PresignOptions {
  /** object key, e.g. `bots/<botId>/recordings/<uuid>.mp4` */
  key: string;
  /** seconds until the signed URL expires (default 900 = 15 min) */
  expiresIn?: number;
  /** required content type for uploads (browser must send the same) */
  contentType?: string;
}

export class Storage {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(cfg: StorageConfig) {
    this.bucket = cfg.bucket;
    this.s3 = new S3Client({
      region: cfg.region ?? "auto",
      endpoint: cfg.endpoint,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  /** Presigned PUT for a browser to upload directly to R2 (bytes skip our server). */
  presignUpload(opts: PresignOptions): Promise<string> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: opts.key,
      ContentType: opts.contentType,
    });
    return getSignedUrl(this.s3, cmd, { expiresIn: opts.expiresIn ?? 900 });
  }

  /** Presigned GET so a private object can be served without making the bucket public. */
  presignDownload(opts: PresignOptions): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: opts.key });
    return getSignedUrl(this.s3, cmd, { expiresIn: opts.expiresIn ?? 900 });
  }

  /** Server-side upload (e.g. a screenshot the agent captured, bytes already on the server). */
  async putObject(key: string, body: Uint8Array | Buffer, contentType?: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Delete an object (attachment TTL cleanup). */
  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
