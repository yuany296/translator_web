from __future__ import annotations

SCHEMA_VERSION = 5

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS translation_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS translation_records (
  id TEXT PRIMARY KEY,
  record_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('webpage','novel','comic')),
  scope_key TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  work_id TEXT NOT NULL DEFAULT '',
  chapter_id TEXT NOT NULL DEFAULT '',
  page_key TEXT NOT NULL DEFAULT '',
  raw_source_text TEXT NOT NULL,
  normalized_source_text TEXT NOT NULL,
  raw_source_hash TEXT NOT NULL,
  normalized_source_hash TEXT NOT NULL,
  configured_source_language TEXT NOT NULL,
  resolved_source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  binding_key TEXT NOT NULL DEFAULT '',
  translation_key TEXT NOT NULL DEFAULT '',
  recovery_json TEXT NOT NULL DEFAULT '{}',
  active_version_id TEXT,
  record_revision INTEGER NOT NULL DEFAULT 0,
  change_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by_operation_id TEXT
);
CREATE TABLE IF NOT EXISTS translation_versions (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES translation_records(id) ON DELETE CASCADE,
  translated_text TEXT NOT NULL,
  source TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL DEFAULT '',
  revision_instruction TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS applied_operations (
  operation_id TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_translation_scope
  ON translation_records(mode, scope_key, resolved_source_language, target_language);
CREATE INDEX IF NOT EXISTS idx_translation_change_seq ON translation_records(change_seq);
CREATE INDEX IF NOT EXISTS idx_translation_versions_record
  ON translation_versions(record_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_record_identity
  ON translation_records(mode, scope_key, segment_key, resolved_source_language, target_language);
"""


def configure_connection(connection) -> None:
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA synchronous=NORMAL")


def initialize_schema(connection) -> None:
    configure_connection(connection)
    connection.executescript(SCHEMA_SQL)
    # v4 引入的扩展配对表已随鉴权移除而废弃，旧库升级时直接清除。
    connection.execute("DROP TABLE IF EXISTS paired_extensions")
    columns = {row[1] for row in connection.execute("PRAGMA table_info(translation_records)")}
    if "recovery_json" not in columns:
        connection.execute(
            "ALTER TABLE translation_records ADD COLUMN recovery_json TEXT NOT NULL DEFAULT '{}'"
        )
    # v3：为 translationKey 增加字段与索引，旧记录双读命中后惰性写入新键
    if "binding_key" not in columns:
        connection.execute(
            "ALTER TABLE translation_records ADD COLUMN binding_key TEXT NOT NULL DEFAULT ''"
        )
    if "translation_key" not in columns:
        connection.execute(
            "ALTER TABLE translation_records ADD COLUMN translation_key TEXT NOT NULL DEFAULT ''"
        )
    # 旧库必须先补列，再创建引用 v3 字段的索引。
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_translation_key "
        "ON translation_records(mode, translation_key, target_language)"
    )
    connection.execute(
        "INSERT INTO translation_meta(key,value) VALUES('schema_version',?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(SCHEMA_VERSION),),
    )
    connection.execute(
        "INSERT OR IGNORE INTO translation_meta(key,value) VALUES('change_seq','0')"
    )
    connection.commit()
