(() => {
  "use strict";

  if (window.__chaoxingExtraSpeedLoaded) {
    return;
  }
  window.__chaoxingExtraSpeedLoaded = true;

  // Blink accepts playbackRate values up to 16.0.
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8, 10, 12, 16];
  const bindings = new WeakMap();
  const POLL_INTERVAL_MS = 500;
  const MAX_POLL_ATTEMPTS = 60;
  const recoveryStates = new WeakMap();

  function formatSpeed(speed) {
    return `${Number(speed).toFixed(2).replace(/\.0+$|0+$/g, "")}x`;
  }

  function closeAllMenus(except) {
    document.querySelectorAll(".cx-extra-speed.is-open").forEach((control) => {
      if (control !== except) {
        control.classList.remove("is-open");
        control.querySelector(".cx-extra-speed-button")?.setAttribute("aria-expanded", "false");
      }
    });
  }

  function findMount(video) {
    // Chaoxing/Video.js may rebuild its control bar after initialization and
    // remove unknown children. Mount to the frame body instead so the button
    // remains visible and independent from the player's internal DOM.
    return { mount: document.body, mode: "fixed" };
  }

  function updateSelection(video, control) {
    const current = Number(video.playbackRate) || 1;
    const label = control.querySelector(".cx-extra-speed-label");
    const nextLabel = `倍速 ${formatSpeed(current)}`;
    if (label && label.textContent !== nextLabel) {
      label.textContent = nextLabel;
    }

    control.querySelectorAll(".cx-extra-speed-option").forEach((option) => {
      const selected = Math.abs(Number(option.dataset.speed) - current) < 0.001;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-checked", String(selected));
    });
  }

  function cancelRecovery(video) {
    const previous = recoveryStates.get(video);
    if (!previous) {
      return;
    }

    previous.timerIds.forEach(window.clearTimeout);
    recoveryStates.delete(video);
  }

  function applyPlaybackSpeed(video, speed) {
    cancelRecovery(video);
    const shouldResume = !video.paused;

    video.setAttribute("data-cx-extra-speed-request", String(speed));
    video.setAttribute("data-cx-extra-speed-was-playing", String(shouldResume));
    video.dispatchEvent(new Event("chaoxing-extra-speed-request"));
    video.removeAttribute("data-cx-extra-speed-request");
    video.removeAttribute("data-cx-extra-speed-was-playing");

    try {
      video.defaultPlaybackRate = speed;
      video.playbackRate = speed;
    } catch (error) {
      console.warn("[超星视频增强倍速] 浏览器拒绝了该倍速：", speed, error);
      return;
    }

    if (speed <= 2 || !shouldResume) {
      return;
    }

    // Chaoxing may react to ratechange by pausing the video. Retry only for a
    // short window after this explicit user action; never override later or
    // user-initiated pauses.
    const state = { speed, timerIds: [] };
    recoveryStates.set(video, state);

    const recover = () => {
      if (recoveryStates.get(video) !== state) {
        return;
      }

      try {
        if (Math.abs(video.playbackRate - speed) > 0.001) {
          video.playbackRate = speed;
        }
        if (video.paused) {
          const playResult = video.play();
          playResult?.catch(() => {});
        }
      } catch (error) {
        console.warn("[超星视频增强倍速] 恢复播放失败：", error);
      }
    };

    [50, 200, 600, 1200].forEach((delay) => {
      state.timerIds.push(window.setTimeout(recover, delay));
    });
    state.timerIds.push(window.setTimeout(() => {
      if (recoveryStates.get(video) === state) {
        recoveryStates.delete(video);
      }
    }, 1500));
  }

  function createControl(video, mode) {
    const control = document.createElement("div");
    control.className = `cx-extra-speed cx-extra-speed--${mode}`;
    control.dataset.chaoxingExtraSpeed = "true";

    if (mode === "control-bar") {
      control.classList.add("vjs-control");
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cx-extra-speed-button";
    button.title = "选择播放倍速";
    button.setAttribute("aria-label", "选择播放倍速");
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "cx-extra-speed-label";
    button.append(label);

    const menu = document.createElement("div");
    menu.className = "cx-extra-speed-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "播放倍速");

    for (const speed of SPEEDS) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "cx-extra-speed-option";
      option.dataset.speed = String(speed);
      option.textContent = formatSpeed(speed);
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", "false");
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyPlaybackSpeed(video, speed);
        updateSelection(video, control);
        control.classList.remove("is-open");
        button.setAttribute("aria-expanded", "false");
      });
      menu.append(option);
    }

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const willOpen = !control.classList.contains("is-open");
      closeAllMenus(control);
      control.classList.toggle("is-open", willOpen);
      button.setAttribute("aria-expanded", String(willOpen));
    });

    control.append(button, menu);
    updateSelection(video, control);
    return control;
  }

  function installForVideo(video) {
    const previous = bindings.get(video);
    if (previous?.control.isConnected) {
      updateSelection(video, previous.control);
      return;
    }

    if (previous) {
      video.removeEventListener("ratechange", previous.onRateChange);
    }

    const { mount, mode } = findMount(video);
    if (!mount) {
      return;
    }

    const control = createControl(video, mode);
    mount.append(control);

    const onRateChange = () => updateSelection(video, control);
    video.addEventListener("ratechange", onRateChange);
    bindings.set(video, { control, onRateChange });
  }

  function pollForVideos(attempt = 0) {
    const videos = document.querySelectorAll("video");
    videos.forEach(installForVideo);

    // A Chaoxing video normally lives in its own iframe. Once found, no
    // document-wide observer is needed; navigating chapters creates a new
    // iframe document and therefore a fresh content-script instance.
    if (videos.length > 0 || attempt >= MAX_POLL_ATTEMPTS - 1) {
      return;
    }

    window.setTimeout(() => pollForVideos(attempt + 1), POLL_INTERVAL_MS);
  }

  document.addEventListener("click", () => closeAllMenus(), true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeAllMenus();
    }
  });

  pollForVideos();
})();
