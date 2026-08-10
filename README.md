# Hydrogen

MP3 플레이어. 플레이리스트 관리와, 가사 텍스트에 타임스탬프를 직접 입력해 동기화하는 가사 편집 기능이 특징입니다. 저장 포맷은 표준 `.lrc`라 다른 플레이어와도 호환됩니다. 아이콘은 전부 [Feather Icons](https://feathericons.com)를 사용합니다. Flask로 만든 웹 앱입니다.

## 실행

```bash
uv run web.py
```

기본적으로 http://127.0.0.1:5000 에서 열립니다. 단일 사용자 로컬/자체 호스팅용으로, 인증 없이 개발 서버로 동작합니다.

## 기능

- **재생**: play/pause, 이전/다음, seek, 볼륨, 셔플, 반복(전체/한 곡), 다음 곡 프리로드(끊김 최소화), 미디어 세션(잠금화면/미디어 키) 연동, 전역 키보드 단축키
- **지원 포맷**: mp3, wav, m4a
- **플레이리스트**: "글로벌 플레이리스트"는 곡의 전역 라이브러리 역할을 합니다. 파일/폴더 추가(태그는 mutagen으로 자동 인식)는 라이브러리(브라우즈 화면)에서만 하고, 그 외 플레이리스트는 라이브러리에 등록된 곡 중에서 골라 추가합니다. 추가되는 음원은 내용 해시를 이름으로 `./data/songs/`에 복사되어 보관됩니다(원본 경로가 바뀌거나 삭제돼도 라이브러리에는 영향 없음, 동일 파일 중복 추가 시 재사용). 드래그로 순서 변경, 여러 개의 플레이리스트 생성/이름변경/삭제/전환, 마지막 세션 자동 복원도 지원합니다.
- **브라우즈**: 라이브러리를 곡/앨범 단위로 검색·정렬·드래그 정렬. 앨범 상세에서 표지·앨범명 일괄 수정, 앨범 통째로 zip 다운로드, 개별 곡 다운로드도 가능합니다. 여러 곡을 선택해 제목/아티스트/앨범 일괄 수정 또는 일괄 삭제(파일까지 완전 삭제)할 수 있습니다.
- **가사 편집**: "가사 편집" 탭에서 각 줄마다 가사 텍스트와 타임스탬프(분:초:밀리초, 예 `1:12:500`)를 직접 입력/수정하면 자동으로 저장됩니다. 마크다운 서식(`**굵게**`, `*기울임*`)과, 번역 등 보조 줄(`> `로 시작)을 지원합니다. 곡을 재생하면서 Enter/Backspace로 줄마다 타이밍을 찍고 전체 반응속도 보정까지 적용하는 전용 타이밍 편집기도 있습니다. 가사는 `./data/lyrics/`에 `.lrc`로 저장되고, "가사 보기" 탭에서 재생 시 현재 줄이 자동으로 하이라이트됩니다. 기존 내용을 덮어쓰거나 지우기 직전엔 자동으로 스냅샷이 백업되며("가사 편집" 툴바의 시계 아이콘에서 확인/복원 가능), 특히 가사가 통째로 빈 상태로 저장될 때는 항상 백업됩니다.
- **재생 통계**: 일/주/월 단위로 최근 재생 목록, 아티스트별/앨범별 재생 순위(TOP3 포함)를 확인할 수 있습니다. 한 곡을 30% 이상(또는 재생시간 정보가 없으면 10초 이상) 들었을 때만 재생 기록으로 집계됩니다.
- **평점**: 트랜스포트 바의 하트 5개짜리 위젯으로 0.5점 단위(반쪽 하트)까지 매길 수 있습니다. 하트를 왼쪽 절반만 클릭하면 -0.5점, 오른쪽 절반을 클릭하면 정수점이 매겨집니다.
- **오늘의 곡**: 사이드바에서 재생 기록이 적거나 없는 곡 중, 평점과 좋아하는 아티스트/앨범 선호도를 반영해 가중 무작위로 몇 곡을 골라 보여줍니다. 하루 동안은 같은 목록이 유지되고("다시 뽑기"로 즉시 새로 추첨 가능), 화면 우측 상단 드롭다운으로 표시 개수(4~30곡, 기본 8곡)를 조절할 수 있으며 설정은 저장되어 다음에 열 때도 유지됩니다. 브라우즈 "곡" 탭에는 이 중 상위 3곡이 재생 통계의 TOP3 앨범과 같은 카드 디자인으로 함께 뜹니다. 요소별 가중치(평점/아티스트/앨범 선호도/미청취 보너스)는 고정값이 아니라, 과거에 추천됐던 곡이 실제로 재생되거나 좋은 평점을 받았는지를 관찰해 배치 경사하강으로 계속 다시 맞춰집니다 — 즉 써볼수록 그 사람에게 어떤 요소가 "다시 듣고 싶어지는지"를 더 잘 반영하게 됩니다.
- **부가 페이지**: `/files`에서 `./data/` 폴더 구조를 트리로 확인/미리보기/삭제할 수 있고, `/logs`에서 요청·액션·에러 로그를 12시간 단위로 조회할 수 있습니다.

## 데이터 저장 위치

- 플레이리스트: `./data/playlists/<이름>.json` (곡 정보 사본을 포함한 JSON, 라이브러리도 `글로벌 플레이리스트.json`으로 이 안에 저장됨)
- 설정: `./data/settings.json` (마지막으로 연 플레이리스트, 볼륨 등)
- 재생 이력: `./data/play_history/<날짜>.jsonl` (통계 집계의 원본 데이터, 날짜별 파일에 재생마다 한 줄씩 추가됨. 구버전의 단일 `play_history.json`은 앱 시작 시 자동으로 이 형태로 이전됨)
- 곡 아티스트 이명: `./data/artists.json` (대표 이름 + 이명 목록. 곡 파일의 artist 태그나 재생 기록은 그대로 두고, 통계/아티스트 상세 화면에서만 여기 등록된 이름들을 같은 사람으로 묶어 보여줌)
- 오늘의 곡 노출 이력: `./data/recommend_exposures.json` (하루에 한 번, 그날 추천된 곡과 당시 점수 요소를 기록 — 이후 실제 재생/평점과 대조해 추천 가중치를 학습하는 데 쓰임)
- 로그: `./data/logs/<날짜>_<AM|PM>.log`
- 음원 파일: `./data/songs/<내용 해시>.<확장자>` (라이브러리에 추가 시 원본을 복사)
- 가사: `./data/lyrics/<음원 파일명(내용 해시)>.lrc` (구버전에서 음원 옆/`./data/lyrics_cache`에 있던 가사는 앱 시작 시 자동으로 이 위치로 이전됨)
- 가사 백업: `./data/lyrics_backups/<음원 파일명(내용 해시)>/<타임스탬프>.lrc` (곡당 최근 30개 보관, "가사 편집" 탭에서 확인·복원 가능)

## 동작 방식

- **서버**: `web.py`가 `lyricstorage.web.create_app()`으로 Flask 앱을 만들어 실행합니다. 앱 팩토리는 요청/응답을 파일 로그(`applog`)에 남기는 훅을 걸고, `routes/` 아래의 블루프린트들을 등록합니다.
- **데이터 저장**: 데이터베이스 없이 전부 `./data/` 아래의 JSON/파일로 저장합니다(`storage.py`가 경로를 관리). 트랙 정보는 플레이리스트 JSON 안에 값 자체가 여러 번 복제되어 들어가므로(같은 곡이 여러 플레이리스트에 각각 사본으로 존재), 메타데이터 수정·삭제 시 `playlist_repo.py`가 모든 플레이리스트 파일을 순회하며 일관성을 맞춥니다.
- **트랙 식별**: 트랙은 별도 ID 없이 파일 경로의 SHA-1 해시 앞 16자(`storage.path_hash`)를 `track_id`로 사용합니다. `lookup.py`가 이 id로 모든 플레이리스트를 훑어 실제 `Track`을 찾아줍니다.
- **음원 파일 관리**: 라이브러리에 곡을 추가하면 원본 파일 내용을 SHA-256으로 해시해 `./data/songs/<해시>.<확장자>`로 복사합니다(`models._copy_into_library`). 그래서 동일한 파일을 여러 번 추가해도 저장은 한 번만 되고, 원본 경로가 사라져도 라이브러리는 영향받지 않습니다. 태그(제목/아티스트/앨범/표지)는 mutagen으로 읽고 씁니다(WAV는 mutagen의 easy 태그가 없어 raw ID3 프레임을 직접 다룹니다).
- **가사 저장 포맷**: 표준 LRC(`[mm:ss.xx]가사`)를 그대로 사용해(`lyrics_io.py`) 다른 플레이어와도 호환됩니다. 음원 파일과는 분리된 `./data/lyrics/`에 파일명(음원의 내용 해시)을 그대로 이어받아 저장합니다 — 과거에는 음원 옆에 사이드카로 저장했는데, 그 폴더가 다른 기능(다운로드/삭제 등)에 의해 건드려지며 드물게 가사가 빈 내용으로 덮어써지는 문제가 있어 분리했습니다. 앱 시작 시 구버전 위치(음원 옆 사이드카, `./data/lyrics_cache` 폴백)에 남은 파일을 자동으로 새 위치로 이전합니다(`lyrics_io.migrate_legacy_lyrics`). 저장/삭제로 기존 내용을 덮어쓰기 직전에는 `./data/lyrics_backups/<파일명>/`에 타임스탬프 스냅샷을 남기는데, 같은 곡은 기본적으로 10분에 한 번만 자동 백업하되(잦은 자동저장으로 인한 파일 폭증 방지) 가사가 통째로 사라지는 경우엔 스로틀과 무관하게 항상 백업하고 곡당 최근 30개를 보관합니다. "가사 편집" 탭의 백업 아이콘에서 목록/미리보기/복원이 가능합니다.
- **프런트엔드**: 서버는 `index.html` 하나만 렌더링하는 SPA(싱글 페이지 앱) 셸이고(`/files`, `/logs`는 각각 별도의 작은 페이지), 최초 로드 시 필요한 초기 데이터(`bootstrap`)를 템플릿에 JSON으로 인라인해 API 왕복을 줄입니다. 화면 전환은 서버 라우팅이 아니라 `router.js`의 해시 라우터(`#/browse`, `#/playlist/<이름>`, `#/stats`)가 담당하며, 모든 서버 통신은 `api.js`의 fetch 래퍼를 통해 `/api/...` 엔드포인트를 호출합니다.
- **재생/업로드**: 오디오는 `<audio>` 태그로 스트리밍하며 서버는 Range 요청(탐색바 이동)을 지원합니다(`media.py`, `send_file(..., conditional=True)`). 파일 업로드는 라이브러리 API(`library.py`)에서만 받아 임시 파일로 저장한 뒤 기존 경로 기반 추가 로직을 재사용합니다.

## 파일 구조

```
web.py                              Flask 앱 진입점 (uv run web.py로 실행)
pyproject.toml                      의존성 정의 (flask, mutagen, markdown, gunicorn)

src/lyricstorage/
├── models.py                       Track/PlaylistModel/LyricTrack 데이터 모델, 태그 읽기/쓰기, 라이브러리 복사 로직
├── storage.py                      data/ 하위 경로 관리, 설정·재생이력 로드/저장, 해시/경로 변환 유틸
├── lyrics_io.py                    LRC 파싱/직렬화, 가사 사이드카 파일 탐색/저장/삭제
├── stats.py                        재생 이력 기록 및 기간별(일/주/월) 집계
├── recommend.py                    "오늘의 곡" 추천: 재생 기록/평점/아티스트·앨범 선호도 기반 가중 무작위 선정
├── applog.py                       12시간 단위 파일 로깅 (요청/액션/에러)
├── markdown_render.py              가사 텍스트의 마크다운(굵게/기울임/보조줄)을 HTML로 변환
│
└── web/
    ├── __init__.py                 Flask 앱 팩토리(create_app), 요청 로깅 훅, 블루프린트 등록
    ├── library.py                  업로드 스트림 -> PlaylistModel.add_file 연결 어댑터
    ├── lookup.py                   track_id(경로 해시) -> Track 조회 (전체 플레이리스트 탐색)
    ├── playlist_repo.py            플레이리스트 이름 -> PlaylistModel 로드, 전체 플레이리스트에 걸친 트랙 갱신/삭제
    ├── serialize.py                Track/PlaylistModel -> JSON 직렬화
    │
    ├── routes/                     블루프린트들 (모두 register_routes에서 등록)
    │   ├── pages.py                 SPA 셸(index.html) 렌더링 + bootstrap 데이터 주입, /files, /logs 페이지
    │   ├── settings.py              /api/settings — 마지막 플레이리스트/볼륨 조회·저장, data 폴더 용량
    │   ├── playlists.py             /api/playlists — CRUD, 순서변경, 트랙 추가/삭제
    │   ├── library.py               /api/library — 라이브러리 조회, 파일 업로드(유일한 업로드 경로)
    │   ├── media.py                 /api/tracks/<id>/audio,art,download — 스트리밍, 앨범아트, 다운로드
    │   ├── metadata.py              /api/tracks/<id>/metadata,rating,art — 태그/평점/표지 수정, 일괄 수정·삭제
    │   ├── lyrics.py                /api/tracks/<id>/lyrics — 가사 조회/저장
    │   ├── stats.py                 /api/stats — 재생 기록, 기간별 순위
    │   ├── recommendations.py       /api/recommendations/today — 오늘의 곡 추천 목록
    │   ├── albums.py                /api/albums — 앨범 단위 정보 수정, zip 다운로드
    │   ├── artists.py               /api/artists — 곡 아티스트 이명 등록/대표 이름 변경
    │   ├── logs.py                  /api/logs — 로그 파일 목록/조회
    │   └── files.py                 /api/files — data 폴더 트리/내용/삭제
    │
    ├── templates/
    │   ├── index.html               메인 SPA 셸: 사이드바, 재생목록/브라우즈/통계 패널, 가사 패널, 트랜스포트 바, 모든 다이얼로그
    │   ├── files.html                /files 페이지 (data 폴더 트리 뷰)
    │   └── logs.html                 /logs 페이지 (로그 조회)
    │
    └── static/
        ├── css/theme.css             단일 다크 테마 스타일시트 (Feather 아이콘 마스킹, 반응형 사이드바 포함)
        ├── icons/*.svg                Feather Icons SVG
        ├── vendor/sortable.min.js     SortableJS (드래그 정렬, 서드파티)
        └── js/
            ├── main.js                 진입점: bootstrap 데이터 로드, 각 기능 모듈 초기화/연결
            ├── router.js                해시 기반 라우팅 (#/browse, #/playlist/<이름>, #/stats, #/today)
            ├── api.js                   모든 백엔드 REST 호출을 감싼 단일 API 객체
            ├── sidebar.js               사이드바 플레이리스트 목록, data 용량 표시, 모바일 드로어
            ├── playlistNames.js         비-글로벌 플레이리스트 이름 목록 조회 (여러 모듈이 공유)
            │
            ├── player.js                PlayerEngine: <audio> 래핑, 셔플/반복/프리로드, 이벤트 발행
            ├── nowplaying.js            트랜스포트 바 UI, 미디어세션 연동, 키보드 단축키
            ├── playtracking.js          청취 시간 추적 -> 재생 기록 API 호출
            ├── rating.js                트랜스포트 바 별점 위젯
            │
            ├── playlist.js              "재생목록" 패널: 트랙 목록, CRUD, 업로드, 정렬, 라이브러리에서 추가
            ├── browse.js                "브라우즈" 패널: 곡/앨범 탭, 검색, 앨범 상세, 업로드
            ├── albumGroup.js            앨범 그룹핑/검색 매칭 순수 헬퍼 (browse.js, playlist.js 공유)
            ├── albuminfo.js             앨범 정보(이름/표지) 수정 다이얼로그
            ├── trackinfo.js             단일 트랙 정보 수정 다이얼로그
            ├── bulkedit.js              여러 트랙 일괄 수정/삭제 다이얼로그
            ├── autocomplete.js          제목/아티스트/앨범 입력 자동완성 위젯
            ├── rowContextMenu.js        곡 행 우클릭(⋮) 컨텍스트 메뉴
            │
            ├── lyrics.js                가사 보기/편집 탭 (현재 줄 하이라이트, 표 형태 편집)
            ├── lyricsEditor.js          곡을 들으며 Enter/Backspace로 타이밍 찍는 전용 편집기
            │
            ├── stats.js                 "재생 통계" 패널: 기간/그룹 탭, 최근 재생, TOP3
            ├── todaysongs.js            "오늘의 곡" 패널: 추천 목록, 다시 뽑기
            ├── files.js                 /files 페이지 로직
            ├── logs.js                  /logs 페이지 로직
            │
            ├── dialog.js                공용 confirm/prompt/alert 다이얼로그
            ├── icons.js                 Feather 아이콘 세팅 헬퍼
            ├── marquee.js               긴 텍스트 스크롤 애니메이션
            ├── progress.js              업로드 진행률 오버레이
            ├── artspinner.js            이미지 로딩 스피너
            └── imageLightbox.js         앨범아트 확대 보기
```
