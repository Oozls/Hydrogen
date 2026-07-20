"""가사 텍스트의 마크다운을 Qt 리치 텍스트(HTML)로 변환.

지원 문법: **굵게**, *기울임*, `코드` 등 표준 마크다운 인라인 서식과, 줄바꿈.
`> 텍스트` (블록쿼트)는 원가사 아래에 작게 표시할 보조 줄(번역 등)로 렌더링된다.
"""

from __future__ import annotations

import re

import markdown as _markdown

_MD = _markdown.Markdown(extensions=["nl2br"])


def to_html(text: str) -> str:
    if not text.strip():
        return ""
    # 사용자가 실제 줄바꿈(Enter) 대신 리터럴 "\n" 두 글자를 직접 입력하는 경우도
    # 동일하게 줄바꿈으로 처리한다 (LRC 저장 시의 이스케이프 표기와 통일).
    text = text.replace("\\n", "\n")
    _MD.reset()
    html = _MD.convert(text)
    html = re.sub(r"</?p>", "", html)
    # blockquote는 원래 블록 요소라 줄바꿈 없이 span(인라인)으로 바꾸면 원가사 뒤에
    # 그대로 이어붙어 렌더링된다. margin만 0으로 죽이고 블록 요소는 유지해야
    # 보조 줄이 실제로 다음 줄에 표시된다.
    html = html.replace("<blockquote>", '<blockquote class="lyric-secondary">')
    return html.strip()
