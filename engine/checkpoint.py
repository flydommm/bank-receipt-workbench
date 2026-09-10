"""Atomic JSON checkpoint storage for long-running page jobs."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
from typing import Any


class CheckpointStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {"items": [], "paused": False, "cancelled": False}
        return json.loads(self.path.read_text(encoding="utf-8"))

    def save(self, payload: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=self.path.parent, delete=False) as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            temporary = Path(handle.name)
        temporary.replace(self.path)
