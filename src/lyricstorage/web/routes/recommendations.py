"""'오늘의 곡' 추천 API."""

from __future__ import annotations

from datetime import date

from flask import Blueprint, jsonify, request

from lyricstorage import recommend, storage
from lyricstorage.web import playlist_repo
from lyricstorage.web.serialize import track_to_json

bp = Blueprint("recommendations", __name__, url_prefix="/api/recommendations")


@bp.get("/today")
def get_today():
    try:
        limit = int(request.args.get("limit", recommend.DEFAULT_LIMIT))
    except ValueError:
        limit = recommend.DEFAULT_LIMIT
    limit = max(1, min(30, limit))

    today = date.today().isoformat()
    reroll = request.args.get("reroll")
    seed = f"{today}:{reroll}" if reroll else today

    playlist = playlist_repo.load_or_create_global()
    tracks = [track_to_json(t) for t in playlist.tracks]
    items = recommend.pick_today_songs(tracks, limit=limit, seed=seed, record_exposure=not reroll)
    return jsonify({"date": today, "items": items})


@bp.get("/weights")
def get_weights():
    playlist = playlist_repo.load_or_create_global()
    tracks = [track_to_json(t) for t in playlist.tracks]
    history = storage.load_play_history()
    rating_by_track = {t.get("track_id"): t.get("rating") or 0 for t in tracks}
    duration_by_track = {t.get("track_id"): t.get("duration_ms") or 0 for t in tracks}

    config = storage.load_recommend_config()
    mode = config.get("mode") if config.get("mode") in ("auto", "manual") else "auto"
    manual_weights = {
        k: recommend.clamp_weight(float((config.get("manual_weights") or {}).get(k, recommend.DEFAULT_WEIGHTS[k])))
        for k in recommend.FEATURE_KEYS
    }
    active_manual = manual_weights if mode == "manual" else None
    weights, source = recommend.resolve_weights(history, rating_by_track, duration_by_track, active_manual)

    return jsonify(
        {
            "mode": mode,
            "source": source,
            "weights": weights,
            "manual_weights": manual_weights,
            "labels": recommend.FEATURE_LABELS,
            "min": recommend.WEIGHT_MIN,
            "max": recommend.WEIGHT_MAX,
            "history": storage.load_recommend_weight_history(),
        }
    )


@bp.put("/weights")
def update_weights():
    data = request.get_json(silent=True) or {}
    config = storage.load_recommend_config()

    if data.get("mode") in ("auto", "manual"):
        config["mode"] = data["mode"]

    incoming = data.get("manual_weights")
    if isinstance(incoming, dict):
        manual_weights = dict(config.get("manual_weights") or recommend.DEFAULT_WEIGHTS)
        for key in recommend.FEATURE_KEYS:
            if key not in incoming:
                continue
            try:
                manual_weights[key] = recommend.clamp_weight(float(incoming[key]))
            except (TypeError, ValueError):
                continue
        config["manual_weights"] = manual_weights

    storage.save_recommend_config(config)
    return jsonify(config)
