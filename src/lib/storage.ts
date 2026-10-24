import { mkdir, readFile, writeFile, stat, rename } from "node:fs/promises";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { env } from "./env";

/** Persistent object storage for original files. Keys are content-addressed and write-once. */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  describe(): string;
}

export function storageKeyFor(sha256: string, ext: string): string {
  return `originals/${sha256.slice(0, 2)}/${sha256}${ext ? "." + ext : ""}`;
}

class LocalStorage implements ObjectStorage {
  constructor(private readonly root: string) {}
  private full(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.full(key);
    if (await this.exists(key)) return; // write-once
    await mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, body);
    await rename(tmp, p);
  }
  async get(key: string) {
    return readFile(this.full(key));
  }
  async exists(key: string) {
    try {
      await stat(this.full(key));
      return true;
    } catch {
      return false;
    }
  }
  describe() {
    return `local:${path.resolve(this.root)}`;
  }
}

class S3Storage implements ObjectStorage {
  private client: S3Client;
  constructor(private readonly bucket: string) {
    const e = env();
    this.client = new S3Client({
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT || undefined,
      forcePathStyle: e.S3_FORCE_PATH_STYLE === "true",
      credentials:
        e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  async put(key: string, body: Buffer, contentType: string) {
    if (await this.exists(key)) return;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return false;
      throw err;
    }
  }
  describe() {
    return `s3:${this.bucket}`;
  }
}

let instance: ObjectStorage | undefined;

export function storage(): ObjectStorage {
  if (!instance) {
    const e = env();
    if (e.STORAGE_DRIVER === "s3") {
      if (!e.S3_BUCKET) throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
      instance = new S3Storage(e.S3_BUCKET);
    } else {
      instance = new LocalStorage(e.STORAGE_LOCAL_DIR);
    }
  }
  return instance;
}

export function setStorageForTests(s: ObjectStorage | undefined) {
  instance = s;
}
