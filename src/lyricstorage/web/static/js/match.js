import { store } from "./store.js";
import { iconSpan, setIcon } from "./icons.js";
import { buildArtEl } from "./artspinner.js";
import { buildArtistCell } from "./songArtist.js";
import { createMarqueeClip, applyMarquee } from "./marquee.js";

// playlist.js의 레이팅 배지와 동일한 구조(하트 아이콘 + 숫자) — 목록 행이
// 아니라 매치 카드에서 쓰는 것이라 그쪽 헬퍼를 export해서 끌어오는 대신
// 그대로 복제한다.
function createRatingBadge(rating) {
  const badge = document.createElement("span");
  badge.className = "playlist-row-rating" + (rating ? "" : " empty");
  badge.appendChild(iconSpan("heart-filled", "icon-sm"));
  badge.appendChild(document.createTextNode(String(rating || 0)));
  return badge;
}

// 취향 기준이 곡 하나만 듣고 매길 때보다 두 곡을 나란히 비교해서 들을 때 더
// 일관되게 잡힌다는 전제로 만든 화면. 라이브러리 전체(또는 체크박스로 이미
// 레이팅된 곡만)에서 무작위 두 곡을 뽑아 나란히 놓고, 재생/레이팅은 기존
// 재생바·다축 평가 다이얼로그를 그대로 재사용한다.
export function setupMatch(player, axisRatingApi, onOpenAlbum, onOpenArtist) {
  const panelEl = document.getElementById("match-panel");
  const cardsEl = document.getElementById("match-cards");
  const leftSlot = document.getElementById("match-card-left");
  const rightSlot = document.getElementById("match-card-right");
  const emptyEl = document.getElementById("match-empty");
  const loadingEl = document.getElementById("match-loading");
  const ratedOnlyCheckbox = document.getElementById("match-rated-only");
  const rerollBtn = document.getElementById("btn-match-reroll");

  let pair = [];

  function pickPair() {
    const ratedOnly = ratedOnlyCheckbox.checked;
    const pool = store.getTracks().filter((t) => !ratedOnly || (t.rating || 0) > 0);
    if (pool.length < 2) return null;
    const i = Math.floor(Math.random() * pool.length);
    let j = Math.floor(Math.random() * (pool.length - 1));
    if (j >= i) j++;
    return [pool[i], pool[j]];
  }

  function syncCardPlayIcon(card, track) {
    const playing = player.isPlaying() && player.currentTrack && player.currentTrack.track_id === track.track_id;
    setIcon(card.querySelector(".match-card-play .icon"), playing ? "pause" : "play");
  }

  function buildCard(track) {
    const card = document.createElement("div");
    card.className = "match-card";
    card.dataset.trackId = track.track_id;

    const artWrap = buildArtEl(track.track_id, "match-card-art-wrap");
    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "match-card-play";
    playBtn.appendChild(iconSpan("play", "icon-lg"));
    playBtn.addEventListener("click", () => {
      const isCurrent = player.currentTrack && player.currentTrack.track_id === track.track_id;
      if (isCurrent) {
        player.togglePlayPause();
      } else {
        player.setPlaylist({ name: "매치", tracks: pair }, { mode: "list" });
        player.playIndex(pair.indexOf(track));
      }
    });
    artWrap.appendChild(playBtn);
    card.appendChild(artWrap);

    card.appendChild(createMarqueeClip("match-card-title", "", track.title || track.track_id));
    if (track.artist) card.appendChild(buildArtistCell("match-card-subtitle", track.artist, onOpenArtist));
    if (track.album) {
      const albumClip = createMarqueeClip("match-card-album", "", track.album);
      if (onOpenAlbum) {
        albumClip.classList.add("playlist-row-album-link");
        albumClip.title = "앨범 보기";
        albumClip.addEventListener("click", (e) => {
          e.stopPropagation();
          onOpenAlbum(track);
        });
      }
      card.appendChild(albumClip);
    }

    const footer = document.createElement("div");
    footer.className = "match-card-footer";
    footer.appendChild(createRatingBadge(track.rating));
    const rateBtn = document.createElement("button");
    rateBtn.type = "button";
    rateBtn.className = "icon-btn";
    rateBtn.title = "여러 측면으로 평가하기";
    rateBtn.appendChild(iconSpan("bar-chart-2"));
    rateBtn.addEventListener("click", () => axisRatingApi.open(track));
    footer.appendChild(rateBtn);
    card.appendChild(footer);

    syncCardPlayIcon(card, track);
    return card;
  }

  async function render() {
    emptyEl.hidden = true;
    cardsEl.hidden = true;
    loadingEl.hidden = store.isLoaded();
    await store.ensureLoaded();
    loadingEl.hidden = true;
    pair = pickPair() || [];
    if (!pair.length) {
      emptyEl.hidden = false;
      return;
    }
    cardsEl.hidden = false;
    leftSlot.replaceChildren(buildCard(pair[0]));
    rightSlot.replaceChildren(buildCard(pair[1]));
    requestAnimationFrame(() => applyMarquee(cardsEl));
  }

  function syncPlayIcons() {
    [...cardsEl.querySelectorAll(".match-card")].forEach((card) => {
      const track = pair.find((t) => t.track_id === card.dataset.trackId);
      if (track) syncCardPlayIcon(card, track);
    });
  }

  rerollBtn.addEventListener("click", render);
  ratedOnlyCheckbox.addEventListener("change", render);
  player.addEventListener("playstate", syncPlayIcons);
  player.addEventListener("trackchange", syncPlayIcons);
  player.addEventListener("ratingchange", (e) => {
    const track = pair.find((t) => t.track_id === e.detail.trackId);
    if (!track) return;
    track.rating = e.detail.rating;
    const card = cardsEl.querySelector(`.match-card[data-track-id="${CSS.escape(e.detail.trackId)}"]`);
    if (!card) return;
    const badge = card.querySelector(".playlist-row-rating");
    badge.classList.toggle("empty", !e.detail.rating);
    const textNode = [...badge.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.textContent = String(e.detail.rating || 0);
  });

  return {
    show() {
      panelEl.classList.add("active");
      render();
    },
    hide() {
      panelEl.classList.remove("active");
    },
  };
}
