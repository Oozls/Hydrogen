"""m4a(AAC-LC)를 재인코딩 없이 fragmented MP4(초기화 세그먼트 + moof/mdat 1개)로 다시 묶는다.

브라우저 MSE(MediaSource)는 일반 m4a를 받지 않고 fMP4만 받는다. 프런트가 여러 곡을
하나의 SourceBuffer에 이어 붙여(곡 경계에서 <audio>가 끝나지 않게) 재생하려고 쓴다.
ffmpeg 같은 외부 도구 없이 표준 라이브러리만으로 동작한다. AAC-LC가 아니거나(ALAC 등)
구조를 해석할 수 없으면 Unsupported를 던지고, 호출부는 일반 재생으로 폴백한다.
"""

from __future__ import annotations

import struct
from pathlib import Path

CODEC_MIME = 'audio/mp4; codecs="mp4a.40.2"'


class Unsupported(Exception):
    pass


def _boxes(buf: bytes, start: int, end: int):
    """(type, payload_start, box_end) 순회."""
    pos = start
    while pos + 8 <= end:
        size, typ = struct.unpack_from(">I4s", buf, pos)
        header = 8
        if size == 1:
            size = struct.unpack_from(">Q", buf, pos + 8)[0]
            header = 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            raise Unsupported("broken box")
        yield typ, pos + header, pos + size
        pos += size


def _find(buf: bytes, start: int, end: int, typ: bytes):
    for t, ps, pe in _boxes(buf, start, end):
        if t == typ:
            return ps, pe
    raise Unsupported(f"missing {typ!r}")


def _box(typ: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), typ) + payload


def _full(typ: bytes, payload: bytes, version: int = 0, flags: int = 0) -> bytes:
    return _box(typ, struct.pack(">I", (version << 24) | flags) + payload)


def _read_desc_len(buf: bytes, pos: int) -> tuple[int, int]:
    length = 0
    for _ in range(4):
        b = buf[pos]
        pos += 1
        length = (length << 7) | (b & 0x7F)
        if not b & 0x80:
            break
    return length, pos


def _audio_object_type(stsd: bytes) -> int:
    """esds의 DecoderSpecificInfo 첫 5비트(audioObjectType)."""
    i = stsd.find(b"esds")
    if i < 0:
        raise Unsupported("no esds")
    pos = i + 4 + 4  # 'esds' + version/flags
    if stsd[pos] != 0x03:
        raise Unsupported("bad ES descriptor")
    _, pos = _read_desc_len(stsd, pos + 1)
    pos += 3  # ES_ID(2) + flags(1) — 우선순위/URL 플래그가 있으면 이후 파싱이 어긋나 Unsupported로 빠진다
    if stsd[pos] != 0x04:
        raise Unsupported("bad DecoderConfig")
    _, pos = _read_desc_len(stsd, pos + 1)
    pos += 13  # objectType(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
    if stsd[pos] != 0x05:
        raise Unsupported("bad DecoderSpecificInfo")
    _, pos = _read_desc_len(stsd, pos + 1)
    return stsd[pos] >> 3


def _zero_duration(payload: bytes, v0_off: int, v1_off: int) -> bytes:
    """mvhd/tkhd/mdhd의 duration 필드를 0으로 만든다(조각 재생에서는 의미 없음)."""
    version = payload[0]
    b = bytearray(payload)
    if version == 0:
        b[v0_off : v0_off + 4] = b"\0\0\0\0"
    else:
        b[v1_off : v1_off + 8] = b"\0" * 8
    return bytes(b)


def remux(path: str | Path) -> bytes:
    """m4a 파일 -> fMP4 바이트(init 세그먼트 + 전체 샘플을 담은 조각 1개)."""
    buf = Path(path).read_bytes()
    try:
        return _remux(buf)
    except (struct.error, IndexError) as exc:
        raise Unsupported(f"parse error: {exc}") from exc


