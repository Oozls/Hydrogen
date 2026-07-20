import { PlayerEngine } from "./player.js";
import { setupNowPlaying } from "./nowplaying.js";
import { setupPlaylist } from "./playlist.js";
import { setupLyrics } from "./lyrics.js";
import { setupTrackInfo } from "./trackinfo.js";

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
    (index) => player.playIndex(index),
    (track) => trackInfoApi.open(track)
  );
  const trackInfoApi = setupTrackInfo((trackId, updated) => {
    playlistApi.refreshTrackInfo(trackId, updated);
    if (player.currentTrack && player.currentTrack.track_id === trackId) {
      nowPlayingApi.setTrack(player.currentTrack, { bustArtCache: true });
    }
  });
  setupLyrics(player, (trackId) => playlistApi.refreshHasLyrics(trackId));

  const initialVolume = bootstrap.settings.volume || 80;
  document.getElementById("volume-slider").value = String(initialVolume);
  nowPlayingApi.updateVolumeFill();
  player.setVolume(initialVolume);
});
