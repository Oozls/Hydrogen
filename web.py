"""Flask 웹 버전 진입점."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from lyricstorage.web import create_app

app = create_app()

if __name__ == "__main__":
    # threaded=True: 기본값(False)은 요청을 한 번에 하나씩만 처리해서, 페이지
    # 로드 시 한꺼번에 요청되는 수십 개의 아이콘 SVG(mask-image)가 순서대로
    # 처리되느라 일부 아이콘이 잠깐(1초 이내) 안 보이는 현상이 있었다.
    app.run(debug=True, port=5000, threaded=True)
