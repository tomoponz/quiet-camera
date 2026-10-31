"use strict";

// All controllers and their event handlers are installed before application startup.
// The first history read therefore uses the paged loader directly.
registerServiceWorker();
initializeApp().catch((error) => { console.error(error); showToast("保存済みデータの読み込みに失敗しました"); });
