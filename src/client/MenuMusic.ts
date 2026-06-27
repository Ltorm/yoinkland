// Background menu music via a hidden YouTube player, with a homepage mute
// toggle.
//
// Browsers block autoplay *with sound*, so we always start the player muted
// (allowed) and only enable sound on a user gesture — either the first click
// anywhere, or the mute button. The choice is remembered across reloads. The
// track pauses in-game (body gets `.in-game`) and resumes on the menu.

const VIDEO_ID = "aKKpqIw-D0A";
const VOLUME = 30;
const STORAGE_KEY = "yoinkland.musicMuted";

// Minimal shape of the YouTube IFrame player we use.
interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  mute(): void;
  unMute(): void;
  setVolume(v: number): void;
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
}

let player: YTPlayer | null = null;
let muted = localStorage.getItem(STORAGE_KEY) === "1"; // user preference
let button: HTMLButtonElement | null = null;
let seeded = false; // jumped to a random start position yet?

// Jump to a random spot in the track (once duration is known) so each load
// starts somewhere different.
function seekRandomOnce(p: YTPlayer): void {
  if (seeded) return;
  let duration = 0;
  try {
    duration = p.getDuration();
  } catch {
    return;
  }
  if (!duration || duration < 5) return; // not loaded yet
  seeded = true;
  try {
    p.seekTo(Math.random() * duration * 0.9, true); // avoid the very end
  } catch {
    /* ignore */
  }
}

function inGame(): boolean {
  return document.body.classList.contains("in-game");
}

function applyAudio(): void {
  if (player === null) return;
  try {
    player.setVolume(VOLUME);
    if (muted) player.mute();
    else player.unMute();
  } catch {
    /* player not ready yet */
  }
}

function syncPlayState(): void {
  if (player !== null) {
    try {
      if (inGame()) player.pauseVideo();
      else player.playVideo();
    } catch {
      /* not ready */
    }
  }
  // Hide the toggle in-game; show it on the menu.
  if (button !== null) button.style.display = inGame() ? "none" : "flex";
}

function updateButton(): void {
  if (button === null) return;
  button.textContent = muted ? "🔇" : "🔊";
  button.setAttribute(
    "aria-label",
    muted ? "Unmute menu music" : "Mute menu music",
  );
  button.title = muted ? "Unmute music" : "Mute music";
}

function createButton(): void {
  const btn = document.createElement("button");
  btn.id = "menu-music-toggle";
  btn.style.cssText = [
    "position:fixed",
    "left:16px",
    "bottom:72px",
    "z-index:60",
    "width:44px",
    "height:44px",
    "border-radius:9999px",
    "border:1px solid rgba(253,230,138,0.35)",
    "background:rgba(24,24,27,0.85)",
    "color:#fde68a",
    "font-size:20px",
    "line-height:1",
    "cursor:pointer",
    "align-items:center",
    "justify-content:center",
    "backdrop-filter:blur(6px)",
    "box-shadow:0 2px 8px rgba(0,0,0,0.4)",
  ].join(";");
  btn.addEventListener("click", () => {
    muted = !muted;
    localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
    applyAudio();
    updateButton();
    syncPlayState();
  });
  document.body.appendChild(btn);
  button = btn;
  updateButton();
  syncPlayState();
}

export function initMenuMusic(): void {
  // Hidden, off-screen container the API replaces with an <iframe>.
  const host = document.createElement("div");
  host.id = "yt-menu-music";
  host.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;opacity:0;";
  document.body.appendChild(host);

  createButton();

  const w = window as unknown as {
    YT?: { Player: new (id: string, opts: unknown) => YTPlayer };
    onYouTubeIframeAPIReady?: () => void;
  };

  const createPlayer = () => {
    if (!w.YT) return;
    player = new w.YT.Player("yt-menu-music", {
      videoId: VIDEO_ID,
      playerVars: {
        autoplay: 1,
        controls: 0,
        disablekb: 1,
        fs: 0,
        loop: 1,
        playlist: VIDEO_ID, // loop requires the playlist param
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: (e: { target: YTPlayer }) => {
          // Always start muted (autoplay policy); the gesture below enables it.
          e.target.setVolume(VOLUME);
          e.target.mute();
          syncPlayState();
          seekRandomOnce(e.target); // in case duration is already known
        },
        // Once playback/buffering begins the duration is known — jump to a
        // random spot so each load starts somewhere different.
        onStateChange: (e: { data: number; target: YTPlayer }) => {
          if (e.data === 1 || e.data === 3) seekRandomOnce(e.target);
        },
      },
    });
  };

  // Load the IFrame API (once) and create the player when it's ready.
  if (w.YT && w.YT.Player) {
    createPlayer();
  } else {
    w.onYouTubeIframeAPIReady = createPlayer;
    if (!document.querySelector('script[data-yt-iframe-api="1"]')) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.dataset.ytIframeApi = "1";
      document.head.appendChild(tag);
    }
  }

  // On the first user gesture, enable sound unless the player explicitly muted.
  const onFirstInteraction = () => {
    if (!muted) applyAudio();
    syncPlayState();
    window.removeEventListener("pointerdown", onFirstInteraction);
    window.removeEventListener("keydown", onFirstInteraction);
    window.removeEventListener("touchstart", onFirstInteraction);
  };
  window.addEventListener("pointerdown", onFirstInteraction, { once: true });
  window.addEventListener("keydown", onFirstInteraction, { once: true });
  window.addEventListener("touchstart", onFirstInteraction, { once: true });

  // Pause in-game / resume on the menu (and toggle the button) by watching the
  // body class.
  new MutationObserver(syncPlayState).observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
