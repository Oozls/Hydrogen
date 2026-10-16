"""로그 조회 API. 12시간 단위(오전/오후)로 나뉜 로그 파일 목록과 내용을 반환한다."""

from __future__ import annotations

import re

from flask import Blueprint, abort, jsonify, request

from lyricstorage import applog

bp = Blueprint("logs", __name__, url_prefix="/api/logs")

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@bp.get("")
def list_logs():
    return jsonify(applog.list_log_files())


@bp.get("/<date>/<half>")
def get_log(date: str, half: str):
    half = half.upper()
    if half not in ("AM", "PM") or not _DATE_RE.match(date):
        abort(404)
    return jsonify({"entries": applog.read_log_entries(date, half)})


@bp.post("/client")
def client_log():
    """브라우저(특히 iOS 백그라운드 재생)에서 보내는 진단 메시지를 로그에 남긴다."""
    data = request.get_json(silent=True) or {}
    msg = str(data.get("msg", ""))[:300]
    if msg:
        applog.log_info("PLAYER", msg)
    return ("", 204)
