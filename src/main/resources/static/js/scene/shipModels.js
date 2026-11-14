// Warship models, generated entirely in code (no model files).
//
// Every model is built along the local +X axis (bow towards +X, starboard is
// +Z), centred on the origin, with y = 0 at the waterline. Lengths match the
// grid cells. Placement, the preview ghost and the holograms rely on this.
//
// How a ship is made:
//  1. The hull is "lofted": a list of cross-sections from stern to bow, joined
//     by triangles. That gives a real ship shape (pointed flared bow, rising
//     sheer line, rounded bilge) instead of an extruded outline.
//  2. Everything on deck (turrets, bridge, funnels, masts, boats...) is made
//     of simple boxes and cylinders.
//  3. All the parts that share a material are merged into ONE mesh, so a ship
//     costs a handful of draw calls however detailed it is.
//
// To use real glTF models later, replace buildShipModel() with a loader that
// returns a THREE.Group with the same orientation and size.

import * as THREE from 'three';
import { CELL, SHIP_LENGTHS } from '../config.js';
import { deckTexture, flightDeckTexture, hullTexture, numberTexture, plateTexture } from './textures.js';

const FREEBOARD = 1.9;        // height of the main deck above the water
const DRAFT = 1.5;            // depth of the keel under the water
const HULL_TEXTURE_SPAN = 4.2;   // world height covered by the hull texture (keel to above the bow)

// ---- Materials (shared by all ships) --------------------------------------------

let materials = null;

function getMaterials() {
    if (materials) {
        return materials;
    }
    const plate = plateTexture();
    const standard = options => new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0.3, ...options });
    materials = {
        // Painted steel hull: red anti-fouling paint below the waterline, grime above.
        hull: standard({ map: hullTexture(), roughness: 0.6 }),
        deck: standard({ color: 0x5a6067, map: deckTexture(), roughness: 0.9, metalness: 0.1 }),
        upper: standard({ color: 0x9aa3ab, map: plate }),            // superstructure, turrets
        dark: standard({ color: 0x2a2f35, map: plate, roughness: 0.7 }),
        black: standard({ color: 0x0c0e10, roughness: 0.8, metalness: 0.2 }),
        // Bridge windows: a faint warm light inside, so the ships look manned.
        glass: standard({ color: 0x0b1215, emissive: 0xffc98a, emissiveIntensity: 0.55, roughness: 0.2, metalness: 0.6 }),
        white: standard({ color: 0xc4c9cc, roughness: 0.75, metalness: 0.05 }),
        orange: standard({ color: 0xa5482a, roughness: 0.8, metalness: 0.05 }),
        submarine: standard({ color: 0x14171a, roughness: 0.45, metalness: 0.35 }),
        flightDeck: standard({ map: flightDeckTexture(), roughness: 0.92, metalness: 0.05 }),
        aircraft: standard({ color: 0x7f8990, roughness: 0.5, metalness: 0.4 }),
        // Navigation lights: they glow by themselves.
        lightRed: new THREE.MeshBasicMaterial({ color: 0xff3020 }),
        lightGreen: new THREE.MeshBasicMaterial({ color: 0x30ff70 }),
        lightWhite: new THREE.MeshBasicMaterial({ color: 0xfff0d0 }),
        rail: new THREE.LineBasicMaterial({ color: 0x9aa4ad, transparent: true, opacity: 0.5 })
    };
    return materials;
}

// ---- Merging many small parts into a few meshes ---------------------------------

const pose = new THREE.Matrix4();
const poseQuaternion = new THREE.Quaternion();
const poseEuler = new THREE.Euler();
const posePosition = new THREE.Vector3();
const poseScale = new THREE.Vector3();

/**
 * Collects geometries per material, then builds one mesh per material.
 * `push` / `pop` place a whole group of parts (a turret, a mast) at once.
 */
function createBatch() {
    const parts = new Map();   // material -> list of geometries, already in ship coordinates
    const stack = [new THREE.Matrix4()];

    function add(geometry, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
        const copy = geometry.index ? geometry.toNonIndexed() : geometry.clone();
        pose.compose(posePosition.set(x, y, z), poseQuaternion.setFromEuler(poseEuler.set(rx, ry, rz)), poseScale.set(sx, sy, sz));
        copy.applyMatrix4(pose.premultiply(stack[stack.length - 1]));
        if (!parts.has(material)) {
            parts.set(material, []);
        }
        parts.get(material).push(copy);
    }

    return {
        add,
        /** Box with w along the ship (x), h up (y), d across the ship (z), centred at (x, y, z). */
        box(w, h, d, material, x, y, z, ry = 0) {
            add(new THREE.BoxGeometry(w, h, d), material, x, y, z, 0, ry, 0);
        },
        /** Upright cylinder (or cone) standing on (x, y, z). */
        post(radiusTop, radiusBottom, height, material, x, y, z, sides = 8) {
            add(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, sides), material, x, y + height / 2, z);
        },
        /** Cylinder lying along the ship, raised by `elevation` radians at its +x end. */
        barrel(radius, length, material, x, y, z, elevation = 0) {
            add(new THREE.CylinderGeometry(radius, radius, length, 6), material, x, y, z, 0, 0, -Math.PI / 2 + elevation);
        },
        push(x, y, z, ry = 0, scale = 1) {
            const matrix = new THREE.Matrix4().compose(
                new THREE.Vector3(x, y, z),
                new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)),
                new THREE.Vector3(scale, scale, scale));
            stack.push(matrix.premultiply(stack[stack.length - 1]));
        },
        pop() {
            stack.pop();
        },
        /** One mesh per material, added to `group`. */
        build(group) {
            for (const [material, geometries] of parts) {
                group.add(new THREE.Mesh(mergeGeometries(geometries), material));
            }
        }
    };
}

