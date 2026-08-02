"use strict";

(() => {
  const root = document.documentElement;
  const button = document.querySelector("#fullscreenButton");
  if (!button) return;

  let nativeFullscreenActive = false;

  function notify(message) {
    if (typeof showToast === "function") showToast(message);
  }

  function isImmersive() {
    return root.classList.contains("immersive-mode");
  }

  function updateButton() {
    const active = isImmersive();
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", active ? "全画面モードを終了" : "全画面モード");
    button.title = active ? "全画面を終了" : "全画面";
    root.style.setProperty("--app-viewport-height", `${window.innerHeight}px`);
  }

  async function enterImmersiveMode() {
    root.classList.add("immersive-mode");
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
      nativeFullscreenActive = true;
    } catch (error) {
      console.warn("Native fullscreen was unavailable; using immersive layout only.", error);
      notify("ブラウザの全画面化は利用できないため、撮影画面だけを拡大しました");
    }
  }

  async function exitImmersiveMode() {
    nativeFullscreenActive = false;
    if (document.fullscreenElement && typeof document.exitFullscreen === "function") {
      try { await document.exitFullscreen(); }
      catch (error) { console.warn("Failed to exit fullscreen.", error); }
    }
    root.classList.remove("immersive-mode");
    updateButton();
  }

  button.addEventListener("click", async () => {
    if (isImmersive()) await exitImmersiveMode();
    else await enterImmersiveMode();
  });

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) {
      nativeFullscreenActive = true;
      root.classList.add("immersive-mode");
    } else if (nativeFullscreenActive) {
      nativeFullscreenActive = false;
      root.classList.remove("immersive-mode");
    }
    updateButton();
  });

  window.addEventListener("resize", updateButton, { passive: true });
  window.visualViewport?.addEventListener("resize", updateButton, { passive: true });
  updateButton();
})();
