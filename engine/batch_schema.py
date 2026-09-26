"""One-way, backed-up migration of the private batch database.

Payload encodings remain versioned independently of this database schema.
No source PDF or old review record is touched by this migration.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
import re
import sqlite3


class BatchMigrationError(ValueError):
    pass


def _schema_objects(connection: sqlite3.Connection) -> dict[tuple[str, str], str]:
    return {(row[0], row[1]): re.sub(r"\s+", " ", row[2]).strip().lower()
            for row in connection.execute(
                "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
            )}


def _verify_legacy(connection: sqlite3.Connection, legacy_ddl: Sequence[str]) -> None:
    expected = sqlite3.connect(":memory:")
    try:
        for statement in legacy_ddl:
            expected.execute(statement)
        expected_objects = _schema_objects(expected)
    finally:
        expected.close()
    actual = _schema_objects(connection)
    if any(actual.get(key) != sql for key, sql in expected_objects.items()):
        raise BatchMigrationError("unsupported legacy batch schema")
    # Auxiliary ownership/preview tables are preserved. Triggers are not part
    # of the supported schema and could mutate data during the copy.
    if any(kind in {"trigger", "view"} for kind, _name in actual):
        raise BatchMigrationError("unsupported legacy batch trigger or view")
    if connection.execute("""SELECT 1 FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
            AND tbl_name IN ('batch_page_results', 'batch_snapshots') LIMIT 1""").fetchone() is not None:
        raise BatchMigrationError("unsupported index on a migrated table")
    if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise BatchMigrationError("legacy batch database failed integrity check")
    if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise BatchMigrationError("legacy batch database has broken references")


def migrate_v1(
    connection: sqlite3.Connection,
    legacy_ddl: Sequence[str],
    current_ddl: Sequence[str],
    backup: Callable[[], None],
    job_columns: Sequence[str],
) -> None:
    """Hold one writer lock across validation, backup, copy and version switch.

    FK enforcement is disabled only on this connection while parent tables
    are replaced; an explicit check occurs before commit and it is restored
    on all exits. Renaming the *new* table keeps child FK names unchanged.
    """
    if connection.in_transaction:
        raise BatchMigrationError("migration requires its own transaction")
    connection.execute("PRAGMA foreign_keys = OFF")
    try:
        connection.execute("BEGIN IMMEDIATE")
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        if version == 2:
            # A concurrent opener completed the migration while we waited.
            connection.rollback()
            return
        if version != 1:
            raise BatchMigrationError("legacy version changed")
        _verify_legacy(connection, legacy_ddl)
        backup()
        for column in job_columns:
            connection.execute("ALTER TABLE batch_jobs ADD COLUMN " + column)
        for name in ("batch_page_results", "batch_snapshots"):
            prefix = "CREATE TABLE IF NOT EXISTS " + name + " ("
            definition = next((item for item in current_ddl if item.strip().startswith(prefix)), None)
            if definition is None:
                raise BatchMigrationError("new table definition is missing")
            temporary = name + "_migration_v2"
            connection.execute(definition.replace(prefix, "CREATE TABLE " + temporary + " (", 1))
            # Column order is unchanged for these two versioned payload tables.
            connection.execute(f"INSERT INTO {temporary} SELECT * FROM {name}")
            connection.execute(f"DROP TABLE {name}")
            connection.execute(f"ALTER TABLE {temporary} RENAME TO {name}")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise BatchMigrationError("migrated batch database has broken references")
        connection.execute("PRAGMA user_version = 2")
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.execute("PRAGMA foreign_keys = ON")
