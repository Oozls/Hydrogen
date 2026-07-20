"""싱글 페이지 셸. 초기 API 왕복을 줄이기 위해 부트스트랩 데이터를 템플릿에 인라인한다."""

from __future__ import annotations

import json

from flask import Blueprint, render_template

from lyricstorage import storage
from lyricstorage.models import PlaylistModel
from lyricstorage.web import playlist_repo
from lyricstorage.web.serialize import playlist_to_json

bp = Blueprint("pages", __name__)


@bp.get("/")
def index():
    settings = storage.load_settings()
    playlist_names = [name for name, _ in PlaylistModel.list_saved_names()]

    last_name = settings.get("last_playlist")
    current_playlist = playlist_repo.load_playlist(last_name) if last_name else None
    if current_playlist is None:
        current_playlist = playlist_repo.load_or_create_global()
    if current_playlist.name not in playlist_names:
        playlist_names.append(current_playlist.name)

    bootstrap = {
        "playlist_names": playlist_names,
        "current_playlist": playlist_to_json(current_playlist),
        "settings": {
            "last_playlist": current_playlist.name,
            "volume": settings.get("volume", 80),
        },
    }
    # </script>로 오인되어 태그가 끊기지 않도록 이스케이프.
    bootstrap_json = json.dumps(bootstrap, ensure_ascii=False).replace("</", "<\\/")
    return render_template("index.html", bootstrap_json=bootstrap_json)
