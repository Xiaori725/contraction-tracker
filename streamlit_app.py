from pathlib import Path
import os

import streamlit as st
import streamlit.components.v2 as components

from backend import Gateway, Settings, SPACE_ID, friendly_error

ROOT = Path(__file__).resolve().parent
st.set_page_config(page_title="一刻 · 宫缩记录", page_icon="⏱️", layout="centered")
st.html("""<style>
.stMainBlockContainer{max-width:1080px;padding-top:2rem;padding-bottom:2rem}
h1{font-size:1.8rem!important}div[data-testid="stForm"]{background:white;border:1px solid #dce5eb;border-radius:20px;padding:24px}
input{font-size:16px!important}button{min-height:44px!important}
.brand{font:700 23px/1.6 system-ui,sans-serif;letter-spacing:.1em;color:#163446;display:flex;align-items:center;gap:10px;margin:0 0 22px}
.brand b{display:grid;place-items:center;color:white;background:#006d77;border-radius:12px;width:38px;height:38px;font-size:25px}.brand small{font-size:15px;letter-spacing:0;color:#607684;font-weight:400}
@media(max-width:600px){.stMainBlockContainer{padding:1.25rem 1rem}div[data-testid="stForm"]{padding:20px}}
</style><div class="brand"><b>∿</b>一刻 <small>宫缩记录</small></div>""")


def load_settings():
    try:
        return Settings.load(dict(st.secrets))
    except st.errors.StreamlitSecretNotFoundError:
        return Settings.load(os.environ)


try:
    settings = load_settings()
except (ValueError, KeyError):
    st.info("记录服务尚未配置好，请联系管理员完成设置。")
    st.stop()


def clear_session():
    for key in list(st.session_state):
        if key.startswith(("tracker", "gateway", "setup_")):
            del st.session_state[key]


def login_screen():
    st.subheader("登录你的记录")
    st.caption("使用已开通的邮箱和独立密码，两个邮箱共同记录。")
    with st.form("login", clear_on_submit=True):
        email = st.text_input("邮箱", autocomplete="username", max_chars=254)
        password = st.text_input("密码", type="password", autocomplete="current-password", max_chars=128)
        submitted = st.form_submit_button("登录", type="primary", width="stretch")
    if submitted:
        gateway = Gateway(settings)
        try:
            gateway.login(email, password)
        except Exception:
            st.error("登录未成功，请检查邮箱和密码，或稍后重试。")
        else:
            clear_session()
            st.session_state.gateway = gateway
            st.rerun()
    with st.expander("首次使用 / 重新设置密码"):
        st.caption("使用管理员私下提供的一次性设置码，无需接收邮件。")
        if "setup_gateway" not in st.session_state:
            with st.form("setup_code", clear_on_submit=True):
                email = st.text_input("要设置密码的邮箱", autocomplete="username", max_chars=254)
                code = st.text_input("一次性设置码", type="password", max_chars=256)
                verify = st.form_submit_button("验证设置码", width="stretch")
            if verify:
                gateway = Gateway(settings)
                try:
                    gateway.verify_setup(email, code)
                except Exception:
                    st.error("设置码无效、已使用或已过期，请联系管理员重新提供。")
                else:
                    st.session_state.setup_gateway = gateway
                    st.rerun()
        else:
            gateway = st.session_state.setup_gateway
            st.caption(f"为 {gateway.email} 设置密码")
            with st.form("set_password", clear_on_submit=True):
                password = st.text_input("新密码", type="password", autocomplete="new-password", max_chars=72)
                confirm = st.text_input("再次输入新密码", type="password", autocomplete="new-password", max_chars=72)
                st.caption("至少 12 个字符，建议使用容易记住的长短语。")
                save = st.form_submit_button("设置密码并登录", type="primary", width="stretch")
            if save:
                if password != confirm:
                    st.error("两次密码不一致。")
                else:
                    try:
                        gateway.set_password(password)
                    except Exception as error:
                        message, _ = friendly_error(error)
                        st.error(message)
                    else:
                        clear_session()
                        st.session_state.gateway = gateway
                        st.rerun()
    st.caption("记录保存在云端。刷新页面后如需重新登录，可使用手机密码管理器填入密码。")


if "gateway" not in st.session_state:
    login_screen()
    st.stop()

gateway = st.session_state.gateway
col1, col2 = st.columns([3, 1], vertical_alignment="center")
with col1:
    st.caption(f"{gateway.email} · 共享记录")
with col2:
    if st.button("退出登录", width="stretch"):
        if st.session_state.get("tracker_pending", 0):
            st.warning("请先同步尚未保存的记录，再退出登录。")
        else:
            try:
                gateway.logout()
            except Exception:
                st.error("暂时无法退出，请重试。")
            else:
                clear_session()
                st.rerun()

tracker_component = components.component(
    "contraction_tracker",
    html=(ROOT / "ui/tracker.html").read_text(encoding="utf-8"),
    css=(ROOT / "ui/tracker.css").read_text(encoding="utf-8"),
    js=(ROOT / "ui/tracker.js").read_text(encoding="utf-8"),
    isolate_styles=True,
)


@st.fragment(run_every="5s")
def tracker():
    state = st.session_state
    state.setdefault("tracker_ack", [])
    state.setdefault("tracker_limit", 50)
    state.setdefault("tracker_error", "")
    state.setdefault("tracker_conflict", False)
    loaded = False
    try:
        state.tracker_snapshot = gateway.snapshot(state.tracker_limit)
        loaded = True
    except Exception as error:
        message, conflict = friendly_error(error)
        state.tracker_error, state.tracker_conflict = message, conflict
    snapshot = state.get("tracker_snapshot", {"records": [], "active": None, "next": None, "server_now": 0})
    result = tracker_component(
        key=f"tracker_ui_{gateway.user_id}",
        data={"user_id": gateway.user_id, "space_id": SPACE_ID,
              "snapshot": snapshot, "acked_operation_ids": state.tracker_ack,
              "sync_error": state.tracker_error, "conflict": state.tracker_conflict, "loaded": loaded},
        default={"pending": {"attempt": 0, "events": []}},
        on_pending_change=lambda: None, on_action_change=lambda: None,
    )
    action = result.get("action")
    if isinstance(action, dict) and action.get("type") == "load_more":
        state.tracker_limit = min(5000, state.tracker_limit + 50)
        st.rerun()
    pending = result.get("pending")
    events = pending.get("events", []) if isinstance(pending, dict) else []
    if not isinstance(events, list) or len(events) > 100:
        state.tracker_error = "本机待同步内容过多或格式无效，请联系管理员。"
        return
    remaining = [event for event in events if isinstance(event, dict) and event.get("operation_id") not in state.tracker_ack]
    total = pending.get("total", len(events)) if isinstance(pending, dict) else 0
    total = total if type(total) is int and 0 <= total <= 500 else len(events)
    state.tracker_pending = max(len(remaining), total - (len(events) - len(remaining)))
    if not remaining:
        if loaded and state.tracker_error:
            state.tracker_error, state.tracker_conflict = "", False
            st.rerun()
        return
    if not loaded:
        return
    changed = False
    for event in remaining:
        try:
            gateway.change(event)
        except Exception as error:
            message, conflict = friendly_error(error)
            changed |= (message != state.tracker_error or conflict != state.tracker_conflict)
            state.tracker_error, state.tracker_conflict = message, conflict
            break
        else:
            state.tracker_ack = (state.tracker_ack + [event["operation_id"]])[-500:]
            state.tracker_error, state.tracker_conflict = "", False
            changed = True
    if changed:
        st.rerun()


tracker()
