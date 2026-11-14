// The holographic tactical board (blocks 3 and 4).
//
// A small glowing copy of the battlefield that floats in the bridge, in front
// of the window: my zone with my ships (near side) and the enemy zone with the
// results of my shots (far side). The player clicks its cells to fire.
//
// Trick used here: the board is a group scaled down by HOLO_SCALE, and
// everything inside it uses the SAME coordinates as the real sea. So a ship,
// a marker or a cell is placed with the usual cellToWorld(), and it lands at
// the matching spot of the miniature.
//
// Like the rest of the scene, the board only shows what the server sent:
// enemy ships appear on it only once they are sunk.

import * as THREE from 'three';
import { CELL, GRID_SIZE, ZONES, ZONE_GAP, ZONE_SPAN, cellToWorld, worldToCell } from '../config.js';
import { placeOnGrid } from './fleet.js';
import { buildShipModel } from './shipModels.js';

const HOLO_SCALE = 0.028;                          // 1 sea cell (10 units) = 0.28 units on the board
const TILT = THREE.MathUtils.degToRad(14);         // far side slightly raised towards the eye
const POSITION = new THREE.Vector3(0, -2.14, -4.64);   // relative to the captain's eye

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
    board.position.copy(POSITION);
    board.rotation.x = TILT;
    board.scale.setScalar(HOLO_SCALE);
    parent.add(board);

    // ---- Static parts: base plate and the two grids --------------------------
    const depth = ZONE_SPAN * 2 + ZONE_GAP;
    const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(ZONE_SPAN + 14, depth + 14).rotateX(-Math.PI / 2),
        holo(MINE, 0.06)
    );
    plate.position.y = -0.6;
    board.add(plate);

    const lineMaterials = [];
    for (const zone of Object.keys(ZONES)) {
        const color = zone === 'enemy' ? ENEMY : MINE;
        // Faint tint under each zone, so the two grids read as two areas.
        const tint = new THREE.Mesh(
            new THREE.PlaneGeometry(ZONE_SPAN, ZONE_SPAN).rotateX(-Math.PI / 2), holo(color, 0.07));
        tint.position.copy(ZONES[zone].center).y = -0.3;
        board.add(tint);
        for (const [positions, opacity] of gridLines(zone)) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            const material = new THREE.LineBasicMaterial({
                color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false
            });
            material.userData.baseOpacity = opacity;
            lineMaterials.push(material);
            board.add(new THREE.LineSegments(geometry, material));
        }
    }

    // ---- Shot markers -------------------------------------------------------
    const markerGroup = new THREE.Group();
    board.add(markerGroup);
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
            markerGroup.remove(current.object);
            markers.delete(key);
        }
        if (shown) {
            const geometry = shown === 'MISS' ? ringGeometry : shown === 'HIT' ? discGeometry : tileGeometry;
            const object = new THREE.Mesh(geometry, materials[shown]);
            cellToWorld(zone, row, col, object.position).y = 0.4;
            markerGroup.add(object);
            markers.set(key, { state: shown, object });
        }
    }

    // ---- Miniature ships ------------------------------------------------------
    const shipGroup = new THREE.Group();
    board.add(shipGroup);
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
                shipGroup.remove(entry.object);
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
            shipGroup.add(object);
            ships.set(id, { key: shipKey(layout), object });
        }
    }

    /** Makes the board match a view sent by the server (null = empty board). */
    function sync(view) {
        if (!view) {
            markerGroup.clear();
            markers.clear();
            shipGroup.clear();
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
        board.add(tile);
        hoverTiles.push(tile);
    }

    function showHover(zone, cells, color) {
        hoverMaterial.color.set(color);
        hoverTiles.forEach((tile, i) => {
            tile.visible = i < cells.length;
            if (tile.visible) {
                cellToWorld(zone, cells[i].row, cells[i].col, tile.position).y = 0.8;
            }
        });
    }

    function hideHover() {
        hoverTiles.forEach(tile => { tile.visible = false; });
    }

    // ---- Picking --------------------------------------------------------------
    // Intersect the mouse ray with the plane of the board, then convert the hit
    // point into the board's own coordinates, which are sea coordinates.
    const plane = new THREE.Plane();
    const normal = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const hitPoint = new THREE.Vector3();

    /** @returns {{zone: string, row: number, col: number}|null} */
    function pick(raycaster) {
        board.updateWorldMatrix(true, false);
        origin.setFromMatrixPosition(board.matrixWorld);
        normal.set(0, 1, 0).transformDirection(board.matrixWorld);
        plane.setFromNormalAndCoplanarPoint(normal, origin);
        if (!raycaster.ray.intersectPlane(plane, hitPoint)) {
            return null;
        }
        board.worldToLocal(hitPoint);
        return worldToCell('mine', hitPoint) || worldToCell('enemy', hitPoint);
    }

    function update(dt, time) {
        // Slight flicker of the lines and a pulse on the hit markers.
        const flicker = 0.9 + 0.1 * Math.sin(time * 17) * Math.sin(time * 3.1);
        for (const material of lineMaterials) {
            material.opacity = material.userData.baseOpacity * flicker;
        }
        materials.HIT.opacity = 0.7 + 0.25 * Math.sin(time * 5);
    }

    return { sync, showHover, hideHover, pick, update };
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
    return [[inner, 0.45], [frame, 1]];
}
