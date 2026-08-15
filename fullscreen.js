"use strict";

(() => {
  const root = document.documentElement;
  const button = document.querySelector("#fullscreenButton");
  if (!button) return;

  let nativeFullscreenOwned = false;

  function notify(message) {
    if (typeof showToast === "function") showToast(message);
  }

  function isImmersive() {
    return root.classList.contains("immersive-mode");
  }

  function setImmersiveMode(active) {
    const changed = isImmersive() !== active;
    root.classList.toggle("immersive-mode", active);
    if (changed) window.dispatchEvent(new Event("quietcamera:immersivechange"));
  }

  function updateButton() {
    const active = isImmersive();
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? "全画面モードを終了" : "全画面モード");
    button.title = active ? "全画面を終了" : "全画面";
    root.style.setProperty("--app-viewport-height", `${window.innerHeight}px`);
  }

  async function enterImmersiveMode() {
    setImmersiveMode(true);
    updateButton();

    if (!document.fullscreenEnabled || typeof root.requestFullscreen !== "function") {
      const installed = window.matchMedia("(display-mode: standalone)").matches
        || window.matchMedia("(display-mode: fullscreen)").matches
        || window.navigator.standalone === true;
      notify(installed
        ? "撮影画面を全画面表示しました"
        : "アプリ内を全画面化しました。URLバーも隠すにはホーム画面へ追加してください");
      return;
    }

    try {
      await root.requestFullscreen({ navigationUI: "hide" });
      nativeFullscreenOwned = document.fullscreenElement === root;
    } catch (error) {
      nativeFullscreenOwned = false;
      console.warn("Native fullscreen was unavailable; using immersive layout only.", error);
      notify("ブラウザの全画面化は利用できないため、撮影画面だけを拡大しました");
    }
  }

  async function exitImmersiveMode() {
    const ownsFullscreen = document.fullscreenElement === root;
    nativeFullscreenOwned = false;
    if (ownsFullscreen && typeof document.exitFullscreen === "function") {
      try { await document.exitFullscreen(); }
      catch (error) { console.warn("Failed to exit fullscreen.", error); }
    }
    setImmersiveMode(false);
    updateButton();
  }

  button.addEventListener("click", async () => {
    if (isImmersive()) await exitImmersiveMode();
    else await enterImmersiveMode();
  });

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement === root) {
      nativeFullscreenOwned = true;
      setImmersiveMode(true);
    } else if (nativeFullscreenOwned) {
      nativeFullscreenOwned = false;
      setImmersiveMode(false);
    }
    updateButton();
  });

  document.addEventListener("keydown", async (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !isImmersive()) return;
    if (document.fullscreenElement || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    await exitImmersiveMode();
    button.focus({ preventScroll: true });
  });

  window.addEventListener("resize", updateButton, { passive: true });
  window.visualViewport?.addEventListener("resize", updateButton, { passive: true });
  updateButton();
})();