/** Joins geometries (all non-indexed, with position / normal / uv) into one. */
function mergeGeometries(geometries) {
    let count = 0;
    for (const geometry of geometries) {
        count += geometry.attributes.position.count;
    }
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    let offset = 0;
    for (const geometry of geometries) {
        position.set(geometry.attributes.position.array, offset * 3);
        normal.set(geometry.attributes.normal.array, offset * 3);
        uv.set(geometry.attributes.uv.array, offset * 2);
        offset += geometry.attributes.position.count;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return merged;
}

// ---- Hull -----------------------------------------------------------------------

const smooth = (edge0, edge1, x) => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};

/**
 * The shape of a hull as a set of functions of t (0 = stern, 1 = bow).
 * @param spec length, beam, and optional: sheer (rise of the deck at the bow),
 *        transom (width of the stern, 0..1), flare (how much narrower the bow
 *        is at the waterline than at the deck), rake (overhang of the stem)
 */
function hullShape({ length, beam, sheer = 0.7, transom = 0.72, flare = 0.5, rake = 1.4 }) {
    const half = beam / 2;
    const shape = {
        length,
        /** Half width of the deck. */
        deckHalf(t) {
            const stern = transom + (1 - transom) * smooth(0, 0.28, t);
            const bow = 1 - Math.pow(Math.max(0, (t - 0.52) / 0.48), 2.2);
            return Math.max(0.03, half * stern * bow);
        },
        /** Half width at the waterline: the bow is much finer down there. */
        waterHalf(t) {
            return shape.deckHalf(t) * (1 - flare * smooth(0.5, 1, t)) * (0.9 + 0.1 * smooth(0, 0.3, t));
        },
        deckY(t) {
            return FREEBOARD + sheer * Math.pow(Math.max(0, (t - 0.58) / 0.42), 2);
        },
        keelY(t) {
            // The keel rises towards the stern (propellers) and at the forefoot.
            return -DRAFT * (1 - 0.65 * (1 - smooth(0, 0.2, t)) - 0.35 * smooth(0.9, 1, t));
        },
        /** Position along the ship; the stem leans forward (rake) towards the top. */
        x(t, y) {
            const lean = rake * Math.pow(Math.max(0, (t - 0.7) / 0.3), 2);
            return -length / 2 + t * (length - rake) + lean * (y + DRAFT) / (FREEBOARD + DRAFT + sheer);
        },
        /** Half width of the hull side at height y (between waterline and deck). */
        sideZ(t, y) {
            const k = Math.min(1, Math.max(0, y / shape.deckY(t)));
            return shape.waterHalf(t) + (shape.deckHalf(t) - shape.waterHalf(t)) * Math.pow(k, 0.8);
        },
        /** t of the station whose deck is at the given x (deck level). */
        tAt(x) {
            return Math.min(1, Math.max(0, (x + length / 2) / length));
        },
        deckYAt(x) {
            return shape.deckY(shape.tAt(x));
        }
    };
    return shape;
}

