"""가사 텍스트의 마크다운을 Qt 리치 텍스트(HTML)로 변환.

지원 문법: **굵게**, *기울임*, `코드` 등 표준 마크다운 인라인 서식과, 줄바꿈.
`> 텍스트` (블록쿼트)는 원가사 아래에 작게 표시할 보조 줄(번역 등)로 렌더링된다.

추가로 색/서식 지정용 커스텀 인라인 문법을 지원한다: `&<코드>...&/`. `&<코드>`가
구간을 열고, `&/`가 가장 최근에 열린 구간을 닫는다(스택 기반이라 중첩 가능).
코드 종류는 `_COLOR_MAP`(색상, 알파벳 한 글자 — 이름 앞글자가 겹치면 대소문자로
구분), `W` + 숫자 3자리(폰트 굵기), `_`(밑줄), `~`(취소선). 정의되지 않은 코드는
원문 그대로 남겨 오타를 조용히 삼키지 않는다. 닫는 태그가 없이 끝나면 텍스트
끝에서 자동으로 닫는다. 표준 마크다운으로 넘기기 전에 순수 HTML 태그로
먼저 치환해 두는 방식이라, `**bold**` 같은 마크다운 문법이 색 구간 안에 있어도
정상적으로 함께 처리된다(raw 인라인 HTML은 markdown 라이브러리가 그대로
통과시키면서, 그 안의 텍스트도 계속 인라인 처리하기 때문).
"""

from __future__ import annotations

import re

import markdown as _markdown

_MD = _markdown.Markdown(extensions=["nl2br"])

# 색상 코드: 알파벳 한 글자 → hex. 앞글자가 겹치는 색은 대소문자로 구분한다
# (예: 초록 g / 회색 G, 보라 p / 분홍 P).
_COLOR_MAP = {
    "r": "#ff6b6b",  # 빨강
    "o": "#ffa94d",  # 주황
    "y": "#ffd43b",  # 노랑
    "g": "#51cf66",  # 초록
    "c": "#22d3ee",  # 하늘색
    "b": "#4dabf7",  # 파랑
    "p": "#b197fc",  # 보라
    "P": "#f783ac",  # 분홍
    "G": "#adb5bd",  # 회색
    "w": "#f8f9fa",  # 하양
}

# &/ (닫기), &_ (밑줄), &~ (취소선), &W + 숫자 3자리 (폰트 굵기), &알파벳 한 글자(색상).
# W+숫자 패턴을 단일 알파벳 패턴보다 먼저 두어야 "W300"이 통째로 한 토큰으로 잡힌다.
_TOKEN_RE = re.compile(r"&(/|~|_|W[1-9]00|[A-Za-z])")


def _apply_inline_style_syntax(text: str) -> str:
    stack: list[str] = []
    out: list[str] = []
    pos = 0
    for m in _TOKEN_RE.finditer(text):
        out.append(text[pos : m.start()])
        pos = m.end()
        code = m.group(1)
        if code == "/":
            if stack:
                out.append(stack.pop())
        elif code == "_":
            out.append("<u>")
            stack.append("</u>")
        elif code == "~":
            out.append("<s>")
            stack.append("</s>")
        elif code.startswith("W") and len(code) == 4:
            out.append(f'<span style="font-weight:{code[1:]}">')
            stack.append("</span>")
        elif code in _COLOR_MAP:
            out.append(f'<span style="color:{_COLOR_MAP[code]}">')
            stack.append("</span>")
        else:
            out.append(m.group(0))
    out.append(text[pos:])
    out.extend(reversed(stack))
    return "".join(out)


def to_html(text: str) -> str:
    if not text.strip():
        return ""
    # 사용자가 실제 줄바꿈(Enter) 대신 리터럴 "\n" 두 글자를 직접 입력하는 경우도
    # 동일하게 줄바꿈으로 처리한다 (LRC 저장 시의 이스케이프 표기와 통일).
    text = text.replace("\\n", "\n")
    text = _apply_inline_style_syntax(text)
    _MD.reset()
    html = _MD.convert(text)
    html = re.sub(r"</?p>", "", html)
    # blockquote는 원래 블록 요소라 줄바꿈 없이 span(인라인)으로 바꾸면 원가사 뒤에
    # 그대로 이어붙어 렌더링된다. margin만 0으로 죽이고 블록 요소는 유지해야
    # 보조 줄이 실제로 다음 줄에 표시된다.
    html = html.replace("<blockquote>", '<blockquote class="lyric-secondary">')
    return html.strip()
