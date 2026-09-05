"""OpenRouter 번역 모델 목록 조회 API."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from lyricstorage import translation

bp = Blueprint("translation", __name__, url_prefix="/api/translation")


@bp.get("/models")
def get_models():
    force_refresh = request.args.get("refresh") == "1"
    try:
        models = translation.list_models(force_refresh=force_refresh)
    except translation.TranslationError as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify({"models": models})
