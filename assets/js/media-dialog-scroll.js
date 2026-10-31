"use strict";

// Native modal dialogs make the page inert, but do not consistently stop its
// scroll container (especially touch overscroll). Share one lock across history
// and review so closing history to open a photo never restores the page midway.
(() => {
  const dialogs = [elements.galleryDialog, elements.reviewDialog];
  const root = document.documentElement;
  const body = document.body;
  let saved = null;
  let scheduled = false;

  function saveStyles(element, properties) {
    return {
      element,
      hadAttribute: element.hasAttribute("style"),
      properties: properties.map((property) => ({
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      })),
    };
  }

  function restoreStyles(snapshot) {
    for (const { property, value, priority } of snapshot.properties) {
      if (value) snapshot.element.style.setProperty(property, value, priority);
      else snapshot.element.style.removeProperty(property);
    }
    if (!snapshot.hadAttribute && !snapshot.element.style.length) {
      snapshot.element.removeAttribute("style");
    }
  }

  function lock() {
    if (saved) return;
    const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
    const paddingRight = parseFloat(getComputedStyle(body).paddingRight) || 0;
    saved = {
      x: window.scrollX,
      y: window.scrollY,
      root: saveStyles(root, ["overflow", "overscroll-behavior"]),
      body: saveStyles(body, ["position", "top", "left", "width", "overflow", "padding-right"]),
    };
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    body.style.position = "fixed";
    body.style.top = `${-saved.y}px`;
    body.style.left = `${-saved.x}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    if (scrollbarWidth) body.style.paddingRight = `${paddingRight + scrollbarWidth}px`;
  }

  function synchronize() {
    scheduled = false;
    if (dialogs.some((dialog) => dialog.open)) {
      lock();
    } else if (saved) {
      const snapshot = saved;
      saved = null;
      restoreStyles(snapshot.body);
      restoreStyles(snapshot.root);
      // Ignore any site-level smooth-scroll preference when restoring the page.
      window.scrollTo({ left: snapshot.x, top: snapshot.y, behavior: "instant" });
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(synchronize);
  }

  for (const dialog of dialogs) {
    // beforetoggle captures scroll before native opening/focus work. The
    // observer covers browsers without this event and direct open changes.
    dialog.addEventListener("beforetoggle", (event) => {
      if (event.newState === "open") lock();
      schedule();
    });
    dialog.addEventListener("close", schedule);
    dialog.addEventListener("cancel", schedule);
    new MutationObserver(schedule).observe(dialog, { attributes: true, attributeFilter: ["open"] });
  }
  window.addEventListener("pageshow", schedule);
  synchronize();
})();
