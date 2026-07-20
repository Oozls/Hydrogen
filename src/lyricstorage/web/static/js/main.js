import { PlayerEngine } from "./player.js";
import { setupNowPlaying } from "./nowplaying.js";
import { setupPlaylist } from "./playlist.js";
import { setupLyrics } from "./lyrics.js";
import { setupTrackInfo } from "./trackinfo.js";
import { setupPlayTracking } from "./playtracking.js";
import { setupStats } from "./stats.js";
import { setupBrowse } from "./browse.js";
import { setupAlbumInfo } from "./albuminfo.js";

function readBootstrap() {
  const el = document.getElementById("bootstrap-data");
  return JSON.parse(el.textContent);
}

document.addEventListener("DOMContentLoaded", () => {
  const bootstrap = readBootstrap();
  const audioEl = document.getElementById("audio-element");
  const player = new PlayerEngine(audioEl);

  const nowPlayingApi = setupNowPlaying(player);
  const playlistApi = setupPlaylist(
    player,
    bootstrap,
    (index) => {
      if (player.playlist !== playlistApi.getCurrentPlaylist()) {
        player.syncTracks(playlistApi.getCurrentPlaylist());
      }
      player.playIndex(index);
    },
    (track) => trackInfoApi.open(track)
  );
  const trackInfoApi = setupTrackInfo((trackId, updated) => {
    playlistApi.refreshTrackInfo(trackId, updated);
    if (player.currentTrack && player.currentTrack.track_id === trackId) {
      nowPlayingApi.setTrack(player.currentTrack, { bustArtCache: true });
    }
  });
  setupLyrics(player, (trackId) => playlistApi.refreshHasLyrics(trackId));
  setupPlayTracking(player);
  setupStats();

  const browseApi = setupBrowse(
    player,
    playlistApi,
    (track) => trackInfoApi.open(track),
    (group) => albumInfoApi.open(group)
  );
  const albumInfoApi = setupAlbumInfo((updatedTracks) => {
    playlistApi.refreshTracksInfo(updatedTracks);
    browseApi.refreshAfterAlbumUpdate();
    if (player.currentTrack && updatedTracks.some((t) => t.track_id === player.currentTrack.track_id)) {
      nowPlayingApi.setTrack(player.currentTrack, { bustArtCache: true });
    }
  });

  const initialVolume = bootstrap.settings.volume || 80;
  document.getElementById("volume-slider").value = String(initialVolume);
  nowPlayingApi.updateVolumeFill();
  player.setVolume(initialVolume);
});
