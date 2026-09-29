"use client";

import { useRef, useState } from "react";

export function BlogAudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    // Drive state from the audio element's own play/pause/ended events (below)
    // so the button always reflects real playback, even if play() is blocked.
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause article audio" : "Listen to this article"}
        aria-pressed={playing}
        className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 px-3 py-1 text-xs font-medium text-primary transition-colors hover:border-primary/60 hover:bg-primary/10"
      >
        <span aria-hidden="true">{playing ? "⏸" : "▶"}</span>
        {playing ? "Pause" : "Listen"}
      </button>
      <audio
        ref={audioRef}
        src={src}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        className="hidden"
      />
    </>
  );
}
