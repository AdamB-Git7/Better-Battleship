// Low-poly military ship models, generated entirely in code (no model files).
// Every model is built along the local +X axis (bow towards +X), centred on
// the origin, with y = 0 at the waterline. Lengths match the grid cells.
//
// To use real glTF models later, replace buildShipModel() with a loader that
// returns a THREE.Group with the same orientation and size.

import * as THREE from 'three';
import { CELL, SHIP_LENGTHS } from '../config.js';

const FREEBOARD = 1.9;   // height of the main deck above the water

const materials = {
    hull: new THREE.MeshStandardMaterial({ color: 0x56616d, roughness: 0.62, metalness: 0.35, flatShading: true }),
    deck: new THREE.MeshStandardMaterial({ color: 0x77828e, roughness: 0.8, metalness: 0.15, flatShading: true }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2c333c, roughness: 0.7, metalness: 0.3, flatShading: true }),
    detail: new THREE.MeshStandardMaterial({ color: 0xaab4bf, roughness: 0.55, metalness: 0.3, flatShading: true }),
    paint: new THREE.MeshStandardMaterial({ color: 0xe6e9ec, roughness: 0.9, metalness: 0 })
};

function mesh(geometry, material, x = 0, y = 0, z = 0) {
    const object = new THREE.Mesh(geometry, material);
    object.position.set(x, y, z);
    return object;
}

/** Box with w along the ship (x), h up (y), d across the ship (z). */
function box(w, h, d, material, x, y, z) {
    return mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z);
}

/** Hull seen from above: flat stern, straight sides, pointed bow. Extruded upwards. */
function hullGeometry(length, beam, height) {
    const hl = length / 2;
    const hb = beam / 2;
    const shape = new THREE.Shape();
    shape.moveTo(-hl, -hb * 0.7);
    shape.lineTo(-hl * 0.9, -hb);
    shape.lineTo(hl * 0.4, -hb);
    shape.quadraticCurveTo(hl * 0.82, -hb * 0.75, hl, 0);
    shape.quadraticCurveTo(hl * 0.82, hb * 0.75, hl * 0.4, hb);
    shape.lineTo(-hl * 0.9, hb);
    shape.lineTo(-hl, hb * 0.7);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 5 });
    geometry.rotateX(-Math.PI / 2);   // the extrusion now points up
    return geometry;
}

/** Hull + lighter deck plate on top. */
function addHull(group, length, beam) {
    const height = 3.2;
    const hull = mesh(hullGeometry(length, beam, height), materials.hull, 0, FREEBOARD - height, 0);
    const deck = mesh(hullGeometry(length * 0.95, beam * 0.84, 0.12), materials.deck, 0, FREEBOARD, 0);
    group.add(hull, deck);
}

/** Gun turret with two barrels. facing = +1 points to the bow, -1 to the stern. */
function turret(x, facing, scale = 1) {
    const group = new THREE.Group();
    group.position.set(x, FREEBOARD, 0);
    group.add(mesh(new THREE.CylinderGeometry(1.15 * scale, 1.25 * scale, 0.5, 10), materials.dark, 0, 0.25, 0));
    group.add(box(2.3 * scale, 0.95 * scale, 1.9 * scale, materials.detail, 0, 0.5 + 0.47 * scale, 0));
    for (const side of [-1, 1]) {
        const barrel = mesh(new THREE.CylinderGeometry(0.14 * scale, 0.14 * scale, 2.8 * scale, 6),
            materials.dark, facing * 2.4 * scale, 0.5 + 0.5 * scale, side * 0.42 * scale);
        barrel.rotation.z = Math.PI / 2;
        group.add(barrel);
    }
    return group;
}

/** Stepped bridge tower with a dark window strip on the top level. */
function bridge(x, width, depth, levels) {
    const group = new THREE.Group();
    group.position.set(x, FREEBOARD, 0);
    const levelHeight = 1.3;
    for (let i = 0; i < levels; i++) {
        const shrink = 1 - i * 0.22;
        group.add(box(width * shrink, levelHeight, depth * shrink, materials.detail,
            -i * 0.25, levelHeight * (i + 0.5), 0));
    }
    const top = 1 - (levels - 1) * 0.22;
    group.add(box(width * top * 0.5, 0.35, depth * top * 1.02, materials.dark,
        width * top * 0.27 - (levels - 1) * 0.25, levelHeight * (levels - 0.4), 0));
    return group;
}

function funnel(x, y = FREEBOARD) {
    const group = new THREE.Group();
    group.position.set(x, y, 0);
    group.add(mesh(new THREE.CylinderGeometry(0.55, 0.75, 2.6, 8), materials.hull, 0, 1.3, 0));
    group.add(mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.3, 8), materials.dark, 0, 2.7, 0));
    group.rotation.z = 0.12;   // raked slightly towards the stern
    return group;
}

