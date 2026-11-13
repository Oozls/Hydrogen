// 곡 경계에서 <audio>가 "끝나지 않도록" 여러 곡(m4a→fMP4)을 하나의 MediaSource(SourceBuffer)에
// 이어 붙이는 래퍼. iOS(특히 홈 화면 앱)는 화면이 꺼진 채 ended 후 src를 바꿔 play()하는
// 경로를 막거나 페이지를 정지시키는데, 엘리먼트가 계속 재생 중이면 그런 전환 자체가
// 필요 없다. 곡 경계 판단/이벤트 발행은 player.js가 담당하고, 여기는 버퍼 조작만 한다.

// 서버 /api/tracks/<id>/stream이 AAC-LC m4a를 fMP4로 다시 묶어 내려준다(fmp4.py).
const MIME = 'audio/mp4; codecs="mp4a.40.2"';

export function gaplessSupported() {
  try {
    return typeof window.MediaSource === "function" && window.MediaSource.isTypeSupported(MIME);
  } catch {
    return false;
  }
}

export class GaplessStream {
  constructor() {
    this.ms = new MediaSource();
    this.url = URL.createObjectURL(this.ms);
    this.sb = null;
    // 모든 SourceBuffer 조작은 이 체인으로 직렬화한다(updating 중에 다른 조작을 하면 예외).
    this._chain = Promise.resolve();
    this._ready = new Promise((resolve, reject) => {
      this.ms.addEventListener(
        "sourceopen",
        () => {
          try {
            this.sb = this.ms.addSourceBuffer(MIME);
            // sequence 모드: 붙이는 조각을 항상 직전 조각 끝에 이어 배치한다.
            this.sb.mode = "sequence";
            resolve();
          } catch (err) {
            reject(err);
          }
        },
        { once: true },
      );
    });
    this._ready.catch(() => {});
  }

  _enqueue(task) {
    const run = this._chain.then(() => this._ready).then(task);
    this._chain = run.catch(() => {});
    return run;
  }

  _waitIdle() {
    const sb = this.sb;
    if (!sb.updating) return Promise.resolve();
    return new Promise((resolve) => sb.addEventListener("updateend", resolve, { once: true }));
  }

  _op(fn) {
    return new Promise((resolve, reject) => {
      const sb = this.sb;
      const onEnd = () => {
        sb.removeEventListener("error", onErr);
        resolve();
      };
      const onErr = () => {
        sb.removeEventListener("updateend", onEnd);
        reject(new Error("SourceBuffer error"));
      };
      sb.addEventListener("updateend", onEnd, { once: true });
      sb.addEventListener("error", onErr, { once: true });
      try {
        fn();
      } catch (err) {
        sb.removeEventListener("updateend", onEnd);
        sb.removeEventListener("error", onErr);
        reject(err);
      }
    });
  }

  _bufferedEnd() {
    const b = this.sb.buffered;
    return b.length ? b.end(b.length - 1) : 0;
  }

  // 한 곡 분량의 mp3 바이트를 startSec 위치에 붙이고 { start, end }(타임라인 초)를 돌려준다.
  append(arrayBuffer, startSec) {
    return this._enqueue(async () => {
      await this._waitIdle();
      // 뒤쪽을 지운 뒤에도 빈틈 없이 이어지도록 시작 위치를 항상 명시한다.
      this.sb.timestampOffset = startSec;
      await this._op(() => this.sb.appendBuffer(arrayBuffer));
      return { start: startSec, end: this._bufferedEnd() };
    });
  }

  removeAfter(sec) {
    return this._enqueue(async () => {
      await this._waitIdle();
      if (this.sb.buffered.length && this._bufferedEnd() > sec) {
        await this._op(() => this.sb.remove(sec, Infinity));
      }
    });
  }

  removeBefore(sec) {
    return this._enqueue(async () => {
      await this._waitIdle();
      if (sec > 0 && this.sb.buffered.length && this.sb.buffered.start(0) < sec) {
        await this._op(() => this.sb.remove(0, sec));
      }
    });
  }

  // 더 붙일 곡이 없을 때 호출 — 그러면 마지막 곡이 끝날 때 <audio>가 정상적으로 ended된다.
  endOfStream() {
    return this._enqueue(async () => {
      await this._waitIdle();
      if (this.ms.readyState === "open") this.ms.endOfStream();
    });
  }

  destroy() {
    try {
      URL.revokeObjectURL(this.url);
    } catch {
      /* 무시 */
    }
  }
}
