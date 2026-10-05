"""Keep test document derivatives out of the application's shared cache."""

import os
from pathlib import Path

import pytest

from engine.private_temp import PRIVATE_TEMP_ENV


@pytest.fixture(autouse=True)
def isolate_engine_private_temp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Respect an explicit runner root. Individual fixtures may still override
    # this fallback; default-path tests can delenv and redirect their platform
    # cache environment into tmp_path.
    if not os.environ.get(PRIVATE_TEMP_ENV):
        monkeypatch.setenv(PRIVATE_TEMP_ENV, str(tmp_path / "engine-private-temp"))
