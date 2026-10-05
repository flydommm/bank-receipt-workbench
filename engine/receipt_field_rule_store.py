"""Versioned local field rules, in the caller's existing SQLite transaction."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import sqlite3
from typing import Any, Mapping
from uuid import uuid4

from .receipt_field_rule_models import FieldRuleConflict, FieldRuleError, canonical_json, rule_digest, text, validate_rule


class FieldRuleStore:
    """Own only field-rule tables; never commit or change SQLite user_version."""

    def __init__(self, connection: sqlite3.Connection, *, initialize: bool = True):
        if not isinstance(connection, sqlite3.Connection):
            raise TypeError("connection must be an existing sqlite3.Connection")
        self.connection = connection
        if initialize:
            self.initialize()

    def initialize(self) -> None:
        self.connection.execute("""CREATE TABLE IF NOT EXISTS receipt_field_rules (
            rule_id TEXT PRIMARY KEY, series_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
            name TEXT NOT NULL, definition_json TEXT NOT NULL, definition_digest TEXT NOT NULL,
            active INTEGER NOT NULL CHECK(active IN (0,1)), operation_id TEXT NOT NULL UNIQUE,
            request_digest TEXT NOT NULL, created_at TEXT NOT NULL,
            UNIQUE(series_id,version))""")
        self.connection.execute("CREATE INDEX IF NOT EXISTS idx_receipt_field_rules_active ON receipt_field_rules(active,series_id,version)")

    def _rows(self, query: str, args: tuple = ()) -> list[dict[str, Any]]:
        cursor = self.connection.execute(query, args)
        columns = [column[0] for column in cursor.description]
        result = []
        for raw in cursor.fetchall():
            row = dict(zip(columns, tuple(raw)))
            definition = validate_rule(json.loads(row.pop("definition_json")))
            if rule_digest(definition) != row["definition_digest"]:
                raise FieldRuleError("保存的规则校验不一致")
            row["definition"] = definition
            row["active"] = bool(row["active"])
            row.pop("request_digest", None)
            result.append(row)
        return result

    def get(self, rule_id: str) -> dict[str, Any] | None:
        rows = self._rows("SELECT * FROM receipt_field_rules WHERE rule_id=?", (text(rule_id, "规则编号"),))
        return rows[0] if rows else None

    def list(self, *, active_only: bool = True) -> list[dict[str, Any]]:
        if type(active_only) is not bool:
            raise FieldRuleError("规则筛选无效")
        return self._rows("SELECT * FROM receipt_field_rules" + (" WHERE active=1" if active_only else "") + " ORDER BY created_at,series_id,version")

    def create(self, definition: Mapping[str, Any], *, name: str, operation_id: str,
               update_rule_id: str | None = None, expected_version: int | None = None) -> dict[str, Any]:
        value = validate_rule(definition)
        if value["batch_only"]:
            raise FieldRuleError("缺少稳定标签，只能本批使用，不能保存供以后自动使用")
        name, operation_id = text(name, "规则名称", 80), text(operation_id, "操作编号")
        if update_rule_id is not None:
            update_rule_id = text(update_rule_id, "待更新规则编号")
            if type(expected_version) is not int or expected_version < 1:
                raise FieldRuleError("请提供待更新规则版本")
        elif expected_version is not None:
            raise FieldRuleError("新建规则不能指定已有版本")
        request = rule_digest({"definition": value, "name": name, "update_rule_id": update_rule_id, "expected_version": expected_version})
        prior = self.connection.execute("SELECT rule_id,request_digest FROM receipt_field_rules WHERE operation_id=?", (operation_id,)).fetchone()
        if prior:
            if prior[1] != request:
                raise FieldRuleConflict("同一操作不能保存不同规则")
            return self.get(prior[0])  # type: ignore[return-value]
        version, series = 1, "field-series-" + uuid4().hex
        if update_rule_id:
            target = self.get(update_rule_id)
            if target is None or not target["active"] or target["version"] != expected_version:
                raise FieldRuleConflict("规则已更新或停用，请重新核对")
            latest = self.connection.execute("SELECT MAX(version) FROM receipt_field_rules WHERE series_id=?", (target["series_id"],)).fetchone()[0]
            if latest != expected_version:
                raise FieldRuleConflict("规则版本已变化")
            if target["definition"]["bank_name"] != value["bank_name"] or target["definition"]["mode"] != value["mode"]:
                raise FieldRuleError("不同银行或字段模式请另存为新规则")
            series, version = target["series_id"], expected_version + 1
        identifier = "field-rule-" + uuid4().hex
        self.connection.execute("""INSERT INTO receipt_field_rules
            (rule_id,series_id,version,name,definition_json,definition_digest,active,operation_id,request_digest,created_at)
            VALUES (?,?,?,?,?,?,1,?,?,?)""", (identifier, series, version, name, canonical_json(value), rule_digest(value), operation_id,
            request, datetime.now(timezone.utc).isoformat()))
        if update_rule_id:
            self.connection.execute("UPDATE receipt_field_rules SET active=0 WHERE rule_id=?", (update_rule_id,))
        return self.get(identifier)  # type: ignore[return-value]

    def deactivate(self, rule_id: str, expected_version: int) -> dict[str, Any]:
        target = self.get(rule_id)
        if type(expected_version) is not int or target is None or target["version"] != expected_version:
            raise FieldRuleConflict("规则已变化，请刷新后重试")
        latest = self.connection.execute("SELECT MAX(version) FROM receipt_field_rules WHERE series_id=?", (target["series_id"],)).fetchone()[0]
        if latest != expected_version:
            raise FieldRuleConflict("规则已更新，不能停用旧版本")
        self.connection.execute("UPDATE receipt_field_rules SET active=0 WHERE rule_id=? AND version=?", (rule_id, expected_version))
        return self.get(rule_id)  # type: ignore[return-value]
