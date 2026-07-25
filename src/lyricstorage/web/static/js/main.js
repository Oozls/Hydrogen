import { PlayerEngine } from "./player.js";
import { setupNowPlaying } from "./nowplaying.js";
import { setupPlaylist } from "./playlist.js";
import { setupLyrics } from "./lyrics.js";
import { setupTrackInfo } from "./trackinfo.js";
import { setupBulkEdit } from "./bulkedit.js";
import { setupPlayTracking } from "./playtracking.js";
import { setupStats } from "./stats.js";
import { setupBrowse } from "./browse.js";
import { setupAlbumInfo } from "./albuminfo.js";
import { setupSidebar } from "./sidebar.js";
import { setupRouter } from "./router.js";

function readBootstrap() {
  const el = document.getElementById("bootstrap-data");
  return JSON.parse(el.textContent);
}

document.addEventListener("DOMContentLoaded", () => {
  const bootstrap = readBootstrap();
  const audioEl = document.getElementById("audio-element");
  const player = new PlayerEngine(audioEl);

  const refs = { router: null };

  const nowPlayingApi = setupNowPlaying(player);
  const sidebarApi = setupSidebar(bootstrap, {
    onSelectPlaylist: (name) => refs.router.goPlaylist(name),
    onGoBrowse: () => refs.router.goBrowse(),
    onGoStats: () => refs.router.goStats(),
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
    { sidebarApi, refs, onBulkEdit: (ids) => bulkEditApi.open(ids) }
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
  const statsApi = setupStats();
  const lyricsPanelEl = document.getElementById("lyrics-panel");

  const browseApi = setupBrowse(
    player,
    playlistApi,
    (track) => trackInfoApi.open(track),
    (group) => albumInfoApi.open(group),
    (ids) => bulkEditApi.open(ids)
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
    onBrowse: () => {
      playlistApi.hide();
      statsApi.hide();
      lyricsPanelEl.style.display = "";
      browseApi.show();
      sidebarApi.setActive(null);
      sidebarApi.refreshDataSize();
    },
    onPlaylist: (name) => {
      browseApi.hide();
      statsApi.hide();
      lyricsPanelEl.style.display = "";
      playlistApi.show();
      playlistApi.loadPlaylist(name);
      sidebarApi.setActive(name);
      sidebarApi.refreshDataSize();
    },
    onStats: () => {
      playlistApi.hide();
      browseApi.hide();
      lyricsPanelEl.style.display = "none";
      statsApi.show();
      sidebarApi.setActive("__stats__");
      sidebarApi.refreshDataSize();
    },
  });

  const initialVolume = bootstrap.settings.volume || 80;
  document.getElementById("volume-slider").value = String(initialVolume);
  nowPlayingApi.updateVolumeFill();
  player.setVolume(initialVolume);
});
