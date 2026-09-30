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
  const DEBUG_SOURCE = "chaoxing-extra-speed-debug";
  const SAFE_VALUE_KEY = /^(playingtime|currenttime|watchtime|duration|attduration|cliptime|position|rate|rt|speed|isdrag|ispassed)$/i;
  const RESPONSE_STATUS_KEY = /^(ispassed|passed|success|status|code|msg|message|error|errormsg|result)$/i;
  const SYNC_HINT = /(log|progress|save|study|learn|report|watch|multimedia|job)/i;
  const xhrRequests = new WeakMap();
  const lastTimeUpdate = new WeakMap();
  const frameDebugId = Math.random().toString(36).slice(2, 6);
  let nextRequestId = 1;

  // Stop intercepting the player's native completion sequence at the very end.
  // At 16x, 0.25 seconds of media is only about 16 ms of wall-clock time.
  const COMPLETION_MARGIN_SECONDS = 0.25;

  function snapshotMedia(video = document.querySelector("video")) {
    if (!(video instanceof HTMLMediaElement)) return null;
    return {
      currentTime: Number(video.currentTime),
      duration: Number(video.duration),
      playbackRate: Number(video.playbackRate),
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      readyState: Number(video.readyState)
    };
  }

  function emitDebug(payload) {
    const message = {
      source: DEBUG_SOURCE,
      payload: {
        timestamp: Date.now(),
        frame: location.hostname,
        ...payload
      }
    };
    try {
      window.top.postMessage(message, "*");
    } catch (_) {
      // Debugging must never affect playback or page networking.
    }
  }

  function collectFields(target, keys, safeValues) {
    if (!target) return;
    const add = (key, value) => {
      const normalizedKey = String(key);
      keys.add(normalizedKey);
      if (SAFE_VALUE_KEY.test(normalizedKey) && /^(?:-?\d+(?:\.\d+)?|true|false|\d+(?:[_:-]\d+)+)$/i.test(String(value))) {
        safeValues[normalizedKey] = String(value);
      }
    };

    if (target instanceof URLSearchParams || target instanceof FormData) {
      for (const [key, value] of target.entries()) add(key, value);
      return;
    }
    if (typeof target === "string") {
      try {
        const parsed = JSON.parse(target);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          Object.entries(parsed).forEach(([key, value]) => add(key, value));
          return;
        }
      } catch (_) {
        // Form-encoded bodies are handled below.
      }
      if (target.includes("=")) {
        for (const [key, value] of new URLSearchParams(target).entries()) add(key, value);
      }
    }
  }

  function inspectRequest(rawUrl, body) {
    const keys = new Set();
    const safeValues = {};
    let endpoint = String(rawUrl || "unknown");
    try {
      const url = new URL(endpoint, location.href);
      collectFields(url.searchParams, keys, safeValues);
      endpoint = `${url.hostname}${url.pathname}`;
    } catch (_) {
      endpoint = endpoint.split("?")[0];
    }
    collectFields(body, keys, safeValues);
    const keyList = [...keys].sort();
    return {
      endpoint,
      keys: keyList,
      safeValues,
      likelySync: SYNC_HINT.test(endpoint) || keyList.some((key) => SYNC_HINT.test(key) || SAFE_VALUE_KEY.test(key))
    };
  }

  function startNetwork(transport, method, rawUrl, body) {
    const requestId = `${frameDebugId}-${nextRequestId++}`;
    const inspected = inspectRequest(rawUrl, body);
    const startedAt = performance.now();
    emitDebug({
      kind: "network",
      phase: "start",
      requestId,
      transport,
      method: String(method || "GET").toUpperCase(),
      ...inspected,
      media: snapshotMedia()
    });
    return { requestId, startedAt, ...inspected };
  }

  function summarizeResponse(value, depth = 0) {
    if (depth > 2 || value == null) return null;
    if (typeof value !== "object") {
      if (["string", "number", "boolean"].includes(typeof value)) return value;
      return null;
    }

    const summary = {};
    for (const [key, child] of Object.entries(value)) {
      if (RESPONSE_STATUS_KEY.test(key) && ["string", "number", "boolean"].includes(typeof child)) {
        summary[key] = String(child).slice(0, 160);
        continue;
      }
      const nested = summarizeResponse(child, depth + 1);
      if (nested && typeof nested === "object" && Object.keys(nested).length > 0) {
        summary[key] = nested;
      }
    }
    return Object.keys(summary).length > 0 ? summary : null;
  }

  function summarizeResponseText(text) {
    if (typeof text !== "string" || !text.trim()) return null;
    try {
      return summarizeResponse(JSON.parse(text));
    } catch (_) {
      const trimmed = text.trim();
      if (/^(?:true|false|ok|success|failed?|\d+)$/i.test(trimmed)) {
        return { text: trimmed.slice(0, 40) };
      }
      return { unparsedLength: trimmed.length };
    }
  }

  function finishNetwork(meta, transport, method, status, outcome = "complete", responseSummary = null) {
    emitDebug({
      kind: "network",
      phase: "complete",
      requestId: meta.requestId,
      transport,
      method: String(method || "GET").toUpperCase(),
      endpoint: meta.endpoint,
      keys: meta.keys,
      safeValues: meta.safeValues,
      likelySync: meta.likelySync,
      status,
      outcome,
      responseSummary,
      elapsedMs: Math.round(performance.now() - meta.startedAt),
      media: snapshotMedia()
    });
  }

  function captureCallers() {
    const stack = String(new Error().stack || "").split("\n").slice(2);
    return stack
      .filter((line) => !line.includes("page-bridge.js"))
      .slice(0, 4)
      .map((line) => line.trim().replace(/\?[^\s)]+/g, "?…"));
  }

  function writePlaybackRate(video, speed) {
    playbackRateDescriptor.set.call(video, speed);
  }

  function writeDefaultPlaybackRate(video, speed) {
    defaultPlaybackRateDescriptor.set.call(video, speed);
  }

  function isCompleting(video) {
    const duration = Number(video.duration);
    const currentTime = Number(video.currentTime);
    return video.ended || (
      Number.isFinite(duration)
      && duration > 0
      && Number.isFinite(currentTime)
      && currentTime >= duration - COMPLETION_MARGIN_SECONDS
    );
  }

  function releaseLock(video, reason = "release") {
    const state = lockStates.get(video);
    if (state) {
      video.removeEventListener("ended", state.onEnded);
      video.removeEventListener("emptied", state.onEmptied);
      emitDebug({ kind: "bridge", event: `speed-lock-${reason}`, media: snapshotMedia(video) });
    }
    lockStates.delete(video);
    lockedVideos.delete(video);
    video.removeAttribute("data-cx-extra-speed-locked");
  }

  function lockVideo(video, speed) {
    releaseLock(video, "replaced");
    if (speed <= 2) return;

    const state = {
      speed,
      allowUserPauseUntil: 0,
      onEnded: () => releaseLock(video, "ended"),
      onEmptied: () => releaseLock(video, "emptied")
    };
    lockStates.set(video, state);
    lockedVideos.add(video);
    video.setAttribute("data-cx-extra-speed-locked", String(speed));
    writeDefaultPlaybackRate(video, speed);
    writePlaybackRate(video, speed);
    video.addEventListener("ended", state.onEnded, { once: true });
    video.addEventListener("emptied", state.onEmptied, { once: true });
    emitDebug({ kind: "bridge", event: `speed-lock-${speed}x`, media: snapshotMedia(video) });
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
    if (Number.isFinite(speed)) lockVideo(video, speed);
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

    if (isCompleting(this)) {
      emitDebug({ kind: "bridge", event: "pause-allowed-completion", media: snapshotMedia(this) });
      releaseLock(this, "completion");
      return nativePause.call(this);
    }

    if (performance.now() <= state.allowUserPauseUntil) {
      emitDebug({ kind: "bridge", event: "pause-allowed-user", media: snapshotMedia(this) });
      return nativePause.call(this);
    }

    // Ignore page-driven pauses during ordinary playback. This covers the
    // visibility-change and in-player quiz-overlay pauses without auto-playing.
    emitDebug({
      kind: "bridge",
      event: "pause-blocked-page",
      media: snapshotMedia(this),
      callers: captureCallers()
    });
    return undefined;
  };

  mediaPrototype.play = function play() {
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
        let state = lockStates.get(this);
        if (state && isCompleting(this)) {
          releaseLock(this, "completion-rate-write");
          state = null;
        }
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
        let state = lockStates.get(this);
        if (state && isCompleting(this)) {
          releaseLock(this, "completion-default-rate-write");
          state = null;
        }
        defaultPlaybackRateDescriptor.set.call(this, state ? state.speed : requestedSpeed);
      }
    });
  }

  // Capture completion before target-level player handlers run, so Chaoxing's
  // own ended/sync callbacks see unmodified media behavior.
  document.addEventListener("ended", (event) => {
    const video = event.target;
    if (video instanceof HTMLMediaElement) releaseLock(video, "ended-capture");
  }, true);

  document.addEventListener("emptied", (event) => {
    const video = event.target;
    if (video instanceof HTMLMediaElement) releaseLock(video, "emptied-capture");
  }, true);

  for (const eventName of ["play", "pause", "ended", "ratechange", "waiting", "stalled", "emptied", "loadedmetadata"]) {
    document.addEventListener(eventName, (event) => {
      const video = event.target;
      if (video instanceof HTMLMediaElement) {
        emitDebug({ kind: "media", event: eventName, media: snapshotMedia(video) });
      }
    }, true);
  }

  document.addEventListener("timeupdate", (event) => {
    const video = event.target;
    if (!(video instanceof HTMLMediaElement)) return;
    const now = performance.now();
    if (now - (lastTimeUpdate.get(video) || 0) < 1000 && !video.ended) return;
    lastTimeUpdate.set(video, now);
    emitDebug({ kind: "media", event: "timeupdate", media: snapshotMedia(video) });
  }, true);

  document.addEventListener("visibilitychange", () => {
    emitDebug({
      kind: "media",
      event: `visibility-${document.visibilityState}`,
      media: snapshotMedia()
    });
  }, true);

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = function fetch(input, init) {
      const rawUrl = input instanceof Request ? input.url : input;
      const method = init?.method || (input instanceof Request ? input.method : "GET");
      const meta = startNetwork("fetch", method, rawUrl, init?.body);
      try {
        const result = Reflect.apply(nativeFetch, this, arguments);
        result.then(
          (response) => {
            if (!meta.likelySync) {
              finishNetwork(meta, "fetch", method, response.status);
              return;
            }
            response.clone().text().then(
              (text) => finishNetwork(meta, "fetch", method, response.status, "complete", summarizeResponseText(text)),
              () => finishNetwork(meta, "fetch", method, response.status)
            );
          },
          () => finishNetwork(meta, "fetch", method, 0, "error")
        );
        return result;
      } catch (error) {
        finishNetwork(meta, "fetch", method, 0, "error");
        throw error;
      }
    };
  }

  const xhrPrototype = XMLHttpRequest.prototype;
  const nativeXhrOpen = xhrPrototype.open;
  const nativeXhrSend = xhrPrototype.send;
  xhrPrototype.open = function open(method, url) {
    xhrRequests.set(this, { method, url });
    return Reflect.apply(nativeXhrOpen, this, arguments);
  };
  xhrPrototype.send = function send(body) {
    const request = xhrRequests.get(this) || { method: "GET", url: "unknown" };
    const meta = startNetwork("xhr", request.method, request.url, body);
    this.addEventListener("loadend", () => {
      let responseSummary = null;
      if (meta.likelySync) {
        try {
          responseSummary = this.responseType === "json"
            ? summarizeResponse(this.response)
            : summarizeResponseText(this.responseText);
        } catch (_) {
          responseSummary = null;
        }
      }
      finishNetwork(
        meta,
        "xhr",
        request.method,
        this.status,
        this.status === 0 ? "error" : "complete",
        responseSummary
      );
    }, { once: true });
    return Reflect.apply(nativeXhrSend, this, arguments);
  };

  const nativeSendBeacon = navigator.sendBeacon;
  if (typeof nativeSendBeacon === "function") {
    navigator.sendBeacon = function sendBeacon(url, data) {
      const meta = startNetwork("beacon", "POST", url, data);
      try {
        const accepted = Reflect.apply(nativeSendBeacon, this, arguments);
        finishNetwork(meta, "beacon", "POST", accepted ? "accepted" : "rejected", accepted ? "queued" : "rejected");
        return accepted;
      } catch (error) {
        finishNetwork(meta, "beacon", "POST", 0, "error");
        throw error;
      }
    };
  }
})();
