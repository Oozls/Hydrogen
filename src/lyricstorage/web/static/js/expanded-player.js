import { buildArtEl } from "./artspinner.js";
import { getDisplayQueue } from "./queue.js";
import { attachScrollAutoHide } from "./scrollAutoHide.js";
import { createMarqueeClip, applyMarquee } from "./marquee.js";

export function setupExpandedPlayer(player, { onOpen } = {}) {
  const btn = document.getElementById("btn-expand-player");
  const panel = document.getElementById("expanded-player-panel");
  const transportBar = document.getElementById("transport-bar");
  const artHost = document.getElementById("expanded-player-art");
  const titleEl = document.getElementById("expanded-player-title");
  const subtitleEl = document.getElementById("expanded-player-subtitle");
  const queueEl = document.getElementById("expanded-player-queue");
  const queueListEl = document.getElementById("expanded-player-queue-list");

  attachScrollAutoHide(queueEl);

  let open = false;

  function renderNowPlaying() {
    const track = player.currentTrack;
    artHost.innerHTML = "";
    if (track) artHost.appendChild(buildArtEl(track.track_id, "expanded-player-art-inner"));
    titleEl.textContent = track ? track.title || track.track_id : "";
    subtitleEl.textContent = track ? [track.artist, track.album].filter(Boolean).join(" · ") : "";
  }

  function buildQueueRow(track, isCurrent) {
    const row = document.createElement("div");
    row.className = "expanded-queue-row" + (isCurrent ? " current" : "");
    row.appendChild(buildArtEl(track.track_id, "expanded-queue-row-art-wrap"));

    const text = document.createElement("div");
    text.className = "expanded-queue-row-text";
    text.appendChild(createMarqueeClip("expanded-queue-row-title", "", track.title || track.track_id));
    text.appendChild(
      createMarqueeClip("expanded-queue-row-subtitle", "", [track.artist, track.album].filter(Boolean).join(" · "))
    );
    row.appendChild(text);

    if (!isCurrent) {
      row.addEventListener("click", () => {
        const realIndex = player.playlist.tracks.indexOf(track);
        if (realIndex >= 0) player.playIndex(realIndex);
      });
    }
    return row;
  }

  function renderQueue() {
    queueListEl.innerHTML = "";
    const queue = getDisplayQueue(player);
    // 큐가 이제 지나간 곡도 포함하므로(더는 끝난 곡이라고 목록에서 지우지
    // 않음), "현재 재생 중"은 배열의 첫 자리가 아니라 실제 재생 중인 트랙과
    // 같은 객체인지로 판단한다.
    queue.forEach((track) => queueListEl.appendChild(buildQueueRow(track, track === player.currentTrack)));
    requestAnimationFrame(() => applyMarquee(queueListEl));
  }

  function renderAll() {
    if (!open) return;
    renderNowPlaying();
    renderQueue();
  }

  // 재생 중인(불러온) 곡이 하나도 없으면 볼 대기 목록 자체가 없으므로 버튼을 막는다.
  function updateButtonAvailability() {
    btn.disabled = !player.currentTrack;
  }

  function setOpen(next) {
    open = next;
    panel.classList.toggle("active", open);
    transportBar.classList.toggle("expanded", open);
    if (open) {
      renderAll();
      // 좁은 화면(사이드바가 토글 드로어인 환경)에서는 드로어가 열려 있는 채로
      // 재생바를 확장하면 서로 겹치므로, 확장하는 순간 드로어를 닫아준다.
      if (onOpen) onOpen();
    }
  }

  let marqueeResizeTimer = null;
  window.addEventListener("resize", () => {
    if (!open) return;
    clearTimeout(marqueeResizeTimer);
    marqueeResizeTimer = setTimeout(() => applyMarquee(queueListEl), 150);
  });

  btn.addEventListener("click", () => setOpen(!open));
  player.addEventListener("trackchange", () => {
    updateButtonAvailability();
    renderAll();
  });
  player.addEventListener("queuechange", renderAll);
  updateButtonAvailability();

  return {
    show: () => setOpen(true),
    hide: () => setOpen(false),
  };
}
