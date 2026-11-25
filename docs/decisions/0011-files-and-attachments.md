# 0011: Files and attachments

Status: accepted (2026-11-24), and built as far as the next section says. What follows it is the proposal as it was discussed, kept for the parts still to come.

## Decided and built

The four open questions were answered:

1. **Where the bytes live:** Postgres by default, S3-compatible as an option (`FILE_STORE=s3`). Metadata is always in Postgres under row-level security.
2. **Limits:** 10 MB per file (`FILE_MAX_MB`) and 1 GB per workspace (`FILE_QUOTA_MB`) unless the operator says otherwise, and 100 files per record.
3. **No scanner:** acceptable. Files are accepted and marked `unscanned`, and are only ever sent as downloads. The scanner hook is not built.
4. **Merges** keep every file: the duplicates' files move to the survivor.

**Built first: files attached to records**, not yet a `file` field type. A file belongs to one record of any object (a note is a record too, so notes carry files), and follows that record's object access: read lists and downloads, write attaches and removes. This gives every object files at once, with no schema change, and it is the smaller step: a field type has to pass through every layer of the field type registry (filters, CSV, retyping, the OpenAPI document) and adds per-field access and restricted files. The `files` table is the one a field type would use too.

- **Tables** (migration 020): `files` (name, size, detected content type, SHA-256, store, key version, scan status, who and when; removed files keep their row) and `file_blobs` (the bytes, for the Postgres store), both with forced row-level security.
- **Routes:** `POST /v1/records/{id}/files?name=…` with the bytes as the body (its own size limit; the 1 MB limit for JSON stays), `GET /v1/records/{id}/files`, `GET /v1/files/{id}`, `GET /v1/files/{id}/content`, `DELETE /v1/files/{id}` and `GET /v1/files/limits`.
- **Access** is decided through the record each time: knowing a file ID gives nothing. Uploads, downloads and removals are audited (`file.uploaded`, `file.downloaded`, `file.deleted`), with the file's ID and size, never its name.
- **Downloads** are always `Content-Disposition: attachment` with `application/octet-stream`, `nosniff` and a sandboxing content security policy, whatever the file is. The content type kept with a file is detected from its first bytes, for showing; the uploader's `Content-Type` is ignored.
- **Names** are one line of text with no path separator or control character; others are refused, not cleaned.
- **The S3 store** needs no SDK: put, get and delete, signed with Signature Version 4. Bytes kept there are sealed with the workspace's data key first (AES-GCM, bound to the workspace and the file), because the store knows nothing about workspaces: a bucket's contents are useless without the database. A file keeps the store it was written to when `FILE_STORE` changes.
- **Integrity:** a download is checked against the stored SHA-256 before it is sent.
- **Removal** deletes the bytes and keeps the row, marked removed.
- **Elsewhere:** `crm files list|attach|download|remove`, `listFiles`, `uploadFile` and `downloadFile` in the SDK, a Files section on every record page and under each note in the web UI, and `list_files` on the ops MCP server (names and sizes only: no tool reads, attaches or removes a file).

