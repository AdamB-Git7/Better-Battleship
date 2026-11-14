// The two 10 x 10 grids drawn on the sea as thin glowing lines (no solid board),
// the hit / miss markers, the hover highlight, and mouse picking by raycasting.

import * as THREE from 'three';
import { CELL, GRID_SIZE, ROW_LABELS, ZONES, ZONE_SPAN, cellToWorld, worldToCell } from '../config.js';
import { labelTexture } from './textures.js';

const LINE_HEIGHT = 0.3;      // just above the water to avoid flickering
const ZONE_COLORS = { mine: 0x58d6ff, enemy: 0xffb054 };

export function createGrid(scene) {
    const root = new THREE.Group();
    scene.add(root);

    for (const zone of Object.keys(ZONES)) {
        root.add(buildLines(zone));
        root.add(buildLabels(zone));
    }

    // ---- Cell markers (result of the shots) --------------------------------
    const markerGroup = new THREE.Group();
    root.add(markerGroup);
    const markers = new Map();   // "zone:row:col" -> { state, object }

    const ringGeometry = new THREE.RingGeometry(CELL * 0.2, CELL * 0.3, 24).rotateX(-Math.PI / 2);
    const dotGeometry = new THREE.CircleGeometry(CELL * 0.07, 12).rotateX(-Math.PI / 2);
    const barGeometry = new THREE.PlaneGeometry(CELL * 0.62, CELL * 0.09).rotateX(-Math.PI / 2);
    const tileGeometry = new THREE.PlaneGeometry(CELL * 0.9, CELL * 0.9).rotateX(-Math.PI / 2);
    const flat = (color, opacity) => new THREE.MeshBasicMaterial({
        color, opacity, transparent: true, depthWrite: false, depthTest: false, fog: false
    });
    const materials = {
        miss: flat(0xe8f4ff, 0.85),
        hit: flat(0xff5a36, 0.95),
        sunk: flat(0x7a1408, 0.4)
    };

    function buildMarker(state) {
        const group = new THREE.Group();
        if (state === 'MISS') {
            group.add(new THREE.Mesh(ringGeometry, materials.miss));
            group.add(new THREE.Mesh(dotGeometry, materials.miss));
        } else {
            if (state === 'SUNK') {
                group.add(new THREE.Mesh(tileGeometry, materials.sunk));
            }
            // A red cross for every hit cell.
            for (const angle of [Math.PI / 4, -Math.PI / 4]) {
                const bar = new THREE.Mesh(barGeometry, materials.hit);
                bar.rotation.y = angle;
                group.add(bar);
            }
        }
        group.renderOrder = 5;
        return group;
    }

    /** Shows the marker of a cell. state is a CellView from the server. */
    function setCellState(zone, row, col, state) {
        const key = `${zone}:${row}:${col}`;
        const shown = state === 'MISS' || state === 'HIT' || state === 'SUNK' ? state : null;
        const current = markers.get(key);
        if ((current ? current.state : null) === shown) {
            return;
        }
        if (current) {
            markerGroup.remove(current.object);
            markers.delete(key);
        }
        if (shown) {
            const object = buildMarker(shown);
            cellToWorld(zone, row, col, object.position).y = LINE_HEIGHT + 0.05;
            markerGroup.add(object);
            markers.set(key, { state: shown, object });
        }
    }

    function clearMarkers() {
        markerGroup.clear();
        markers.clear();
    }

    // ---- Hover highlight -----------------------------------------------------
    // A small pool of translucent tiles, enough for the longest ship (5 cells).
    const hoverMaterial = flat(0xffffff, 0.42);
    const hoverTiles = [];
    for (let i = 0; i < 5; i++) {
        const tile = new THREE.Mesh(tileGeometry, hoverMaterial);
        tile.visible = false;
        tile.renderOrder = 6;
        root.add(tile);
        hoverTiles.push(tile);
    }

    function showHover(zone, cells, color) {
        hoverMaterial.color.set(color);
        hoverTiles.forEach((tile, i) => {
            tile.visible = i < cells.length;
            if (tile.visible) {
                cellToWorld(zone, cells[i].row, cells[i].col, tile.position).y = LINE_HEIGHT + 0.1;
            }
        });
    }

    function hideHover() {
        hoverTiles.forEach(tile => { tile.visible = false; });
    }

    // ---- Picking ----------------------------------------------------------------
    // Both grids lie on the sea plane (y = 0), so one ray / plane intersection
    // is enough to know which cell is under the mouse.
    const seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitPoint = new THREE.Vector3();

    /** @returns {{zone: string, row: number, col: number}|null} */
    function pick(raycaster) {
        if (!raycaster.ray.intersectPlane(seaPlane, hitPoint)) {
            return null;
        }
        return worldToCell('mine', hitPoint) || worldToCell('enemy', hitPoint);
    }

    return { setCellState, clearMarkers, showHover, hideHover, pick };
}

/** Thin additive lines: 11 horizontal + 11 vertical per zone, plus a brighter frame. */
function buildLines(zone) {
    const center = ZONES[zone].center;
    const half = ZONE_SPAN / 2;
    const inner = [];
    const frame = [];
    for (let i = 0; i <= GRID_SIZE; i++) {
        const offset = -half + i * CELL;
        const target = i === 0 || i === GRID_SIZE ? frame : inner;
        target.push(center.x - half, LINE_HEIGHT, center.z + offset, center.x + half, LINE_HEIGHT, center.z + offset);
        target.push(center.x + offset, LINE_HEIGHT, center.z - half, center.x + offset, LINE_HEIGHT, center.z + half);
    }
    const group = new THREE.Group();
    const add = (positions, opacity) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        const material = new THREE.LineBasicMaterial({
            color: ZONE_COLORS[zone],
            transparent: true,
            opacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            // The enemy grid stays readable through the fog (a tactical overlay).
            depthTest: zone !== 'enemy',
            fog: false
        });
        const lines = new THREE.LineSegments(geometry, material);
        lines.renderOrder = 4;
        group.add(lines);
    };
    add(inner, zone === 'enemy' ? 0.3 : 0.22);
    add(frame, 0.75);
    return group;
}

/** Letters A-J along the west side and numbers 1-10 along the north side. */
function buildLabels(zone) {
    const center = ZONES[zone].center;
    const half = ZONE_SPAN / 2;
    const color = zone === 'enemy' ? '#ffcf96' : '#a5eaff';
    const group = new THREE.Group();
    const add = (text, x, z) => {
        const material = new THREE.SpriteMaterial({
            map: labelTexture(text, color), transparent: true, opacity: 0.8,
            depthWrite: false, depthTest: false, fog: false
        });
        const sprite = new THREE.Sprite(material);
        sprite.position.set(x, 1, z);
        sprite.scale.setScalar(5.5);
        sprite.renderOrder = 4;
        group.add(sprite);
    };
    for (let i = 0; i < GRID_SIZE; i++) {
        const offset = -half + (i + 0.5) * CELL;
        add(ROW_LABELS[i], center.x - half - 5, center.z + offset);
        add(String(i + 1), center.x + offset, center.z - half - 5);
    }
    return group;
}
