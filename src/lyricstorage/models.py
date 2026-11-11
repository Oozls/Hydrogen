"""Track / Playlist / Lyric 데이터 모델."""

from __future__ import annotations

import json
import re
import shutil
import threading
from dataclasses import dataclass, asdict
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Optional

from PIL import Image
from mutagen import File as MutagenFile
from mutagen.id3 import ID3, ID3NoHeaderError, APIC, TALB, TIT2, TPE1
from mutagen.mp4 import MP4, MP4Cover
from mutagen.wave import WAVE

from lyricstorage import albums as albums_repo
from lyricstorage import applog, lyrics_io, storage

GLOBAL_PLAYLIST_NAME = "글로벌 플레이리스트"
SUPPORTED_EXTENSIONS = (".mp3", ".wav", ".m4a")

# PlaylistModel.save()가 호출될 때마다 올라가는 카운터. 플레이리스트 내용을 캐시하는
# 쪽(web/lookup.py)이 "저장이 있었는지"를 값싸게 확인하는 데 쓴다.
_save_generation = 0
_save_generation_lock = threading.Lock()


def playlist_save_generation() -> int:
    return _save_generation


def _bump_save_generation() -> None:
    global _save_generation
    with _save_generation_lock:
        _save_generation += 1


def _copy_into_library(path: str) -> str:
    """음원 파일을 data/songs 폴더에 내용 해시 이름으로 복사(중복 내용은 재사용)."""
    src = Path(path)
    digest = storage.file_content_hash(src)
    target = storage.songs_dir() / f"{digest}{src.suffix.lower()}"
    if not target.exists():
        shutil.copy2(src, target)
    return str(target)


def _wave_frame_text(tags, frame_id: str, default: str) -> str:
    frame = tags.get(frame_id) if tags else None
    return str(frame.text[0]) if frame is not None and frame.text else default


def _parse_track_no(text: str) -> int:
    """"3", "3/12" 같은 트랙 번호 태그에서 앞의 숫자만 뽑는다. 없거나 형식이
    이상하면 0(=번호 없음)."""
    match = re.match(r"\s*(\d+)", text or "")
    return int(match.group(1)) if match else 0


# 일본 서클 음반 태그에 흔한 전각 쉼표(，)/모점(、)과 세미콜론(;)까지, 아티스트
# 여러 명을 나누는 구분자로 흔히 쓰이는 것들을 전부 반각 쉼표 + 공백 한 칸으로
# 통일한다. split_artists()가 ","만 인식하므로, 여기서 미리 정규화해두지 않으면
# 저 구분자를 쓴 곡만 여러 아티스트로 안 나뉘고 통째로 한 이름 취급된다.
_ARTIST_SEPARATOR_RE = re.compile(r"\s*[,，、;]\s*")


def normalize_artist_text(artist: str) -> str:
    text = (artist or "").strip()
    if not text:
        return text
    return _ARTIST_SEPARATOR_RE.sub(", ", text)


def read_tags(path: str) -> dict:
    title = Path(path).stem
    artist = ""
    album = ""
    duration_ms = 0
    track_no = 0
    try:
        # WAV엔 mutagen의 "easy" 태그 래퍼가 없어(File(easy=True)가 조용히 raw
        # WAVE를 반환) title/artist/album 이지키 읽기가 항상 실패하고 파일명으로
        # 폴백한다. raw ID3 프레임(TIT2/TPE1/TALB/TRCK)으로 직접 읽어야 한다.
        if Path(path).suffix.lower() == ".wav":
            audio = WAVE(path)
            title = _wave_frame_text(audio.tags, "TIT2", title)
            artist = _wave_frame_text(audio.tags, "TPE1", artist)
            album = _wave_frame_text(audio.tags, "TALB", album)
            track_no = _parse_track_no(_wave_frame_text(audio.tags, "TRCK", ""))
            if audio.info is not None:
                duration_ms = int(audio.info.length * 1000)
        else:
            audio = MutagenFile(path, easy=True)
            if audio is not None:
                if audio.tags:
                    title = (audio.tags.get("title") or [title])[0]
                    artist = (audio.tags.get("artist") or [""])[0]
                    album = (audio.tags.get("album") or [""])[0]
                    track_no = _parse_track_no((audio.tags.get("tracknumber") or [""])[0])
                if audio.info is not None:
                    duration_ms = int(audio.info.length * 1000)
    except Exception:
        pass
    return {
        "title": title,
        "artist": normalize_artist_text(artist),
        "album": album,
        "duration_ms": duration_ms,
        "track_no": track_no,
    }


