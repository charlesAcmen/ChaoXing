(() => {
  "use strict";

  if (window.top !== window || window.__chaoxingSyncDebugPanelLoaded) {
    return;
  }
  window.__chaoxingSyncDebugPanelLoaded = true;

  const DEBUG_SOURCE = "chaoxing-extra-speed-debug";
  const MAX_EVENTS = 240;
  const events = [];
  let panel;
  let list;
  let summary;
  let copyStatus;
  let showAllNetwork = false;

  function formatMedia(media) {
    if (!media) return "";
    const current = Number.isFinite(media.currentTime) ? media.currentTime.toFixed(1) : "?";
    const duration = Number.isFinite(media.duration) ? media.duration.toFixed(1) : "?";
    const rate = Number.isFinite(media.playbackRate) ? media.playbackRate : "?";
    return ` · ${current}/${duration}s · ${rate}x${media.paused ? " · paused" : ""}`;
  }

  function formatSafeValues(entry) {
    const values = Object.entries(entry.safeValues || {});
    return values.length > 0
      ? ` · values=${values.map(([key, value]) => `${key}=${value}`).join(",")}`
      : "";
  }

  function formatResponse(entry) {
    return entry.responseSummary
      ? ` · response=${JSON.stringify(entry.responseSummary)}`
      : "";
  }

  function formatEvent(entry) {
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour12: false });
    if (entry.kind === "media") {
      return `${time}  MEDIA  ${entry.event}${formatMedia(entry.media)} · ${entry.frame}`;
    }
    if (entry.kind === "bridge") {
      const caller = entry.callers?.length ? `\n    from ${entry.callers.join("\n    from ")}` : "";
      return `${time}  BRIDGE ${entry.event}${formatMedia(entry.media)} · ${entry.frame}${caller}`;
    }

    const direction = entry.phase === "start" ? "↑" : "↓";
    const status = entry.phase === "start"
      ? "pending"
      : `${entry.status ?? entry.outcome ?? "done"}${entry.elapsedMs != null ? ` · ${entry.elapsedMs}ms` : ""}`;
    const keys = entry.keys?.length ? ` · keys=${entry.keys.join(",")}` : "";
    return `${time}  ${direction} #${entry.requestId} ${entry.transport.toUpperCase()} ${entry.method} ${entry.endpoint} · ${status}${keys}${formatSafeValues(entry)}${formatResponse(entry)}${formatMedia(entry.media)}`;
  }

  function isVisible(entry) {
    return entry.kind !== "network" || showAllNetwork || entry.likelySync || entry.status === 0 || entry.outcome === "error";
  }

  function render() {
    if (!list) return;
    list.replaceChildren();
    const visible = events.filter(isVisible);
    for (const entry of visible) {
      const row = document.createElement("div");
      row.className = `cx-sync-debug-row cx-sync-debug-row--${entry.kind}`;
      if (entry.kind === "network" && entry.likelySync) {
        row.classList.add("is-sync");
      }
      row.textContent = formatEvent(entry);
      list.append(row);
    }
    summary.textContent = `${visible.length}/${events.length} 条`;
    list.scrollTop = list.scrollHeight;
  }

  function serializeEvents() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      page: `${location.origin}${location.pathname}`,
      note: "Query/body values are omitted except safe numeric playback fields.",
      events
    }, null, 2);
  }

  function createButton(label, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    return button;
  }

  function mount() {
    if (panel?.isConnected || !document.body) return;

    panel = document.createElement("section");
    panel.className = "cx-sync-debug";
    panel.setAttribute("aria-label", "超星同步调试");

    const header = document.createElement("div");
    header.className = "cx-sync-debug-header";
    const title = document.createElement("strong");
    title.textContent = "同步调试";
    summary = document.createElement("span");
    summary.className = "cx-sync-debug-summary";

    const actions = document.createElement("div");
    actions.className = "cx-sync-debug-actions";
    const copy = createButton("复制", "复制脱敏后的完整调试日志");
    const clear = createButton("清空", "清空当前调试日志");
    const collapse = createButton("−", "折叠或展开调试窗口");
    actions.append(copy, clear, collapse);
    header.append(title, summary, actions);

    const toolbar = document.createElement("label");
    toolbar.className = "cx-sync-debug-toolbar";
    const allNetwork = document.createElement("input");
    allNetwork.type = "checkbox";
    toolbar.append(allNetwork, document.createTextNode("显示全部网络请求（默认只显示疑似同步请求）"));

    copyStatus = document.createElement("div");
    copyStatus.className = "cx-sync-debug-copy-status";
    list = document.createElement("div");
    list.className = "cx-sync-debug-list";

    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(serializeEvents());
        copyStatus.textContent = "已复制脱敏日志";
      } catch (_) {
        copyStatus.textContent = "复制失败，请在开发者工具中复制";
      }
      window.setTimeout(() => {
        copyStatus.textContent = "";
      }, 1800);
    });
    clear.addEventListener("click", () => {
      events.length = 0;
      render();
    });
    collapse.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("is-collapsed");
      collapse.textContent = collapsed ? "+" : "−";
    });
    allNetwork.addEventListener("change", () => {
      showAllNetwork = allNetwork.checked;
      render();
    });

    panel.append(header, toolbar, copyStatus, list);
    document.body.append(panel);
    render();
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.source !== DEBUG_SOURCE || typeof message.payload !== "object") {
      return;
    }

    events.push(message.payload);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    mount();
    render();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
