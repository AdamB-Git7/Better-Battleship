// The 3D world: creates the renderer, builds every part of the scene (storm,
// sea, grid, ships and their sinking, fog, effects, the battle in the background, bridge,
// holographic board, camera) and runs
// the render loop.
//
// main.js talks to the scene only through the object returned here.

import * as THREE from 'three';
import { cellToWorld, GRID_SIZE } from '../config.js';
import { createStorm } from './storm.js';
import { weather } from './weather.js';
import { createSea } from './sea.js';
import { createGrid } from './grid.js';
import { createFleet } from './fleet.js';
import { createFog } from './fog.js';
import { createEffects } from './effects.js';
import { createSinking } from './sinking.js';
import { createBattlefield } from './battlefield.js';
import { createCameraRig } from './camera.js';
import { createBridge } from './bridge.js';
import { createHoloBoard } from './holoBoard.js';
import { DECK_HEIGHT } from './shipModels.js';

/**
 * @param canvas the <canvas> to draw on
 * @param sound the sound module (used by the effects)
 * @param onProgress called with 0..1 while assets load
 */
export async function createWorld(canvas, sound, onProgress) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));   // cap for performance
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    // ---- Assets -------------------------------------------------------------
    const manager = new THREE.LoadingManager();
    manager.onProgress = (url, loaded, total) => onProgress(loaded / total);
    const waterNormals = await new THREE.TextureLoader(manager).loadAsync('assets/textures/waternormals.jpg');

    // ---- Scene ----------------------------------------------------------------
    const scene = new THREE.Scene();
    const rig = createCameraRig(canvas);
    const storm = createStorm(scene, renderer, sound);
    const sea = createSea(scene, waterNormals);
    const grid = createGrid(scene);
    const effects = createEffects(scene, sound, sea);
    const sinking = createSinking(scene, effects, sea, sound);   // takes over the ships fleet.js reports sunk
    const fleet = createFleet(scene, sinking);
    const fog = createFog(scene);
    const battlefield = createBattlefield(scene, sound, sea);   // decoration only: knows nothing of the game
    const bridge = createBridge(scene);
    const holo = createHoloBoard(bridge.interior, bridge.floorY);
    fog.setBridgeMode(true);   // the game starts behind the menu

    // ---- Resize ---------------------------------------------------------------
    function resize() {
        renderer.setSize(window.innerWidth, window.innerHeight);
        rig.resize(window.innerWidth, window.innerHeight);
        effects.resize(renderer.domElement.height);
        battlefield.resize(renderer.domElement.height);
    }
    window.addEventListener('resize', resize);
    resize();

    // ---- Render loop ------------------------------------------------------------
    const clock = new THREE.Clock();
    // One frame. The order matters: the storm first (it decides the wind and
    // the lightning of this frame), then everything that reacts to it.
    let time = 0;
    function frame(forcedDt) {
        const dt = forcedDt ?? Math.min(clock.getDelta(), 0.1);   // avoid huge jumps after a pause
        time += dt;
        storm.update(dt, time, rig.camera);
        sound.setGust(weather.gust);
        sea.update(time);
        grid.update(time);
        fleet.update(dt, time);
        sinking.update(dt, time);   // before the effects: it moves the fires they burn
        fog.update(dt, time);
        effects.update(dt, time, rig.camera);
        battlefield.update(dt, time, rig.camera);
        bridge.update(dt, time);
        holo.update(dt, time);
        rig.update(dt, time);
        renderer.render(scene, rig.camera);
    }
    renderer.setAnimationLoop(() => frame());

    // Developer hook: open the page with ?debug to step and time frames from
    // the console (used to measure performance and to test a sinking). It shows
    // nothing hidden: the fleet only holds ships the server has revealed.
    if (new URLSearchParams(location.search).has('debug')) {
        window.__bb = { renderer, scene, rig, frame, weather, storm, battlefield, fleet };
    }

    // ---- Mouse picking -----------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    /**
     * Grid cell under a mouse position (in pixels), or null.
     * From the bridge the player points at the holographic board,
     * from the air directly at the sea.
     */
    function pickCell(clientX, clientY) {
        pointer.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
        raycaster.setFromCamera(pointer, rig.camera);
        return rig.isOnBridge() ? holo.pick(raycaster) : grid.pick(raycaster);
    }

    /** Highlights cells, both on the sea and on the holographic board. */
    function showHover(zone, cells, color) {
        grid.showHover(zone, cells, color);
        holo.showHover(zone, cells, color);
    }

    function hideHover() {
        grid.hideHover();
        holo.hideHover();
    }

    /** Which zone is big on the holographic board: 'enemy' to aim, 'mine' to watch. */
    function setBoardFocus(zone, delay) {
        holo.setFocus(zone, delay);
    }

    /** Moves the player into the bridge (first person)... */
    function enterBridge() {
        bridge.setInside(true);
        grid.setVisible(false);
        fog.setBridgeMode(true);
        storm.setRoom(bridge.roomBox, bridge.roofPlane);   // no rain inside the bridge
        sound.setPlace('bridge');
        rig.flyTo('bridge');
    }

    /** ...or back to one of the aerial viewpoints ('placement', 'battle', 'lobby'). */
    function leaveBridge(viewpoint) {
        bridge.setInside(false);
        grid.setVisible(true);
        // The tall mist is hidden in the aerial views of a game (it would cover
        // the enemy grid) but kept behind the menu, where it gives the bank volume.
        fog.setBridgeMode(viewpoint === 'lobby');
        storm.setRoom(null);
        sound.setPlace(viewpoint === 'lobby' ? 'lobby' : 'aerial');
        rig.flyTo(viewpoint);
    }

    /**
     * Makes the whole scene match a view sent by the server (or empties it when
     * view is null). It can be called any number of times with the same view.
     * @param instant skip the animations (sinking, fog opening)
     */
    function showView(view, instant = false) {
        if (!view) {
            grid.clearMarkers();
            holo.sync(null);
            fleet.clear();
            fog.reset();
            effects.clear();
            return;
        }
        const fires = [];
        for (let row = 0; row < GRID_SIZE; row++) {
            for (let col = 0; col < GRID_SIZE; col++) {
                const mine = view.yourBoard[row][col];
                const theirs = view.opponentBoard[row][col];
                grid.setCellState('mine', row, col, mine);
                grid.setCellState('enemy', row, col, theirs);
                // The fog opens above every cell I have already shot.
                fog.setRevealed(row, col, theirs !== 'EMPTY', instant);
                // A hit ship burns until it sinks (then sinking.js burns its decks until the sea puts them out).
                if (mine === 'HIT') {
                    fires.push({ key: `mine:${row}:${col}`, position: cellToWorld('mine', row, col).setY(DECK_HEIGHT + 0.6) });
                }
                if (theirs === 'HIT') {
                    fires.push({ key: `enemy:${row}:${col}`, position: cellToWorld('enemy', row, col).setY(1.6) });
                }
            }
        }
        effects.syncFires(fires);
        holo.sync(view, instant);
        fleet.sync('mine', view.yourShips, instant);
        // Only sunk enemy ships are in this list: the server sends nothing else.
        fleet.sync('enemy', view.opponentShips, instant);
    }

    return { showView, pickCell, showHover, hideHover, enterBridge, leaveBridge, setBoardFocus, fleet, effects, camera: rig };
}
