// 데스크톱 player.py의 PlayerEngine(QMediaPlayer 래퍼)을 <audio> 기반으로 이식.
// 셔플/반복/이전-다음 계산 로직은 원본과 동일하게 유지한다.

const REPEAT_ORDER = ["off", "all", "one"];

function shuffledIndices(count) {
  const arr = Array.from({ length: count }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class PlayerEngine extends EventTarget {
  constructor(audioEl) {
    super();
    this.audio = audioEl;
    this.playlist = null; // { name, tracks: [...] }
    this.currentIndex = -1;
    this.repeatMode = "off"; // off | all | one
    this.shuffle = false;
    this.shuffleOrder = [];
    this._seeking = false;

    this.audio.addEventListener("timeupdate", () => {
      if (!this._seeking) this._emit("tick", { positionMs: this.position() });
    });
    this.audio.addEventListener("durationchange", () => {
      this._emit("durationchange", { durationMs: this.duration() });
    });
    this.audio.addEventListener("play", () => this._emit("playstate", { playing: true }));
    this.audio.addEventListener("pause", () => this._emit("playstate", { playing: false }));
    this.audio.addEventListener("ended", () => this._onEnded());
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  // 완전히 다른 플레이리스트로 전환할 때 사용 (원본의 PlayerEngine.set_playlist와 동일하게
  // 재생 인덱스를 초기화한다).
  setPlaylist(playlist) {
    this.playlist = playlist;
    this.currentIndex = -1;
    this._rebuildShuffleOrder();
  }

  // 같은 플레이리스트가 업로드/삭제/추가/순서변경 등으로 갱신됐을 때 사용.
  // 재생 중이던 트랙이 여전히 있으면 새 배열에서의 인덱스로 다시 맞춰
  // 재생 상태(다음/이전 계산 기준)가 끊기지 않게 한다.
  syncTracks(playlist) {
    const playingTrackId = this.currentTrack ? this.currentTrack.track_id : null;
    this.playlist = playlist;
    this._rebuildShuffleOrder();
    if (playingTrackId) {
      this.currentIndex = playlist.tracks.findIndex((t) => t.track_id === playingTrackId);
    }
  }

  _rebuildShuffleOrder() {
    const count = this.playlist ? this.playlist.tracks.length : 0;
    this.shuffleOrder = shuffledIndices(count);
  }

  setShuffle(enabled) {
    this.shuffle = enabled;
    if (enabled) this._rebuildShuffleOrder();
    this._emit("shufflechange", { shuffle: enabled });
  }

  cycleRepeat() {
    const idx = REPEAT_ORDER.indexOf(this.repeatMode);
    this.repeatMode = REPEAT_ORDER[(idx + 1) % REPEAT_ORDER.length];
    this._emit("repeatchange", { repeatMode: this.repeatMode });
    return this.repeatMode;
  }

  get currentTrack() {
    if (this.playlist && this.currentIndex >= 0 && this.currentIndex < this.playlist.tracks.length) {
      return this.playlist.tracks[this.currentIndex];
    }
    return null;
  }

  playIndex(index) {
    if (!this.playlist || index < 0 || index >= this.playlist.tracks.length) return;
    this.currentIndex = index;
    const track = this.playlist.tracks[index];
    this.audio.src = `/api/tracks/${track.track_id}/audio`;
    this.audio.play().catch(() => {});
    this._emit("trackchange", { track, index });
  }

  togglePlayPause() {
    if (!this.audio.paused && !this.audio.ended) {
      this.audio.pause();
    } else if (this.currentIndex >= 0) {
      this.audio.play().catch(() => {});
    } else if (this.playlist && this.playlist.tracks.length) {
      this.playIndex(0);
    }
  }

  stop() {
    this.audio.pause();
  }

  seek(ms) {
    if (Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.max(0, ms) / 1000;
    }
  }

  setSeeking(seeking) {
    this._seeking = seeking;
  }

  setVolume(v) {
    this.audio.volume = Math.max(0, Math.min(100, v)) / 100;
  }

  volume() {
    return Math.round(this.audio.volume * 100);
  }

  position() {
    return Math.round((this.audio.currentTime || 0) * 1000);
  }

  duration() {
    return Math.round((this.audio.duration || 0) * 1000);
  }

  isPlaying() {
    return !this.audio.paused && !this.audio.ended;
  }

  // 3초 넘게 재생된 상태라면 이전 곡 대신 현재 곡을 재시작한다.
  previousTrack() {
    if (!this.playlist || !this.playlist.tracks.length) return;
    if (this.position() > 3000) {
      this.seek(0);
      return;
    }
    const count = this.playlist.tracks.length;
    if (this.shuffle && this.shuffleOrder.length) {
      const pos = this.shuffleOrder.indexOf(this.currentIndex);
      const prevPos = (pos - 1 + this.shuffleOrder.length) % this.shuffleOrder.length;
      this.playIndex(this.shuffleOrder[prevPos]);
    } else {
      this.playIndex((this.currentIndex - 1 + count) % count);
    }
  }

  nextTrack() {
    const index = this._computeNextIndex();
    if (index !== null) {
      this.playIndex(index);
    } else {
      this.stop();
    }
  }

  _computeNextIndex() {
    if (!this.playlist || !this.playlist.tracks.length) return null;
    const count = this.playlist.tracks.length;
    if (this.shuffle && this.shuffleOrder.length) {
      const pos = this.shuffleOrder.indexOf(this.currentIndex);
      let nextPos = pos + 1;
      if (nextPos >= count) {
        if (this.repeatMode !== "all") return null;
        this._rebuildShuffleOrder();
        nextPos = 0;
      }
      return this.shuffleOrder[nextPos];
    }
    const nextIndex = this.currentIndex + 1;
    if (nextIndex >= count) {
      return this.repeatMode === "all" ? 0 : null;
    }
    return nextIndex;
  }

  _onEnded() {
    this._emit("ended", {});
    if (this.repeatMode === "one") {
      this.playIndex(this.currentIndex);
    } else {
      this.nextTrack();
    }
  }
}
