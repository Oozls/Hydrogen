"""가사 텍스트의 마크다운을 Qt 리치 텍스트(HTML)로 변환.

지원 문법: **굵게**, *기울임*, `코드` 등 표준 마크다운 인라인 서식과, 줄바꿈.
`> 텍스트`는 원가사 아래에 작게 표시할 보조 줄(번역 등)로 렌더링된다. 표준
마크다운 블록쿼트(줄 앞 `>`)를 그대로 쓰면 "빈 줄이 나올 때까지" 뒤따르는
줄까지 통째로 삼켜버리는 lazy continuation 때문에 다음 원가사 줄까지 작게
나오는 문제가 있어, markdown 라이브러리에 넘기기 전에 직접 처리하는 커스텀
문법이다: 줄 맨 앞의 `>`가 구간을 열고, 그 뒤에 나오는 `/>` 또는 다음
줄바꿈(`\n`) 중 먼저 오는 것에서 닫힌다 — 즉 기본적으로 "그 줄 끝까지"만
작게 나오고, `/>`로 줄 중간에서 조기 종료할 수도 있다.

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


def _apply_secondary_line_syntax(text: str) -> str:
    """줄 맨 앞 `>`부터 `/>` 또는 다음 `\n`(먼저 오는 쪽)까지를 보조 줄 span으로
    감싼다. 표준 마크다운 블록쿼트를 쓰지 않으므로 lazy continuation으로 뒤
    줄까지 삼켜지는 일이 없다 — 닫히는 지점이 항상 명시적이다."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        if text[i] == ">" and (i == 0 or text[i - 1] == "\n"):
            close = text.find("/>", i + 1)
            newline = text.find("\n", i + 1)
            if close != -1 and (newline == -1 or close < newline):
                end = close
                next_i = close + 2
            elif newline != -1:
                end = newline
                next_i = newline
            else:
                end = n
                next_i = n
            content = text[i + 1 : end]
            if content.startswith(" "):
                content = content[1:]
            out.append(f'<span class="lyric-secondary">{content}</span>')
            i = next_i
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def to_html(text: str) -> str:
    if not text.strip():
        return ""
    # 사용자가 실제 줄바꿈(Enter) 대신 리터럴 "\n" 두 글자를 직접 입력하는 경우도
    # 동일하게 줄바꿈으로 처리한다 (LRC 저장 시의 이스케이프 표기와 통일).
    text = text.replace("\\n", "\n")
    text = _apply_secondary_line_syntax(text)
    text = _apply_inline_style_syntax(text)
    _MD.reset()
    html = _MD.convert(text)
    # 빈 줄(문단 구분)은 <p>...</p><p>...</p>로 갈라져 나오는데, 태그를 그냥
    # 지우기만 하면 시각적 줄바꿈(빈 줄이었던 자리)까지 같이 사라져 버린다.
    # </p>를 <br><br>로 바꿔서 빈 줄 자리를 유지한 채 <p>만 제거한다.
    html = html.replace("</p>", "<br><br>")
    html = re.sub(r"<p>", "", html)
    html = re.sub(r"(<br\s*/?>\s*)+$", "", html)
    return html.strip()
