"""가사 각 줄에 한국어 발음(읽기)과 번역을 붙인다(Gemini API).

한 줄씩 따로 요청하면 문맥이 끊겨 발음/번역 품질이 떨어지고 API 호출도 줄
수만큼 늘어나므로, 곡 전체를 한 번에 보내고 구조화 출력(response_schema)으로
원본과 정확히 같은 개수·순서의 {reading, translation} 배열을 받는다.
"""

from __future__ import annotations

import os

from google import genai
from google.genai import types
from pydantic import BaseModel

_MODEL = "gemini-2.5-flash"

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
    """가사 한 줄을 (원문/발음/번역) 4줄로 합친다. 발음 줄만 markdown_render.py가
    이미 지원하는 "> 텍스트"(보조 줄, 작게 표시) 문법으로 시작해 원가사보다
    작게 보이게 한다 — 번역은 원문과 같은 크기로 둔다. 마크다운 blockquote는
    바로 다음 줄이 "> "로 안 시작해도(lazy continuation) 빈 줄을 만나기 전까진
    같은 블록에 묶어버리므로, 번역 줄을 blockquote 밖(원문 크기)으로 빼내려면
    둘 사이에 실제 빈 줄이 하나 필요하다 — split_original_lines()가 이 빈
    줄을 "원문 사이 문단 구분"과 헷갈리지 않도록 구분해서 걸러낸다."""
    return f"{original}\n> {_MARKER}{translated.reading}\n\n{_MARKER}{translated.translation}"


def _is_marked(part: str) -> bool:
    candidate = part[2:] if part.startswith("> ") else part
    return candidate.startswith(_MARKER)


def split_original_lines(text: str) -> list[str | None]:
    """LyricLine 텍스트에서 실제 가사 원문만 순서대로 뽑는다(빈 줄은 None).
    이미 붙어있는 발음/번역 줄(_MARKER로 시작 — 발음 줄은 "> " 뒤에 옴)과 그
    둘 사이의 빈 줄(format_translated_line이 blockquote를 끊으려고 넣은 것)은
    건너뛴다 — 그래서 한 번도 번역 안 된 줄이든 이미 번역된 줄이든 항상
    원문(그리고 원문 사이의 진짜 문단 구분 빈 줄)만 정확히 되찾는다."""
    parts = text.split("\n")
    result: list[str | None] = []
    i = 0
    while i < len(parts):
        part = parts[i]
        if _is_marked(part):
            i += 1
            continue
        if part == "" and i + 1 < len(parts) and _is_marked(parts[i + 1]):
            i += 1  # 발음/번역 사이의 blockquote 분리용 빈 줄 — 건너뛴다
            continue
        result.append(part if part.strip() else None)
        i += 1
    return result


def _client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise TranslationError("GEMINI_API_KEY 환경변수가 설정되지 않았습니다.")
    return genai.Client(api_key=api_key)


def translate_lines(originals: list[str]) -> list[LineTranslation]:
    """originals와 정확히 같은 길이·순서의 리스트를 반환. 실패하면 TranslationError."""
    if not originals:
        return []

    client = _client()
    numbered = "\n".join(f"{i + 1}. {text}" for i, text in enumerate(originals))
    prompt = (
        "다음은 노래 가사를 한 줄씩 번호를 매긴 것이다. 각 줄마다 원어 발음을 한국어로 옮긴 "
        "표기(reading)와 자연스러운 한국어 번역(translation)을 만들어라. 결과 배열의 길이와 "
        "순서는 입력 줄 수·순서와 정확히 같아야 한다.\n\n" + numbered
    )
    try:
        response = client.models.generate_content(
            model=_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=list[LineTranslation],
            ),
        )
    except Exception as exc:  # Gemini SDK가 여러 예외 타입을 던진다 — 외부 API 경계라 전부 번역 실패로 통일
        raise TranslationError(f"Gemini 호출 실패: {exc}") from exc

    result = response.parsed
    if not isinstance(result, list) or len(result) != len(originals):
        raise TranslationError("번역 결과 줄 수가 원본과 맞지 않습니다.")
    return result
