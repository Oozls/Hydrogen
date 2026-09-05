"""가사 각 줄에 한국어 발음(읽기)과 번역을 붙인다(OpenRouter API).

한 줄씩 따로 요청하면 문맥이 끊겨 발음/번역 품질이 떨어지고 API 호출도 줄
수만큼 늘어나므로, 곡 전체를 한 번에 보내고 JSON 객체 하나로 원본과 정확히
같은 개수·순서의 {reading, translation} 배열을 받는다.

OpenRouter는 단일 엔드포인트로 다양한 제공사의 모델을 고를 수 있어(모델 문자열만
바꾸면 됨), 번역에 쓸 모델을 사용자가 선택할 수 있게 한다(기본값은 이전과 동일한
품질을 위해 Gemini 2.5 Flash로 유지).
"""

from __future__ import annotations

import json
import os
import re
import time

import requests
from pydantic import BaseModel, ValidationError

DEFAULT_MODEL = "google/gemini-2.5-flash"
_API_BASE = "https://openrouter.ai/api/v1"
_API_URL = f"{_API_BASE}/chat/completions"
_MODELS_URL = f"{_API_BASE}/models"

# 가사가 길면(특히 타임스탬프 없이 통째로 받아온 가사 — lyrics.py의
# translate_lyrics 라우트 주석 참고) 한 번에 다 번역시킬 경우 응답이
# max_tokens에 걸려 JSON이 중간에 잘려버릴 수 있다. 두 가지로 대응한다:
# (1) max_tokens를 넉넉히 명시해 어지간한 길이는 애초에 안 잘리게 하고,
# (2) 그래도 너무 길면 여러 번 나눠 요청해 각 요청이 절대 그 한도를 넘지
# 않게 한다(문맥이 배치 경계에서 약간 끊기는 대신, 잘림으로 인한 전체 실패를
# 막는 쪽을 택함).
_BATCH_SIZE = 40
_MAX_TOKENS = 8000

# 모델 목록(수백 개)은 자주 안 바뀌므로, 매번 새로 받는 대신 한 시간 동안
# 캐시해둔다. 모듈 전역 하나뿐인 단일 프로세스 dev/gunicorn 앱 구조라
# 프로세스 안에서만 공유되면 충분하다.
_MODELS_CACHE_TTL = 3600.0
_models_cache: list[dict] | None = None
_models_cache_at = 0.0

# 발음/번역 줄 앞에 붙이는 폭 없는 표시 문자(화면엔 안 보임). 저장된 가사
# 텍스트를 다시 읽을 때 "이 줄은 원문이 아니라 이전에 붙인 발음/번역이다"를
# 구분하는 용도 — 줄 수가 3의 배수인지 같은 우연에 기대는 휴리스틱 대신,
# 명시적인 표시로 재번역 시에도 원문만 정확히 다시 뽑아낼 수 있게 한다.
_MARKER = "​"


class LineTranslation(BaseModel):
    reading: str  # 원어 발음을 한국어 표기로 옮긴 것(예: そらに憧れたのは -> 소라니 아코가레타노와)
    translation: str  # 자연스러운 한국어 번역


class TranslationError(Exception):
    pass


def format_translated_line(original: str, translated: LineTranslation) -> str:
    """가사 한 줄을 (원문/발음/번역) 3줄로 합치고, 다음 원가사와의 사이에 빈
    줄 두 개를 둔다. 발음·번역 줄 모두 markdown_render.py가 지원하는
    "> 텍스트"(보조 줄, 작게 표시) 문법으로 시작해 원가사보다 작게 보인다.
    끝의 "\n\n"는 이 줄 자체가 아니라 다음 그룹과의 간격이므로, 여러 그룹을
    "\n"로 이어붙이면(호출부) 실제로는 빈 줄 두 개(개행 세 번)가 된다 —
    split_original_lines()가 이 빈 줄들을 스페이서로 인식해 걸러낸다."""
    return f"{original}\n> {_MARKER}{translated.reading}\n> {_MARKER}{translated.translation}\n\n"


def _is_marked(part: str) -> bool:
    candidate = part[2:] if part.startswith("> ") else part
    return candidate.startswith(_MARKER)


def split_original_lines(text: str) -> list[str | None]:
    """LyricLine 텍스트에서 실제 가사 원문만 순서대로 뽑는다(빈 줄은 None).
    이미 붙어있는 발음/번역 줄(_MARKER로 시작, "> " 뒤에 옴)과 그 뒤에 붙는
    스페이서 빈 줄(최대 2개, format_translated_line이 다음 원가사와의 간격으로
    넣은 것)은 건너뛴다 — 그래서 한 번도 번역 안 된 줄이든 이미 번역된
    줄이든 항상 원문(그리고 원문 사이의 진짜 문단 구분 빈 줄)만 정확히
    되찾는다."""
    parts = text.split("\n")
    result: list[str | None] = []
    i = 0
    n = len(parts)
    while i < n:
        part = parts[i]
        if _is_marked(part):
            i += 1
            skipped = 0
            while skipped < 2 and i < n and parts[i] == "":
                i += 1
                skipped += 1
            continue
        result.append(part if part.strip() else None)
        i += 1
    return result


