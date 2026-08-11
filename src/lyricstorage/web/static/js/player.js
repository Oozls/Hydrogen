// 데스크톱 player.py의 PlayerEngine(QMediaPlayer 래퍼)을 <audio> 기반으로 이식.
// 셔플/반복/이전-다음 계산 로직은 원본과 동일하게 유지한다.

const REPEAT_ORDER = ["off", "all", "one"];
// 다음 곡 종료 이 시간(초) 전부터 미리 다음 곡을 백그라운드로 불러 둔다.
// 모바일에서 트랙 전환 시점에 그제서야 네트워크 요청/디코더 초기화를 시작하면
// 초반 오디오가 씹히거나(특히 화면이 꺼져 백그라운드 상태일 때 네트워크가
// 느려지면) 전환 자체가 멎는 문제가 있어, 끝나기 전에 미리 준비해 둔다.
const PRELOAD_AHEAD_SEC = 15;
// 이 간격(초)마다 재생 중에도 currentTime을 스스로 재-seek해 디코더 위치
// 추적 오차를 보정한다.
const POSITION_RESYNC_INTERVAL_SEC = 20;

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
    // "list": 재생목록/앨범처럼 고정된 목록을 그대로 이어 재생. "recommend": 홈
    // 화면에서 시작한, queue.js가 계속 곡을 채워 넣는 라디오 형태의 대기 목록.
    this.queueMode = "list";
    this.shuffleOrder = [];
    this._seeking = false;
    // 우리 코드가 의도적으로 pause()를 호출한 경우에만 true로 두고, 그 밖의
    // 경우(모바일 OS가 백그라운드/오디오 포커스 상실 등으로 임의로 멈춘 경우)
    // 발생하는 pause 이벤트는 자동으로 재생을 재개해 "화면 꺼짐/다른 앱 사용 중
    // 재생이 멈추는" 문제를 완화한다.
    this._intentionalPause = true;
    // 일부 오디오 파일(특히 정확한 탐색 인덱스가 없는 VBR mp3)은 브라우저가
    // currentTime을 근사치로만 추적해, 정지 후 재생을 반복하면 실제 소리와
    // 표시되는 위치가 조금씩 어긋날 수 있다. 재생이 실제로 재개되는 시점마다
    // 같은 위치로 한 번 더 seek해 브라우저가 스스로를 다시 맞추도록 유도한다.
    this._needsResyncOnPlay = false;
    // 재생을 계속 이어가는 동안에도 VBR mp3 등에서 currentTime 추적이 조금씩
    // 어긋날 수 있어(_needsResyncOnPlay 설명 참고), 일정 간격마다 같은 위치로
    // 재-seek해 브라우저가 위치를 다시 정확히 맞추도록 한다. 재생 재개 시
    // 보정(_needsResyncOnPlay)은 정지 중 쌓인 오차만 잡아주므로 별개로 필요하다.
    this._lastPositionResyncSec = 0;
    // 새로 시작한 트랙이 실제로 소리가 나기 시작하는 시점(playing 이벤트)에
    // 0으로 한 번 더 seek해, 버퍼가 덜 찬 상태로 재생을 걸었을 때 브라우저가
    // 초반을 건너뛰는 경우를 바로잡는다. playIndex()/_swapToPreloaded()에서
    // 세팅한다.
    this._resetPositionOnPlay = false;
    // 가사 상세 편집(타이밍 태깅) 중에는 곡이 끝나도 다음 곡으로 자동
    // 전환되면 저장하지 않은 태깅 진행 상황이 날아가므로, 그 화면이 열려
    // 있는 동안은 이 플래그를 false로 두어 트랙 전환을 막는다.
    this.autoAdvance = true;

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
      if (!this._seeking) {
        this._emit("tick", { positionMs: this.position() });
        this._maybeResyncPosition(audio);
      }
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
      this._needsResyncOnPlay = true;
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
      if (this._resetPositionOnPlay) {
        this._resetPositionOnPlay = false;
        this.seek(0);
      } else if (this._needsResyncOnPlay) {
        this._needsResyncOnPlay = false;
        this.seek(this.position());
      }
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
  setPlaylist(playlist, { mode = "list" } = {}) {
    this.playlist = playlist;
    this.queueMode = mode;
    this.currentIndex = -1;
    this._resetPreload();
    this._rebuildShuffleOrder();
  }

  // 재생 대기 목록(큐) 끝에 추천 곡을 이어 붙인다 — queueMode가 "recommend"일 때
  // queue.js가 곡이 끝나거나 건너뛸 때마다 호출한다.
  appendTracks(tracks) {
    if (!this.playlist || !tracks || !tracks.length) return;
    this.playlist.tracks.push(...tracks);
    if (this.shuffle) this._rebuildShuffleOrder();
    this._maybePreloadNext();
    this._emit("queuechange", {});
  }

  // 추천 큐(라디오)로 들어갈 때 셔플/반복을 강제로 끈다 — 계속 늘어나는 목록에는
  // 두 개념이 맞지 않는다(무엇을 "반복"할지, 아직 없는 곡을 어떻게 "셔플"할지가
  // 불명확해진다).
  resetPlaybackModes() {
    if (this.shuffle) {
      this.shuffle = false;
      this._emit("shufflechange", { shuffle: false });
    }
    if (this.repeatMode !== "off") {
      this.repeatMode = "off";
      this._emit("repeatchange", { repeatMode: "off" });
    }
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

  // avoidFirstIndex를 주면, 새로 섞은 순서의 첫 곡이 그 인덱스와 겹칠 때 0번과
  // 1번을 맞바꿔 피한다 — 셔플+전곡반복으로 목록 끝에서 처음으로 되돌아갈 때,
  // 방금 끝난 마지막 곡이 곧바로 다시 나오지 않게 하는 용도.
  _rebuildShuffleOrder(avoidFirstIndex = null) {
    const count = this.playlist ? this.playlist.tracks.length : 0;
    const order = shuffledIndices(count);
    if (avoidFirstIndex !== null && count > 1 && order[0] === avoidFirstIndex) {
      [order[0], order[1]] = [order[1], order[0]];
    }
    this.shuffleOrder = order;
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
    this._resetPositionOnPlay = true;
    this._lastPositionResyncSec = 0;
    this._playWhenReady(this.audio);
    this._emit("trackchange", { track, index });
  }

  // 재생 버튼을 다시 누를 필요 없이 클릭 즉시 소리가 나도록, 버퍼 상태와
  // 무관하게 지금 바로 play()를 호출한다 — canplay를 기다렸다가 나중에
  // 호출하면, 그 사이 클릭(사용자 제스처) 컨텍스트가 만료돼 일부 환경
  // (느린 네트워크 등)에서는 자동재생 자체가 막혀버린다. 아직 버퍼가
  // 부족한 상태로 재생을 걸어 초반이 건너뛰어지는 문제는 _resetPositionOnPlay로
  // 실제로 소리가 나기 시작하는 시점에 0으로 재보정해서 막는다.
  _playWhenReady(audio) {
    audio.play().catch(() => {});
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
        this._rebuildShuffleOrder(this.currentIndex);
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
    if (!this.autoAdvance) return;
    if (this.repeatMode === "one") {
      this._resetPreload();
      this.playIndex(this.currentIndex);
    } else {
      this.nextTrack();
    }
  }

  _maybeResyncPosition(audio) {
    const now = audio.currentTime;
    if (now - this._lastPositionResyncSec < POSITION_RESYNC_INTERVAL_SEC) return;
    this._lastPositionResyncSec = now;
    this.seek(this.position());
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
    this._resetPositionOnPlay = true;
    this._lastPositionResyncSec = 0;
    this._playWhenReady(promoted);
    this._emit("trackchange", { track, index });
    // promoted는 프리로드 단계에서 이미 durationchange가 한 번 발생했지만 그때는
    // this.audio가 아니어서 무시됐다. 지금 this.audio로 승격됐다는 사실만으로는
    // 네이티브 durationchange가 다시 발생하지 않으므로, 재생바 길이 표시가
    // 새 트랙 값으로 갱신되도록 수동으로 다시 emit한다.
    this._emit("durationchange", { durationMs: this.duration() });
  }
}