/** The hull skin: cross-sections from stern to bow, joined by triangles. */
function hullGeometry(shape) {
    const stations = 22;
    const ring = [];     // per station: points from the port deck edge, under the keel, to the starboard deck edge
    for (let i = 0; i <= stations; i++) {
        const t = i / stations;
        const deck = shape.deckY(t);
        const keel = shape.keelY(t);
        const water = shape.waterHalf(t);
        // Starboard half, from the keel up: keel, turn of the bilge, waterline, side, deck edge.
        const half = [
            [0, keel],
            [water * 0.55, keel + 0.12],
            [water * 0.9, keel * 0.45],
            [water, 0],
            [shape.sideZ(t, deck * 0.5), deck * 0.5],
            [shape.deckHalf(t), deck]
        ];
        const points = [];
        for (let j = half.length - 1; j > 0; j--) {
            points.push([-half[j][0], half[j][1]]);      // port side, deck down to bilge
        }
        for (const point of half) {
            points.push(point);                          // keel, then up the starboard side
        }
        ring.push(points.map(([z, y]) => new THREE.Vector3(shape.x(t, y), y, z)));
    }
    const perRing = ring[0].length;
    const positions = [];
    const uvs = [];
    for (const points of ring) {
        for (const p of points) {
            positions.push(p.x, p.y, p.z);
            uvs.push(p.x / 22, (p.y + DRAFT) / HULL_TEXTURE_SPAN);
        }
    }
    const indices = [];
    for (let i = 0; i < stations; i++) {
        for (let j = 0; j < perRing - 1; j++) {
            const a = i * perRing + j;
            const b = a + perRing;
            indices.push(a, b, b + 1, a, b + 1, a + 1);
        }
    }
    const skin = new THREE.BufferGeometry();
    skin.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    skin.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    skin.setIndex(indices);
    skin.computeVertexNormals();

    // The flat stern (transom): a fan of triangles closing the first ring.
    const stern = ring[0];
    const transomPositions = [];
    const transomUvs = [];
    for (let j = 1; j < perRing - 1; j++) {
        for (const p of [stern[0], stern[j + 1], stern[j]]) {
            transomPositions.push(p.x, p.y, p.z);
            transomUvs.push(p.z / 22, (p.y + DRAFT) / HULL_TEXTURE_SPAN);
        }
    }
    const transom = new THREE.BufferGeometry();
    transom.setAttribute('position', new THREE.Float32BufferAttribute(transomPositions, 3));
    transom.setAttribute('uv', new THREE.Float32BufferAttribute(transomUvs, 2));
    transom.computeVertexNormals();
    return [skin, transom];
}

