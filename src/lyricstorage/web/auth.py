"""로그인 게이트.

여러 사용자 계정을 관리할 필요가 없는 개인용 서버라, 계정 DB 없이
환경변수(LYRICSTORAGE_AUTH_USER/LYRICSTORAGE_AUTH_PASSWORD) 한 쌍만 아이디/
비밀번호로 쓴다. 두 환경변수가 설정돼 있지 않으면(로컬 개발 등) 로그인 없이
그대로 접근을 허용한다 — 실제 배포 시엔 VM의 systemd 유닛 등에 이 두
환경변수를 설정해야 로그인 게이트가 켜진다.

세션은 SESSION_LIFETIME만큼 유휴 상태(요청 없음)가 지속되면 만료된다. 매
요청마다 만료 시각을 늘려주므로(SESSION_REFRESH_EACH_REQUEST 기본값) 계속
쓰는 동안은 로그인이 유지되고, 새 탭/브라우저 재시작 후 오래 방치했다가
다시 접속하면 이 유휴 타임아웃에 걸려 다시 로그인 페이지로 보내진다.
"""

from __future__ import annotations

import hmac
import os
import secrets
from datetime import timedelta

from flask import Blueprint, Flask, redirect, render_template, request, session, url_for

from lyricstorage import applog, storage

SESSION_LIFETIME = timedelta(hours=12)

bp = Blueprint("auth", __name__)


def _configured_credentials() -> tuple[str, str] | None:
    user = os.environ.get("LYRICSTORAGE_AUTH_USER")
    password = os.environ.get("LYRICSTORAGE_AUTH_PASSWORD")
    if not user or not password:
        return None
    return user, password


def _secret_key() -> str:
    path = storage.app_data_dir() / "secret_key"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    key = secrets.token_hex(32)
    path.write_text(key, encoding="utf-8")
    return key


@bp.get("/login")
def login_page():
    if session.get("authenticated"):
        return redirect(url_for("pages.index"))
    return render_template("login.html", failed=request.args.get("failed") is not None)


@bp.post("/login")
def login_submit():
    creds = _configured_credentials()
    username = request.form.get("username", "")
    password = request.form.get("password", "")
    ok = (
        creds is not None
        and hmac.compare_digest(username, creds[0])
        and hmac.compare_digest(password, creds[1])
    )
    if not ok:
        applog.log_info("AUTH", f"로그인 실패: username={username!r}")
        return redirect(url_for("auth.login_page", failed=1))
    session.clear()
    session["authenticated"] = True
    session.permanent = True
    applog.log_info("AUTH", f"로그인 성공: username={username!r}")
    return redirect(url_for("pages.index"))


def init_auth(app: Flask) -> None:
    creds = _configured_credentials()
    if creds is None:
        applog.log_info(
            "AUTH",
            "LYRICSTORAGE_AUTH_USER/LYRICSTORAGE_AUTH_PASSWORD가 설정되지 않아 "
            "로그인 없이 접근을 허용합니다.",
        )
        return

    app.secret_key = _secret_key()
    app.config["PERMANENT_SESSION_LIFETIME"] = SESSION_LIFETIME
    # 브라우저가 세션 쿠키를 https 연결에서만 보내게 강제한다. localhost/127.0.0.1은
    # 브라우저가 예외적으로 "안전한 출처"로 취급해 http로 로컬 테스트해도 그대로 동작한다.
    app.config["SESSION_COOKIE_SECURE"] = True
    app.register_blueprint(bp)

    @app.before_request
    def _require_login():
        if request.endpoint in ("auth.login_page", "auth.login_submit") or request.path.startswith(
            "/static/"
        ):
            return None
        if not session.get("authenticated"):
            return redirect(url_for("auth.login_page"))
        session.permanent = True
        return None
