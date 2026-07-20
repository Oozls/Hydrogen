"""Track / Playlist / Lyric 데이터 모델."""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from mutagen import File as MutagenFile
from mutagen.id3 import ID3, ID3NoHeaderError, APIC, TALB, TIT2, TPE1
from mutagen.mp4 import MP4, MP4Cover
from mutagen.wave import WAVE

from lyricstorage import lyrics_io, storage

GLOBAL_PLAYLIST_NAME = "기본 플레이리스트"
SUPPORTED_EXTENSIONS = (".mp3", ".wav", ".m4a")


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


def _read_tags(path: str) -> dict:
    title = Path(path).stem
    artist = ""
    album = ""
    duration_ms = 0
    try:
        # WAV엔 mutagen의 "easy" 태그 래퍼가 없어(File(easy=True)가 조용히 raw
        # WAVE를 반환) title/artist/album 이지키 읽기가 항상 실패하고 파일명으로
        # 폴백한다. raw ID3 프레임(TIT2/TPE1/TALB)으로 직접 읽어야 한다.
        if Path(path).suffix.lower() == ".wav":
            audio = WAVE(path)
            title = _wave_frame_text(audio.tags, "TIT2", title)
            artist = _wave_frame_text(audio.tags, "TPE1", artist)
            album = _wave_frame_text(audio.tags, "TALB", album)
            if audio.info is not None:
                duration_ms = int(audio.info.length * 1000)
        else:
            audio = MutagenFile(path, easy=True)
            if audio is not None:
                if audio.tags:
                    title = (audio.tags.get("title") or [title])[0]
                    artist = (audio.tags.get("artist") or [""])[0]
                    album = (audio.tags.get("album") or [""])[0]
                if audio.info is not None:
                    duration_ms = int(audio.info.length * 1000)
    except Exception:
        pass
    return {"title": title, "artist": artist, "album": album, "duration_ms": duration_ms}


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
    artist: str = ""
    album: str = ""
    duration_ms: int = 0

    @classmethod
    def from_file(cls, path: str) -> "Track":
        tags = _read_tags(path)
        return cls(path=str(path), **tags)

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
            duration_ms=data.get("duration_ms", 0),
        )


class PlaylistModel:
    """트랙 리스트 + 이름을 관리하고 JSON으로 저장/로드한다."""

    def __init__(self, name: str = GLOBAL_PLAYLIST_NAME):
        self.name = name
        self.tracks: list[Track] = []

    def add_file(self, path: str) -> Track:
        library_path = _copy_into_library(path)
        track = Track.from_file(library_path)
        self.tracks.append(track)
        return track

    def add_folder(self, folder: str) -> list[Track]:
        added: list[Track] = []
        found = [p for ext in SUPPORTED_EXTENSIONS for p in Path(folder).rglob(f"*{ext}")]
        for audio_path in sorted(found):
            added.append(self.add_file(str(audio_path)))
        return added

    def remove(self, index: int) -> None:
        if 0 <= index < len(self.tracks):
            del self.tracks[index]

    def move(self, from_index: int, to_index: int) -> None:
        if not (0 <= from_index < len(self.tracks)):
            return
        track = self.tracks.pop(from_index)
        to_index = max(0, min(to_index, len(self.tracks)))
        self.tracks.insert(to_index, track)

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
        path.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return path

    @classmethod
    def load(cls, path: Path) -> "PlaylistModel":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls.from_dict(data)

    @staticmethod
    def list_saved() -> list[Path]:
        return sorted(storage.playlists_dir().glob("*.json"))

    @staticmethod
    def list_saved_names() -> list[tuple[str, Path]]:
        result: list[tuple[str, Path]] = []
        for path in sorted(storage.playlists_dir().glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                result.append((data.get("name", path.stem), path))
            except (json.JSONDecodeError, OSError):
                continue
        return result


@dataclass
class LyricLine:
    timestamp_ms: int
    text: str


class LyricTrack:
    """한 트랙에 대한 동기화 가사 데이터. 라이브 캡처와 탭싱크가 공유한다."""

    def __init__(self, track_path: str, lines: Optional[list[LyricLine]] = None):
        self.track_path = track_path
        self.lines: list[LyricLine] = lines or []

    @classmethod
    def load_for_track(cls, track_path: str) -> "LyricTrack":
        raw = lyrics_io.load_lyrics(track_path)
        lines = [LyricLine(ms, text) for ms, text in raw]
        return cls(track_path, lines)

    def add_line(self, timestamp_ms: int, text: str) -> None:
        text = text.strip()
        if not text:
            return
        self.lines.append(LyricLine(timestamp_ms, text))
        self.lines.sort(key=lambda line: line.timestamp_ms)

    def clear(self) -> None:
        self.lines.clear()

    def save(self) -> Path:
        raw = [(line.timestamp_ms, line.text) for line in self.lines]
        return lyrics_io.save_lyrics(self.track_path, raw)

    def current_index(self, position_ms: int) -> int:
        """현재 재생 위치에 해당하는 줄 인덱스 (이진 탐색). 없으면 -1."""
        if not self.lines:
            return -1
        lo, hi, result = 0, len(self.lines) - 1, -1
        while lo <= hi:
            mid = (lo + hi) // 2
            if self.lines[mid].timestamp_ms <= position_ms:
                result = mid
                lo = mid + 1
            else:
                hi = mid - 1
        return result
