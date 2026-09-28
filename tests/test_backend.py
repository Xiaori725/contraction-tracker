"""Authentication failure-state regressions, without external requests."""
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import Gateway  # noqa: E402


def test_failed_remote_logout_does_not_leave_mixed_local_identity():
    gateway = Gateway.__new__(Gateway)
    gateway.user_id, gateway.email = "test-user", "test@example.invalid"
    sdk_session = object()

    def sign_out(options):
        # A transport exception occurs before supabase-py's _remove_session.
        raise ConnectionError("network unavailable")

    gateway.client = SimpleNamespace(auth=SimpleNamespace(sign_out=sign_out, get_session=lambda: sdk_session))
    try:
        gateway.logout()
    except ConnectionError:
        # The app currently retains the Gateway after an unsuccessful logout.
        # It must retain its identity too, or explicitly clear the SDK session.
        assert gateway.user_id == "test-user" or gateway.client.auth.get_session() is None


def test_rpc_refresh_happens_before_the_database_request():
    calls = []
    gateway = Gateway.__new__(Gateway)

    def get_session():
        calls.append("refresh")
        return object()

    def rpc(name, args):
        calls.append("rpc")
        return SimpleNamespace(execute=lambda: SimpleNamespace(data={"records": []}))

    gateway.client = SimpleNamespace(auth=SimpleNamespace(get_session=get_session), rpc=rpc)
    assert gateway.snapshot()["records"] == []
    assert calls == ["refresh", "rpc"]


def test_expired_session_blocks_database_request():
    gateway = Gateway.__new__(Gateway)
    gateway.client = SimpleNamespace(auth=SimpleNamespace(get_session=lambda: None))
    with pytest.raises(ValueError, match="登录已失效"):
        gateway.snapshot()