def read_album_art(path: str) -> Optional[bytes]:
    try:
        suffix = Path(path).suffix.lower()
        if suffix == ".m4a":
            audio = MP4(path)
            covers = audio.tags.get("covr") if audio.tags else None
            if covers:
                return bytes(covers[0])
            return None
        # WAV는 RIFF 컨테이너라 ID3(path)를 바로 호출하면 ID3NoHeaderError가 난다.
        # RIFF의 "id3 " 청크 안에 든 태그를 읽으려면 WAVE를 거쳐야 한다.
        tags = WAVE(path).tags if suffix == ".wav" else ID3(path)
        if tags is None:
            return None
        for frame in tags.values():
            if isinstance(frame, APIC):
                return frame.data
    except Exception:
        pass
    return None


def resize_image_bytes(data: bytes, max_dim: int) -> tuple[bytes, str]:
    """이미지가 max_dim보다 크면 비율을 유지해 축소하고 JPEG로 재인코딩한다.
    이미 그보다 작으면 원본 그대로 반환(불필요한 재인코딩 방지)."""
    with Image.open(BytesIO(data)) as img:
        if img.width <= max_dim and img.height <= max_dim:
            return data, img.get_format_mimetype() or "image/jpeg"
        img = img.convert("RGB")
        img.thumbnail((max_dim, max_dim), Image.LANCZOS)
        out = BytesIO()
        img.save(out, format="JPEG", quality=85)
        return out.getvalue(), "image/jpeg"


def write_tags(path: str, *, title: str, artist: str, album: str) -> None:
    suffix = Path(path).suffix.lower()
    if suffix == ".wav":
        audio = WAVE(path)
        if audio.tags is None:
            audio.add_tags()
        audio.tags.setall("TIT2", [TIT2(encoding=3, text=title)])
        audio.tags.setall("TPE1", [TPE1(encoding=3, text=artist)])
        audio.tags.setall("TALB", [TALB(encoding=3, text=album)])
        audio.save()
        return
    audio = MutagenFile(path, easy=True)
    if audio.tags is None:
        audio.add_tags()
    audio.tags["title"] = title
    audio.tags["artist"] = artist
    audio.tags["album"] = album
    audio.save()


def write_album_art(path: str, image_bytes: bytes, mime: str) -> None:
    suffix = Path(path).suffix.lower()
    if suffix == ".m4a":
        audio = MP4(path)
        fmt = MP4Cover.FORMAT_PNG if mime == "image/png" else MP4Cover.FORMAT_JPEG
        if audio.tags is None:
            audio.add_tags()
        audio.tags["covr"] = [MP4Cover(image_bytes, imageformat=fmt)]
        audio.save()
        return
    if suffix == ".wav":
        audio = WAVE(path)
        if audio.tags is None:
            audio.add_tags()
        tags = audio.tags
    else:
        try:
            tags = ID3(path)
        except ID3NoHeaderError:
            tags = ID3()
    tags.delall("APIC")
    tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=image_bytes))
    if suffix == ".wav":
        audio.save()
    else:
        tags.save(path)


@dataclass
class Track:
    path: str
    title: str = ""
    artist: str = ""  # 곡 아티스트(앨범 아티스트와 별개)
    album: str = ""
    album_id: str = ""
    duration_ms: int = 0
    rating: float = 0.0
    added_at: str = ""  # 라이브러리에 추가된 시각(ISO) — "최근 추가" 발견용, 과거 데이터엔 빈 문자열
    track_no: int = 0  # 앨범 내 트랙 번호(태그의 tracknumber) — 없으면 0

    @classmethod
    def from_file(cls, path: str) -> "Track":
        tags = read_tags(path)
        track = cls(path=str(path), **tags)
        track.album_id = albums_repo.get_or_create_album(track.album, track.artist).id
        track.added_at = datetime.now().isoformat(timespec="seconds")
        return track

    @property
    def has_lyrics(self) -> bool:
        return lyrics_io.find_lyrics_path(self.path) is not None

    def to_dict(self) -> dict:
        data = asdict(self)
        data["path"] = storage.to_relative_path(self.path)
        return data

    @classmethod
    def from_dict(cls, data: dict) -> "Track":
        return cls(
            path=storage.to_absolute_path(data["path"]),
            title=data.get("title", ""),
            artist=data.get("artist", ""),
            album=data.get("album", ""),
            album_id=data.get("album_id", ""),
            duration_ms=data.get("duration_ms", 0),
            rating=float(data.get("rating", 0) or 0),
            added_at=data.get("added_at", ""),
            track_no=int(data.get("track_no", 0) or 0),
        )