**Not built yet:** the `file` field type (and with it per-field access, restricted files and file columns in CSV); the scanner hook; signed URLs (the server streams every download itself, also from S3); `crm data export-files`; events for files (automations and webhooks don't see an upload); and a sweep for objects left in a bucket when a transaction rolled back after the upload, or when a workspace is deleted. `erase_contact`, which would delete a contact's files, isn't built either.

---

## Context

People will want to attach files to records: a résumé on a candidate, a signed contract on a deal, a photo on a property. hl-crm-db is self-hosted and Postgres-only, and it runs multi-tenant with forced row-level security. Every value has to be checked against object and field access, including `restricted`, which is encrypted and needs `restricted:read`. The API refuses request bodies over 1 MB. The server already has a small local blob store (`BLOB_DIR`), which it uses for export files. A hosted service is planned to run the same code. Whatever is chosen must also work in exports, imports, merges and erasure.

## Options for where the bytes live

1. **In Postgres** (`bytea` in a `files` table, or large objects). One backup covers everything, row-level security applies to the bytes themselves, and a transaction covers the record and its file. But every byte goes through the pool and the WAL, backups and replicas grow with the files, and large objects sit outside row-level security (`pg_largeobject` has no tenant column), so they would need their own guard. Workable for small files (up to a few MB) and small workspaces.
2. **The existing local blob store** (a directory on the server). Simple, and no extra service. But it is not shared between API processes or hosts, it is not in the database backup unless the operator copies it too, and tenant separation is only in our code (paths), not in the database.
3. **S3-compatible object storage** (AWS S3, MinIO, Cloudflare R2, Backblaze B2). It scales and backs up apart from the database, and would suit a hosted service. But it is one more thing a self-hoster must run or rent, and isolation rests on key naming and on our checks, since the store knows nothing about tenants.

**Suggested:** an interface `FileStore { put, get, delete, signedGet? }` with two implementations: Postgres `bytea` as the default (self-hosting needs nothing new), and S3-compatible as an option (`FILE_STORE=s3`). Metadata always lives in Postgres under row-level security, whatever holds the bytes.

## The rest of the design

- **Model.** A `file` field type whose value is a list of file references: `{id, name, size, content_type, sha256, uploaded_at}`. A `files` table (forced RLS) holds those references plus the record and field each belongs to and the storage key. Bytes are never in the record JSON.
- **Size limits.** Uploads can't fit in the 1 MB JSON body limit, so they need their own route: `PUT /v1/files` with a raw body and its own limit (suggested default 10 MB, set by the operator), streamed with a running hash and size check. Add a per-workspace quota, and a per-field limit on files per value. The 1 MB limit for everything else stays.
- **Permission on download.** `GET /v1/files/{id}` checks the caller's access to the record's object and field each time (`fieldAccess`), and `restricted:read` for a restricted field. Knowing a file ID gives nothing. Downloads are audited, at least for restricted fields. An upload not attached to a record within an hour is removed.
- **Signed URLs.** Optional, short-lived (5 minutes), for browsers and for S3 direct download. They are issued only after the permission check, bound to one file and one credential, and listed in the audit log. With Postgres storage the server streams the file itself, so no signed URL is needed.
- **Virus scanning.** A hook rather than a built-in scanner: uploads stay `pending` until a configured scanner (ClamAV over its socket, or a webhook to a scanning service) says `clean`. Without a scanner they are marked `unscanned` and served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`, never inline. Content types are sniffed, not trusted.
- **Encryption.** Restricted files are encrypted per file with the workspace data key (AES-GCM, the same envelope as restricted values), whatever the store. On S3, server-side encryption is added on top, not relied on.
- **Export and import.** A CSV export writes file names and IDs, never bytes. A separate `crm data export-files` bundles the files a caller can read into a zip with a manifest. Import takes file IDs already uploaded to the same workspace, never URLs, so the server never fetches from outside (no SSRF).
- **Merge.** The survivor keeps its files, and the duplicates' files are added to the list (a merge already treats list fields as values; file lists would be the documented exception, to avoid losing documents). Duplicates' references stay in the merge record, for unmerge.
- **Erasure and retention.** `erase_contact` deletes files on the contact's confidential and restricted fields. Archiving a record keeps its files. Deleting a workspace deletes its bytes in the store too, which S3 needs a sweep for.
- **Schema packs** can declare file fields, but never carry files.

## Open questions

1. Postgres-by-default plus optional S3, or S3 only?
2. Default upload limit and per-workspace quota?
3. Is a missing virus scanner acceptable for self-hosting (files served as downloads only), or should uploads be refused without one?
4. Should merges combine file lists (the suggestion) or follow the survivor-wins rule like other lists?
