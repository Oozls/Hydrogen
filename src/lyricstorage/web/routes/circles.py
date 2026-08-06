"""서클(앨범 아티스트) 이명(별칭)/대표 이름 관리 API. artists.py 라우트와 구조가
동일하다 — 대상이 곡 아티스트냐 서클이냐 차이일 뿐."""

from __future__ import annotations

from flask import Blueprint, abort, jsonify, request

from lyricstorage import circles as circles_repo

bp = Blueprint("circles", __name__, url_prefix="/api/circles")


@bp.get("")
def list_circles():
    return jsonify({"circles": [c.to_dict() for c in circles_repo.load_circles()]})


@bp.post("/resolve")
def resolve_circle():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name이 필요합니다."}), 400
    circle = circles_repo.get_or_create_circle(name)
    return jsonify(circle.to_dict())


@bp.put("/<circle_id>")
def rename_circle(circle_id: str):
    data = request.get_json(silent=True) or {}
    new_name = str(data.get("name") or "").strip()
    if not new_name:
        return jsonify({"error": "이름을 입력하세요."}), 400
    circle = circles_repo.rename_circle(circle_id, new_name)
    if circle is None:
        abort(404)
    return jsonify(circle.to_dict())


@bp.post("/<circle_id>/aliases")
def add_alias(circle_id: str):
    data = request.get_json(silent=True) or {}
    alias = str(data.get("alias") or "").strip()
    if not alias:
        return jsonify({"error": "이명을 입력하세요."}), 400
    circle = circles_repo.add_alias(circle_id, alias)
    if circle is None:
        abort(404)
    return jsonify(circle.to_dict())


@bp.delete("/<circle_id>/aliases")
def delete_alias(circle_id: str):
    alias = str(request.args.get("alias") or "").strip()
    if not alias:
        return jsonify({"error": "alias가 필요합니다."}), 400
    circle = circles_repo.remove_alias(circle_id, alias)
    if circle is None:
        abort(404)
    return jsonify(circle.to_dict())