class PlaylistModel:
    """트랙 리스트 + 이름을 관리하고 JSON으로 저장/로드한다."""

    def __init__(self, name: str = GLOBAL_PLAYLIST_NAME):
        self.name = name
        self.tracks: list[Track] = []

    def add_file(self, path: str) -> Track:
        library_path = _copy_into_library(path)
        # library_path 파일명 자체가 내용 해시이므로, 경로 일치 여부만으로
        # 완전히 동일한 파일이 이미 추가돼 있는지 판단할 수 있다(재해싱 불필요).
        # 이 검사는 self(호출 대상 플레이리스트)의 트랙 목록만 기준으로 하므로,
        # add_file이 라이브러리(글로벌) 플레이리스트가 아닌 다른
        # 플레이리스트에서 직접 호출되면 그 플레이리스트 기준으로 중복이 판단된다.
        # 업로드처럼 add_file을 연속 호출할 때 매번 전체 목록을 훑지 않도록 경로
        # 집합을 캐시한다(트랙 목록 객체/길이가 달라졌으면 다시 만든다).
        paths = self._known_paths()
        if library_path in paths:
            raise ValueError("이미 라이브러리에 있는 파일입니다")
        track = Track.from_file(library_path)
        self.tracks.append(track)
        paths.add(track.path)
        self._paths_cache = (self.tracks, len(self.tracks), paths)
        return track

    def _known_paths(self) -> set[str]:
        cache = getattr(self, "_paths_cache", None)
        if cache is not None and cache[0] is self.tracks and cache[1] == len(self.tracks):
            return cache[2]
        paths = {t.path for t in self.tracks}
        self._paths_cache = (self.tracks, len(self.tracks), paths)
        return paths

    def remove(self, index: int) -> None:
        if 0 <= index < len(self.tracks):
            del self.tracks[index]

    def move(self, from_index: int, to_index: int) -> None:
        if not (0 <= from_index < len(self.tracks)):
            return
        track = self.tracks.pop(from_index)
        to_index = max(0, min(to_index, len(self.tracks)))
        self.tracks.insert(to_index, track)

    def reorder(self, track_ids: list[str]) -> None:
        """주어진 track_id 순서대로 트랙을 통째로 재배열한다(브라우즈의 곡/앨범
        목록처럼, 드래그로 만든 순서를 그룹 단위로 한 번에 반영해야 하는 경우용).
        track_ids는 현재 트랙 집합과 정확히 같은 id 집합이어야 한다."""
        by_id = {storage.path_hash(t.path): t for t in self.tracks}
        if len(track_ids) != len(self.tracks) or set(track_ids) != set(by_id.keys()):
            raise ValueError("잘못된 순서 목록입니다.")
        self.tracks = [by_id[tid] for tid in track_ids]

    def to_dict(self) -> dict:
        return {"name": self.name, "tracks": [t.to_dict() for t in self.tracks]}

    @classmethod
    def from_dict(cls, data: dict) -> "PlaylistModel":
        playlist = cls(name=data.get("name", "재생목록"))
        playlist.tracks = [Track.from_dict(t) for t in data.get("tracks", [])]
        return playlist

    def _slug(self) -> str:
        safe = "".join(c if c.isalnum() or c in "-_ " else "_" for c in self.name)
        return safe.strip() or "playlist"

    def save(self) -> Path:
        path = storage.playlists_dir() / f"{self._slug()}.json"
        storage.write_json_atomic(path, self.to_dict())
        _bump_save_generation()
        return path

    @classmethod
    def load(cls, path: Path) -> "PlaylistModel":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(data)

    @staticmethod
    def list_saved_with_data():
        """저장된 플레이리스트를 (이름, 경로, 파싱된 dict)로 하나씩 돌려준다(파일명
        정렬 순). 읽지 못한 파일은 로그만 남기고 건너뛴다. 호출자가 곧바로
        from_dict()로 쓸 수 있어 파일을 두 번 파싱하지 않아도 된다."""
        for path in sorted(storage.playlists_dir().glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                name = data.get("name", path.stem)
            except (json.JSONDecodeError, OSError) as exc:
                # 손상된 파일을 "없는 파일"로 조용히 취급하면 곧바로 빈 플레이리스트로
                # 덮어써지는 사고가 재발한다(글로벌 플레이리스트 유실 사고 참고).
                applog.log_error("PLAYLIST", f"플레이리스트 파일을 읽지 못했습니다: {path} ({exc})")
                continue
            yield name, path, data

    @staticmethod
    def list_saved_names() -> list[tuple[str, Path]]:
        return [(name, path) for name, path, _data in PlaylistModel.list_saved_with_data()]


@dataclass
class LyricLine:
    timestamp_ms: int
    text: str


class LyricTrack:
    """한 트랙에 대한 동기화 가사(LRC) 데이터."""

    def __init__(self, track_path: str, lines: Optional[list[LyricLine]] = None):
        self.track_path = track_path
        self.lines: list[LyricLine] = lines or []

    @classmethod
    def load_for_track(cls, track_path: str) -> "LyricTrack":
        raw = lyrics_io.load_lyrics(track_path)
        lines = [LyricLine(ms, text) for ms, text in raw]
        return cls(track_path, lines)

    def save(self) -> Optional[Path]:
        raw = [(line.timestamp_ms, line.text) for line in self.lines]
        return lyrics_io.save_lyrics(self.track_path, raw)
