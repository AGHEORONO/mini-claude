// Native bridge: only active inside the Tauri shell.
// - OS-level window dragging instead of moving a DOM node
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
      // Threshold drag: a real move starts OS window dragging, while a plain
      // press stays a click so the character can still toggle the panel.
      let down = false, sx = 0, sy = 0, started = false, endTimer = 0;

      // Once startDragging() hands the pointer to the OS the webview stops
      // receiving pointer events, so the end of a drag is inferred from the
      // window's own move events going quiet.
      function endDrag() {
        clearTimeout(endTimer);
        const wasDragging = started;
        down = false;
        started = false;
        if (wasDragging) {
          repin();
          window.dispatchEvent(new Event('pet-dragend'));
        }
      }
      function keepDragging() {
        clearTimeout(endTimer);
        // Generous: holding the pet still mid-drag must not look like a drop.
        // The real end signal is the mouseup below; this is only a safety net.
        endTimer = setTimeout(endDrag, 1500);
      }

      ch.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        down = true; started = false; sx = e.clientX; sy = e.clientY;
      });
      ch.addEventListener('pointermove', (e) => {
        if (!down || started) return;
        if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 5) {
          started = true;
          window.clawd?.play('drag');
          keepDragging();
          win.startDragging();
        }
      });
      ch.addEventListener('pointerup', () => { if (!started) down = false; else endDrag(); });
      // startDragging() hands the pointer to the OS, so the release usually
      // comes back here on the window rather than on the character.
      window.addEventListener('mouseup', () => { if (started) endDrag(); });
      window.addEventListener('pointerup', () => { if (started) endDrag(); });
      window.addEventListener('blur', () => { if (started) endDrag(); });
      // fit() repositions the window too, hence the `started` guard.
      win.onMoved(() => { if (started) keepDragging(); }).catch(() => {});
    }

    // Re-fit whenever the pet's size changes (panel opening or closing).
    const pet = document.getElementById('pet');
    if (pet && 'ResizeObserver' in window) {
      new ResizeObserver(() => fit()).observe(pet);
    }
    fit();
  });
}
