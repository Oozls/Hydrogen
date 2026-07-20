"""Flask 앱 팩토리."""

from __future__ import annotations

from pathlib import Path

from flask import Flask

_PACKAGE_ROOT = Path(__file__).resolve().parent


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=str(_PACKAGE_ROOT / "templates"),
        static_folder=str(_PACKAGE_ROOT / "static"),
    )

    from lyricstorage.web.routes import register_routes

    register_routes(app)
    return app
