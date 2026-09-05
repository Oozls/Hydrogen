"""앱 설정(마지막 플레이리스트, 볼륨) 조회/저장 API."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage import applog, storage, translation

bp = Blueprint("settings", __name__, url_prefix="/api/settings")


@bp.get("")
def get_settings():
    settings = storage.load_settings()
    return jsonify(
        {
            "last_playlist": settings.get("last_playlist"),
            "volume": settings.get("volume", 80),
            "lyrics_slide_mode": bool(settings.get("lyrics_slide_mode", False)),
            "translation_model": settings.get("translation_model") or translation.DEFAULT_MODEL,
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
    if "lyrics_slide_mode" in data:
        settings["lyrics_slide_mode"] = bool(data["lyrics_slide_mode"])
        applied["lyrics_slide_mode"] = settings["lyrics_slide_mode"]
    if "translation_model" in data:
        model = str(data["translation_model"] or "").strip() or translation.DEFAULT_MODEL
        settings["translation_model"] = model
        applied["translation_model"] = model
    storage.save_settings(settings)
    applog.log_info("ACTION", f"설정 변경: {applied}")
    return jsonify(settings)


@bp.get("/data-size")
def get_data_size():
    return jsonify({"bytes": storage.app_data_dir_size_bytes()})
