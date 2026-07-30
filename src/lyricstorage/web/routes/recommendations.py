"""'오늘의 곡' 추천 API."""

from __future__ import annotations

from datetime import date

from flask import Blueprint, jsonify, request

from lyricstorage import recommend
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
