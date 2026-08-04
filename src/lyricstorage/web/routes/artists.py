"""곡 아티스트 이명(별칭)/대표 이름 관리 API."""

from __future__ import annotations

from flask import Blueprint, abort, jsonify, request

from lyricstorage import artists as artists_repo

bp = Blueprint("artists", __name__, url_prefix="/api/artists")


@bp.get("")
def list_artists():
    return jsonify({"artists": [a.to_dict() for a in artists_repo.load_artists()]})


@bp.post("/resolve")
def resolve_artist():
    """이름 문자열로 아티스트 정체성을 찾거나(없으면) 새로 만들어 반환한다.
    등록된 정체성이 없는 이름도 항상 성공적으로 {id, name, aliases:[]}를
    반환해, 아티스트 상세 화면을 열 때마다 이명 편집 UI를 그대로 쓸 수 있다."""
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name이 필요합니다."}), 400
    artist = artists_repo.get_or_create_artist(name)
    return jsonify(artist.to_dict())


@bp.put("/<artist_id>")
def rename_artist(artist_id: str):
    data = request.get_json(silent=True) or {}
    new_name = str(data.get("name") or "").strip()
    if not new_name:
        return jsonify({"error": "이름을 입력하세요."}), 400
    artist = artists_repo.rename_artist(artist_id, new_name)
    if artist is None:
        abort(404)
    return jsonify(artist.to_dict())


@bp.post("/<artist_id>/aliases")
def add_alias(artist_id: str):
    data = request.get_json(silent=True) or {}
    alias = str(data.get("alias") or "").strip()
    if not alias:
        return jsonify({"error": "이명을 입력하세요."}), 400
    artist = artists_repo.add_alias(artist_id, alias)
    if artist is None:
        abort(404)
    return jsonify(artist.to_dict())


@bp.delete("/<artist_id>/aliases")
def delete_alias(artist_id: str):
    # 이명 문자열에 "/" 등 URL 경로에 쓰기 까다로운 문자가 섞일 수 있어 쿼리로 받는다.
    alias = str(request.args.get("alias") or "").strip()
    if not alias:
        return jsonify({"error": "alias가 필요합니다."}), 400
    artist = artists_repo.remove_alias(artist_id, alias)
    if artist is None:
        abort(404)
    return jsonify(artist.to_dict())
