// Shared constants and coordinate helpers.
// Everything that converts between "game" coordinates (row, col) and
// "world" coordinates (x, y, z in the 3D scene) lives here, so later blocks
// (bridge view, holographic board) can reuse the same layout.

import * as THREE from 'three';

export const GRID_SIZE = 10;          // classic 10 x 10 board
export const CELL = 10;               // world units per grid cell
export const ZONE_SPAN = GRID_SIZE * CELL;
export const ZONE_GAP = 24;           // open water between the two zones

// The two play zones. Mine is close to the camera (south, +z),
// the enemy zone is further away (north, -z) and hidden by the fog.
export const ZONES = {
    mine: { center: new THREE.Vector3(0, 0, (ZONE_SPAN + ZONE_GAP) / 2) },
    enemy: { center: new THREE.Vector3(0, 0, -(ZONE_SPAN + ZONE_GAP) / 2) }
};

export const ROW_LABELS = 'ABCDEFGHIJ';

// Must match ShipType on the server.
export const SHIP_LENGTHS = {
    CARRIER: 5,
    BATTLESHIP: 4,
    CRUISER: 3,
    SUBMARINE: 3,
    DESTROYER: 2
};
export const FLEET_SIZE = Object.keys(SHIP_LENGTHS).length;

/** World position of the centre of a cell (y = 0 is the sea surface). */
export function cellToWorld(zone, row, col, target = new THREE.Vector3()) {
    const center = ZONES[zone].center;
    return target.set(
        center.x + (col - (GRID_SIZE - 1) / 2) * CELL,
        0,
        center.z + (row - (GRID_SIZE - 1) / 2) * CELL
    );
}

/** Cell under a world point for one zone, or null if the point is outside it. */
export function worldToCell(zone, point) {
    const center = ZONES[zone].center;
    const col = Math.floor((point.x - center.x) / CELL + GRID_SIZE / 2);
    const row = Math.floor((point.z - center.z) / CELL + GRID_SIZE / 2);
    if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE) {
        return null;
    }
    return { zone, row, col };
}

/** The cells a ship would cover (may include out-of-board cells). */
export function shipCells(type, row, col, orientation) {
    const cells = [];
    for (let i = 0; i < SHIP_LENGTHS[type]; i++) {
        cells.push(orientation === 'HORIZONTAL'
            ? { row, col: col + i }
            : { row: row + i, col });
    }
    return cells;
}

export function inBounds(cell) {
    return cell.row >= 0 && cell.row < GRID_SIZE && cell.col >= 0 && cell.col < GRID_SIZE;
}
