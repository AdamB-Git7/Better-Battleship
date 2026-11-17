// Entry point: connects the three parts of the front end.
//
//   network (STOMP)  --->  game flow (this file)  --->  3D world + HUD + pirate guide
//
// Ships are placed from an aerial view. The battle is fought from the captain's
// bridge, by clicking the holographic board (the V key switches back to the aerial view).
//
// The server is the only source of truth. This file keeps the last view it
// received, decides what the player is allowed to click, and plays the shot
// animation (a guided missile) before showing each new view.

import { cellToWorld, inBounds, shipCells, ZONES, ZONE_SPAN } from './config.js';
import { createNetwork } from './net/network.js';
import { findNewShot } from './game/viewDiff.js';
import { createGuide } from './game/guide.js';
import { createSound } from './audio/sound.js';
import { createWorld } from './scene/world.js';
import { DECK_HEIGHT } from './scene/shipModels.js';
import { createHud } from './ui/hud.js';
import { createInput } from './ui/input.js';
import { createPirate } from './ui/pirate.js';

const HOVER_VALID = 0x4dff88;
const HOVER_INVALID = 0xff4a3d;
const HOVER_TARGET = 0xffc46b;

// ---- State ------------------------------------------------------------------
let roomCode = null;            // null = in the lobby
let view = null;                // last view shown on screen
let orientation = 'HORIZONTAL'; // direction of the ship being placed
let hover = null;               // cell under the mouse
let animating = false;          // a missile is in the air
let preferBridge = true;        // battle view: captain's bridge (true) or aerial (false)

const canvas = document.getElementById('scene');
const sound = createSound();
const guide = createGuide();          // chooses what the pirate says
const pirate = createPirate(sound);   // shows it on screen

const hud = createHud({
    onCreate: () => network.createRoom(),
    onJoin: code => network.joinRoom(code),
    onRotate: rotate,
    onRematch: () => network.rematch(),
    onLeave: leave,
    onMute: () => sound.toggleMute(),
    onGuide: () => pirate.toggle(),
    onView: toggleBattleView
});

const network = createNetwork({
    onConnection: connected => hud.setConnected(connected),
    onRoom: room => {
        roomCode = room.code;
        hud.showRoom(room);
        pirate.enter();
        pirate.say(guide.onRoom(room));
    },
    onGame: receiveView,
    onError: message => hud.showError(message),
    onLeft: message => backToLobby(message)
});

let world;
try {
    world = await createWorld(canvas, sound, progress => hud.setLoading(progress));
} catch (error) {
    // Usually: WebGL is not available, or an asset failed to load.
    hud.setLoading(0, 'Could not start the 3D scene. Check that WebGL is enabled, then refresh.');
    throw error;
}
hud.setLoading(1, 'Ready');
hud.hideLoading();

createInput(canvas, {
    onMove: (x, y) => {
        hover = world.pickCell(x, y);
        refreshHover();
    },
    onLeave: () => {
        hover = null;
        refreshHover();
    },
    onClick: (x, y) => {
        const cell = world.pickCell(x, y);
        if (!cell) {
            return;
        }
        if (cell.zone === 'mine') {
            placeShip(cell.row, cell.col);
        } else {
            fireAt(cell.row, cell.col);
        }
    },
    onRightClick: rotate
});

// On the bridge the view follows the mouse near the screen edges. This listens on
// the whole window (not only the canvas) so the view keeps following when the
// mouse passes over the top bar or the side panels.
window.addEventListener('pointermove', event => world.camera.pointAt(event.clientX, event.clientY));
document.documentElement.addEventListener('mouseleave', () => world.camera.pointAt(null));
window.addEventListener('blur', () => world.camera.pointAt(null));

document.addEventListener('keydown', event => {
    if (hud.isTypingCode(event.target)) {
        return;
    }
    if (event.key === 'r' || event.key === 'R') {
        rotate();
    } else if (event.key === 'v' || event.key === 'V') {
        toggleBattleView();
    }
});

network.connect();

// ---- Views from the server -----------------------------------------------------
// Views are handled one at a time, in order. If a view contains a new shot,
// the missile animation is played first and the result is revealed on impact.
const pending = [];
let processing = false;

function receiveView(newView) {
    if (roomCode === null) {
        return;
    }
    pending.push(newView);
    if (!processing) {
        processViews();
    }
}

async function processViews() {
    processing = true;
    while (pending.length > 0 && roomCode !== null) {
        const next = pending.shift();
        const shot = findNewShot(view, next);
        if (shot) {
            animating = true;
            refreshHover();
            hud.showMissileInFlight(shot.zone === 'enemy');
            world.camera.lookAt('window');   // on the bridge: look up and watch the missile
            await playShot(shot);
            animating = false;
            if (roomCode === null) {
                break;   // the player left while the missile was flying
            }
        }
        showView(next, shot);
    }
    processing = false;
}

/** Flies a missile to the target cell. Resolves when it lands (or is cancelled by leaving). */
function playShot(shot) {
    return new Promise(resolve => {
        const hit = shot.result !== 'MISS';
        let from;
        let to;
        if (shot.zone === 'enemy') {
            // My shot: from one of my ships into the fog.
            from = world.fleet.randomMuzzle();
            to = cellToWorld('enemy', shot.row, shot.col).setY(hit ? 1 : 0);
        } else {
            // Enemy shot: we do not know where their ships are (and must not),
            // so the missile simply rises out of a random point of the fog.
            from = randomFogPoint();
            to = cellToWorld('mine', shot.row, shot.col).setY(hit ? DECK_HEIGHT : 0);
        }
        const onImpact = () => {
            if (hit) {
                world.effects.explosion(to);
            } else {
                world.effects.splash(to);
            }
            resolve();
        };
        world.effects.fireMissile(from, to, onImpact, {
            kind: shot.zone === 'enemy' ? 'outgoing' : 'incoming',
            onCancel: resolve   // the player left: nothing to reveal any more
        });
    });
}

