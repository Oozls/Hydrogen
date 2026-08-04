import { buildArtEl } from "./artspinner.js";
import { getDisplayQueue } from "./queue.js";

export function setupExpandedPlayer(player) {
  const btn = document.getElementById("btn-expand-player");
  const panel = document.getElementById("expanded-player-panel");
  const transportBar = document.getElementById("transport-bar");
  const artHost = document.getElementById("expanded-player-art");
  const titleEl = document.getElementById("expanded-player-title");
  const subtitleEl = document.getElementById("expanded-player-subtitle");
  const queueListEl = document.getElementById("expanded-player-queue-list");

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
    const title = document.createElement("div");
    title.className = "expanded-queue-row-title";
    title.textContent = track.title || track.track_id;
    const subtitle = document.createElement("div");
    subtitle.className = "expanded-queue-row-subtitle";
    subtitle.textContent = track.artist || "";
    text.appendChild(title);
    text.appendChild(subtitle);
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
    queue.forEach((track, i) => queueListEl.appendChild(buildQueueRow(track, i === 0)));
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
    if (open) renderAll();
  }

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
