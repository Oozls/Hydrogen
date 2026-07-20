"""앱 설정(마지막 플레이리스트, 볼륨) 조회/저장 API."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage import storage

bp = Blueprint("settings", __name__, url_prefix="/api/settings")


@bp.get("")
def get_settings():
    settings = storage.load_settings()
    return jsonify(
        {
            "last_playlist": settings.get("last_playlist"),
            "volume": settings.get("volume", 80),
        }
    )


@bp.put("")
def update_settings():
    data = request.get_json(silent=True) or {}
    settings = storage.load_settings()
    if "last_playlist" in data:
        settings["last_playlist"] = data["last_playlist"]
    if "volume" in data:
        try:
            settings["volume"] = max(0, min(100, int(data["volume"])))
        except (TypeError, ValueError):
            pass
    storage.save_settings(settings)
    return jsonify(settings)
