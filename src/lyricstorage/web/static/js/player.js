// 데스크톱 player.py의 PlayerEngine(QMediaPlayer 래퍼)을 <audio> 기반으로 이식.
// 셔플/반복/이전-다음 계산 로직은 원본과 동일하게 유지한다.

import { GaplessStream, gaplessSupported } from "./gaplessStream.js";

const REPEAT_ORDER = ["off", "all", "one"];
// 다음 곡 추가(append)가 실패했을 때 다시 시도하기까지 기다리는 시간(ms).
const STREAM_RETRY_MS = 3000;
// 다음 곡을 SourceBuffer에 실제로 붙이는 시점 — 현재 곡이 끝나기 이 시간(초) 전.
// 곡 전체를 미리 붙여 두면 브라우저의 SourceBuffer 용량 한도(크롬은 오디오 약 12MB)를
// 넘기므로, 내려받기는 미리 해 두되(메모리) 붙이기는 끝이 가까워진 뒤에 한다.
const STREAM_APPEND_LEAD_SEC = 45;
// 다음 곡 종료 이 시간(초) 전부터 미리 다음 곡을 백그라운드로 불러 둔다 —
// 연결이 넉넉해서 다운로드가 재생 속도를 따라잡고 있을 때 쓰는 기본 여유분
// (디코더 초기화 등). 연결이 느려 다운로드가 재생을 못 따라가는 중이면
// _estimatedPreloadLeadSec가 실측 배속을 기반으로 이보다 훨씬 이른 시점을
// 계산해 대신 쓴다.
const PRELOAD_MIN_SEC = 15;
// 재생 시작 후 이 시간(초)이 지난 첫 timeupdate에서, 딱 한 번만 currentTime을
// 스스로에게 재-seek해 디코더 위치 추적 오차를 보정한다(그 뒤로는 반복하지
// 않는다 — 재생 중 계속 반복하면 매번 실제 seek이 걸려 끊김이 들린다). 너무
// 늦게 하면(예전 2초) 한창 듣고 있는 도중 눈에 띄게 끊기므로, 값을 0에
// 가깝게 둬서 "실제 디코딩이 시작된 뒤 첫 timeupdate" 시점에 최대한 앞당긴다
// — 그 시점엔 아직 곡 초반이라 재-seek이 나도 거의 안 들린다.
const INITIAL_RESYNC_AFTER_SEC = 0;
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
    // 일부 오디오 파일(특히 정확한 탐색 인덱스가 없는 VBR mp3)은 브라우저가
    // currentTime을 근사치로만 추적해, 정지 후 재생을 반복하면 실제 소리와
    // 표시되는 위치가 조금씩 어긋날 수 있다. 재생이 실제로 재개되는 시점마다
    // 같은 위치로 한 번 더 seek해 브라우저가 스스로를 다시 맞추도록 유도한다.
    this._needsResyncOnPlay = false;
    // 새로 시작한 트랙이 실제로 소리가 나기 시작하는 시점(playing 이벤트)에
    // 0으로 한 번 더 seek해, 버퍼가 덜 찬 상태로 재생을 걸었을 때 브라우저가
    // 초반을 건너뛰는 경우를 바로잡는다. playIndex()에서
    // 세팅한다.
    this._resetPositionOnPlay = false;
    // 새 트랙이 시작될 때마다 true로 세팅되고, 재생이 INITIAL_RESYNC_AFTER_SEC초
    // 지난 시점에 한 번 자기 자신에게 재-seek해 VBR mp3 등의 currentTime 위치
    // 추적 오차를 보정한 뒤 false로 되돌린다. 트랙당 딱 한 번만 실행된다.
    this._needsInitialResync = false;
    // 가사 상세 편집(타이밍 태깅) 중에는 곡이 끝나도 다음 곡으로 자동
    // 전환되면 저장하지 않은 태깅 진행 상황이 날아가므로, 그 화면이 열려
    // 있는 동안은 이 플래그를 false로 두어 트랙 전환을 막는다.
    this.autoAdvance = true;

    // 다음 곡 미리 불러오기용 숨겨진 <audio>. { audio, index } 형태이며,
    // index는 그 엘리먼트에 로드해 둔 트랙이 playlist 상 몇 번째인지를 뜻한다.
    // 다음 곡을 미리 통째로 받아 둔 Blob URL: { index, url, controller, failed }.
    // 별도 <audio>로 미리 틀지 않고 같은 엘리먼트의 src만 바꾸므로, 화면이 꺼진
    // 상태에서도 다음 곡이 네트워크 대기 없이(이미 메모리에 있음) 바로 시작된다.
    this._prefetch = null;
    this._currentBlobUrl = null;
    // 현재 곡 재생이 시작된 시각(performance.now()) — 다운로드가 실제로
    // 재생 속도를 따라잡고 있는지(버퍼링된 초 / 경과한 실제 초) 재는 기준점.
    this._trackStartWallMs = null;
    // playIndex()로 새 곡을 시작한 뒤 아직 한 번도 실제 재생(playing 이벤트)에 도달하지
    // 못한 동안 true. 화면이 꺼진 채 곡이 넘어갈 때 iOS가 백그라운드 play()를 거부하거나
    // 로드 도중 페이지를 정지시키면 이 상태로 남는다 — 사용자가 화면을 다시 켰을 때
    // (visible/pageshow) 이 플래그로 "시작하다 만 곡"만 골라 다시 시도한다.
    this._pendingStart = false;

    // 연속 스트림(MSE) 재생 세션: { gs, segs: [{index,start,end}], cur, filling, ... }.
    // 활성 중에는 곡이 바뀌어도 <audio>가 ended되지 않는다(iOS 백그라운드 전환 문제 회피).
    this._stream = null;
    // MSE 재생이 한 번이라도 실패하면 이 페이지 세션에서는 기존 방식(곡마다 src 교체)으로 돌린다.
    this._streamDisabled = false;
    // 서버가 fMP4로 못 묶는 곡(ALAC 등, 415) — 이 곡은 일반 재생으로만 돌린다.
    this._noStreamIds = new Set();

    // iOS 16.4+: 재생을 "미디어 재생"으로 분류해 무음 스위치/백그라운드에서 세션이 덜 끊기게 한다.
    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback";
    } catch {
      /* 미지원 환경 */
    }

    this._bindAudioEvents(this.audio);
    document.addEventListener("visibilitychange", () => {
      this._log(`visibility -> ${document.visibilityState}`);
      this._recoverIfStuck();
    });
    window.addEventListener("pageshow", () => this._recoverIfStuck());
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
        if (this._needsInitialResync && audio.currentTime >= INITIAL_RESYNC_AFTER_SEC) {
          this._needsInitialResync = false;
          // 화면이 꺼진 상태의 곡 전환에서는 seek가 waiting/Range 재요청을 일으켜
          // iOS가 페이지를 정지시키기 전의 짧은 실행 시간을 갉아먹는다 — 생략한다.
          if (!document.hidden) this.seek(this.position());
        }
      }
      if (this._stream) this._streamTick();
      else this._maybePreloadNext();
    });
    // MSE 파이프라인이 디코드/로드 오류를 내면 기존 재생 방식으로 되돌려 곡을 이어간다.
    audio.addEventListener("error", () => {
      if (audio !== this.audio || !this._stream) return;
      this._log("audio error in stream mode, falling back");
      this._streamFallback();
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
      // OS가 전화/Siri/이어폰 분리/잠금화면 조작 등으로 멈춘 경우에도 되살리지 않는다 —
      // 예전엔 의도치 않은 pause를 자동 재개해, 기기는 정지로 인식하는데 소리는
      // 계속 나는 불일치가 생겼다. 항상 실제 상태를 그대로 UI/미디어 세션에 반영한다.
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
      this._pendingStart = false;
      this._emit("playstate", { playing: true });
      this._emit("buffering", { buffering: false });
      // 화면이 꺼져 있거나(위와 같은 이유), 곡 전체가 이미 메모리에 있는 Blob이면
      // (버퍼 부족으로 초반을 건너뛸 일이 없다) 보정 seek를 하지 않는다.
      const skipSeek = document.hidden;
      if (this._resetPositionOnPlay) {
        this._resetPositionOnPlay = false;
        if (!skipSeek && !this._currentBlobUrl) this.seek(0);
      } else if (this._needsResyncOnPlay) {
        this._needsResyncOnPlay = false;
        if (!skipSeek && !this._stream) this.seek(this.position());
      }
    });
    audio.addEventListener("canplay", () => {
      if (audio !== this.audio) return;
      this._emit("buffering", { buffering: false });
    });
    // 브라우저가 데이터를 내려받을 때마다(스펙상 다운로드 중 주기적으로) 발생 —
    // 재생바에 "어디까지 미리 받아졌는지" 표시하는 용도.
    audio.addEventListener("progress", () => {
      if (audio !== this.audio) return;
      this._emit("buffered", { bufferedMs: this.bufferedMs() });
    });
  }

  // 화면을 다시 켰을 때(visible/pageshow) 새 곡 시작이 도중에 끊긴 상태면 다시 시도한다.
  // 예전에는 waiting이 8초 넘게 이어지면 pause()로 강제 정지시켰지만, 정지된 페이지에서는
  // 그 타이머가 돌지 않아 "재생 중인데 소리 없음"을 못 잡았고, 돌 때는 복구 없이 재생을
  // 확정적으로 멈출 뿐이었다. 사용자가 직접 멈춘 곡과 구분하기 위해 _pendingStart를 쓴다.
  _recoverIfStuck() {
    if (document.hidden || !this.currentTrack) return;
    if (this._stream) {
      // 스트림 모드: 다음 곡 추가가 멈춰 있었다면(백그라운드에서 fetch 중단 등) 바로 재시도한다.
      this._stream.retryAt = 0;
      this._streamFillAhead(this._stream);
      if (!this._pendingStart) return;
      if (!this.audio.paused && this.audio.readyState >= 3) return;
      // 시작하다 만 스트림은 MediaSource가 붙은 채 load()하면 깨지므로 처음부터 다시 연다.
      this._log("recover stuck start (stream)");
      this._teardownStream();
      this.playIndex(this.currentIndex);
      return;
    }
    if (!this._pendingStart) return;
    if (!this.audio.paused && this.audio.readyState >= 3) return;
    this._log("recover stuck start");
    this.audio.load();
    this._tryPlay(this.audio);
  }

  // 지금 재생 위치가 속한 버퍼 구간의 끝(ms) — 그 구간에 없으면(탐색 등)
  // 마지막 버퍼 구간의 끝을 대신 쓴다.
  bufferedMs() {
    const buffered = this.audio.buffered;
    if (!buffered.length) return 0;
    const t = this.audio.currentTime;
    if (this._stream) {
      // 스트림은 여러 곡이 한 타임라인에 있으므로 현재 곡 구간 안으로 잘라 보여 준다.
      const seg = this._segAt(t);
      if (!seg) return 0;
      const end = Math.min(buffered.end(buffered.length - 1), seg.end);
      return Math.max(0, Math.round((end - seg.start) * 1000));
    }
    for (let i = 0; i < buffered.length; i++) {
      if (t <= buffered.end(i)) return Math.round(buffered.end(i) * 1000);
    }
    return Math.round(buffered.end(buffered.length - 1) * 1000);
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
    this._streamInvalidateAhead();
  }

  // 재생 대기 목록(큐) 끝에 추천 곡을 이어 붙인다 — queueMode가 "recommend"일 때
  // queue.js가 곡이 끝나거나 건너뛸 때마다 호출한다.
  appendTracks(tracks) {
    if (!this.playlist || !tracks || !tracks.length) return;
    this.playlist.tracks.push(...tracks);
    if (this.shuffle) this._rebuildShuffleOrder();
    if (this._stream) {
      // 마지막 곡이라 스트림을 닫아 뒀더라도 새로 생긴 다음 곡을 다시 이어 붙인다.
      // 셔플 순서가 다시 짜였다면 이미 붙여 둔 다음 곡도 달라질 수 있어 함께 갱신한다.
      if (this.shuffle) this._streamInvalidateAhead();
      else {
        this._stream.eos = false;
        this._streamFillAhead(this._stream);
      }
    } else {
      this._maybePreloadNext();
    }
    this._emit("queuechange", {});
  }

  // 같은 플레이리스트가 업로드/삭제/추가/순서변경 등으로 갱신됐을 때 사용.
  // 재생 중이던 트랙이 여전히 있으면 새 배열에서의 인덱스로 다시 맞춰
  // 재생 상태(다음/이전 계산 기준)가 끊기지 않게 한다.
  syncTracks(playlist) {
    const playingTrackId = this.currentTrack ? this.currentTrack.track_id : null;
    this.playlist = playlist;
    // syncTracks는 고정된(사이드바) 재생목록에만 쓰인다 — 이전에 홈 화면
    // 추천 큐(queueMode "recommend")를 듣고 있다가 여기로 넘어온 경우에도
    // 셔플/반복 버튼이 계속 비활성 상태로 남지 않도록 "list"로 되돌린다.
    this.queueMode = "list";
    this._resetPreload();
    this._rebuildShuffleOrder();
    if (playingTrackId) {
      this.currentIndex = playlist.tracks.findIndex((t) => t.track_id === playingTrackId);
    }
    this._streamInvalidateAhead();
  }

  // avoidFirstIndex를 주면, 새로 섞은 순서의 첫 곡이 그 인덱스와 겹칠 때 0번과
  // 1번을 맞바꿔 피한다 — 셔플+전곡반복으로 목록 끝에서 처음으로 되돌아갈 때,
  // 방금 끝난 마지막 곡이 곧바로 다시 나오지 않게 하는 용도.
  _rebuildShuffleOrder(avoidFirstIndex = null, pinFirstIndex = null) {
    const count = this.playlist ? this.playlist.tracks.length : 0;
    if (pinFirstIndex !== null && pinFirstIndex >= 0) {
      const rest = shuffledIndices(count).filter((i) => i !== pinFirstIndex);
      this.shuffleOrder = [pinFirstIndex, ...rest];
      return;
    }
    const order = shuffledIndices(count);
    if (avoidFirstIndex !== null && count > 1 && order[0] === avoidFirstIndex) {
      [order[0], order[1]] = [order[1], order[0]];
    }
    this.shuffleOrder = order;
  }

  // 셔플을 켜는 순간에는 지금 재생 중이던 곡을 그대로 새 순서의 첫 곡으로 고정하고
  // 나머지만 섞는다 — 꺼졌다 켜졌을 뿐인데 지금 듣던 곡이 순서상 뒤로 밀려나
  // 재생이 갑자기 다른 곡으로 튀는 것처럼 느껴지지 않도록.
  setShuffle(enabled) {
    this.shuffle = enabled;
    this._resetPreload();
    if (enabled) this._rebuildShuffleOrder(null, this.currentIndex);
    this._streamInvalidateAhead();
    this._emit("shufflechange", { shuffle: enabled });
  }

  cycleRepeat() {
    const idx = REPEAT_ORDER.indexOf(this.repeatMode);
    this.repeatMode = REPEAT_ORDER[(idx + 1) % REPEAT_ORDER.length];
    this._resetPreload();
    this._streamInvalidateAhead();
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
    // 이미 스트림에 이어 붙여 둔 곡이면 src를 건드리지 않고 그 위치로 건너뛴다.
    if (this._stream && this._streamJump(index)) return;
    const streaming = this._canStream(this.playlist.tracks[index]);
    // 미리 받아 둔 다음 곡이 이 곡이면 그 Blob URL을 넘겨받고, 나머지 프리페치는 정리한다.
    const prefetched =
      !streaming && this._prefetch && this._prefetch.index === index && this._prefetch.url ? this._prefetch : null;
    if (prefetched) this._prefetch = null;
    this._resetPreload();
    this.currentIndex = index;
    // queue.js의 getDisplayQueue()가 여기서 앵커를 정한다 — 대기열 패널을 아직
    // 한 번도 안 열어본 상태로 곡이 여러 번 넘어가면(예: 자동재생), 패널을 열 때
    // 가서야 그 시점의 currentIndex로 뒤늦게 앵커가 잡혀 이미 지나간 곡들이
    // 목록에서 통째로 빠져 보인다. 재생이 실제로 시작되는 지금 이 시점에 한
    // 번만(플레이리스트당) 앵커를 확정해 그 문제를 막는다.
    if (this.playlist._queueAnchor == null) this.playlist._queueAnchor = index;
    const track = this.playlist.tracks[index];
    if (streaming) {
      this._startStream(index, track);
      return;
    }
    this._teardownStream();
    const previousBlobUrl = this._currentBlobUrl;
    this._currentBlobUrl = prefetched ? prefetched.url : null;
    this.audio.src = prefetched ? prefetched.url : `/api/tracks/${track.track_id}/audio`;
    if (previousBlobUrl) URL.revokeObjectURL(previousBlobUrl);
    this._log(`playIndex ${index} ${prefetched ? "blob" : "network"}`);
    this._resetPositionOnPlay = true;
    this._needsInitialResync = true;
    this._trackStartWallMs = performance.now();
    this._pendingStart = true;
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
    this._tryPlay(audio);
  }

  // play()가 거부되면(특히 iOS 백그라운드에서 자동 전환 시) 이벤트가 안 와서 UI가
  // "재생 중"으로 남으므로, 실제 상태(정지)를 명시적으로 알린다.
  _tryPlay(audio) {
    const p = audio.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (audio !== this.audio) return;
        this._log(`play() rejected ${err && err.name}`);
        this._emit("playstate", { playing: !audio.paused });
      });
    }
  }

  play() {
    if (this.currentIndex < 0) {
      if (this.playlist && this.playlist.tracks.length) this.playIndex(0);
      return;
    }
    if (this.audio.ended) {
      this.playIndex(this.currentIndex);
      return;
    }
    this._tryPlay(this.audio);
  }

  pause() {
    this._pendingStart = false;
    this.audio.pause();
  }

  // UI/미디어 세션이 실제 오디오 엘리먼트 상태와 어긋났을 때 다시 맞추기 위해 호출.
  syncPlayState() {
    this._emit("playstate", { playing: this.isPlaying() });
  }

  togglePlayPause() {
    if (this.isPlaying()) this.pause();
    else this.play();
  }

  stop() {
    this.pause();
  }

  seek(ms) {
    // MSE 스트림은 endOfStream 전에는 audio.duration이 NaN/Infinity이므로 곡 구간 정보로 판단한다.
    const seg = this._stream && this._segAt(this.audio.currentTime);
    if (!seg && !Number.isFinite(this.audio.duration)) return;
    if (seg) {
      // 현재 곡 구간 안으로 한정 — 끝을 넘기면 의도치 않게 다음 곡으로 넘어가 버린다.
      const t = Math.min(seg.start + Math.max(0, ms) / 1000, Math.max(seg.start, seg.end - 0.05));
      if (!this._isBuffered(t)) {
        // 용량 확보로 이미 비워진 앞부분으로 되감기 — 같은 곡을 그 위치에서 스트림부터 다시 연다.
        this._log(`seek to unbuffered ${t.toFixed(1)}, restarting stream`);
        this._startStream(this.currentIndex, this.currentTrack, Math.max(0, ms));
        return;
      }
      this.audio.currentTime = t;
      return;
    }
    this.audio.currentTime = Math.max(0, ms) / 1000;
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
    const t = this.audio.currentTime || 0;
    const seg = this._stream && this._segAt(t);
    if (seg) return Math.max(0, Math.round((Math.min(t, seg.end) - seg.start) * 1000));
    return Math.round(t * 1000);
  }

  duration() {
    if (this._stream) {
      const seg = this._segAt(this.audio.currentTime || 0);
      if (seg) return Math.round((seg.end - seg.start) * 1000);
      // 첫 곡이 아직 붙기 전에는 태그상의 길이를 대신 쓴다.
      const track = this.currentTrack;
      return track && track.duration_ms > 0 ? track.duration_ms : 0;
    }
    return Math.round((this.audio.duration || 0) * 1000);
  }

  // ───── 연속 스트림(MSE) 재생 ─────

  _canStream(track) {
    return (
      !this._streamDisabled &&
      !!track &&
      track.audio_ext === "m4a" &&
      !this._noStreamIds.has(track.track_id) &&
      gaplessSupported()
    );
  }

  // 타임라인 t초가 속한 곡 구간(지난 곡은 제거돼 있으므로 끝이 t보다 큰 첫 구간).
  _segAt(t) {
    const st = this._stream;
    if (!st || !st.segs.length) return null;
    for (const seg of st.segs) {
      if (t < seg.end) return seg;
    }
    return st.segs[st.segs.length - 1];
  }

  _isBuffered(t) {
    const b = this.audio.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.05 && t <= b.end(i)) return true;
    }
    return false;
  }

  _teardownStream() {
    const st = this._stream;
    if (!st) return;
    this._stream = null;
    st.gs.destroy();
  }

  async _fetchTrackBuffer(index) {
    const track = this.playlist.tracks[index];
    const r = await fetch(`/api/tracks/${track.track_id}/stream`);
    if (r.status === 415) {
      this._noStreamIds.add(track.track_id);
      const err = new Error("unsupported for stream");
      err.unsupported = true;
      throw err;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.arrayBuffer();
  }

  // 곡 하나를 내려받아 타임라인 startSec 위치에 이어 붙이고 구간 정보를 기록한다.
  async _streamAppend(st, index, startSec, prefetchedBuf = null) {
    const buf = prefetchedBuf || (await this._fetchTrackBuffer(index));
    if (st !== this._stream) return null;
    let result;
    try {
      result = await st.gs.append(buf, startSec);
    } catch (err) {
      if (!(err && err.name === "QuotaExceededError")) throw err;
      // 용량 초과: 이미 재생한 앞부분을 비우고 한 번 더 시도한다.
      await st.gs.removeBefore(Math.max(0, (this.audio.currentTime || 0) - 1));
      if (st !== this._stream) return null;
      result = await st.gs.append(buf, startSec);
    }
    const { start, end } = result;
    if (st !== this._stream) return null;
    const seg = { index, start, end };
    st.segs.push(seg);
    this._log(`stream append index=${index} start=${start.toFixed(1)} end=${end.toFixed(1)} bytes=${buf.byteLength}`);
    return seg;
  }

  _startStream(index, track, startMs = 0) {
    this._teardownStream();
    if (this._currentBlobUrl) {
      URL.revokeObjectURL(this._currentBlobUrl);
      this._currentBlobUrl = null;
    }
    const st = { gs: new GaplessStream(), segs: [], cur: null, filling: false, fillPromise: null, eos: false, retryAt: 0, pre: null };
    this._stream = st;
    this.audio.src = st.gs.url;
    this._log(`playIndex ${index} stream`);
    this._resetPositionOnPlay = false;
    this._needsInitialResync = false;
    this._needsResyncOnPlay = false;
    this._trackStartWallMs = performance.now();
    this._pendingStart = true;
    // 데이터가 붙기 전에 play()를 먼저 걸어 둔다 — 클릭(사용자 제스처) 컨텍스트가 살아 있는 동안.
    this._tryPlay(this.audio);
    // 같은 곡을 위치만 바꿔 다시 여는 경우(startMs > 0)엔 trackchange를 다시 내지 않는다.
    if (startMs === 0) this._emit("trackchange", { track, index });
    this._streamAppend(st, index, 0)
      .then((seg) => {
        if (!seg) return;
        st.cur = seg;
        if (startMs > 0) this.audio.currentTime = seg.start + startMs / 1000;
        this._emit("durationchange", { durationMs: this.duration() });
        this._streamFillAhead(st);
      })
      .catch((err) => {
        if (st !== this._stream) return;
        this._log(`stream start failed ${err && err.message}`);
        if (err && err.unsupported) {
          // 이 곡만 못 묶는 경우 — 스트림 전체를 끄지 말고 이 곡만 일반 재생으로.
          this._teardownStream();
          this.playIndex(index);
        } else {
          this._streamFallback();
        }
      });
  }

  // 지금 곡 바로 뒤에 다음 곡이 이어 붙어 있도록 한다(없으면 내려받아 붙이고, 더 없으면 스트림을 닫는다).
  _streamFillAhead(st) {
    if (!st || st !== this._stream || !st.cur || st.filling) return;
    if (st.segs[st.segs.length - 1] !== st.cur) return; // 이미 다음 곡이 붙어 있음
    if (performance.now() < st.retryAt) return;
    const nextIndex = this.repeatMode === "one" ? this.currentIndex : this._computeNextIndex();
    const nextTrack = nextIndex === null || nextIndex < 0 ? null : this.playlist.tracks[nextIndex];
    if (!nextTrack || !this._canStream(nextTrack)) {
      // 더 이어 붙일 수 없는 곡(없음/mp3 아님)이면 닫아서, 이 곡이 끝날 때 평소처럼 ended 처리되게 한다.
      if (!st.eos) {
        st.eos = true;
        st.gs.endOfStream().catch(() => {});
      }
      return;
    }
    st.eos = false;
    // 1단계: 다음 곡 바이트를 미리 내려받아 메모리에 둔다(붙이기는 아직 안 함).
    if (!st.pre || st.pre.index !== nextIndex) {
      st.filling = true;
      st.fillPromise = this._fetchTrackBuffer(nextIndex)
        .then((buf) => {
          if (st === this._stream) st.pre = { index: nextIndex, buf };
        })
        .catch((err) => {
          this._log(`stream prefetch failed ${err && err.message}`);
          st.retryAt = performance.now() + (err && err.unsupported ? 0 : STREAM_RETRY_MS);
        })
        .finally(() => {
          st.filling = false;
          this._streamFillAhead(st);
        });
      return;
    }
    // 2단계: 현재 곡 끝이 가까워지면 실제로 붙인다.
    if (st.cur.end - (this.audio.currentTime || 0) > STREAM_APPEND_LEAD_SEC) return;
    st.filling = true;
    const { buf } = st.pre;
    st.pre = null;
    st.fillPromise = this._streamAppend(st, nextIndex, st.cur.end, buf)
      .catch((err) => {
        this._log(`stream fill failed ${err && err.message}`);
        st.retryAt = performance.now() + STREAM_RETRY_MS;
      })
      .finally(() => {
        st.filling = false;
      });
  }

  // 셔플/반복/목록 변경으로 "다음 곡"이 달라졌을 수 있을 때, 미리 붙여 둔 뒷부분을 지우고 다시 채운다.
  async _streamInvalidateAhead() {
    const st = this._stream;
    if (!st || !st.cur) return;
    st.cur.index = this.currentIndex;
    st.eos = false;
    try {
      await st.fillPromise;
    } catch {
      /* 이미 로그됨 */
    }
    if (st !== this._stream || !st.cur) return;
    const at = st.segs.indexOf(st.cur);
    if (at >= 0 && at < st.segs.length - 1) {
      st.segs.length = at + 1;
      try {
        await st.gs.removeAfter(st.cur.end);
      } catch (err) {
        this._log(`stream trim failed ${err && err.message}`);
      }
    }
    st.retryAt = 0;
    this._streamFillAhead(st);
  }

  // 이미 붙어 있는 뒷 곡으로 바로 이동(수동 다음 곡 포함).
  _streamJump(index) {
    const st = this._stream;
    if (!st || !st.cur) return false;
    const at = st.segs.indexOf(st.cur);
    const seg = st.segs.slice(at + 1).find((s) => s.index === index);
    if (!seg) return false;
    this._streamEnter(st, seg);
    this.audio.currentTime = seg.start;
    this._tryPlay(this.audio);
    return true;
  }

  // 재생 위치가 다음 곡 구간으로 넘어간 것을 알아채 현재 곡 정보를 갱신하고 이벤트를 낸다.
  _streamEnter(st, seg) {
    st.cur = seg;
    this.currentIndex = seg.index;
    const track = this.currentTrack;
    this._log(`stream boundary -> ${seg.index}`);
    this._trackStartWallMs = performance.now();
    if (this.playlist && this.playlist._queueAnchor == null) this.playlist._queueAnchor = seg.index;
    this._emit("trackchange", { track, index: seg.index });
    this._emit("durationchange", { durationMs: this.duration() });
    // 지난 곡은 버퍼에서 비우고(메모리), 다음 곡을 이어 붙인다.
    const at = st.segs.indexOf(seg);
    if (at > 0) {
      st.segs.splice(0, at);
      st.gs.removeBefore(seg.start - 1).catch(() => {});
    }
    st.retryAt = 0;
    this._streamFillAhead(st);
  }

  _streamTick() {
    const st = this._stream;
    if (!st || !st.cur) return;
    const seg = this._segAt(this.audio.currentTime);
    if (seg && seg !== st.cur) this._streamEnter(st, seg);
    else this._streamFillAhead(st);
  }

  // MSE가 안 되는 환경/상황: 이 세션에서는 스트림을 끄고 지금 곡을 기존 방식으로 다시 시작한다.
  _streamFallback() {
    const index = this.currentIndex;
    const posMs = this.position();
    this._streamDisabled = true;
    this._teardownStream();
    if (index < 0) return;
    this.playIndex(index);
    if (posMs > 1000) {
      this.audio.addEventListener("loadedmetadata", () => this.seek(posMs), { once: true });
    }
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
    // 예전엔 미리 불러온 별도 <audio>로 갈아탔지만, iOS는 사용자 제스처로 한 번도
    // 활성화되지 않은 엘리먼트의 백그라운드 play()를 막아 "재생 중으로 보이는데
    // 소리가 안 나는" 증상을 냈다. 이미 활성화된 같은 엘리먼트의 src만 바꾼다.
    this.playIndex(index);
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
    this._log("ended");
    this._emit("ended", {});
    if (!this.autoAdvance) return;
    if (this.repeatMode === "one") {
      this._resetPreload();
      this.playIndex(this.currentIndex);
    } else {
      this.nextTrack();
    }
  }

  // 재생 중인 곡이 얼마 남지 않으면 다음 곡을 통째로 내려받아 Blob으로 들고 있는다.
  // "one" 반복은 항상 같은 곡을 재시작하므로 대상이 아니다.
  _maybePreloadNext() {
    if (this.repeatMode === "one") return;
    const dur = this.audio.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    // 화면이 꺼지면 백그라운드 fetch가 멈출 수 있으므로, 현재 곡을 이미 끝까지 받았으면
    // (대역폭 경쟁 없음) 곡 초반에 바로 다음 곡을 받아 둔다. 아직 다 못 받았으면 예전처럼
    // 끝이 가까워진 뒤에 시작한다.
    if (!this._currentFullyBuffered(dur) && dur - this.audio.currentTime > this._estimatedPreloadLeadSec(dur)) return;
    const nextIndex = this._computeNextIndex();
    if (nextIndex === null || nextIndex === this.currentIndex) return;
    if (this._prefetch && this._prefetch.index === nextIndex) return;

    this._cancelPrefetch();
    const track = this.playlist.tracks[nextIndex];
    const controller = new AbortController();
    const pf = { index: nextIndex, url: null, controller, failed: false };
    this._prefetch = pf;
    fetch(`/api/tracks/${track.track_id}/audio`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        if (this._prefetch !== pf) return; // 그 사이 취소/교체됨
        pf.url = URL.createObjectURL(blob);
        this._log(`prefetch ok index=${nextIndex} bytes=${blob.size}`);
      })
      .catch((err) => {
        // 실패해도 같은 곡을 계속 재시도하지 않는다(재생 시 일반 URL로 폴백).
        pf.failed = true;
        if (err && err.name !== "AbortError") this._log(`prefetch fail index=${nextIndex} ${err.message}`);
      });
  }

  // 지금 곡이 실제로 받아지는 속도(=재생 1초당 몇 초 분량이 버퍼링되는지)를
  // 재서, 그 속도로 다음 곡(길이는 지금 곡으로 추정)을 다 받는 데 필요한
  // 시간을 계산한다. 다운로드가 재생보다 빠르면(1배 이상) 여유가 있다는
  // 뜻이므로 기본값만 쓴다 — 다운로드가 재생을 못 따라가는 중일 때(1배 미만)만
  // 이르게 시작한다. 그런 경우는 지금 곡 자체가 이미 대역폭 부족으로 버벅이고
  // 있다는 뜻이라, 다음 곡까지 같은 대역폭을 두고 경쟁시키면 지금 곡이 더
  // 나빠질 수 있지만, 어차피 지금 곡은 이미 끊기는 중이므로 다음 곡이라도
  // 미리 받아두는 쪽이 낫다는 판단이다.
  _currentFullyBuffered(dur) {
    const buffered = this.audio.buffered;
    return buffered.length > 0 && buffered.end(buffered.length - 1) >= dur - 0.5;
  }

  _estimatedPreloadLeadSec(dur) {
    if (!this._trackStartWallMs) return PRELOAD_MIN_SEC;
    const buffered = this.audio.buffered;
    if (!buffered.length) return PRELOAD_MIN_SEC;
    const elapsedSec = (performance.now() - this._trackStartWallMs) / 1000;
    // 재생 시작 직후엔 초기 버퍼링이 순간적으로 몰려 배속이 튀어 보이므로,
    // 어느 정도 실제 재생 시간이 쌓인 뒤의 값만 신뢰한다.
    if (elapsedSec < 5) return PRELOAD_MIN_SEC;
    const bufferedSec = buffered.end(buffered.length - 1);
    const rate = bufferedSec / elapsedSec;
    if (rate >= 1) return PRELOAD_MIN_SEC;
    // rate < 1이면 dur / rate는 항상 dur보다 크므로, 남은 시간과 비교하는
    // 호출부 입장에선 "지금 곡 안에서 언제 만나든 즉시 시작"과 같은 뜻이다.
    return dur;
  }

  _cancelPrefetch() {
    const pf = this._prefetch;
    if (!pf) return;
    pf.controller.abort();
    if (pf.url) URL.revokeObjectURL(pf.url);
    this._prefetch = null;
  }

  _resetPreload() {
    this._cancelPrefetch();
  }

  // 원격 진단용: 클라이언트(특히 iOS 백그라운드)에서 일어난 일을 서버 로그로 남긴다.
  _log(msg) {
    const a = this.audio;
    this._emit("debuglog", {
      msg: `${msg} [vis=${document.visibilityState} paused=${a.paused} rs=${a.readyState} ns=${a.networkState} t=${a.currentTime.toFixed(1)}]`,
    });
  }
}
