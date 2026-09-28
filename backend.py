"""Per-session Supabase client; database RPCs enforce the actual permissions."""
from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from typing import Any, Mapping
from uuid import UUID

from supabase import ClientOptions, create_client

SPACE_ID = "e0a8f00c-9b6d-4a5e-91ac-7cc5ef9c1a21"


@dataclass(frozen=True)
class Settings:
    url: str
    publishable_key: str
    allowed_emails: frozenset[str]

    @classmethod
    def load(cls, source: Mapping[str, Any]) -> "Settings":
        def value(key: str, default: Any = "") -> Any:
            return source.get(key, os.environ.get(key, default))
        url = str(value("SUPABASE_URL")).rstrip("/")
        key = str(value("SUPABASE_PUBLISHABLE_KEY"))
        emails = value("TRACKER_ALLOWED_EMAILS", [])
        if isinstance(emails, str):
            emails = emails.replace(";", ",").split(",")
        normalized = frozenset(str(email).strip().lower() for email in emails if str(email).strip())
        if not url.startswith("https://") or not key or not normalized:
            raise ValueError("Supabase settings are incomplete")
        if key.startswith("sb_secret_"):
            raise ValueError("A server administrator key must not be used by this app")
        if key.startswith("eyJ"):
            try:
                part = key.split(".")[1]
                payload = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
            except (ValueError, IndexError):
                raise ValueError("Invalid Supabase public key") from None
            if payload.get("role") != "anon":
                raise ValueError("Only the Supabase anon role is allowed")
        elif not key.startswith("sb_publishable_"):
            raise ValueError("Use a Supabase publishable/anon key")
        return cls(url, key, normalized)


def validate_event(event: Any) -> dict:
    """Reject malformed/unbounded browser messages before they reach Postgres."""
    if not isinstance(event, dict):
        raise ValueError("无效的记录内容。")
    action = event.get("action")
    if action not in {"start", "finish", "strength", "edit", "delete"}:
        raise ValueError("无效的记录操作。")
    clean = {"action": action}
    for field in ("id", "operation_id"):
        try:
            clean[field] = str(UUID(str(event[field])))
        except (KeyError, ValueError, TypeError, AttributeError):
            raise ValueError("记录编号无效。") from None
    if action != "start":
        version = event.get("version")
        if type(version) is not int or not 1 <= version <= 2_147_483_647:
            raise ValueError("记录版本无效，请刷新后再试。")
        clean["version"] = version
    for field in ("start_ms", "end_ms"):
        if field in event:
            value = event[field]
            if type(value) is not int or not 946684800000 <= value <= 253402300799000:
                raise ValueError("记录时间无效。")
            clean[field] = value
    needed = {"start": ["start_ms"], "finish": ["end_ms"], "edit": ["start_ms", "end_ms"]}.get(action, [])
    if any(field not in clean for field in needed):
        raise ValueError("记录缺少时间。")
    if action == "edit" and clean["end_ms"] < clean["start_ms"]:
        raise ValueError("结束时间不能早于开始时间。")
    if "intensity" in event:
        level = event["intensity"]
        if level is not None and (type(level) is not int or level not in (1, 2, 3)):
            raise ValueError("请选择轻、中或强。")
        clean["intensity"] = level
    return clean


class Gateway:
    """Construct once per Streamlit session, never cache globally across users."""
    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = create_client(settings.url, settings.publishable_key, options=ClientOptions(
            auto_refresh_token=False, persist_session=False, postgrest_client_timeout=15,
        ))
        self.user_id: str | None = None
        self.email: str | None = None

    def _accept(self, response) -> None:
        user = response.user
        if not response.session or not user or (user.email or "").lower() not in self.settings.allowed_emails:
            self.logout()
            raise ValueError("邮箱或密码不正确，或该邮箱尚未开通。")
        self.user_id, self.email = str(user.id), user.email.lower()
        # Confirm database membership as well as authentication.
        self.snapshot(limit=1)

    def login(self, email: str, password: str) -> None:
        email = email.strip().lower()
        if email not in self.settings.allowed_emails:
            raise ValueError("邮箱或密码不正确，或该邮箱尚未开通。")
        self._accept(self.client.auth.sign_in_with_password({"email": email, "password": password}))

    def verify_setup(self, email: str, code: str) -> None:
        if email.strip().lower() not in self.settings.allowed_emails:
            raise ValueError("设置码无效或邮箱尚未开通。")
        result = self.client.auth.verify_otp({"token_hash": code.strip(), "type": "recovery"})
        if not result.user or (result.user.email or "").lower() != email.strip().lower():
            self.logout()
            raise ValueError("设置码与邮箱不匹配。")
        self._accept(result)

    def set_password(self, password: str) -> None:
        if len(password) < 12 or len(password.encode("utf-8")) > 72:
            raise ValueError("密码至少 12 个字符，最多 72 个字节。")
        self.client.auth.update_user({"password": password})

    def _refresh(self) -> None:
        if not self.client.auth.get_session():
            raise ValueError("登录已失效，请重新登录。")

    def snapshot(self, limit: int = 50, cursor: dict | None = None) -> dict:
        self._refresh()
        params: dict[str, Any] = {"p_limit": min(5000, max(1, limit))}
        if cursor:
            params.update(p_before=cursor["start_ms"], p_before_id=cursor["id"])
        result = self.client.rpc("tracker_snapshot", params).execute().data
        if not isinstance(result, dict) or not isinstance(result.get("records"), list):
            raise ValueError("云端记录格式异常。")
        return result

    def change(self, event: dict) -> dict:
        self._refresh()
        result = self.client.rpc("tracker_change", {"p_change": validate_event(event)}).execute().data
        if not isinstance(result, dict) or not result.get("ok"):
            raise ValueError("云端没有确认保存，请重试。")
        return result

    def logout(self) -> None:
        self.client.auth.sign_out({"scope": "local"})
        self.user_id, self.email = None, None


def friendly_error(error: Exception) -> tuple[str, bool]:
    """No raw provider diagnostics or credentials are rendered in the app."""
    code = str(getattr(error, "code", ""))
    if code in {"PT409", "23505"}:
        return "这条记录已在另一台设备变化，或已有正在计时的宫缩。请先查看云端版本。", True
    if code in {"42501", "PGRST301", "bad_jwt", "session_not_found", "refresh_token_not_found"}:
        return "登录已失效或没有访问权限，请重新登录。", True
    if code in {"over_request_rate_limit", "over_email_send_rate_limit"}:
        return "尝试次数较多，请稍后再试。", False
    if code in {"22023", "P0002"}:
        return "记录时间、强度或编号无效，请检查或查看云端版本。", True
    if isinstance(error, ValueError):
        return str(error), True
    return "暂时无法连接云端，未确认的操作会保留，请稍后重试。", False
