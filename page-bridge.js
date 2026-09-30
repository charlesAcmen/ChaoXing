(() => {
  "use strict";

  if (window.__chaoxingExtraSpeedBridgeLoaded) return;
  window.__chaoxingExtraSpeedBridgeLoaded = true;

  const REQUEST_EVENT = "chaoxing-extra-speed-request";
  const lockedVideos = new Set();
  const lockStates = new WeakMap();
  const mediaPrototype = HTMLMediaElement.prototype;
  const nativePause = mediaPrototype.pause;
  const nativePlay = mediaPrototype.play;
  const playbackRateDescriptor = Object.getOwnPropertyDescriptor(mediaPrototype, "playbackRate");
  const defaultPlaybackRateDescriptor = Object.getOwnPropertyDescriptor(mediaPrototype, "defaultPlaybackRate");

  function readPlaybackRate(video) {
    return playbackRateDescriptor.get.call(video);
  }

  function writePlaybackRate(video, speed) {
    playbackRateDescriptor.set.call(video, speed);
  }

  function writeDefaultPlaybackRate(video, speed) {
    defaultPlaybackRateDescriptor.set.call(video, speed);
  }

  function safePlay(video) {
    try {
      const result = nativePlay.call(video);
      result?.catch(() => {});
    } catch (_) {
      // The periodic enforcer retries transient player failures.
    }
  }

  function releaseLock(video) {
    const state = lockStates.get(video);
    if (state) window.clearInterval(state.timerId);
    lockStates.delete(video);
    lockedVideos.delete(video);
    video.removeAttribute("data-cx-extra-speed-locked");
  }

  function enforce(video, state) {
    if (!video.isConnected) {
      releaseLock(video);
      return;
    }

    try {
      if (Math.abs(readPlaybackRate(video) - state.speed) > 0.001) {
        writePlaybackRate(video, state.speed);
      }
      writeDefaultPlaybackRate(video, state.speed);
      if (!state.userPaused && video.paused) safePlay(video);
    } catch (_) {
      // Keep the enforcement loop alive for transient player rebuilds.
    }
  }

  function lockVideo(video, speed, wasPlaying) {
    releaseLock(video);
    if (speed <= 2) return;

    const state = {
      speed,
      userPaused: !wasPlaying,
      allowUserPauseUntil: 0,
      timerId: 0
    };
    lockStates.set(video, state);
    lockedVideos.add(video);
    video.setAttribute("data-cx-extra-speed-locked", String(speed));
    writeDefaultPlaybackRate(video, speed);
    writePlaybackRate(video, speed);
    state.timerId = window.setInterval(() => enforce(video, state), 150);
    enforce(video, state);
  }

  function findVideoForGesture(target) {
    if (!(target instanceof Element)) return null;
    if (target.matches("video")) return target;
    const player = target.closest(".video-js, .vjs-player, [data-player], [class*='video-player']");
    return player?.querySelector("video") || null;
  }

  document.addEventListener(REQUEST_EVENT, (event) => {
    const video = event.target;
    if (!(video instanceof HTMLMediaElement)) return;

    const speed = Number(video.getAttribute("data-cx-extra-speed-request"));
    const wasPlaying = video.getAttribute("data-cx-extra-speed-was-playing") === "true";
    if (Number.isFinite(speed)) lockVideo(video, speed, wasPlaying);
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest(".cx-extra-speed")) return;
    const video = findVideoForGesture(event.target);
    const state = video && lockStates.get(video);
    if (state && event.isTrusted) {
      state.allowUserPauseUntil = performance.now() + 1200;
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || (event.key !== " " && event.key.toLowerCase() !== "k")) return;
    for (const video of lockedVideos) {
      const state = lockStates.get(video);
      if (state) state.allowUserPauseUntil = performance.now() + 1200;
    }
  }, true);

  mediaPrototype.pause = function pause() {
    const state = lockStates.get(this);
    if (!state) return nativePause.call(this);

    if (performance.now() <= state.allowUserPauseUntil) {
      state.userPaused = true;
      return nativePause.call(this);
    }
    return undefined;
  };

  mediaPrototype.play = function play() {
    const state = lockStates.get(this);
    if (state && performance.now() <= state.allowUserPauseUntil) {
      state.userPaused = false;
    }
    return nativePlay.call(this);
  };

  if (playbackRateDescriptor?.get && playbackRateDescriptor?.set) {
    Object.defineProperty(mediaPrototype, "playbackRate", {
      configurable: playbackRateDescriptor.configurable,
      enumerable: playbackRateDescriptor.enumerable,
      get() {
        return playbackRateDescriptor.get.call(this);
      },
      set(requestedSpeed) {
        const state = lockStates.get(this);
        playbackRateDescriptor.set.call(this, state ? state.speed : requestedSpeed);
      }
    });
  }

  if (defaultPlaybackRateDescriptor?.get && defaultPlaybackRateDescriptor?.set) {
    Object.defineProperty(mediaPrototype, "defaultPlaybackRate", {
      configurable: defaultPlaybackRateDescriptor.configurable,
      enumerable: defaultPlaybackRateDescriptor.enumerable,
      get() {
        return defaultPlaybackRateDescriptor.get.call(this);
      },
      set(requestedSpeed) {
        const state = lockStates.get(this);
        defaultPlaybackRateDescriptor.set.call(this, state ? state.speed : requestedSpeed);
      }
    });
  }

  document.addEventListener("pause", (event) => {
    const video = event.target;
    const state = video instanceof HTMLMediaElement && lockStates.get(video);
    if (state && !state.userPaused) queueMicrotask(() => enforce(video, state));
  }, true);
})();