function mast(x, baseY, height) {
    const group = new THREE.Group();
    group.position.set(x, baseY, 0);
    group.add(mesh(new THREE.CylinderGeometry(0.07, 0.1, height, 5), materials.dark, 0, height / 2, 0));
    group.add(box(0.1, 0.1, 1.8, materials.dark, 0, height * 0.72, 0));
    group.add(box(0.7, 0.35, 0.12, materials.detail, 0.1, height * 0.9, 0));   // radar
    return group;
}

const builders = {
    // 2 cells: small and fast, one forward gun.
    DESTROYER(length) {
        const group = new THREE.Group();
        addHull(group, length, 4.2);
        group.add(turret(5, 1, 0.85));
        group.add(bridge(-0.5, 4, 2.6, 2));
        group.add(funnel(-4.6));
        group.add(mast(-0.6, FREEBOARD + 2.6, 2.6));
        return group;
    },
    // 3 cells: a gun at each end, bridge in the middle.
    CRUISER(length) {
        const group = new THREE.Group();
        addHull(group, length, 4.8);
        group.add(turret(8.2, 1));
        group.add(turret(-9.2, -1));
        group.add(bridge(2.2, 5, 3, 3));
        group.add(funnel(-2.8));
        group.add(mast(1.6, FREEBOARD + 3.9, 3));
        return group;
    },
    // 4 cells: three heavy turrets, tall bridge, two funnels.
    BATTLESHIP(length) {
        const group = new THREE.Group();
        addHull(group, length, 5.6);
        group.add(turret(13, 1, 1.15));
        group.add(turret(8, 1, 1.15));
        group.add(turret(-12.5, -1, 1.15));
        group.add(bridge(2.5, 6, 3.6, 3));
        group.add(funnel(-2.5));
        group.add(funnel(-6));
        group.add(mast(2, FREEBOARD + 3.9, 3.6));
        return group;
    },
    // 5 cells: wide flat flight deck with runway markings and a side island.
    CARRIER(length) {
        const group = new THREE.Group();
        const beam = 5.8;
        addHull(group, length, beam);
        const deckY = FREEBOARD + 0.3;
        group.add(box(length * 0.96, 0.6, beam * 1.22, materials.dark, -0.6, deckY, 0));
        const paintY = deckY + 0.31;
        for (let i = 0; i < 9; i++) {
            group.add(box(2.4, 0.02, 0.28, materials.paint, -length * 0.4 + i * 4.6, paintY, -0.4));
        }
        group.add(box(length * 0.8, 0.02, 0.14, materials.paint, -2, paintY, -2.6));
        group.add(box(length * 0.8, 0.02, 0.14, materials.paint, -2, paintY, 1.9));
        // Island (command tower) on the starboard edge.
        const islandZ = beam * 0.47;
        group.add(box(7, 2.4, 1.7, materials.detail, 5, deckY + 1.5, islandZ));
        group.add(box(3.6, 1.2, 1.5, materials.detail, 5.6, deckY + 3.3, islandZ));
        group.add(box(1.8, 0.3, 1.55, materials.dark, 6.6, deckY + 3.5, islandZ));
        const stack = funnel(2.6, deckY + 2.2);
        stack.position.z = islandZ;
        stack.scale.setScalar(0.7);
        group.add(stack);
        const pole = mast(5.6, deckY + 3.9, 3);
        pole.position.z = islandZ;
        group.add(pole);
        return group;
    },
    // 3 cells: a rounded hull that barely breaks the surface, with a sail.
    SUBMARINE(length) {
        const group = new THREE.Group();
        const radius = 1.9;
        const body = new THREE.CapsuleGeometry(radius, length - radius * 2, 4, 10);
        body.rotateZ(Math.PI / 2);
        group.add(mesh(body, materials.dark, 0, -0.55, 0));
        group.add(box(length * 0.7, 0.1, 1.1, materials.hull, 0, 1.33, 0));   // walkway
        group.add(box(4.6, 2, 1.3, materials.hull, 2.4, 2.2, 0));              // sail
        group.add(box(1, 0.16, 3.4, materials.hull, 2.8, 2.5, 0));             // dive planes
        group.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.8, 5), materials.detail, 3.3, 4, 0));
        group.add(box(2.4, 2.6, 0.2, materials.hull, -length / 2 + 2.2, 0.7, 0));   // tail fin
        return group;
    }
};

/** Builds a new model for a ship type. */
export function buildShipModel(type) {
    const length = SHIP_LENGTHS[type] * CELL - 2;   // 1 unit of margin at each end
    const model = builders[type](length);
    model.userData.length = length;
    return model;
}

/** Translucent single-colour copy of a ship, used as the placement preview. */
export function buildGhostModel(type, material) {
    const model = buildShipModel(type);
    model.traverse(child => {
        if (child.isMesh) {
            child.material = material;
        }
    });
    return model;
}

export const DECK_HEIGHT = FREEBOARD;
