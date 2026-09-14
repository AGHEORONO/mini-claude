// Native bridge: only active inside the Tauri shell.
// - drags the window by hand rather than through the OS move loop
// - keyboard repositioning, so dragging is never the only way to move the pet
// - resizes the transparent window to tightly fit the pet, anchored
//   bottom-left, so the panel grows upward and the empty window never blocks
//   the desktop underneath.
// In a plain browser the whole block is skipped.

const T = globalThis.__TAURI__;

if (T) {
  document.body.classList.add('tauri');

  const { getCurrentWindow, PhysicalSize, PhysicalPosition } = T.window;
  const win = getCurrentWindow();

  // Fit the window to the visible pet, keeping the bottom-left corner fixed.
  // The very first fit also parks it in the corner of the work area: left to
  // itself Windows drops the window wherever it likes, which on a fresh launch
  // was often half under the taskbar.
  let lastW = 0, lastH = 0, busy = false;
  // The bottom edge the pet is pinned to, in physical pixels. Deriving it from
  // the current position on every fit let rounding creep in, and the pet
  // walked a couple of dozen pixels up the screen every time the panel or the
  // menu opened and closed.
  let anchorBottom = null;
  async function fit() {
    const pet = document.getElementById('pet');
    if (!pet || busy) return;
    const r = pet.getBoundingClientRect();
    // 4px all round; the motion envelope already lives inside .character.
    const cssW = Math.ceil(r.width) + 8;
    const cssH = Math.ceil(r.height) + 8;
    try {
      busy = true;
      const scale = await win.scaleFactor();
      const newW = Math.round(cssW * scale);
      const newH = Math.round(cssH * scale);
      if (newW === lastW && newH === lastH) return;
      const pos = await win.outerPosition();
      let newX = pos.x;
      if (anchorBottom == null) {
        // First fit parks him in the corner of the work area: screen.avail*
        // already excludes the taskbar, and is in CSS pixels.
        anchorBottom = Math.round(window.screen.availHeight * scale) - Math.round(8 * scale);
        newX = Math.round(16 * scale);
      }
      await win.setSize(new PhysicalSize(newW, newH));
      await win.setPosition(new PhysicalPosition(newX, anchorBottom - newH));
      lastW = newW; lastH = newH;
    } catch (e) {
      console.warn('fit failed', e);
    } finally {
      busy = false;
    }
  }

  async function moveBy(dx, dy) {
    try {
      const scale = await win.scaleFactor();
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      const y = Math.round(pos.y + dy * scale);
      await win.setPosition(new PhysicalPosition(Math.round(pos.x + dx * scale), y));
      anchorBottom = y + size.height;
    } catch (e) {
      console.warn('move failed', e);
    }
  }

  /// After an OS drag the window is wherever the user dropped it, so that
  /// becomes the new anchor.
  async function repin() {
    try {
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      anchorBottom = pos.y + size.height;
    } catch { /* keep the old anchor */ }
  }

  globalThis.miniClaude = { fit, moveBy };

  window.addEventListener('DOMContentLoaded', () => {
    const ch = document.getElementById('character');
    if (ch) {
      // Dragging is done by hand rather than with Tauri's startDragging().
      // Handing the window to the OS puts Windows into its modal move loop,
      // and that loop does two visible things to a transparent window: it
      // paints its own rectangle around the whole frame, and it stops
      // compositing the character's 3D layer, so the pet vanished and left an
      // empty outlined box behind. The move loop also swallows every pointer
      // event, which meant the swing animation had nothing to run on.
      //
      // Moving the window ourselves keeps the pointer, so the animation runs,
      // the drag ends exactly when the button comes up, and no frame is drawn.
      let down = false, started = false;
      let startScreenX = 0, startScreenY = 0;
      let startWinX = 0, startWinY = 0, scale = 1;
      let target = null, raf = 0;

      function flush() {
        raf = 0;
        if (!target) return;
        const { x, y } = target;
        target = null;
        win.setPosition(new PhysicalPosition(x, y)).catch(() => {});
      }

      function endDrag() {
        down = false;
        if (!started) return;
        started = false;
        if (raf) { cancelAnimationFrame(raf); flush(); }
        repin();
        window.dispatchEvent(new Event('pet-dragend'));
      }

      ch.addEventListener('pointerdown', async (e) => {
        if (e.button !== 0) return;
        down = true;
        started = false;
        startScreenX = e.screenX;
        startScreenY = e.screenY;
        try {
          scale = await win.scaleFactor();
          const pos = await win.outerPosition();
          startWinX = pos.x;
          startWinY = pos.y;
        } catch {
          down = false;
        }
      });

      ch.addEventListener('pointermove', (e) => {
        if (!down) return;
        // screen coordinates, not client: the window moves out from under the
        // pointer, so client deltas collapse to zero as soon as it catches up.
        const dx = e.screenX - startScreenX;
        const dy = e.screenY - startScreenY;
        if (!started) {
          if (Math.abs(dx) + Math.abs(dy) <= 4) return;
          started = true;
          ch.setPointerCapture(e.pointerId);
          window.dispatchEvent(new Event('pet-dragstart'));
        }
        target = {
          x: Math.round(startWinX + dx * scale),
          y: Math.round(startWinY + dy * scale),
        };
        // One move per frame; a setPosition per pointermove floods the IPC.
        if (!raf) raf = requestAnimationFrame(flush);
      });

      ch.addEventListener('pointerup', endDrag);
      ch.addEventListener('pointercancel', endDrag);
      ch.addEventListener('lostpointercapture', endDrag);
    }

    // Re-fit whenever the pet's size changes (panel opening or closing).
    const pet = document.getElementById('pet');
    if (pet && 'ResizeObserver' in window) {
      new ResizeObserver(() => fit()).observe(pet);
    }
    fit();
  });
}
