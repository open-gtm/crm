import { config } from "../config.js";
import { deleteFileBlob, fileBlob, insertFileBlob } from "../core/queries/files.js";
import type { Tx } from "../db/pool.js";
import { ConfigError } from "../lib/errors.js";
import { S3Client } from "./s3.js";

/**
 * Where the bytes of files attached to records live (ADR 0011). Metadata is always in Postgres under
 * row-level security (the `files` table); a store holds bytes only. Self-hosted deployments use Postgres
 * by default, so nothing new has to run and one backup covers everything; FILE_STORE=s3 moves the bytes
 * to an S3-compatible store.
 */
export interface FileStore {
  readonly name: "postgres" | "s3";
  /**
   * True when the store sits outside the database and knows nothing about workspaces: bytes kept in it
   * are sealed with the workspace's data key first (core/files.ts), so they are useless without the database.
   */
  readonly external: boolean;
  put(tx: Tx, tenantId: string, fileId: string, data: Buffer): Promise<void>;
  get(tx: Tx, tenantId: string, fileId: string): Promise<Buffer | null>;
  delete(tx: Tx, tenantId: string, fileId: string): Promise<void>;
}

/** Bytes in the `file_blobs` table, under the same row-level security and transaction as everything else. */
export class PostgresFileStore implements FileStore {
  readonly name = "postgres";
  readonly external = false;
  async put(tx: Tx, tenantId: string, fileId: string, data: Buffer): Promise<void> {
    await insertFileBlob(tx, tenantId, fileId, data);
  }
  async get(tx: Tx, _tenantId: string, fileId: string): Promise<Buffer | null> {
    return (await fileBlob(tx, fileId)) ?? null;
  }
  async delete(tx: Tx, _tenantId: string, fileId: string): Promise<void> {
    await deleteFileBlob(tx, fileId);
  }
}

/** Bytes in an S3-compatible bucket, one object per file under `<workspace>/<file>`. */
export class S3FileStore implements FileStore {
  readonly name = "s3";
  readonly external = true;
  constructor(private readonly client: S3Client) {}
  private key = (tenantId: string, fileId: string) => `${tenantId}/${fileId}`;
  async put(_tx: Tx, tenantId: string, fileId: string, data: Buffer): Promise<void> {
    await this.client.put(this.key(tenantId, fileId), data);
  }
  async get(_tx: Tx, tenantId: string, fileId: string): Promise<Buffer | null> {
    return this.client.get(this.key(tenantId, fileId));
  }
  async delete(_tx: Tx, tenantId: string, fileId: string): Promise<void> {
    await this.client.delete(this.key(tenantId, fileId));
  }
}

const postgres = new PostgresFileStore();
let s3: FileStore | null = null;
let override: FileStore | null = null;

/** The store new uploads go to (FILE_STORE). */
export function fileStore(): FileStore {
  if (override) return override;
  return config().FILE_STORE === "s3" ? storeNamed("s3") : postgres;
}

/** The store a file was written to: a file keeps its store when FILE_STORE changes later. */
export function storeNamed(name: "postgres" | "s3"): FileStore {
  if (override && override.name === name) return override;
  if (name === "postgres") return postgres;
  if (s3) return s3;
  const c = config();
  if (!c.S3_ENDPOINT || !c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY) {
    throw new ConfigError("FILE_STORE=s3 needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
  }
  s3 = new S3FileStore(new S3Client({ endpoint: c.S3_ENDPOINT, bucket: c.S3_BUCKET, region: c.S3_REGION, accessKeyId: c.S3_ACCESS_KEY_ID,
    secretAccessKey: c.S3_SECRET_ACCESS_KEY }));
  return s3;
}

/** Replaces the store (tests). null restores the configured one. */
export const setFileStore = (s: FileStore | null): void => {
  override = s;
};
