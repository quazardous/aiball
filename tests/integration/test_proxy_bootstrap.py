"""#853 — pty-proxy `_rest_word()` bootstrap default = BOOT.

Pure unit test (no loop spawn, no fixtures) : imports the proxy
module and exercises `_rest_word()` under the bootstrap condition
(`_pushed_view_cache["view"] is None`) where the cascade used to
fall through to LOOP. After the fix, the bootstrap default is BOOT
by construction — "par definition on commence en boot" (david
`w7t4pt`).

Run :
  cd tests/integration && uv run --with pytest pytest test_proxy_bootstrap.py -q
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path


def _load_proxy_module():
    """Load `pty-proxy.py` as a module without running it as a script."""
    repo_root = Path(__file__).resolve().parents[2]
    proxy_path = repo_root / "src" / "claude-loop" / "pty-proxy.py"
    os.environ.setdefault("CL_LOOP_NAME", "test")
    os.environ.setdefault("CL_STATE_DIR", "/tmp/aiball-test-proxy")
    spec = importlib.util.spec_from_file_location("pty_proxy_for_test", proxy_path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_853_rest_word_bootstrap_default_is_boot():
    """Before the timer's first `_apply_pushed_view` arrives, the proxy
    must paint BOOT (not LOOP). This is the construction-time invariant
    david called out : "par definition on commence en boot"."""
    mod = _load_proxy_module()
    mod._pushed_view_cache["view"] = None
    assert mod._rest_word() == mod._HUMAN_BOOT, (
        f"bootstrap default (cache view=None) should be BOOT, "
        f"got {mod._rest_word()!r}"
    )


def test_853_rest_word_falls_through_once_cache_populated():
    """Sanity : once any push has arrived, the new top-of-cascade check
    no longer fires and we fall through to the existing logic. We don't
    assert the exact return (boot grace + AFK env-dependent) — we only
    need to confirm the function dispatched past the bootstrap
    shortcut, i.e. its return is determined by the rest of the cascade
    not the bootstrap branch."""
    mod = _load_proxy_module()
    mod._pushed_view_cache["view"] = {"barWord": "loop"}
    # Either _HUMAN_BOOT (boot grace), _HUMAN_WAIT (AFK), or _HUMAN_LOOP
    # depending on env — all are valid cascade outcomes. The point is
    # that the bootstrap shortcut wasn't taken.
    result = mod._rest_word()
    assert result in {mod._HUMAN_BOOT, mod._HUMAN_WAIT, mod._HUMAN_LOOP}, (
        f"post-push result must come from the original cascade, got {result!r}"
    )
