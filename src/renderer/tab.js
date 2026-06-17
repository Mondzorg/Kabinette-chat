(async () => {
  const meta = await window.kabinette.meta();
  const tab = document.getElementById("edgeTabButton");
  let edgeSide = meta.config.edgeTabSide === "left" ? "left" : "right";
  let edgeTop = Number.isFinite(Number(meta.config.edgeTabTop)) ? Number(meta.config.edgeTabTop) : 0;
  let edgeDisplayBounds = meta.config.edgeDisplayBounds || null;
  let drag = null;
  let moveRequestId = 0;

  function applyPlacement(result) {
    if (!result?.ok) return;
    if (Number.isFinite(Number(result.edgeTabTop))) edgeTop = Number(result.edgeTabTop);
    edgeSide = result.edgeTabSide === "left" ? "left" : "right";
    edgeDisplayBounds = result.edgeDisplayBounds || edgeDisplayBounds;
    document.body.classList.toggle("edge-side-left", edgeSide === "left");
  }

  async function persistPlacement() {
    await window.kabinette.updateConfig({
      edgeTabTop: Math.round(edgeTop),
      edgeTabSide: edgeSide,
      edgeDisplayBounds
    });
  }

  applyPlacement({
    ok: true,
    edgeTabTop: edgeTop,
    edgeTabSide: edgeSide,
    edgeDisplayBounds
  });

  tab.addEventListener("pointerdown", (event) => {
    drag = {
      startX: event.screenX,
      startY: event.screenY,
      moved: false
    };
    tab.setPointerCapture(event.pointerId);
    tab.classList.add("is-dragging");
    event.preventDefault();
  });

  tab.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const deltaX = event.screenX - drag.startX;
    const deltaY = event.screenY - drag.startY;
    if (Math.hypot(deltaX, deltaY) > 5) drag.moved = true;
    if (!drag.moved) return;
    const requestId = ++moveRequestId;
    window.kabinette.previewClientEdgeDrag({
      screenX: event.screenX,
      screenY: event.screenY
    }).then((result) => {
      if (requestId === moveRequestId) applyPlacement(result);
    }).catch(() => {});
  });

  tab.addEventListener("pointerup", async (event) => {
    if (!drag) return;
    tab.releasePointerCapture(event.pointerId);
    tab.classList.remove("is-dragging");
    const wasDragged = drag.moved;
    drag = null;
    if (wasDragged) {
      applyPlacement(await window.kabinette.setClientEdgeTabPosition({
        screenX: event.screenX,
        screenY: event.screenY
      }));
      await persistPlacement();
      return;
    }
    await window.kabinette.focusWindow();
  });

  tab.addEventListener("pointercancel", () => {
    drag = null;
    tab.classList.remove("is-dragging");
  });
})();
