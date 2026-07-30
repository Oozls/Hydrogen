"""앱 설정(마지막 플레이리스트, 볼륨) 조회/저장 API."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage import applog, recommend, storage

bp = Blueprint("settings", __name__, url_prefix="/api/settings")


@bp.get("")
def get_settings():
    settings = storage.load_settings()
    return jsonify(
        {
            "last_playlist": settings.get("last_playlist"),
            "volume": settings.get("volume", 80),
            "today_limit": settings.get("today_limit", recommend.DEFAULT_LIMIT),
        }
    )


@bp.put("")
def update_settings():
    data = request.get_json(silent=True) or {}
    settings = storage.load_settings()
    applied = {}
    if "last_playlist" in data:
        settings["last_playlist"] = data["last_playlist"]
        applied["last_playlist"] = data["last_playlist"]
    if "volume" in data:
        try:
            settings["volume"] = max(0, min(100, int(data["volume"])))
            applied["volume"] = settings["volume"]
        except (TypeError, ValueError):
            pass
    if "today_limit" in data:
        try:
            settings["today_limit"] = max(1, min(30, int(data["today_limit"])))
            applied["today_limit"] = settings["today_limit"]
        except (TypeError, ValueError):
            pass
    storage.save_settings(settings)
    applog.log_info("ACTION", f"설정 변경: {applied}")
    return jsonify(settings)


@bp.get("/data-size")
def get_data_size():
    return jsonify({"bytes": storage.app_data_dir_size_bytes()})
