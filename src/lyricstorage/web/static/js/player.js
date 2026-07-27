// 데스크톱 player.py의 PlayerEngine(QMediaPlayer 래퍼)을 <audio> 기반으로 이식.
// 셔플/반복/이전-다음 계산 로직은 원본과 동일하게 유지한다.

const REPEAT_ORDER = ["off", "all", "one"];
// 다음 곡 종료 이 시간(초) 전부터 미리 다음 곡을 백그라운드로 불러 둔다.
// 모바일에서 트랙 전환 시점에 그제서야 네트워크 요청/디코더 초기화를 시작하면
// 초반 오디오가 씹히거나(특히 화면이 꺼져 백그라운드 상태일 때 네트워크가
// 느려지면) 전환 자체가 멎는 문제가 있어, 끝나기 전에 미리 준비해 둔다.
const PRELOAD_AHEAD_SEC = 15;

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
    // 우리 코드가 의도적으로 pause()를 호출한 경우에만 true로 두고, 그 밖의
    // 경우(모바일 OS가 백그라운드/오디오 포커스 상실 등으로 임의로 멈춘 경우)
    // 발생하는 pause 이벤트는 자동으로 재생을 재개해 "화면 꺼짐/다른 앱 사용 중
    // 재생이 멈추는" 문제를 완화한다.
    this._intentionalPause = true;

    // 다음 곡 미리 불러오기용 숨겨진 <audio>. { audio, index } 형태이며,
    // index는 그 엘리먼트에 로드해 둔 트랙이 playlist 상 몇 번째인지를 뜻한다.
    this._preloadAudio = null;
    this._preloadIndex = -1;

    this._bindAudioEvents(this.audio);
  }

  // 여러 <audio> 엘리먼트(현재 재생용 + 다음 곡 미리듣기용)에 동일한 이벤트
  // 배선을 재사용하기 위한 헬퍼. this.audio가 교체(gapless 전환)되어도 이미
  // 붙어있는 리스너가 계속 살아있으므로, 매 콜백에서 "지금 실제로 활성
  // 엘리먼트인지"를 확인해 아닌 경우(대기 중인 프리로드 엘리먼트, 막 물러난
  // 이전 엘리먼트)의 이벤트는 무시한다.
  _bindAudioEvents(audio) {
    audio.addEventListener("timeupdate", () => {
      if (audio !== this.audio) return;
      if (!this._seeking) this._emit("tick", { positionMs: this.position() });
      this._maybePreloadNext();
    });
    audio.addEventListener("durationchange", () => {
      if (audio !== this.audio) return;
      this._emit("durationchange", { durationMs: this.duration() });
    });
    audio.addEventListener("play", () => {
      if (audio !== this.audio) return;
      this._emit("playstate", { playing: true });
    });
    audio.addEventListener("pause", () => {
      if (audio !== this.audio) return;
      this._emit("playstate", { playing: false });
      if (!this._intentionalPause && !audio.ended && this.currentIndex >= 0) {
        audio.play().catch(() => {});
      }
    });
    audio.addEventListener("ended", () => {
      if (audio !== this.audio) return;
      this._onEnded();
    });
    // 트랙 전환 직후나 네트워크가 느릴 때 재생이 버퍼링으로 잠시 멎는 구간을
    // UI가 "로딩 중"으로 표시할 수 있도록 패스스루한다.
    audio.addEventListener("waiting", () => {
      if (audio !== this.audio) return;
      this._emit("buffering", { buffering: true });
    });
    audio.addEventListener("playing", () => {
      if (audio !== this.audio) return;
      this._emit("buffering", { buffering: false });
    });
    audio.addEventListener("canplay", () => {
      if (audio !== this.audio) return;
      this._emit("buffering", { buffering: false });
    });
  }

  _emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  // 완전히 다른 플레이리스트로 전환할 때 사용 (원본의 PlayerEngine.set_playlist와 동일하게
  // 재생 인덱스를 초기화한다).
  setPlaylist(playlist) {
    this.playlist = playlist;
    this.currentIndex = -1;
    this._resetPreload();
    this._rebuildShuffleOrder();
  }

  // 같은 플레이리스트가 업로드/삭제/추가/순서변경 등으로 갱신됐을 때 사용.
  // 재생 중이던 트랙이 여전히 있으면 새 배열에서의 인덱스로 다시 맞춰
  // 재생 상태(다음/이전 계산 기준)가 끊기지 않게 한다.
  syncTracks(playlist) {
    const playingTrackId = this.currentTrack ? this.currentTrack.track_id : null;
    this.playlist = playlist;
    this._resetPreload();
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
    this._resetPreload();
    if (enabled) this._rebuildShuffleOrder();
    this._emit("shufflechange", { shuffle: enabled });
  }

  cycleRepeat() {
    const idx = REPEAT_ORDER.indexOf(this.repeatMode);
    this.repeatMode = REPEAT_ORDER[(idx + 1) % REPEAT_ORDER.length];
    this._resetPreload();
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
    this._resetPreload();
    this.currentIndex = index;
    const track = this.playlist.tracks[index];
    this._intentionalPause = false;
    this.audio.src = `/api/tracks/${track.track_id}/audio`;
    this.audio.play().catch(() => {});
    this._emit("trackchange", { track, index });
  }

  togglePlayPause() {
    if (!this.audio.paused && !this.audio.ended) {
      this._intentionalPause = true;
      this.audio.pause();
    } else if (this.currentIndex >= 0) {
      this._intentionalPause = false;
      this.audio.play().catch(() => {});
    } else if (this.playlist && this.playlist.tracks.length) {
      this.playIndex(0);
    }
  }

  stop() {
    this._intentionalPause = true;
    this.audio.pause();
  }

  seek(ms) {
    if (Number.isFinite(this.audio.duration)) {
      this.audio.currentTime = Math.max(0, ms) / 1000;
    }
  }

  setSeeking(seeking) {
    this._seeking = seeking;
    this._emit("seeking", { seeking });
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
    if (index === null) {
      this.stop();
      return;
    }
    if (this._preloadIndex === index && this._preloadAudio) {
      this._swapToPreloaded(index);
    } else {
      this.playIndex(index);
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
      this._resetPreload();
      this.playIndex(this.currentIndex);
    } else {
      this.nextTrack();
    }
  }

  // 재생 중인 곡이 얼마 남지 않으면 다음 곡을 백그라운드 <audio>에 미리
  // 로드해 둔다. "one" 반복은 항상 같은 곡을 재시작하므로 대상이 아니다.
  _maybePreloadNext() {
    if (this.repeatMode === "one") return;
    const dur = this.audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    if (dur - this.audio.currentTime > PRELOAD_AHEAD_SEC) return;
    const nextIndex = this._computeNextIndex();
    if (nextIndex === null || nextIndex === this.currentIndex) return;
    if (this._preloadIndex === nextIndex) return;

    const track = this.playlist.tracks[nextIndex];
    const el = this._ensurePreloadElement();
    this._preloadIndex = nextIndex;
    el.src = `/api/tracks/${track.track_id}/audio`;
    el.load();
  }

  _ensurePreloadElement() {
    if (!this._preloadAudio) {
      const el = document.createElement("audio");
      el.preload = "auto";
      el.style.display = "none";
      document.body.appendChild(el);
      this._bindAudioEvents(el);
      this._preloadAudio = el;
    }
    return this._preloadAudio;
  }

  _resetPreload() {
    if (this._preloadAudio) {
      this._preloadAudio.pause();
      this._preloadAudio.removeAttribute("src");
      this._preloadAudio.load();
    }
    this._preloadIndex = -1;
  }

  // 미리 불러와 둔 다음 곡으로 즉시(콜드 스타트 없이) 전환한다. 기존 재생
  // 엘리먼트는 비워서 다음 프리로드 슬롯으로 재사용한다.
  _swapToPreloaded(index) {
    const promoted = this._preloadAudio;
    const demoted = this.audio;

    this._preloadAudio = demoted;
    this._preloadIndex = -1;
    demoted.pause();
    demoted.removeAttribute("src");
    demoted.load();

    promoted.volume = demoted.volume;
    promoted.style.display = "";
    demoted.style.display = "none";

    this.audio = promoted;
    this.currentIndex = index;
    const track = this.playlist.tracks[index];

    this._intentionalPause = false;
    promoted.play().catch(() => {});
    this._emit("trackchange", { track, index });
  }
}
