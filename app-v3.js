"use strict";

(async () => {
  const scripts = [
    "./utils-v3.js",
    "./storage-v3.js",
    "./core-v3.js",
    "./photo-v3.js",
    "./video-v3.js",
    "./ui-v3.js",
  ];

  for (const src of scripts) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`${src}を読み込めませんでした`));
      document.head.append(script);
    });
  }
})().catch((error) => {
  console.error(error);
  const toast = document.querySelector("#toast");
  if (toast) {
    toast.textContent = "アプリの読み込みに失敗しました";
    toast.classList.add("visible");
  }
});
