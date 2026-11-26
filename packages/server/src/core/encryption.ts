import { randomBytes } from "node:crypto";
import type { Tx } from "../db/pool.js";
import { open, seal } from "../lib/crypto.js";
import { keyProvider } from "../providers/keys.js";
import { currentTenantKey, insertTenantKey } from "./queries/encryption.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { key: Buffer; version: number; expires: number }>();

/** Creates the tenant's first data key. Called once, when the workspace is created. */
export async function createTenantKey(tx: Tx, tenantId: string): Promise<void> {
  const dek = randomBytes(32);
  const wrapped = await keyProvider().wrap(tenantId, dek);
  await insertTenantKey(tx, tenantId, keyProvider().name, wrapped);
}

async function currentKey(tx: Tx, tenantId: string): Promise<{ key: Buffer; version: number }> {
  const hit = cache.get(tenantId);
  if (hit && hit.expires > Date.now()) return hit;
  const row = await currentTenantKey(tx);
  if (!row) throw new Error("tenant has no data key");
  const key = await keyProvider().unwrap(tenantId, row.wrapped_key);
  const entry = { key, version: row.version, expires: Date.now() + CACHE_TTL_MS };
  cache.set(tenantId, entry);
  return entry;
}

/** Encrypts one restricted field value. AAD binds it to its tenant, record and field. */
export async function encryptValue(tx: Tx, tenantId: string, recordId: string, storageKey: string, value: unknown): Promise<string> {
  const { key, version } = await currentKey(tx, tenantId);
  const sealed = seal(key, Buffer.from(JSON.stringify(value)), `${tenantId}|${recordId}|${storageKey}`);
  return `v${version}:${sealed.toString("base64")}`;
}

export async function decryptValue(tx: Tx, tenantId: string, recordId: string, storageKey: string, stored: string): Promise<unknown> {
  const m = /^v(\d+):(.+)$/.exec(stored);
  if (!m) throw new Error("malformed ciphertext");
  const { key, version } = await currentKey(tx, tenantId);
  if (Number(m[1]) !== version) throw new Error("ciphertext uses a retired key version; re-encryption pending");
  const plain = open(key, Buffer.from(m[2]!, "base64"), `${tenantId}|${recordId}|${storageKey}`);
  return JSON.parse(plain.toString("utf8"));
}

/**
 * Seals a file's bytes with the workspace's data key, bound to the workspace and the file: for stores
 * outside the database, which know nothing about workspaces. Returns the key version to keep with the file.
 */
export async function sealBytes(tx: Tx, tenantId: string, fileId: string, data: Buffer): Promise<{ sealed: Buffer; version: number }> {
  const { key, version } = await currentKey(tx, tenantId);
  return { sealed: seal(key, data, `${tenantId}|file|${fileId}`), version };
}

export async function openBytes(tx: Tx, tenantId: string, fileId: string, sealed: Buffer, keyVersion: number): Promise<Buffer> {
  const { key, version } = await currentKey(tx, tenantId);
  if (keyVersion !== version) throw new Error("file uses a retired key version; re-encryption pending");
  return open(key, sealed, `${tenantId}|file|${fileId}`);
}
