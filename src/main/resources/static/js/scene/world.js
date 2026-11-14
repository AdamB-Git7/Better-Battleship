// The 3D world: creates the renderer, builds every part of the scene (sky, sea,
// grid, ships, fog, effects, bridge, holographic board, camera) and runs the
// render loop.
//
// main.js talks to the scene only through the object returned here.

import * as THREE from 'three';
import { cellToWorld, GRID_SIZE } from '../config.js';
import { createSky } from './sky.js';
import { createSea } from './sea.js';
import { createGrid } from './grid.js';
import { createFleet } from './fleet.js';
import { createFog } from './fog.js';
import { createEffects } from './effects.js';
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
    renderer.toneMappingExposure = 0.55;

    // ---- Assets -------------------------------------------------------------
    const manager = new THREE.LoadingManager();
    manager.onProgress = (url, loaded, total) => onProgress(loaded / total);
    const waterNormals = await new THREE.TextureLoader(manager).loadAsync('assets/textures/waternormals.jpg');

    // ---- Scene ----------------------------------------------------------------
    const scene = new THREE.Scene();
    const rig = createCameraRig(canvas);
    const { sunDirection } = createSky(scene, renderer);
    const sea = createSea(scene, waterNormals, sunDirection);
    const grid = createGrid(scene);
    const fleet = createFleet(scene);
    const fog = createFog(scene);
    const effects = createEffects(scene, sound);
    const bridge = createBridge(scene);
    const holo = createHoloBoard(bridge.interior);

    // ---- Resize ---------------------------------------------------------------
    window.addEventListener('resize', () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        rig.resize(window.innerWidth, window.innerHeight);
    });

    // ---- Render loop ------------------------------------------------------------
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
        const dt = Math.min(clock.getDelta(), 0.1);   // avoid huge jumps after a pause
        const time = clock.elapsedTime;
        sea.update(dt);
        fleet.update(dt, time);
        fog.update(dt, time);
        effects.update(dt);
        bridge.update(dt, time);
        holo.update(dt, time);
        rig.update(dt, time);
        renderer.render(scene, rig.camera);
    });

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
        fog.setBridgeMode(true);
        rig.flyTo('bridge');
    }

    /** ...or back to one of the aerial viewpoints ('placement', 'battle', 'lobby'). */
    function leaveBridge(viewpoint) {
        bridge.setInside(false);
        fog.setBridgeMode(false);
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
                // A hit ship burns until it sinks.
                if (mine === 'HIT') {
                    fires.push({ key: `mine:${row}:${col}`, position: cellToWorld('mine', row, col).setY(DECK_HEIGHT + 0.6) });
                }
                if (theirs === 'HIT') {
                    fires.push({ key: `enemy:${row}:${col}`, position: cellToWorld('enemy', row, col).setY(1) });
                }
            }
        }
        effects.syncFires(fires);
        holo.sync(view);
        fleet.sync('mine', view.yourShips, instant);
        // Only sunk enemy ships are in this list: the server sends nothing else.
        fleet.sync('enemy', view.opponentShips, instant);
    }

    return { showView, pickCell, showHover, hideHover, enterBridge, leaveBridge, setBoardFocus, fleet, effects, camera: rig };
}
