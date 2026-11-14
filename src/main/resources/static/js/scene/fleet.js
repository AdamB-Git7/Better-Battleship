// Manages the ships that are in the scene: creates them from the layouts the
// server sends, makes them float, draws their wake, sinks them, and shows the
// translucent placement preview ("ghost").
//
// Anti-cheat note: this module only ever draws what is in view.yourShips and
// view.opponentShips. The server puts an enemy ship in opponentShips only once
// it is sunk, so there is never a hidden enemy ship in the scene to find.

import * as THREE from 'three';
import { CELL, SHIP_LENGTHS, ZONES, cellToWorld } from '../config.js';
import { buildGhostModel, buildShipModel, DECK_HEIGHT } from './shipModels.js';
import { swellAt } from './sea.js';
import { foamTexture, wakeMaskTexture } from './textures.js';

const SINK_SECONDS = 7;
const SINK_DEPTH = 4.6;
const WAKE_OPACITY = 0.8;

export function createFleet(scene) {
    const root = new THREE.Group();
    scene.add(root);

    const fleets = { mine: new Map(), enemy: new Map() };   // type -> entry
    const foamMap = foamTexture();   // shared by all wakes, scrolled once per frame
    foamMap.repeat.set(2, 1);
    const wakeMask = wakeMaskTexture();

    function buildWake(model) {
        const length = model.userData.length;
        const material = new THREE.MeshBasicMaterial({
            map: foamMap,
            alphaMap: wakeMask,
            transparent: true,
            opacity: WAKE_OPACITY,
            depthWrite: false
        });
        const wake = new THREE.Mesh(new THREE.PlaneGeometry(length * 1.5, CELL * 1.7), material);
        wake.rotation.x = -Math.PI / 2;
        wake.position.set(-length * 0.3, 0.14, 0);   // shifted towards the stern
        wake.renderOrder = -5;
        return wake;
    }

    function addShip(zone, layout) {
        const anchor = new THREE.Group();     // fixed position + heading on the grid
        placeOnGrid(anchor, zone, layout);
        const body = buildShipModel(layout.type);   // moves with the swell / sinks
        const wake = buildWake(body);
        anchor.add(body, wake);
        root.add(anchor);
        const entry = { anchor, body, wake, key: layoutKey(layout), sunk: false, sinkTime: 0 };
        fleets[zone].set(layout.type, entry);
        return entry;
    }

    function removeShip(zone, type) {
        const entry = fleets[zone].get(type);
        if (entry) {
            root.remove(entry.anchor);
            entry.wake.material.dispose();
            fleets[zone].delete(type);
        }
    }

    /**
     * Makes the scene match the list of ships sent by the server for one zone.
     * Safe to call with the same data many times.
     * @param instant true = no sinking animation (ship is shown already sunk)
     */
    function sync(zone, layouts, instant = false) {
        const wanted = new Map(layouts.map(layout => [layout.type, layout]));
        for (const [type, entry] of fleets[zone]) {
            const layout = wanted.get(type);
            if (!layout || entry.key !== layoutKey(layout)) {
                removeShip(zone, type);
            }
        }
        for (const layout of layouts) {
            const entry = fleets[zone].get(layout.type) || addShip(zone, layout);
            if (layout.sunk && !entry.sunk) {
                entry.sunk = true;
                entry.sinkTime = instant ? SINK_SECONDS : 0;
            }
        }
    }

    function clear() {
        for (const zone of Object.keys(fleets)) {
            for (const type of [...fleets[zone].keys()]) {
                removeShip(zone, type);
            }
        }
        hideGhost();
    }

    /** Deck position of one of my ships that is still afloat (where shells start). */
    function randomMuzzle() {
        const afloat = [...fleets.mine.values()].filter(entry => !entry.sunk);
        if (afloat.length === 0) {
            return ZONES.mine.center.clone().setY(DECK_HEIGHT);
        }
        const entry = afloat[Math.floor(Math.random() * afloat.length)];
        return entry.anchor.position.clone().setY(DECK_HEIGHT + 1.5);
    }

    // ---- Placement preview ---------------------------------------------------
    const ghostMaterial = new THREE.MeshBasicMaterial({
        color: 0x4dff88, transparent: true, opacity: 0.55, depthWrite: false, fog: false
    });
    const ghosts = new Map();   // type -> model (built once, then reused)
    let activeGhost = null;

    function showGhost(layout, valid) {
        let ghost = ghosts.get(layout.type);
        if (!ghost) {
            ghost = buildGhostModel(layout.type, ghostMaterial);
            ghosts.set(layout.type, ghost);
            root.add(ghost);
        }
        if (activeGhost && activeGhost !== ghost) {
            activeGhost.visible = false;
        }
        activeGhost = ghost;
        ghost.visible = true;
        placeOnGrid(ghost, 'mine', layout);
        ghost.position.y = 0.4;
        ghostMaterial.color.set(valid ? 0x4dff88 : 0xff4a3d);
    }

    function hideGhost() {
        if (activeGhost) {
            activeGhost.visible = false;
            activeGhost = null;
        }
    }

    // ---- Animation ---------------------------------------------------------
    function update(dt, time) {
        foamMap.offset.x += dt * 0.12;   // foam drifts towards the stern
        for (const zone of Object.keys(fleets)) {
            for (const entry of fleets[zone].values()) {
                const { anchor, body, wake } = entry;
                const swell = swellAt(anchor.position.x, anchor.position.z, time);
                if (!entry.sunk) {
                    body.position.y = swell.height;
                    body.rotation.x = swell.roll;
                    body.rotation.z = swell.pitch;
                    continue;
                }
                // Sinking: go down slowly while listing to one side, bow up.
                entry.sinkTime = Math.min(entry.sinkTime + dt, SINK_SECONDS);
                const p = entry.sinkTime / SINK_SECONDS;
                const eased = p * p * (3 - 2 * p);
                const afloat = 1 - eased;
                body.position.y = swell.height * afloat - SINK_DEPTH * eased;
                body.rotation.x = swell.roll * afloat + 0.3 * eased;
                body.rotation.z = swell.pitch * afloat + 0.16 * eased;
                wake.material.opacity = WAKE_OPACITY * afloat;
            }
        }
    }

    return { sync, clear, update, showGhost, hideGhost, randomMuzzle };
}

/**
 * Puts an object at the centre of the cells a ship covers, with its heading.
 * Also used by the holographic board for its miniature ships.
 */
export function placeOnGrid(object, zone, layout) {
    const length = SHIP_LENGTHS[layout.type];
    const horizontal = layout.orientation === 'HORIZONTAL';
    const midRow = layout.row + (horizontal ? 0 : (length - 1) / 2);
    const midCol = layout.col + (horizontal ? (length - 1) / 2 : 0);
    cellToWorld(zone, midRow, midCol, object.position);
    // Models point to +X. A vertical ship points to +Z (towards higher rows).
    object.rotation.y = horizontal ? 0 : -Math.PI / 2;
}

function layoutKey(layout) {
    return `${layout.row}:${layout.col}:${layout.orientation}`;
}
