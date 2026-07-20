"""블루프린트 등록."""

from __future__ import annotations

from flask import Flask


def register_routes(app: Flask) -> None:
    from lyricstorage.web.routes.library import bp as library_bp
    from lyricstorage.web.routes.lyrics import bp as lyrics_bp
    from lyricstorage.web.routes.media import bp as media_bp
    from lyricstorage.web.routes.metadata import bp as metadata_bp
    from lyricstorage.web.routes.pages import bp as pages_bp
    from lyricstorage.web.routes.playlists import bp as playlists_bp
    from lyricstorage.web.routes.settings import bp as settings_bp

    app.register_blueprint(pages_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(playlists_bp)
    app.register_blueprint(library_bp)
    app.register_blueprint(media_bp)
    app.register_blueprint(metadata_bp)
    app.register_blueprint(lyrics_bp)