/** The deck plating: a strip from one deck edge to the other, following the sheer. */
function deckGeometry(shape) {
    const stations = 22;
    const positions = [];
    const uvs = [];
    const edge = t => {
        const half = shape.deckHalf(t) * 0.985;
        const y = shape.deckY(t);
        const x = shape.x(t, y);
        return [[x, y, -half], [x, y, half]];
    };
    for (let i = 0; i < stations; i++) {
        const [portA, starA] = edge(i / stations);
        const [portB, starB] = edge((i + 1) / stations);
        for (const p of [portA, starA, starB, portA, starB, portB]) {
            positions.push(p[0], p[1], p[2]);
            uvs.push(p[0] / 7, p[2] / 7);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    return geometry;
}

/** Guard rails along both deck edges, as thin lines: [x, y, z, x, y, z, ...]. */
function railLines(shape, from = 0.02, to = 0.985) {
    const lines = [];
    const steps = Math.round(shape.length / 1.3);
    for (const side of [-1, 1]) {
        let previous = null;
        for (let i = 0; i <= steps; i++) {
            const t = from + (to - from) * (i / steps);
            const y = shape.deckY(t);
            const point = [shape.x(t, y), y, side * shape.deckHalf(t) * 0.97];
            lines.push(point[0], y, point[2], point[0], y + 0.55, point[2]);          // stanchion
            if (previous) {
                for (const height of [0.28, 0.55]) {                                    // two rails
                    lines.push(previous[0], previous[1] + height, previous[2], point[0], y + height, point[2]);
                }
            }
            previous = point;
        }
    }
    return lines;
}

/** Hull number painted on both sides of the bow. */
function addHullNumber(group, shape, text) {
    const t = 0.76;
    const y = 1.05;
    const height = 1.0;
    const width = height * 0.62 * text.length;
    const material = new THREE.MeshStandardMaterial({
        map: numberTexture(text), alphaTest: 0.35, roughness: 0.8, metalness: 0.1,
        polygonOffset: true, polygonOffsetFactor: -2
    });
    // Slopes of the hull side at that spot, so the paint lies on the plating.
    const x = shape.x(t, y);
    const z = shape.sideZ(t, y);
    const a = (shape.sideZ(t + 0.02, y) - shape.sideZ(t - 0.02, y)) / (shape.x(t + 0.02, y) - shape.x(t - 0.02, y));
    const b = (shape.sideZ(t, y + 0.2) - shape.sideZ(t, y - 0.2)) / 0.4;
    for (const side of [1, -1]) {
        const tangent = new THREE.Vector3(side, 0, a).normalize();           // reading direction
        const up = new THREE.Vector3(0, 1, side * b).normalize();
        const normal = new THREE.Vector3().crossVectors(tangent, up).normalize();
        up.crossVectors(normal, tangent);
        const decal = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        decal.matrixAutoUpdate = false;
        decal.matrix.makeBasis(tangent, up, normal).setPosition(x + normal.x * 0.03, y, side * z + normal.z * 0.03);
        decal.userData.detail = true;
        group.add(decal);
    }
}

// ---- Parts on deck --------------------------------------------------------------

let gunHouse = null;

/** Armoured gun house with a sloped front, seen from the side: extruded across. */
function gunHouseGeometry() {
    if (!gunHouse) {
        const profile = new THREE.Shape();
        profile.moveTo(-1.25, 0);
        profile.lineTo(1.35, 0);
        profile.lineTo(1.1, 0.55);
        profile.lineTo(0.3, 0.95);
        profile.lineTo(-1.25, 0.95);
        profile.closePath();
        gunHouse = new THREE.ExtrudeGeometry(profile, { depth: 2, bevelEnabled: false }).translate(0, 0, -1);
    }
    return gunHouse;
}

/**
 * Gun turret. facing = +1 points to the bow, -1 to the stern.
 * @param barrels 1, 2 or 3 guns
 * @param raise extra height of the barbette (a turret firing over another one)
 */
function turret(batch, m, x, y, facing, scale = 1, barrels = 2, raise = 0) {
    batch.push(x, y, 0, facing > 0 ? 0 : Math.PI, scale);
    batch.post(1.2, 1.3, 0.4 + raise, m.dark, 0, 0, 0, 12);                       // barbette
    const top = 0.4 + raise;
    batch.add(gunHouseGeometry(), m.upper, 0, top, 0);
    batch.box(0.5, 0.25, 2.5, m.upper, -0.5, top + 0.85, 0);                       // rangefinder
    for (let i = 0; i < barrels; i++) {
        const z = (i - (barrels - 1) / 2) * 0.62;
        batch.barrel(0.2, 0.7, m.dark, 1.55, top + 0.42, z, 0.07);                // sleeve
        batch.barrel(0.12, 3.1, m.dark, 2.9, top + 0.52, z, 0.07);
    }
    batch.pop();
}

/** Small anti-aircraft gun. */
function lightGun(batch, m, x, y, z, facing = 1) {
    batch.post(0.28, 0.34, 0.35, m.dark, x, y, z, 8);
    batch.box(0.5, 0.3, 0.4, m.upper, x, y + 0.5, z);
    batch.barrel(0.045, 1.1, m.dark, x + facing * 0.6, y + 0.68, z, facing > 0 ? 0.45 : Math.PI - 0.45);
}

/**
 * A block of superstructure with a strip of lit windows near its top.
 * (x, y) is the middle of its base.
 */
function house(batch, m, x, y, w, h, d, windows = false) {
    batch.box(w, h, d, m.upper, x, y + h / 2, 0);
    if (windows) {
        // A slightly larger dark band around the front and the sides.
        batch.box(w * 0.62, 0.3, d + 0.04, m.glass, x + w * 0.2, y + h - 0.42, 0);
        batch.box(0.04, 0.3, d * 0.9, m.glass, x + w / 2 + 0.01, y + h - 0.42, 0);
    }
}

/** Oval funnel, raked aft, with a black top. */
function funnel(batch, m, x, y, scale = 1, z = 0) {
    batch.push(x, y, z, 0, scale);
    batch.add(new THREE.CylinderGeometry(0.62, 0.82, 2.7, 14), m.upper, -0.16, 1.35, 0, 0, 0, 0.12, 1.25, 1, 0.8);
    batch.add(new THREE.CylinderGeometry(0.65, 0.63, 0.5, 14), m.black, -0.35, 2.92, 0, 0, 0, 0.12, 1.25, 1, 0.8);
    batch.post(0.07, 0.07, 2.4, m.dark, 0.75, 0.2, 0.25, 5);                        // steam pipe
    batch.box(1.9, 0.12, 1.5, m.dark, -0.05, 0.9, 0);                               // band
    batch.pop();
}

/** Mast with a yard, a radar aerial, whip antennas and a masthead light. */
function mast(batch, m, x, y, height, z = 0) {
    batch.push(x, y, z);
    batch.post(0.07, 0.13, height, m.dark, 0, 0, 0, 6);
    // Two legs make it a tripod: it reads as a real mast, not a stick.
    batch.add(new THREE.CylinderGeometry(0.05, 0.06, height * 0.74, 5), m.dark, -0.5, height * 0.35, 0.3, 0, 0, -0.42);
    batch.add(new THREE.CylinderGeometry(0.05, 0.06, height * 0.74, 5), m.dark, -0.5, height * 0.35, -0.3, 0, 0, -0.42);
    batch.post(0.5, 0.35, 0.3, m.upper, 0, height * 0.58, 0, 8);                    // platform
    batch.box(0.08, 0.08, 2.6, m.dark, 0, height * 0.76, 0);                        // yard
    batch.box(0.1, 0.62, 1.5, m.dark, 0.14, height * 0.92, 0);                      // radar aerial
    batch.box(0.05, 0.5, 1.3, m.upper, 0.2, height * 0.92, 0);
    batch.post(0.02, 0.03, height * 0.5, m.dark, -0.1, height, 0, 4);               // topmast
    batch.post(0.015, 0.015, height * 0.36, m.dark, 0, height * 0.76, 1.2, 4);      // whip antennas
    batch.post(0.015, 0.015, height * 0.36, m.dark, 0, height * 0.76, -1.2, 4);
    batch.add(new THREE.SphereGeometry(0.09, 6, 4), m.lightWhite, 0.12, height * 1.02, 0);
    batch.pop();
}

/** A ship's boat under its davits. side = +1 starboard, -1 port. */
function lifeboat(batch, m, x, y, z) {
    batch.add(new THREE.SphereGeometry(0.5, 8, 6), m.white, x, y + 0.62, z, 0, 0, 0, 1.7, 0.5, 0.6);
    batch.box(1.3, 0.07, 0.5, m.orange, x, y + 0.84, z);                             // canvas cover
    batch.post(0.04, 0.04, 1.05, m.dark, x - 0.6, y, z, 4);
    batch.post(0.04, 0.04, 1.05, m.dark, x + 0.6, y, z, 4);
}

/** Things every surface ship has on its foredeck and stern. */
function deckFittings(batch, m, shape) {
    const bowX = shape.length / 2;
    const fore = x => shape.deckYAt(x);
    const capstanX = bowX - shape.length * 0.11;
    for (const side of [-1, 1]) {
        batch.post(0.2, 0.24, 0.3, m.dark, capstanX, fore(capstanX), side * 0.4, 8);             // capstans
        batch.box(1.5, 0.06, 0.1, m.black, capstanX + 0.9, fore(capstanX + 0.9) + 0.03, side * 0.34);   // anchor chains
        batch.post(0.1, 0.1, 0.25, m.dark, -bowX + 1.6, FREEBOARD, side * shape.deckHalf(0.06) * 0.7, 6);   // bollards
    }
    batch.post(0.025, 0.03, 1.5, m.dark, bowX - 0.9, fore(bowX - 0.9), 0, 4);       // jackstaff
    batch.post(0.025, 0.03, 1.7, m.dark, -bowX + 0.4, FREEBOARD, 0, 4);             // ensign staff
}

/** Red and green side lights on the bridge wings. */
function sideLights(batch, m, x, y, halfWidth) {
    batch.add(new THREE.SphereGeometry(0.09, 6, 4), m.lightGreen, x, y, halfWidth);
    batch.add(new THREE.SphereGeometry(0.09, 6, 4), m.lightRed, x, y, -halfWidth);
}

/** Hull, deck and the fittings common to all surface ships. */
function surfaceShip(spec) {
    const m = getMaterials();
    const shape = hullShape(spec);
    const batch = createBatch();
    for (const geometry of hullGeometry(shape)) {
        batch.add(geometry, m.hull);
    }
    batch.add(deckGeometry(shape), m.deck);
    deckFittings(batch, m, shape);
    return { m, shape, batch };
}

// ---- The five ships -------------------------------------------------------------

const builders = {
    // 2 cells: small and fast. One gun forward, one aft, a single funnel.
    DESTROYER(length) {
        const { m, shape, batch } = surfaceShip({ length, beam: 3.7, sheer: 0.75, rake: 1.2 });
        const deck = FREEBOARD;
        turret(batch, m, 4.0, shape.deckYAt(4.0), 1, 0.62, 1);
        house(batch, m, 0.9, deck, 3.6, 1.2, 2.7);
        house(batch, m, 1.3, deck + 1.2, 2.2, 1.1, 2.3, true);
        batch.box(0.9, 0.1, 3.3, m.upper, 1.0, deck + 1.25, 0);                     // bridge wings
        sideLights(batch, m, 1.0, deck + 1.5, 1.65);
        mast(batch, m, 0.1, deck + 2.3, 3.4);
        funnel(batch, m, -2.3, deck, 0.8);
        house(batch, m, -4.7, deck, 2.2, 0.9, 2.2);
        lightGun(batch, m, -4.7, deck + 0.9, 0);
        turret(batch, m, -6.6, deck, -1, 0.55, 1);
        lifeboat(batch, m, -0.9, deck, 1.3);
        lifeboat(batch, m, -0.9, deck, -1.3);
        batch.box(1.0, 0.35, 0.5, m.dark, -7.9, deck + 0.18, 0.6);                   // depth charge racks
        batch.box(1.0, 0.35, 0.5, m.dark, -7.9, deck + 0.18, -0.6);
        return { batch, shape, number: 'D47' };
    },
    // 3 cells: two turrets forward (one firing over the other), one aft.
    CRUISER(length) {
        const { m, shape, batch } = surfaceShip({ length, beam: 4.7, sheer: 0.8 });
        const deck = FREEBOARD;
        turret(batch, m, 8.8, shape.deckYAt(8.8), 1, 0.8, 2);
        turret(batch, m, 5.9, shape.deckYAt(5.9), 1, 0.8, 2, 0.95);
        house(batch, m, 1.9, deck, 5.4, 1.3, 3.4);
        house(batch, m, 2.3, deck + 1.3, 3.6, 1.2, 2.9);
        house(batch, m, 2.7, deck + 2.5, 2.3, 1.1, 2.4, true);
        batch.box(1.0, 0.1, 4.0, m.upper, 2.4, deck + 2.55, 0);                      // bridge wings
        sideLights(batch, m, 2.4, deck + 2.8, 2.0);
        mast(batch, m, 1.3, deck + 3.6, 4.0);
        funnel(batch, m, -1.2, deck + 0.4, 0.95);
        funnel(batch, m, -4.0, deck + 0.4, 0.95);
        batch.box(6.2, 0.4, 3.0, m.upper, -2.6, deck + 0.2, 0);                      // boat deck
        for (const side of [-1, 1]) {
            lifeboat(batch, m, -2.6, deck + 0.4, side * 1.75);
            lightGun(batch, m, 0.4, deck + 1.3, side * 1.3);
            lightGun(batch, m, -5.4, deck + 0.4, side * 1.2, -1);
        }
        house(batch, m, -7.0, deck, 2.6, 1.2, 2.6);
        mast(batch, m, -6.6, deck + 1.2, 3.0);
        turret(batch, m, -10.0, deck, -1, 0.8, 2);
        return { batch, shape, number: 'C21' };
    },
    // 4 cells: three heavy triple turrets, a tall tower, two funnels, a row of
    // secondary guns along each side.
    BATTLESHIP(length, options) {
        const { m, shape, batch } = surfaceShip({ length, beam: 6.2, sheer: 0.9, rake: 1.7 });
        const deck = FREEBOARD;
        turret(batch, m, 13.2, shape.deckYAt(13.2), 1, 1.08, 3);
        turret(batch, m, 8.4, shape.deckYAt(8.4), 1, 1.08, 3, 1.0);
        if (!options.foredeckOnly) {
            // The tower is 2.5 units ahead of the centre (bridge.js relies on it).
            house(batch, m, 2.3, deck, 7.0, 1.4, 4.2);
            house(batch, m, 2.6, deck + 1.4, 5.0, 1.3, 3.6);
            house(batch, m, 3.0, deck + 2.7, 3.4, 1.2, 3.0, true);
            house(batch, m, 2.9, deck + 3.9, 2.2, 1.1, 2.4, true);
            batch.box(1.2, 0.1, 5.0, m.upper, 3.0, deck + 2.75, 0);
            sideLights(batch, m, 3.0, deck + 3.0, 2.5);
            batch.post(0.75, 0.75, 0.5, m.upper, 2.7, deck + 5.0, 0, 10);            // gun director
            batch.box(0.3, 0.25, 3.0, m.dark, 2.7, deck + 5.3, 0);
            mast(batch, m, 1.5, deck + 5.0, 4.4);
            funnel(batch, m, -2.2, deck + 0.5, 1.15);
            funnel(batch, m, -5.6, deck + 0.5, 1.15);
            batch.box(8.6, 0.5, 4.0, m.upper, -3.6, deck + 0.25, 0);                 // boat deck
            for (const side of [-1, 1]) {
                for (const x of [5.6, 0.2, -7.4]) {                                  // secondary turrets
                    batch.push(x, deck, side * 2.45, side > 0 ? -0.5 : 0.5, 0.42);
                    batch.post(1.2, 1.3, 0.5, m.dark, 0, 0, 0, 10);
                    batch.add(gunHouseGeometry(), m.upper, 0, 0.5, 0);
                    batch.barrel(0.13, 2.6, m.dark, 2.5, 1.0, 0.4, 0.1);
                    batch.barrel(0.13, 2.6, m.dark, 2.5, 1.0, -0.4, 0.1);
                    batch.pop();
                }
                lifeboat(batch, m, -3.8, deck + 0.5, side * 2.3);
                lightGun(batch, m, -1.2, deck + 0.5, side * 1.8);
                lightGun(batch, m, -9.4, deck + 1.2, side * 1.0, -1);
            }
            house(batch, m, -9.0, deck, 3.2, 1.2, 3.2);
            batch.post(0.6, 0.6, 0.45, m.upper, -9.0, deck + 1.2, 0, 10);
            mast(batch, m, -8.2, deck + 1.2, 3.4);
            turret(batch, m, -13.0, deck, -1, 1.08, 3);
        }
        return { batch, shape, number: 'B63' };
    },
    // 5 cells: a full-length flight deck with an angled landing strip to port,
    // an island on the starboard side, and aircraft parked on deck.
    CARRIER(length) {
        const { m, shape, batch } = surfaceShip({ length, beam: 6.4, sheer: 0.3, transom: 0.85, flare: 0.6, rake: 2.2 });
        const hl = length / 2;
        const deckY = FREEBOARD + 1.5;      // top of the flight deck
        // Hangar: the block between the hull and the flight deck, with dark openings.
        batch.box(length * 0.66, 1.2, 5.0, m.upper, -3.6, FREEBOARD + 0.6, 0);
        for (const x of [-14, -5, 6]) {
            batch.box(4.2, 0.75, 5.06, m.black, x, FREEBOARD + 0.55, 0);
        }
        // Pillars under the forward end of the flight deck.
        for (const side of [-1, 1]) {
            batch.post(0.12, 0.12, 1.3, m.upper, 16.5, shape.deckYAt(16.5), side * 1.1, 6);
        }
        // Flight deck outline, seen from above (x along the ship, y = port side).
        const outline = new THREE.Shape();
        outline.moveTo(-hl + 0.3, -3.5);
        outline.lineTo(hl - 6, -3.5);
        outline.lineTo(hl - 0.5, -2.3);
        outline.lineTo(hl - 0.5, 2.3);
        outline.lineTo(hl - 7, 3.4);
        outline.lineTo(6, 3.6);
        outline.lineTo(2, 5.9);            // the angled deck sticks out to port
        outline.lineTo(-12, 5.9);
        outline.lineTo(-16, 3.5);
        outline.lineTo(-hl + 0.3, 3.5);
        outline.closePath();
        const slab = new THREE.ExtrudeGeometry(outline, { depth: 0.35, bevelEnabled: false }).rotateX(-Math.PI / 2);
        batch.add(slab, m.dark, 0, deckY - 0.36, 0);
        // The painted top: its texture is mapped over the whole deck (see textures.js).
        const top = new THREE.ShapeGeometry(outline).rotateX(-Math.PI / 2);
        const uv = top.attributes.uv;
        const position = top.attributes.position;
        for (let i = 0; i < uv.count; i++) {
            uv.setXY(i, (position.getX(i) + hl) / length, 1 - (position.getZ(i) + 7) / 14);
        }
        batch.add(top, m.flightDeck, 0, deckY, 0);
        // Catwalks and gun sponsons under the deck edge.
        batch.box(length * 0.5, 0.12, 0.5, m.dark, -4, deckY - 0.6, -3.75);
        batch.box(length * 0.3, 0.12, 0.5, m.dark, -12, deckY - 0.6, 3.75);
        lightGun(batch, m, hl - 9, deckY - 0.5, 3.6);
        lightGun(batch, m, -hl + 4, deckY - 0.5, -3.7, -1);
        lightGun(batch, m, -hl + 4, deckY - 0.5, 3.7, -1);

        // Island (command tower) on the starboard edge.
        const z = 2.75;
        batch.push(5, deckY, z);
        batch.box(8, 1.6, 1.5, m.upper, 0, 0.8, 0);
        batch.box(5.4, 1.2, 1.4, m.upper, 0.6, 2.2, 0);
        batch.box(3.4, 0.3, 1.46, m.glass, 1.3, 2.35, 0);                             // flight control windows
        batch.box(3.0, 1.0, 1.3, m.upper, 1.6, 3.3, 0);
        batch.box(2.2, 0.3, 1.36, m.glass, 1.9, 3.45, 0);                             // navigation bridge
        batch.pop();
        funnel(batch, m, 2.2, deckY + 1.6, 0.85, z);
        mast(batch, m, 5.6, deckY + 3.8, 3.6, z);
        batch.box(0.12, 1.0, 2.2, m.dark, 7.4, deckY + 4.6, z);                       // big air-search radar
        batch.post(0.05, 0.07, 1.0, m.dark, 7.4, deckY + 3.8, z, 5);
        batch.add(new THREE.SphereGeometry(0.42, 10, 8), m.white, 3.6, deckY + 4.2, z);   // radome

        // Parked aircraft: a fuselage, swept wings and twin tails each.
        const jets = [[-19, 2.2, 0.5], [-16.5, 2.4, 0.5], [-14, 2.2, 0.5], [9.5, -2.3, -0.4], [12, -2.2, -0.4], [-9, -4.6, 2.6]];
        for (const [x, jz, turn] of jets) {
            batch.push(x, deckY, jz, turn, 0.8);
            batch.box(2.2, 0.26, 0.3, m.aircraft, 0, 0.32, 0);
            batch.add(new THREE.ConeGeometry(0.15, 0.6, 6), m.aircraft, 1.38, 0.32, 0, 0, 0, -Math.PI / 2);
            batch.box(0.8, 0.05, 1.9, m.aircraft, -0.25, 0.3, 0);
            batch.box(0.4, 0.05, 0.9, m.aircraft, -1.0, 0.32, 0);
            batch.box(0.45, 0.42, 0.04, m.aircraft, -0.95, 0.6, 0.18);
            batch.box(0.45, 0.42, 0.04, m.aircraft, -0.95, 0.6, -0.18);
            batch.box(0.5, 0.13, 0.2, m.glass, 0.55, 0.47, 0);
            batch.pop();
        }
        return { batch, shape, number: null };
    },
    // 3 cells: a round hull that barely breaks the surface, a sail with dive
    // planes, and a cross of fins at the stern.
    SUBMARINE(length) {
        const m = getMaterials();
        const batch = createBatch();
        // The hull is a body of revolution: a blunt rounded bow, a long parallel
        // middle, and a stern that tapers to the propeller.
        const radius = 1.75;
        const profile = [];
        for (let i = 0; i <= 26; i++) {
            const t = i / 26;                                    // 0 = stern tip, 1 = bow tip
            let r;
            if (t > 0.86) {
                r = radius * Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.86) / 0.14, 2)));   // bow dome
            } else if (t < 0.42) {
                r = radius * (0.08 + 0.92 * Math.pow(t / 0.42, 0.75));                      // stern cone
            } else {
                r = radius;
            }
            profile.push(new THREE.Vector2(r, (t - 0.5) * length));
        }
        const body = new THREE.LatheGeometry(profile, 18).rotateZ(-Math.PI / 2);
        const centreY = -0.8;
        batch.add(body, m.submarine, 0, centreY, 0);
        const top = centreY + radius;                           // the back of the hull, just above the water
        batch.box(length * 0.6, 0.16, 1.5, m.black, 1.5, top - 0.02, 0);            // deck casing
        // Sail: a streamlined tower, drawn from above as a long teardrop.
        const outline = new THREE.Shape();
        outline.moveTo(2.4, 0);
        outline.quadraticCurveTo(2.0, 0.62, 0.4, 0.62);
        outline.quadraticCurveTo(-1.6, 0.55, -2.6, 0);
        outline.quadraticCurveTo(-1.6, -0.55, 0.4, -0.62);
        outline.quadraticCurveTo(2.0, -0.62, 2.4, 0);
        const sail = new THREE.ExtrudeGeometry(outline, { depth: 2.4, bevelEnabled: false, curveSegments: 6 }).rotateX(-Math.PI / 2);
        batch.add(sail, m.submarine, 3.4, top - 0.05, 0);
        batch.box(1.0, 0.1, 3.6, m.submarine, 3.9, top + 1.5, 0);                    // fairwater planes
        batch.post(0.07, 0.07, 1.7, m.dark, 4.2, top + 2.3, 0, 6);                   // periscope
        batch.post(0.05, 0.05, 1.2, m.dark, 3.3, top + 2.3, 0.15, 5);                // radio mast
        batch.post(0.12, 0.12, 0.8, m.dark, 2.5, top + 2.3, 0, 6);                   // snorkel
        batch.add(new THREE.SphereGeometry(0.08, 6, 4), m.lightWhite, 4.2, top + 4.05, 0);
        // Stern fins: the upper rudder shows above the water.
        const sternX = -length / 2 + 2.4;
        batch.box(1.9, 2.3, 0.14, m.submarine, sternX, centreY + 1.3, 0);
        batch.box(1.9, 2.3, 0.14, m.submarine, sternX, centreY - 1.3, 0);
        batch.box(1.7, 0.14, 4.4, m.submarine, sternX, centreY, 0);
        batch.add(new THREE.ConeGeometry(0.5, 0.9, 8), m.dark, -length / 2 + 0.5, centreY, 0, 0, 0, Math.PI / 2);
        return { batch, shape: null, number: null };
    }
};

