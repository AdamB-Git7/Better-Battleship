// Mouse input on the 3D canvas.
// The same buttons are used to move the camera (drag) and to play (click),
// so a press only counts as a click if the mouse hardly moved.

const CLICK_TOLERANCE = 6;   // pixels

/**
 * @param canvas the 3D canvas
 * @param handlers {{
 *   onMove: (x: number, y: number) => void,
 *   onLeave: () => void,
 *   onDrag: (dx: number, dy: number) => void,
 *   onClick: (x: number, y: number) => void,
 *   onRightClick: () => void
 * }}
 */
export function createInput(canvas, handlers) {
    let press = null;

    canvas.addEventListener('pointerdown', event => {
        press = { x: event.clientX, y: event.clientY, button: event.button, lastX: event.clientX, lastY: event.clientY };
    });

    canvas.addEventListener('pointerup', event => {
        if (!press || press.button !== event.button) {
            return;
        }
        const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y);
        press = null;
        if (moved > CLICK_TOLERANCE) {
            return;   // it was a camera drag
        }
        if (event.button === 0) {
            handlers.onClick(event.clientX, event.clientY);
        } else if (event.button === 2) {
            handlers.onRightClick();
        }
    });

    canvas.addEventListener('pointermove', event => {
        if (press && event.buttons !== 0) {
            // A button is held down: this is a drag.
            handlers.onDrag(event.clientX - press.lastX, event.clientY - press.lastY);
            press.lastX = event.clientX;
            press.lastY = event.clientY;
        }
        handlers.onMove(event.clientX, event.clientY);
    });
    canvas.addEventListener('pointerleave', () => handlers.onLeave());
    // Right click rotates the ship, so the browser menu must not open.
    canvas.addEventListener('contextmenu', event => event.preventDefault());
}