def _remux(buf: bytes) -> bytes:
    moov_s, moov_e = _find(buf, 0, len(buf), b"moov")
    mvhd_s, mvhd_e = _find(buf, moov_s, moov_e, b"mvhd")

    trak = None
    for t, ps, pe in _boxes(buf, moov_s, moov_e):
        if t != b"trak":
            continue
        mdia_s, mdia_e = _find(buf, ps, pe, b"mdia")
        hdlr_s, hdlr_e = _find(buf, mdia_s, mdia_e, b"hdlr")
        if buf[hdlr_s + 8 : hdlr_s + 12] == b"soun":
            trak = (ps, pe, mdia_s, mdia_e, hdlr_s, hdlr_e)
            break
    if trak is None:
        raise Unsupported("no audio track")
    trak_s, trak_e, mdia_s, mdia_e, hdlr_s, hdlr_e = trak

    tkhd_s, tkhd_e = _find(buf, trak_s, trak_e, b"tkhd")
    mdhd_s, mdhd_e = _find(buf, mdia_s, mdia_e, b"mdhd")
    minf_s, minf_e = _find(buf, mdia_s, mdia_e, b"minf")
    smhd_s, smhd_e = _find(buf, minf_s, minf_e, b"smhd")
    dinf_s, dinf_e = _find(buf, minf_s, minf_e, b"dinf")
    stbl_s, stbl_e = _find(buf, minf_s, minf_e, b"stbl")
    stsd_s, stsd_e = _find(buf, stbl_s, stbl_e, b"stsd")
    stts_s, stts_e = _find(buf, stbl_s, stbl_e, b"stts")
    stsc_s, stsc_e = _find(buf, stbl_s, stbl_e, b"stsc")
    stsz_s, stsz_e = _find(buf, stbl_s, stbl_e, b"stsz")

    stsd = bytes(buf[stsd_s:stsd_e])
    if stsd[12:16] != b"mp4a":  # version/flags(4) + entry_count(4) + entry size(4) 다음이 형식
        raise Unsupported("not mp4a")
    if _audio_object_type(stsd) != 2:
        raise Unsupported("not AAC-LC")

    chunk_offsets: list[int]
    try:
        co_s, co_e = _find(buf, stbl_s, stbl_e, b"stco")
        n = struct.unpack_from(">I", buf, co_s + 4)[0]
        chunk_offsets = list(struct.unpack_from(f">{n}I", buf, co_s + 8))
    except Unsupported:
        co_s, co_e = _find(buf, stbl_s, stbl_e, b"co64")
        n = struct.unpack_from(">I", buf, co_s + 4)[0]
        chunk_offsets = list(struct.unpack_from(f">{n}Q", buf, co_s + 8))

    # 샘플 크기
    sample_size, count = struct.unpack_from(">II", buf, stsz_s + 4)
    if sample_size:
        sizes = [sample_size] * count
    else:
        sizes = list(struct.unpack_from(f">{count}I", buf, stsz_s + 12))

    # 샘플 길이(stts 런렝스 확장)
    n = struct.unpack_from(">I", buf, stts_s + 4)[0]
    durations: list[int] = []
    for i in range(n):
        c, d = struct.unpack_from(">II", buf, stts_s + 8 + i * 8)
        durations.extend([d] * c)
    if len(durations) != count:
        raise Unsupported("stts/stsz mismatch")

    # 샘플 -> 파일 오프셋(stsc로 청크별 샘플 수 확장)
    n = struct.unpack_from(">I", buf, stsc_s + 4)[0]
    stsc = [struct.unpack_from(">III", buf, stsc_s + 8 + i * 12) for i in range(n)]
    data = bytearray()
    sample = 0
    for ci, off in enumerate(chunk_offsets):
        per_chunk = 0
        for first_chunk, spc, _desc in stsc:
            if first_chunk <= ci + 1:
                per_chunk = spc
            else:
                break
        for _ in range(per_chunk):
            if sample >= count:
                break
            size = sizes[sample]
            if off + size > len(buf):
                raise Unsupported("sample out of range")
            data += buf[off : off + size]
            off += size
            sample += 1
    if sample != count:
        raise Unsupported("sample count mismatch")

    tkhd = bytes(buf[tkhd_s:tkhd_e])
    track_id = struct.unpack_from(">I", tkhd, 12 if tkhd[0] == 0 else 20)[0]

    def empty_stbl() -> bytes:
        return _box(
            b"stbl",
            _box(b"stsd", stsd)
            + _full(b"stts", struct.pack(">I", 0))
            + _full(b"stsc", struct.pack(">I", 0))
            + _full(b"stsz", struct.pack(">II", 0, 0))
            + _full(b"stco", struct.pack(">I", 0)),
        )

    minf = _box(
        b"minf",
        _box(b"smhd", bytes(buf[smhd_s:smhd_e])) + _box(b"dinf", bytes(buf[dinf_s:dinf_e])) + empty_stbl(),
    )
    mdia = _box(
        b"mdia",
        _box(b"mdhd", _zero_duration(bytes(buf[mdhd_s:mdhd_e]), 16, 24))
        + _box(b"hdlr", bytes(buf[hdlr_s:hdlr_e]))
        + minf,
    )
    trak_box = _box(b"trak", _box(b"tkhd", _zero_duration(tkhd, 20, 28)) + mdia)
    trex = _full(b"trex", struct.pack(">IIIII", track_id, 1, 0, 0, 0))
    moov = _box(
        b"moov",
        _box(b"mvhd", _zero_duration(bytes(buf[mvhd_s:mvhd_e]), 16, 24)) + trak_box + _box(b"mvex", trex),
    )
    ftyp = _box(b"ftyp", b"iso5" + struct.pack(">I", 512) + b"iso5iso6mp41")

    # 조각: sample_count + data_offset + (duration, size) 반복
    trun_len = 8 + 4 + 4 + 4 + 8 * count
    tfhd = _full(b"tfhd", struct.pack(">I", track_id), flags=0x020000)  # default-base-is-moof
    tfdt = _full(b"tfdt", struct.pack(">Q", 0), version=1)
    traf_len = 8 + len(tfhd) + len(tfdt) + trun_len
    mfhd = _full(b"mfhd", struct.pack(">I", 1))
    moof_len = 8 + len(mfhd) + traf_len
    entries = b"".join(struct.pack(">II", d, s) for d, s in zip(durations, sizes))
    trun = _full(b"trun", struct.pack(">Ii", count, moof_len + 8) + entries, flags=0x000301)
    moof = _box(b"moof", mfhd + _box(b"traf", tfhd + tfdt + trun))
    assert len(moof) == moof_len
    mdat = struct.pack(">I4s", 8 + len(data), b"mdat") + bytes(data)
    return ftyp + moov + moof + mdat
