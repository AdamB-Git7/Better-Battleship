// The holographic tactical board (blocks 3 and 4).
//
// Two glowing miniatures float in the bridge, in front of the window: the
// enemy zone (with the results of my shots) and my own zone (with my ships).
// The player clicks cells of the enemy zone to fire.
//
// Only one zone is needed at a time, so the board has a "focus":
//  - focus 'enemy' (my turn): the enemy zone is big, in the middle, easy to click;
//    my zone shrinks to a small inset on the right.
//  - focus 'mine' (their turn): my zone is big, to see where I am hit;
//    the enemy zone shrinks to a small inset on the left.
// The two zones slide and resize smoothly when the focus changes.
//
// Trick used here: each miniature is a group scaled down, and everything
// inside it uses the SAME coordinates as the real sea. So a ship, a marker or
// a cell is placed with the usual cellToWorld(), and it lands at the matching
// spot of the miniature.
//
// Like the rest of the scene, the board only shows what the server sent:
// enemy ships appear on it only once they are sunk.

import * as THREE from 'three';
import { CELL, GRID_SIZE, ZONES, ZONE_SPAN, cellToWorld, worldToCell } from '../config.js';
import { placeOnGrid } from './fleet.js';
import { buildShipModel } from './shipModels.js';

// Where the board floats, relative to the captain's eye (-z is forward), and
// how much its far side is raised towards him.
export const BOARD_POSITION = new THREE.Vector3(0, -2.0, -3.6);
const TILT = THREE.MathUtils.degToRad(30);

// The two places a zone can be in. scale: 1 sea cell (10 units) = scale * 10 on the board.
const MAIN = { x: 0, z: 0, scale: 0.034 };
const INSET = { x: 2.65, z: -0.6, scale: 0.014 };   // mirrored to the left for the enemy zone
const SLIDE_SPEED = 4;                              // how fast zones move when the focus changes

const MINE = 0x58d6ff;
const ENEMY = 0xffb054;
const DANGER = 0xff4a3d;

/** Glowing, see-through material: the "hologram" look. */
function holo(color, opacity) {
    return new THREE.MeshBasicMaterial({
        color, opacity, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, fog: false
    });
}

/**
 * @param parent the bridge interior group (its origin is the captain's eye)
 */
