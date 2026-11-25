-- Files attached to records (ADR 0011). A file belongs to one record of any object, standard or custom,
-- and is read and changed with that record's object access: read to list and download, write to
-- attach and remove. Metadata is always here, under row-level security; the bytes are in file_blobs
-- (the default) or in an S3-compatible store, where they are sealed with the workspace's data key.

CREATE TABLE files (
  tenant_id    uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id           uuid NOT NULL,
  record_id    uuid NOT NULL,
  -- One line of text, no path: the name a download is saved under.
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 255 AND name !~ '[/\\[:cntrl:]]'),
  size         bigint NOT NULL CHECK (size > 0),
  -- Detected from the first bytes, never taken from the uploader. Downloads are served as attachments whatever it says.
  content_type text NOT NULL CHECK (length(content_type) <= 100),
  sha256       text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  store        text NOT NULL CHECK (store IN ('postgres', 's3')),
  -- Set when the stored bytes are sealed with the workspace data key of this version (always in s3).
  key_version  integer NULL,
  -- No scanner is built in: files are 'unscanned' and only ever downloaded, never shown inline.
  scan_status  text NOT NULL DEFAULT 'unscanned' CHECK (scan_status IN ('unscanned', 'clean', 'infected')),
  uploaded_by  uuid NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Removing a file deletes its bytes and keeps this row, so the audit trail still names it.
  deleted_at   timestamptz NULL,
  deleted_by   uuid NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, record_id) REFERENCES record_registry (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX files_record ON files (tenant_id, record_id, created_at) WHERE deleted_at IS NULL;
SELECT app.enable_tenant_rls('files');

-- The bytes, for the postgres store. Apart from files, so listing a record's files never reads them.
CREATE TABLE file_blobs (
  tenant_id uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  file_id   uuid NOT NULL,
  data      bytea NOT NULL,
  PRIMARY KEY (tenant_id, file_id),
  FOREIGN KEY (tenant_id, file_id) REFERENCES files (tenant_id, id) ON DELETE CASCADE
);
SELECT app.enable_tenant_rls('file_blobs');