def _api_key() -> str:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        raise TranslationError("OPENROUTER_API_KEY 환경변수가 설정되지 않았습니다.")
    return api_key


def _extract_json(content: str) -> object:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
        text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise TranslationError(f"번역 결과를 JSON으로 해석하지 못했습니다: {exc}") from exc


def _price_per_million(raw: object) -> float | None:
    if raw in (None, ""):
        return None
    try:
        return float(raw) * 1_000_000
    except (TypeError, ValueError):
        return None


def list_models(force_refresh: bool = False) -> list[dict]:
    """OpenRouter에 등록된 전체 모델 목록을 가져온다. 이 엔드포인트는 공개라
    API 키 없이도 조회할 수 있다(실제 번역 호출에만 키가 필요)."""
    global _models_cache, _models_cache_at
    now = time.monotonic()
    if not force_refresh and _models_cache is not None and now - _models_cache_at < _MODELS_CACHE_TTL:
        return _models_cache

    try:
        response = requests.get(_MODELS_URL, timeout=15)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        if _models_cache is not None:  # 새로고침 실패해도 기존 캐시가 있으면 그거라도 보여준다
            return _models_cache
        raise TranslationError(f"OpenRouter 모델 목록 조회 실패: {exc}") from exc

    models = []
    for item in payload.get("data") or []:
        model_id = item.get("id")
        if not model_id:
            continue
        pricing = item.get("pricing") or {}
        models.append(
            {
                "id": model_id,
                "name": item.get("name") or model_id,
                "context_length": item.get("context_length"),
                "prompt_price_per_m": _price_per_million(pricing.get("prompt")),
                "completion_price_per_m": _price_per_million(pricing.get("completion")),
            }
        )
    models.sort(key=lambda m: m["id"])
    _models_cache = models
    _models_cache_at = now
    return models


def _translate_batch(originals: list[str], model: str, api_key: str) -> list[LineTranslation]:
    numbered = "\n".join(f"{i + 1}. {text}" for i, text in enumerate(originals))
    prompt = (
        "다음은 노래 가사를 한 줄씩 번호를 매긴 것이다. 각 줄마다 원어 발음을 한국어로 옮긴 "
        "표기(reading)와 자연스러운 한국어 번역(translation)을 만들어라. 결과는 "
        '{"lines": [{"reading": "...", "translation": "..."}, ...]} 형태의 JSON 객체 '
        "하나만 출력하고(다른 설명이나 코드 블록 표시 없이), lines 배열의 길이와 순서는 "
        "입력 줄 수·순서와 정확히 같아야 한다.\n\n" + numbered
    )

    try:
        response = requests.post(
            _API_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "response_format": {"type": "json_object"},
                "max_tokens": _MAX_TOKENS,
            },
            timeout=180,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("error"):
            raise TranslationError(f"OpenRouter 오류: {payload['error'].get('message', payload['error'])}")
        choice = payload["choices"][0]
        content = choice["message"]["content"]
        # 모델이 max_tokens를 다 채우고도 못 끝냈다는 신호 — 이 경우 JSON이 중간에
        # 잘려 있을 가능성이 높으므로, 파싱을 시도하기 전에 먼저 명확한 원인으로
        # 실패시킨다(그냥 "줄 수가 안 맞다"보다 사용자가 뭘 해야 할지 알 수 있게).
        if choice.get("finish_reason") == "length":
            raise TranslationError(
                "번역 응답이 길이 제한에 걸려 잘렸습니다. 이 가사 묶음이 너무 깁니다 — "
                "다른 모델을 선택해보세요."
            )
    except TranslationError:
        raise
    except Exception as exc:  # 네트워크/HTTP/응답 형식 등 외부 API 경계라 전부 번역 실패로 통일
        raise TranslationError(f"OpenRouter 호출 실패: {exc}") from exc

    data = _extract_json(content)
    items = data.get("lines") if isinstance(data, dict) else data
    if not isinstance(items, list) or len(items) != len(originals):
        raise TranslationError("번역 결과 줄 수가 원본과 맞지 않습니다.")
    try:
        return [LineTranslation(**item) for item in items]
    except (TypeError, ValidationError) as exc:
        raise TranslationError(f"번역 결과 형식이 올바르지 않습니다: {exc}") from exc


def translate_lines(originals: list[str], model: str | None = None) -> list[LineTranslation]:
    """originals와 정확히 같은 길이·순서의 리스트를 반환. 실패하면 TranslationError.

    _BATCH_SIZE보다 길면 여러 번에 나눠 요청한다(모듈 docstring의 배치 설명 참고)."""
    if not originals:
        return []

    api_key = _api_key()
    model = model or DEFAULT_MODEL
    results: list[LineTranslation] = []
    for start in range(0, len(originals), _BATCH_SIZE):
        chunk = originals[start : start + _BATCH_SIZE]
        results.extend(_translate_batch(chunk, model, api_key))
    return results