export function createHoloBoard(parent) {
    const board = new THREE.Group();
    board.position.copy(BOARD_POSITION);
    board.rotation.x = TILT;
    parent.add(board);

    // ---- The two miniatures ----------------------------------------------------
    // slot  = the group that slides and scales on the board,
    // inner = shifted so that the centre of the zone is the centre of the slot;
    //         its children use sea coordinates.
    const zones = {};
    const lineMaterials = [];
    for (const zone of Object.keys(ZONES)) {
        const slot = new THREE.Group();
        const inner = new THREE.Group();
        inner.position.copy(ZONES[zone].center).negate();
        slot.add(inner);
        board.add(slot);
        zones[zone] = { slot, inner, markers: new THREE.Group(), ships: new THREE.Group() };
        inner.add(zones[zone].markers, zones[zone].ships);

        const color = zone === 'enemy' ? ENEMY : MINE;
        // Faint plate under the zone, so the grid reads as a surface.
        const plate = new THREE.Mesh(
            new THREE.PlaneGeometry(ZONE_SPAN + 6, ZONE_SPAN + 6).rotateX(-Math.PI / 2), holo(color, 0.1));
        plate.position.copy(ZONES[zone].center).y = -0.4;
        inner.add(plate);
        for (const [positions, opacity] of gridLines(zone)) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            const material = new THREE.LineBasicMaterial({
                color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false
            });
            material.userData.baseOpacity = opacity;
            lineMaterials.push(material);
            inner.add(new THREE.LineSegments(geometry, material));
        }
    }

    // ---- Focus: which zone is big ---------------------------------------------
    let focus = 'mine';

    function slotTarget(zone) {
        if (zone === focus) {
            return MAIN;
        }
        // My zone parks on the right, the enemy zone on the left.
        return zone === 'mine' ? INSET : { x: -INSET.x, z: INSET.z, scale: INSET.scale };
    }

    function applySlots(ease) {
        for (const zone of Object.keys(zones)) {
            const { slot } = zones[zone];
            const target = slotTarget(zone);
            slot.position.x += (target.x - slot.position.x) * ease;
            slot.position.z += (target.z - slot.position.z) * ease;
            slot.scale.setScalar(slot.scale.x + (target.scale - slot.scale.x) * ease);
        }
    }
    applySlots(1);

    let pendingFocus = null;   // { zone, delay } while a change of focus is waiting

    /**
     * Chooses the big zone: 'enemy' to aim, 'mine' to watch the enemy's shots.
     * @param delay seconds to wait first, so the result of a shot stays readable
     */
    function setFocus(zone, delay = 0) {
        pendingFocus = { zone, delay };
    }

    // ---- Shot markers -------------------------------------------------------
    const markers = new Map();   // "zone:row:col" -> { state, object }
    const ringGeometry = new THREE.RingGeometry(CELL * 0.2, CELL * 0.32, 20).rotateX(-Math.PI / 2);
    const discGeometry = new THREE.CircleGeometry(CELL * 0.3, 20).rotateX(-Math.PI / 2);
    const tileGeometry = new THREE.PlaneGeometry(CELL * 0.9, CELL * 0.9).rotateX(-Math.PI / 2);
    const materials = {
        MISS: holo(0xe8f4ff, 0.8),
        HIT: holo(0xff6a2a, 0.95),
        SUNK: holo(DANGER, 0.45)
    };

    function setCellState(zone, row, col, state) {
        const key = `${zone}:${row}:${col}`;
        const shown = materials[state] ? state : null;
        const current = markers.get(key);
        if ((current ? current.state : null) === shown) {
            return;
        }
        if (current) {
            zones[zone].markers.remove(current.object);
            markers.delete(key);
        }
        if (shown) {
            const geometry = shown === 'MISS' ? ringGeometry : shown === 'HIT' ? discGeometry : tileGeometry;
            const object = new THREE.Mesh(geometry, materials[shown]);
            // Hits float above the ship holograms so they are not hidden inside them.
            cellToWorld(zone, row, col, object.position).y = shown === 'MISS' ? 0.4 : 5;
            zones[zone].markers.add(object);
            markers.set(key, { state: shown, object });
        }
    }

    // ---- Miniature ships ------------------------------------------------------
    const ships = new Map();   // "zone:type" -> { key, object }
    const shipMaterials = {
        mine: holo(MINE, 0.32),
        lost: holo(DANGER, 0.22),     // one of my ships, sunk
        enemy: holo(DANGER, 0.4)      // an enemy ship (only shown once sunk)
    };

    function syncShips(zone, layouts) {
        const wanted = new Map(layouts.map(layout => [layout.type, layout]));
        for (const [id, entry] of ships) {
            const [entryZone, type] = id.split(':');
            const layout = wanted.get(type);
            if (entryZone === zone && (!layout || entry.key !== shipKey(layout))) {
                zones[zone].ships.remove(entry.object);
                ships.delete(id);
            }
        }
        for (const layout of layouts) {
            const id = `${zone}:${layout.type}`;
            if (ships.has(id)) {
                continue;
            }
            const material = zone === 'enemy' ? shipMaterials.enemy : layout.sunk ? shipMaterials.lost : shipMaterials.mine;
            const object = buildShipModel(layout.type);
            object.traverse(child => {
                if (child.isMesh) {
                    child.material = material;
                }
            });
            placeOnGrid(object, zone, layout);
            zones[zone].ships.add(object);
            ships.set(id, { key: shipKey(layout), object });
        }
    }

    /** Makes the board match a view sent by the server (null = empty board). */
    function sync(view) {
        if (!view) {
            for (const zone of Object.keys(zones)) {
                zones[zone].markers.clear();
                zones[zone].ships.clear();
            }
            markers.clear();
            ships.clear();
            return;
        }
        for (let row = 0; row < GRID_SIZE; row++) {
            for (let col = 0; col < GRID_SIZE; col++) {
                setCellState('mine', row, col, view.yourBoard[row][col]);
                setCellState('enemy', row, col, view.opponentBoard[row][col]);
            }
        }
        syncShips('mine', view.yourShips);
        syncShips('enemy', view.opponentShips);
    }

    // ---- Hover highlight ------------------------------------------------------
    const hoverMaterial = holo(0xffffff, 0.55);
    const hoverTiles = [];
    for (let i = 0; i < 5; i++) {
        const tile = new THREE.Mesh(tileGeometry, hoverMaterial);
        tile.visible = false;
        hoverTiles.push(tile);
    }

    function showHover(zone, cells, color) {
        hoverMaterial.color.set(color);
        hoverTiles.forEach((tile, i) => {
            tile.visible = i < cells.length;
            if (tile.visible) {
                zones[zone].inner.add(tile);   // moves the tile into the right miniature
                cellToWorld(zone, cells[i].row, cells[i].col, tile.position).y = 0.8;
            }
        });
    }

    function hideHover() {
        hoverTiles.forEach(tile => { tile.visible = false; });
    }

    // ---- Picking --------------------------------------------------------------
    // Intersect the mouse ray with the plane of the board, then convert the hit
    // point into the coordinates of each miniature, which are sea coordinates.
    const plane = new THREE.Plane();
    const normal = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const hitPoint = new THREE.Vector3();
    const local = new THREE.Vector3();

    /** @returns {{zone: string, row: number, col: number}|null} */
    function pick(raycaster) {
        board.updateWorldMatrix(true, true);
        origin.setFromMatrixPosition(board.matrixWorld);
        normal.set(0, 1, 0).transformDirection(board.matrixWorld);
        plane.setFromNormalAndCoplanarPoint(normal, origin);
        if (!raycaster.ray.intersectPlane(plane, hitPoint)) {
            return null;
        }
        for (const zone of Object.keys(zones)) {
            const cell = worldToCell(zone, zones[zone].inner.worldToLocal(local.copy(hitPoint)));
            if (cell) {
                return cell;
            }
        }
        return null;
    }

    function update(dt, time) {
        if (pendingFocus) {
            pendingFocus.delay -= dt;
            if (pendingFocus.delay <= 0) {
                focus = pendingFocus.zone;
                pendingFocus = null;
            }
        }
        applySlots(1 - Math.exp(-dt * SLIDE_SPEED));
        // Slight flicker of the lines and a pulse on the hit markers.
        const flicker = 0.9 + 0.1 * Math.sin(time * 17) * Math.sin(time * 3.1);
        for (const material of lineMaterials) {
            material.opacity = material.userData.baseOpacity * flicker;
        }
        materials.HIT.opacity = 0.7 + 0.25 * Math.sin(time * 5);
    }

    return { sync, setFocus, showHover, hideHover, pick, update };
}

function shipKey(layout) {
    return `${layout.row}:${layout.col}:${layout.orientation}:${layout.sunk}`;
}

/** [positions, opacity] pairs: the inner lines of a zone, then its brighter frame. */
function gridLines(zone) {
    const center = ZONES[zone].center;
    const half = ZONE_SPAN / 2;
    const inner = [];
    const frame = [];
    for (let i = 0; i <= GRID_SIZE; i++) {
        const offset = -half + i * CELL;
        const target = i === 0 || i === GRID_SIZE ? frame : inner;
        target.push(center.x - half, 0, center.z + offset, center.x + half, 0, center.z + offset);
        target.push(center.x + offset, 0, center.z - half, center.x + offset, 0, center.z + half);
    }
    return [[inner, 0.5], [frame, 1]];
}