// ---- Public API -----------------------------------------------------------------

const cache = new Map();   // "TYPE:options" -> finished model, cloned for every ship

/**
 * Builds a model for a ship type.
 * options.plain: no railings and no painted numbers (for ghosts and holograms)
 * options.foredeckOnly: battleship without its superstructure (the view from its own bridge)
 */
export function buildShipModel(type, options = {}) {
    const key = `${type}:${options.plain ? 'plain' : 'full'}:${options.foredeckOnly ? 'foredeck' : 'whole'}`;
    if (!cache.has(key)) {
        const length = SHIP_LENGTHS[type] * CELL - 2;   // 1 unit of margin at each end
        const { batch, shape, number } = builders[type](length, options);
        const model = new THREE.Group();
        batch.build(model);
        if (shape && !options.plain) {
            const rails = new THREE.BufferGeometry();
            rails.setAttribute('position', new THREE.Float32BufferAttribute(railLines(shape), 3));
            const lines = new THREE.LineSegments(rails, getMaterials().rail);
            lines.userData.detail = true;
            model.add(lines);
            if (number) {
                addHullNumber(model, shape, number);
            }
        }
        model.userData.length = length;
        cache.set(key, model);
    }
    return cache.get(key).clone();
}

/** Translucent single-colour copy of a ship, used as the placement preview. */
export function buildGhostModel(type, material) {
    const model = buildShipModel(type, { plain: true });
    model.traverse(child => {
        if (child.isMesh) {
            child.material = material;
        }
    });
    return model;
}

export const DECK_HEIGHT = FREEBOARD;
