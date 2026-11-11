"""아티스트/서클 이명 관리 API 공용 블루프린트 팩토리."""

from __future__ import annotations

from flask import Blueprint, abort, jsonify, request


def make_identity_blueprint(name: str, plural: str, repo) -> Blueprint:
    """name='artist', plural='artists' 처럼 넘기면 기존과 동일한 엔드포인트
    (artists.list_artists 등)와 URL(/api/artists/...)이 만들어진다."""
    bp = Blueprint(plural, __name__, url_prefix=f"/api/{plural}")
    id_param = f"{name}_id"

    def list_all():
        return jsonify({plural: [i.to_dict() for i in repo.load()]})

    def resolve():
        data = request.get_json(silent=True) or {}
        n = str(data.get("name") or "").strip()
        if not n:
            return jsonify({"error": "name이 필요합니다."}), 400
        return jsonify(repo.get_or_create(n).to_dict())

    def rename(**kw):
        data = request.get_json(silent=True) or {}
        new_name = str(data.get("name") or "").strip()
        if not new_name:
            return jsonify({"error": "이름을 입력하세요."}), 400
        item = repo.rename(kw[id_param], new_name)
        if item is None:
            abort(404)
        return jsonify(item.to_dict())

    def add_alias(**kw):
        data = request.get_json(silent=True) or {}
        alias = str(data.get("alias") or "").strip()
        if not alias:
            return jsonify({"error": "이명을 입력하세요."}), 400
        item = repo.add_alias(kw[id_param], alias)
        if item is None:
            abort(404)
        return jsonify(item.to_dict())

    def delete_alias(**kw):
        # 이명 문자열에 "/" 등 URL 경로에 쓰기 까다로운 문자가 섞일 수 있어 쿼리로 받는다.
        alias = str(request.args.get("alias") or "").strip()
        if not alias:
            return jsonify({"error": "alias가 필요합니다."}), 400
        item = repo.remove_alias(kw[id_param], alias)
        if item is None:
            abort(404)
        return jsonify(item.to_dict())

    bp.add_url_rule("", f"list_{plural}", list_all, methods=["GET"])
    bp.add_url_rule("/resolve", f"resolve_{name}", resolve, methods=["POST"])
    bp.add_url_rule(f"/<{id_param}>", f"rename_{name}", rename, methods=["PUT"])
    bp.add_url_rule(f"/<{id_param}>/aliases", "add_alias", add_alias, methods=["POST"])
    bp.add_url_rule(f"/<{id_param}>/aliases", "delete_alias", delete_alias, methods=["DELETE"])
    return bp
