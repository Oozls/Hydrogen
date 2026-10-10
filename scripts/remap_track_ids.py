"""서버 이전 등으로 곡 ID(track_id) 계산 기준이 바뀐 뒤, 기존 재생 기록/추천 노출 기록의
옛 ID를 새 ID로 바꿔 다시 듣기·자동 플레이리스트가 재생 이력을 다시 인식하게 한다.

사용법 (프로젝트 루트에서):
  uv run python scripts/remap_track_ids.py                      # 미리보기(수정 안 함)
  uv run python scripts/remap_track_ids.py --old-root /home/me/app   # 옛 서버 프로젝트 경로를 알 때
  uv run python scripts/remap_track_ids.py --apply              # 실제 적용(data/ 백업 후)

옛 ID 매칭 순서: (1) 옛 서버 절대경로(--old-root) (2) 현재 서버 절대경로 (3) 제목/아티스트/앨범이
유일하게 일치하는 곡.
"""
import argparse
import json
import shutil
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lyricstorage import storage  # noqa: E402
from lyricstorage.web import playlist_repo  # noqa: E402


def build_mapping(old_root):
    tracks = playlist_repo.load_or_create_global().tracks
    new_ids = {}
    legacy = {}
    by_meta = {}
    for t in tracks:
        new_id = storage.path_hash(t.path)
        new_ids[new_id] = t
        rel = storage.to_relative_path(t.path)
        if not Path(rel).is_absolute():
            legacy[storage.legacy_path_hash(str(storage.PROJECT_ROOT / rel))] = new_id
            if old_root:
                legacy[storage.legacy_path_hash(f"{old_root.rstrip('/')}/{rel}")] = new_id
        by_meta.setdefault((t.title, t.artist, t.album), []).append(new_id)
    return new_ids, legacy, by_meta


def resolve(entry_id, entry, new_ids, legacy, by_meta):
    if entry_id in new_ids:
        return entry_id, "already-new"
    if entry_id in legacy:
        return legacy[entry_id], "path"
    cands = by_meta.get((entry.get("title"), entry.get("artist"), entry.get("album")), [])
    if len(cands) == 1:
        return cands[0], "meta"
    return None, "unmatched"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old-root", help="옛 서버의 프로젝트 절대경로 (예: /home/ubuntu/lyric-storage)")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    new_ids, legacy, by_meta = build_mapping(args.old_root)
    stats = Counter()

    hist_dir = storage.play_history_dir()
    rewrites = {}
    for f in sorted(hist_dir.glob("*.jsonl")):
        out = []
        changed = False
        for line in f.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                e = json.loads(line)
            except ValueError:
                out.append(line)
                continue
            new_id, how = resolve(e.get("track_id"), e, new_ids, legacy, by_meta)
            stats[how] += 1
            if new_id and new_id != e.get("track_id"):
                e["track_id"] = new_id
                changed = True
                line = json.dumps(e, ensure_ascii=False)
            out.append(line)
        if changed:
            rewrites[f] = "\n".join(out) + "\n"

    exp_path = storage.recommend_exposures_path()
    exp_new = None
    if exp_path.exists():
        exps = json.loads(exp_path.read_text(encoding="utf-8"))
        ex_changed = False
        for e in exps:
            new_id, how = resolve(e.get("track_id"), {}, new_ids, legacy, by_meta)
            stats["exposure-" + how] += 1
            if new_id and new_id != e.get("track_id"):
                e["track_id"] = new_id
                ex_changed = True
        if ex_changed:
            exp_new = exps

    print("결과:", dict(stats))
    print(f"수정될 재생 기록 파일: {len(rewrites)}개, 추천 노출 기록: {'수정' if exp_new else '변경 없음'}")
    if not args.apply:
        print("미리보기입니다. 적용하려면 --apply를 붙이세요.")
        return
    backup = storage.app_data_dir() / f"_backup_before_remap_{datetime.now():%Y%m%d_%H%M%S}"
    backup.mkdir()
    shutil.copytree(hist_dir, backup / "play_history")
    if exp_path.exists():
        shutil.copy2(exp_path, backup / exp_path.name)
    for f, text in rewrites.items():
        storage.write_text_atomic(f, text)
    if exp_new is not None:
        storage.write_json_atomic(exp_path, exp_new)
    print(f"적용 완료. 백업: {backup}")


if __name__ == "__main__":
    main()