/**
 * A random point low in the enemy fog bank. Enemy missiles start there, never
 * from a real enemy ship (the client does not know where they are, and must not).
 */
function randomFogPoint() {
    const point = ZONES.enemy.center.clone();
    point.x += (Math.random() - 0.5) * ZONE_SPAN * 0.8;
    point.z += (Math.random() - 0.5) * ZONE_SPAN * 0.8;
    point.y = 2;
    return point;
}

function showView(newView, shot) {
    const previous = view;
    view = newView;
    // The very first view of a room is drawn without animations.
    world.showView(view, previous === null);
    if (!previous || previous.status !== view.status) {
        chooseCamera();
    }
    hud.showGame(view, orientation, onBridge());
    pirate.say(guide.onView(previous, view, shot));
    // After a shot, watch the impact a moment first. After a sinking, the eyes
    // stay on the window a little longer to see the ship go down, but the board
    // is ready to aim as usual (and stays clickable in the lower part of the view).
    const sunk = shot && shot.result === 'SUNK';
    aimHead(shot ? 1.2 : 0.4, sunk ? (shot.zone === 'enemy' ? 3.4 : 2.6) : undefined);
    refreshHover();
}

// ---- Camera: aerial view or captain's bridge -------------------------------------

/** Ships are placed from the air; the battle is fought from the bridge (or from the air). */
function onBridge() {
    return view !== null && view.status !== 'PLACING_SHIPS' && preferBridge;
}

function chooseCamera() {
    if (onBridge()) {
        world.enterBridge();
    } else {
        world.leaveBridge(view.status === 'PLACING_SHIPS' ? 'placement' : 'battle');
    }
}

/**
 * On the bridge the captain looks down at the holographic board when it is
 * his turn to aim, and out of the window the rest of the time.
 * @param delay seconds to keep the current look first (to watch an impact)
 * @param lookDelay the same for the head only (default: delay), the board
 *        still switches its focus after `delay`
 */
function aimHead(delay, lookDelay = delay) {
    if (onBridge()) {
        const aiming = view.status === 'IN_PROGRESS' && view.yourTurn;
        world.camera.lookAt(aiming ? 'board' : 'window', lookDelay);
        // The board shows the enemy zone big to aim, my own zone big otherwise.
        world.setBoardFocus(aiming ? 'enemy' : 'mine', delay);
    }
}

/** The VIEW button and the V key: switch between the bridge and the aerial view. */
function toggleBattleView() {
    if (view === null || view.status === 'PLACING_SHIPS') {
        return;
    }
    preferBridge = !preferBridge;
    chooseCamera();
    hud.showGame(view, orientation, onBridge());
    aimHead(0.4);
    refreshHover();
}

function backToLobby(message) {
    roomCode = null;
    view = null;
    pending.length = 0;
    animating = false;
    world.showView(null);
    world.leaveBridge('lobby');
    hud.showLobby(message);
    pirate.leave();
    refreshHover();
}

function leave() {
    const midGame = view !== null && (view.status === 'PLACING_SHIPS' || view.status === 'IN_PROGRESS');
    if (midGame && !confirm('Leave this game? Your opponent will be sent back to the menu.')) {
        return;
    }
    network.leave();
    backToLobby(null);
}

// ---- Player actions ------------------------------------------------------------
// These checks only avoid useless messages: the server validates every move again.

function isPlacing() {
    return view !== null && view.status === 'PLACING_SHIPS' && view.shipsToPlace.length > 0;
}

function canFire() {
    return view !== null && view.status === 'IN_PROGRESS' && view.yourTurn && !animating;
}

/** Same rule as the server: the ship must be on the board and on free cells. */
function fits(type, row, col) {
    return shipCells(type, row, col, orientation)
        .every(cell => inBounds(cell) && view.yourBoard[cell.row][cell.col] === 'EMPTY');
}

function placeShip(row, col) {
    if (isPlacing()) {
        network.placeShip(roomCode, view.shipsToPlace[0], row, col, orientation);
    }
}

function fireAt(row, col) {
    if (canFire() && view.opponentBoard[row][col] === 'EMPTY') {
        network.fire(roomCode, row, col);
    }
}

function rotate() {
    if (!isPlacing()) {
        return;
    }
    orientation = orientation === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL';
    hud.showGame(view, orientation, onBridge());
    refreshHover();
}

/** Updates the placement preview or the target highlight under the mouse. */
function refreshHover() {
    world.fleet.hideGhost();
    world.hideHover();
    canvas.classList.remove('targeting');
    if (!hover) {
        return;
    }
    if (isPlacing() && hover.zone === 'mine') {
        const type = view.shipsToPlace[0];
        const valid = fits(type, hover.row, hover.col);
        world.fleet.showGhost({ type, row: hover.row, col: hover.col, orientation }, valid);
        const cells = shipCells(type, hover.row, hover.col, orientation).filter(inBounds);
        world.showHover('mine', cells, valid ? HOVER_VALID : HOVER_INVALID);
    } else if (canFire() && hover.zone === 'enemy') {
        const free = view.opponentBoard[hover.row][hover.col] === 'EMPTY';
        world.showHover('enemy', [hover], free ? HOVER_TARGET : HOVER_INVALID);
        canvas.classList.toggle('targeting', free);
    }
}
