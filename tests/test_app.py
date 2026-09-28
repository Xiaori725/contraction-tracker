"""Exercise tracker control flow against Streamlit's real component result type.

These checks require no Supabase credentials or browser connection.
"""
import ast
from pathlib import Path
from types import SimpleNamespace
import sys

import pytest
from streamlit.components.v2.bidi_component.serialization import BidiComponentSerde
from streamlit.components.v2.bidi_component.state import ComponentResult
from streamlit.util import AttributeDictionary
from streamlit.testing.v1 import AppTest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import friendly_error  # noqa: E402


class Rerun(Exception):
    pass


def harness(events=None, action=None, failure=None, snapshot_failure=None):
    state = AttributeDictionary({})
    calls = []
    inputs = {}
    event_list = events or []

    def rerun(*args, **kwargs):
        raise Rerun()

    def snapshot(limit):
        if snapshot_failure:
            raise snapshot_failure
        return {"records": [], "active": None, "next": None, "server_now": 1}

    def change(event):
        calls.append(event)
        if failure:
            raise failure
        return {"ok": True}

    def component(**kwargs):
        inputs.clear()
        inputs.update(kwargs)
        # This is the same merge used by Streamlit 1.62.0: state defaults
        # must never include a trigger name, or they mask its transient value.
        raw = {"pending": {"attempt": 1, "events": event_list}}
        actual_state = BidiComponentSerde(default=kwargs["default"]).deserialize(raw)
        return ComponentResult(actual_state, {"action": action})

    module = ast.parse((ROOT / "streamlit_app.py").read_text(encoding="utf-8"))
    function = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == "tracker")
    function.decorator_list = []
    environment = {
        "st": SimpleNamespace(session_state=state, rerun=rerun),
        "gateway": SimpleNamespace(user_id="test-user", snapshot=snapshot, change=change),
        "tracker_component": component,
        "SPACE_ID": "test-space",
        "friendly_error": friendly_error,
    }
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(ROOT / "streamlit_app.py"), "exec"), environment)
    return environment["tracker"], state, calls, inputs


def test_load_more_trigger_is_not_masked_by_state_default():
    tracker, state, _, _ = harness(action={"type": "load_more"})
    with pytest.raises(Rerun):
        tracker()
    assert state.tracker_limit == 100


def test_success_is_acked_and_not_applied_again_on_rerun():
    event = {"operation_id": "test-operation"}
    tracker, state, calls, inputs = harness(events=[event])
    with pytest.raises(Rerun):
        tracker()
    tracker()
    assert calls == [event]
    assert state.tracker_pending == 0
    assert inputs["data"]["acked_operation_ids"] == ["test-operation"]


def test_stable_conflict_does_not_create_infinite_immediate_reruns():
    tracker, state, _, _ = harness(events=[{"operation_id": "failed"}], failure=ValueError("conflict"))
    with pytest.raises(Rerun):
        tracker()
    tracker()
    assert state.tracker_ack == []
    assert state.tracker_pending == 1


def test_failed_snapshot_preserves_outbox_without_attempting_writes():
    tracker, state, calls, inputs = harness(events=[{"operation_id": "waiting"}], snapshot_failure=RuntimeError("offline"))
    tracker()
    assert calls == []
    assert state.tracker_pending == 1
    assert state.tracker_ack == []
    assert inputs["data"]["loaded"] is False


class AppGateway:
    def __init__(self, settings):
        self.user_id = self.email = None
        self.changed = []

    def login(self, email, password):
        self.user_id, self.email = "d88a0c99-7e5b-482c-998f-80f03e4b97da", email

    def snapshot(self, limit=50):
        return {"records": [], "active": None, "next": None, "server_now": 1}

    def change(self, event):
        self.changed.append(event)
        return {"ok": True}

    def logout(self):
        self.user_id = self.email = None


def logged_in_app(monkeypatch):
    import backend
    monkeypatch.setattr(backend, "Gateway", AppGateway)
    app = AppTest.from_file(str(ROOT / "streamlit_app.py"), default_timeout=5)
    app.secrets["SUPABASE_URL"] = "https://example.supabase.co"
    app.secrets["SUPABASE_PUBLISHABLE_KEY"] = "sb_publishable_test_only"
    app.secrets["TRACKER_ALLOWED_EMAILS"] = ["tester@example.invalid"]
    app.run()
    assert not app.exception
    app.text_input[0].set_value("tester@example.invalid")
    app.text_input[1].set_value("test-password-123")
    next(button for button in app.button if button.label == "登录").click()
    app.run()
    assert not app.exception
    return app


def test_apptest_login_renders_tracker_and_logout_returns_to_login(monkeypatch):
    app = logged_in_app(monkeypatch)
    assert any("tester@example.invalid" in caption.value for caption in app.caption)
    assert app.session_state["tracker_pending"] == 0
    next(button for button in app.button if button.label == "退出登录").click()
    app.run()
    assert not app.exception
    assert any(button.label == "登录" for button in app.button)
    assert "gateway" not in app.session_state


def test_apptest_persistent_component_pending_ack_terminates(monkeypatch):
    app = logged_in_app(monkeypatch)
    gateway = app.session_state["gateway"]
    event = {"operation_id": "component-test-operation"}
    app.session_state[f"tracker_ui_{gateway.user_id}"] = {
        "pending": {"attempt": 1, "total": 1, "events": [event]}
    }
    app.run()
    assert not app.exception
    assert gateway.changed == [event]
    assert app.session_state["tracker_ack"] == ["component-test-operation"]
    assert app.session_state["tracker_pending"] == 0
    app.run()
    assert not app.exception
    assert gateway.changed == [event]
