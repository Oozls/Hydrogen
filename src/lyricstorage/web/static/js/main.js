import { PlayerEngine } from "./player.js";
import { store } from "./store.js";
import { setupNowPlaying } from "./nowplaying.js";
import { setupPlaylist } from "./playlist.js";
import { setupLyrics } from "./lyrics.js";
import { setupTrackInfo } from "./trackinfo.js";
import { setupBulkEdit } from "./bulkedit.js";
import { setupPlayTracking } from "./playtracking.js";
import { setupStats } from "./stats.js";
import { setupTodaySongs } from "./todaysongs.js";
import { setupHome } from "./home.js";
import { setupQueueEngine } from "./queue.js";
import { setupExpandedPlayer } from "./expanded-player.js";
import { setupBrowse } from "./browse.js";
import { setupAlbumInfo } from "./albuminfo.js";
import { setupSidebar } from "./sidebar.js";
import { setupRouter } from "./router.js";
import { setupRating } from "./rating.js";
import { setupArtistIdentityDialog } from "./artistIdentityDialog.js";

function readBootstrap() {
  const el = document.getElementById("bootstrap-data");
  return JSON.parse(el.textContent);
}

document.addEventListener("DOMContentLoaded", () => {
  const bootstrap = readBootstrap();
  // 화면들이 각자 처음 열릴 때 라이브러리를 fetch하길 기다리는 대신, 앱이
  // 뜨자마자 한 번 미리 데워둔다 — 첫 라우팅 진입 시점에 이미 캐시가 있으면
  // 그만큼 fetch 대기가 줄어든다(완전히 없어지는 건 3단계 라우팅 개편에서).
  store.refresh();
  const audioEl = document.getElementById("audio-element");
  const player = new PlayerEngine(audioEl);

  const refs = { router: null, pendingAlbumFocus: null };
  const identityDialogApi = setupArtistIdentityDialog();

  // 재생바/재생 통계에서 앨범명을 클릭하면 브라우즈 > 앨범 탭으로 이동해 그
  // 앨범의 상세 화면을 바로 연다. browseApi가 아직 만들어지기 전이라(순서상
  // 아래에서 생성) refs에 "다음 브라우즈 진입 시 열어야 할 앨범"만 남겨두고,
  // onBrowse 라우터 콜백이 이를 소비해 browseApi.show(focus)에 전달한다.
  // track_id는(재생 기록 TOP3 앨범처럼) 이후 파일이 바뀌어 더 이상 라이브러리에
  // 없을 수 있으므로, album/artist도 같이 넘겨 track_id 매칭이 실패해도
  // album+artist로 앨범을 찾을 수 있게 한다.
  function openAlbumFromTrack(track) {
    if (!track || !track.album) return;
    refs.pendingAlbumFocus = { track_id: track.track_id, album: track.album, artist: track.artist };
    refs.router.goBrowse();
  }

  // 곡 목록 행의 아티스트명(곡 아티스트)을 클릭하면 브라우즈 > 곡 아티스트 탭의
  // 그 아티스트 상세 페이지로 바로 이동한다. 쉼표로 여럿 표기된 경우 각 이름이
  // 개별적으로 클릭되므로(buildArtistCell) 여기엔 이미 나뉜 이름 하나만 들어온다.
  // 앨범 id와 달리 이름만으로도 URL이 성립하므로, openAlbumFromTrack과 달리
  // pendingFocus 없이 라우터로 곧장 이동한다.
  function openArtistFromTrack(name) {
    if (!name) return;
    refs.router.goSongArtistDetail(name);
  }

  const nowPlayingApi = setupNowPlaying(player, openAlbumFromTrack, openArtistFromTrack);
  const sidebarApi = setupSidebar(bootstrap, {
    onSelectPlaylist: (name) => refs.router.goPlaylist(name),
    onGoHome: () => refs.router.goHome(),
    onGoBrowse: () => refs.router.goBrowse(),
    onGoStats: () => refs.router.goStats(),
    onGoToday: () => refs.router.goToday(),
  });
  const playlistApi = setupPlaylist(
    player,
    bootstrap,
    (index) => {
      if (player.playlist !== playlistApi.getCurrentPlaylist()) {
        player.syncTracks(playlistApi.getCurrentPlaylist());
      }
      player.playIndex(index);
    },
    (track) => trackInfoApi.open(track),
    {
      sidebarApi,
      refs,
      onBulkEdit: (ids) => bulkEditApi.open(ids),
      onOpenAlbum: openAlbumFromTrack,
      onOpenArtist: openArtistFromTrack,
    }
  );
  const trackInfoApi = setupTrackInfo(
    async (trackId, updated) => {
      playlistApi.refreshTrackInfo(trackId, updated);
      await browseApi.refreshAfterAlbumUpdate();
      if (player.currentTrack && player.currentTrack.track_id === trackId) {
        // 검색 결과(브라우즈)에서 바로 재생 중인 트랙은 currentPlaylist/브라우즈 목록과
        // 별개의 객체 참조라 위 갱신들이 닿지 않으므로, 재생 중 표시줄은 직접 패치한다.
        player.currentTrack.title = updated.title;
        player.currentTrack.artist = updated.artist;
        player.currentTrack.album = updated.album;
        nowPlayingApi.setTrack(player.currentTrack, { bustArtCache: true });
      }
    },
    async (trackId) => {
      if (player.currentTrack && player.currentTrack.track_id === trackId) player.stop();
      await playlistApi.refreshCurrent();
      await browseApi.refreshAfterAlbumUpdate();
    }
  );
  setupLyrics(player, (trackId) => playlistApi.refreshHasLyrics(trackId));
  setupPlayTracking(player);
  setupRating(player);
  setupQueueEngine(player);
  setupExpandedPlayer(player, {
    onOpen: () => sidebarApi.closeDrawer(),
    onOpenAlbum: openAlbumFromTrack,
    onOpenArtist: openArtistFromTrack,
  });
  const statsApi = setupStats(player, openAlbumFromTrack, identityDialogApi, openArtistFromTrack, refs);
  const homeApi = setupHome(player, openAlbumFromTrack, openArtistFromTrack);
  const todaySongsApi = setupTodaySongs(
    bootstrap,
    player,
    playlistApi,
    (track) => trackInfoApi.open(track),
    (ids) => bulkEditApi.open(ids),
    openAlbumFromTrack,
    openArtistFromTrack
  );
  const lyricsPanelEl = document.getElementById("lyrics-panel");
  const lyricsToggleBtn = document.getElementById("btn-lyrics-toggle");

  // 가사 패널은 기본적으로 숨겨져 있고, 트랜스포트 바의 토글 버튼으로 세션 중에만
  // 켜고 끌 수 있다(새로고침하면 다시 숨김으로 시작). 통계 화면을 포함해 어느
  // 화면에서든 토글할 수 있다. 다만 통계 화면의 TOP 3 앨범 패널과는 공간이
  // 겹치므로, 가사 패널이 켜져 있는 동안은 TOP 3 앨범을 숨긴다.
  let lyricsVisible = false;
  function syncLyricsPanelDisplay() {
    lyricsPanelEl.style.display = lyricsVisible ? "" : "none";
    // 가사 패널이 나타나거나 사라지면 옆에 있는 재생목록/브라우즈/통계 패널의
    // 실제 폭이 바뀌므로, 각 화면에 이미 있는 리사이즈 시 재계산 로직(컬럼 우선순위
    // 숨김/마퀴 스크롤 여부)이 다시 돌도록 가짜 resize 이벤트를 발생시킨다.
    window.dispatchEvent(new Event("resize"));
  }
  syncLyricsPanelDisplay();
  lyricsToggleBtn.addEventListener("click", () => {
    lyricsVisible = !lyricsVisible;
    lyricsToggleBtn.classList.toggle("active", lyricsVisible);
    syncLyricsPanelDisplay();
    statsApi.setLyricsActive(lyricsVisible);
    browseApi.setLyricsActive(lyricsVisible);
  });

  const browseApi = setupBrowse(
    player,
    playlistApi,
    (track) => trackInfoApi.open(track),
    (group) => albumInfoApi.open(group),
    (ids) => bulkEditApi.open(ids),
    identityDialogApi,
    refs
  );
  const albumInfoApi = setupAlbumInfo((updatedTracks) => {
    playlistApi.refreshTracksInfo(updatedTracks);
    browseApi.refreshAfterAlbumUpdate();
    if (player.currentTrack && updatedTracks.some((t) => t.track_id === player.currentTrack.track_id)) {
      nowPlayingApi.setTrack(player.currentTrack, { bustArtCache: true });
    }
  });
  const bulkEditApi = setupBulkEdit(
    (updatedTracks, trackIds) => {
      if (updatedTracks.length) playlistApi.refreshTracksInfo(updatedTracks);
      playlistApi.clearSelection();
      browseApi.refreshAfterAlbumUpdate();
      browseApi.clearSelection();
      if (player.currentTrack && trackIds.includes(player.currentTrack.track_id)) {
        nowPlayingApi.setTrack(player.currentTrack, { bustArtCache: true });
      }
    },
    async (trackIds) => {
      if (player.currentTrack && trackIds.includes(player.currentTrack.track_id)) player.stop();
      playlistApi.clearSelection();
      browseApi.clearSelection();
      await playlistApi.refreshCurrent();
      await browseApi.refreshAfterAlbumUpdate();
    }
  );

  refs.router = setupRouter({
    onHome: () => {
      playlistApi.hide();
      browseApi.hide();
      statsApi.hide();
      todaySongsApi.hide();
      homeApi.show();
      sidebarApi.setActive("__home__");
      sidebarApi.refreshDataSize();
    },
    onBrowse: (route) => {
      homeApi.hide();
      playlistApi.hide();
      statsApi.hide();
      todaySongsApi.hide();
      const focus = refs.pendingAlbumFocus;
      refs.pendingAlbumFocus = null;
      browseApi.show(route, focus);
      sidebarApi.setActive("__browse__");
      sidebarApi.refreshDataSize();
    },
    onPlaylist: (name) => {
      homeApi.hide();
      browseApi.hide();
      statsApi.hide();
      todaySongsApi.hide();
      playlistApi.show();
      playlistApi.loadPlaylist(name);
      sidebarApi.setActive(name);
      sidebarApi.refreshDataSize();
    },
    onStats: (route) => {
      homeApi.hide();
      playlistApi.hide();
      browseApi.hide();
      todaySongsApi.hide();
      statsApi.show(route);
      sidebarApi.setActive("__stats__");
      sidebarApi.refreshDataSize();
    },
    onToday: () => {
      homeApi.hide();
      playlistApi.hide();
      browseApi.hide();
      statsApi.hide();
      todaySongsApi.show();
      sidebarApi.setActive("__today__");
      sidebarApi.refreshDataSize();
    },
  });

  const initialVolume = bootstrap.settings.volume || 80;
  document.getElementById("volume-slider").value = String(initialVolume);
  nowPlayingApi.updateVolumeFill();
  player.setVolume(initialVolume);
});
