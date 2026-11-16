// Models of everything that is NOT a warship in the battle in the background:
// merchant ships (a freighter and a tanker), torpedo boats, lifeboats, buoys,
// mines, floating wreckage and barrage balloons.
//
// Like the distant warships (distantModels.js), every model is ONE geometry
// with the colours written into its corners, drawn by one shared material. So
// a convoy costs one draw call per ship and a field of buoys one draw call in
// all (instancing). They are built from a few boxes, cylinders and one hull
// shape: seen from far away, at night and in the rain, the silhouette is all
// that counts.
//
// Every boat has its bow towards +x and its waterline at y = 0.

import * as THREE from 'three';
import { mergeWithColors, part } from './distantModels.js';

const color = hex => new THREE.Color(hex);
const RED_LEAD = color(0x4a211c);        // the paint below the waterline
const DARK = color(0x1b1e21);

const box = (w, h, d, x, y, z) => part(new THREE.BoxGeometry(w, h, d), x, y, z);
const tube = (top, bottom, h, x, y, z, sides = 8) => part(new THREE.CylinderGeometry(top, bottom, h, sides), x, y, z);
/** A cylinder lying along the length of the boat (a gun barrel, a torpedo tube, a pipe). */
const lying = (radius, length, x, y, z) => part(new THREE.CylinderGeometry(radius, radius, length, 6).rotateZ(-Math.PI / 2), x, y, z);

/**
 * A hull seen from above: square stern, parallel sides, pointed bow; pulled
 * up into a solid from `draft` under the water to `freeboard` above it.
 */
function hull(length, beam, freeboard, draft) {
    const half = length / 2;
    const side = beam / 2;
    const outline = new THREE.Shape();
    outline.moveTo(-half, -side * 0.72);
    outline.lineTo(-half * 0.8, -side);
    outline.lineTo(half * 0.45, -side);
    outline.quadraticCurveTo(half * 0.82, -side * 0.75, half, 0);
    outline.quadraticCurveTo(half * 0.82, side * 0.75, half * 0.45, side);
    outline.lineTo(-half * 0.8, side);
    outline.lineTo(-half, side * 0.72);
    outline.closePath();
    const solid = new THREE.ExtrudeGeometry(outline, { depth: freeboard + draft, bevelEnabled: false, curveSegments: 5 });
    solid.rotateX(-Math.PI / 2);          // the outline was drawn flat, the extrusion becomes the height
    return part(solid, 0, -draft, 0);
}

/** Builds a model once and remembers it. */
const cache = new Map();
function once(name, build) {
    if (!cache.has(name)) {
        cache.set(name, build());
    }
    return cache.get(name);
}

/** Joins the parts; parts flagged as hull get red paint below the waterline. */
function assemble(parts, length, extra = {}) {
    const geometry = mergeWithColors(parts.map(p => p[0]), parts.map(p => p[1]), (tint, y, index) => {
        if (parts[index][2] && y < 0.25) {
            tint.copy(RED_LEAD);
        }
    });
    return { geometry, length, ...extra };
}

/**
 * A freighter of the convoys, 46 units long: raised bow and stern, the
 * bridge and funnel amidships, cargo hatches, two masts with their derricks.
 * @returns {{ geometry, length, mast }} mast = height of the masthead (for its lamp)
 */
export function freighterModel() {
    return once('freighter', () => {
        const steel = color(0x424a51);
        const house = color(0x8d9290);
        const deck = color(0x4c4840);
        const cargo = color(0x5d5443);
        const boom = (x, lean) => part(new THREE.BoxGeometry(0.3, 7.5, 0.3).rotateZ(lean), x, 8.2, 0);
        return assemble([
            [hull(46, 8.4, 3.6, 1.6), steel, true],
            [box(9, 1.3, 6.2, 17.5, 4.25, 0), steel],            // forecastle
            [box(7.5, 1.5, 7.6, -19, 4.35, 0), steel],           // poop
            [box(9, 4.2, 7.2, -3, 5.7, 0), house],               // midship house
            [box(6, 2.2, 6.4, -2, 8.9, 0), house],               // bridge
            [box(6.4, 0.25, 7.6, -2, 10.1, 0), DARK],            // bridge roof
            [tube(1.25, 1.4, 5.2, -6, 10.4, 0, 10), DARK],       // funnel
            [box(6, 0.9, 5, 9, 4.05, 0), deck],                  // hatches
            [box(5, 0.9, 5, 2.8, 4.05, 0), deck],
            [box(6, 0.9, 5, -12, 4.05, 0), deck],
            [box(3, 1.6, 4.2, 9, 5.3, 0), cargo],                // deck cargo under tarpaulins
            [box(2.4, 1.3, 3.2, -12, 5.1, 0.4), cargo],
            [tube(0.2, 0.26, 11, 13, 9.1, 0, 6), DARK],          // foremast
            [tube(0.2, 0.26, 11, -8.8, 9.1, 0, 6), DARK],        // mainmast (behind the funnel)
            [boom(10.6, 0.7), DARK],
            [boom(-11.2, -0.7), DARK]
        ], 46, { mast: 14.6 });
    });
}

/**
 * A tanker, 60 units long: a long low hull, the engine and funnel right aft,
 * a small bridge island amidships and a catwalk over the pipes of the deck.
 */
export function tankerModel() {
    return once('tanker', () => {
        const steel = color(0x33383d);
        const house = color(0x878c8b);
        const oxide = color(0x56302a);
        return assemble([
            [hull(60, 9.4, 2.7, 2.2), steel, true],
            [box(54, 0.2, 8.2, -1, 2.8, 0), oxide],              // the red deck
            [box(8.5, 1.3, 7, 24.5, 3.35, 0), steel],            // forecastle
            [box(12, 4.6, 8.4, -22, 5, 0), house],               // aft house
            [box(7.5, 2.2, 7.2, -21, 8.4, 0), house],
            [tube(1.5, 1.7, 5.6, -25.5, 9.6, 0, 10), DARK],      // funnel
            [box(5.2, 4.4, 7.8, 7, 4.9, 0), house],              // bridge island
            [box(4.2, 2.1, 6.8, 7, 8.15, 0), house],
            [box(4.6, 0.25, 8, 7, 9.3, 0), DARK],
            [box(42, 0.3, 0.9, -1, 4.5, 0), DARK],               // catwalk
            [lying(0.32, 40, -1, 3.3, 1.9), DARK],               // pipes
            [lying(0.32, 40, -1, 3.3, -1.9), DARK],
            [tube(0.2, 0.26, 9, 17, 7.4, 0, 6), DARK],           // masts
            [tube(0.2, 0.26, 8, -14, 7, 0, 6), DARK]
        ], 60, { mast: 11.9 });
    });
}

/** A motor torpedo boat, 11 units long: a low fast hull, a small cabin, four torpedo tubes, a gun aft. */
export function torpedoBoatModel() {
    return once('torpedoBoat', () => {
        const grey = color(0x66727b);
        const tubes = color(0x30363b);
        return assemble([
            [hull(11, 3.1, 1.25, 0.45), grey, true],
            [box(3.2, 1.1, 2, 0.8, 1.8, 0), grey],               // cabin
            [box(1.6, 0.7, 1.6, 1.2, 2.6, 0), tubes],            // open bridge
            [lying(0.34, 3.4, -0.6, 1.62, 1.2), tubes],          // torpedo tubes
            [lying(0.34, 3.4, -0.6, 1.62, -1.2), tubes],
            [tube(0.5, 0.6, 0.6, -3.9, 1.55, 0), tubes],         // gun mount
            [lying(0.09, 2, -3.2, 2.05, 0), tubes],
            [tube(0.06, 0.06, 2.6, 0.4, 4, 0, 5), tubes]         // mast
        ], 11);
    });
}

/** A ship's lifeboat full of survivors, 6 units long. */
export function lifeboatModel() {
    return once('lifeboat', () => {
        const paint = color(0xaaa596);
        const people = color(0x23262a);
        const parts = [
            [hull(6, 2.2, 0.95, 0.35), paint, true],
            [box(4.6, 0.12, 1.5, -0.2, 0.75, 0), color(0x3d3a33)],   // the dark inside
            [part(new THREE.BoxGeometry(4.4, 0.1, 0.16).rotateY(0.5), 0.4, 1.15, 1.5), color(0x6b5a44)]   // an oar
        ];
        // Heads and shoulders along both sides.
        for (let i = 0; i < 6; i++) {
            const x = -1.9 + (i >> 1) * 1.5 + (i % 2) * 0.4;
            const z = (i % 2 ? 0.55 : -0.55);
            parts.push([box(0.55, 0.75, 0.6, x, 1.2, z), people]);
        }
        return assemble(parts, 6);
    });
}

/**
 * A channel buoy, 6 units tall: a float, a body, a little tower and a lamp.
 * It is white: each buoy is tinted red or green when it is placed (instance colour).
 */
export function buoyModel() {
    return once('buoy', () => assemble([
        [tube(1.5, 1.5, 0.9, 0, 0.1, 0, 10), color(0x777777)],
        [tube(0.55, 1.35, 2.3, 0, 1.7, 0, 8), color(0xffffff)],
        [tube(0.14, 0.14, 2.6, 0, 4.1, 0.45, 4), color(0x666666)],     // three legs of the tower
        [tube(0.14, 0.14, 2.6, 0.4, 4.1, -0.25, 4), color(0x666666)],
        [tube(0.14, 0.14, 2.6, -0.4, 4.1, -0.25, 4), color(0x666666)],
        [tube(0.5, 0.5, 0.5, 0, 5.6, 0, 6), color(0xffffff)]            // the lamp house
    ], 3, { lamp: 5.9 }));
}

/** A floating contact mine: a dark ball, 2.4 units across, with its horns. */
export function mineModel() {
    return once('mine', () => {
        const iron = color(0x202423);
        const rust = color(0x4a3024);
        const parts = [[part(new THREE.IcosahedronGeometry(1.2, 1), 0, 0, 0), iron]];
        // Horns on the upper half, pointing straight out.
        const horns = [[0, 1, 0], [0.75, 0.66, 0], [-0.75, 0.66, 0], [0, 0.66, 0.75], [0, 0.66, -0.75], [0.6, 0.3, 0.74], [-0.6, 0.3, -0.74]];
        const up = new THREE.Vector3(0, 1, 0);
        const out = new THREE.Vector3();
        const turn = new THREE.Quaternion();
        for (const [x, y, z] of horns) {
            out.set(x, y, z).normalize();
            const horn = new THREE.CylinderGeometry(0.1, 0.13, 0.6, 5).applyQuaternion(turn.setFromUnitVectors(up, out));
            parts.push([part(horn, out.x * 1.45, out.y * 1.45, out.z * 1.45), rust]);
        }
        return assemble(parts, 2.4);
    });
}

/** Wreckage: a few planks, a crate and a barrel floating together, about 7 units across. */
export function wreckageModel() {
    return once('wreckage', () => {
        const wood = color(0x66553f);
        const dark = color(0x3a3229);
        const plank = (length, x, z, angle) => part(new THREE.BoxGeometry(length, 0.22, 0.6).rotateY(angle), x, 0.12, z);
        return assemble([
            [plank(5, 0, 0, 0.2), wood],
            [plank(3.6, 1.2, 1.6, -0.7), wood],
            [plank(4.2, -1.4, -1.5, 1.1), dark],
            [plank(2.6, 2.4, -1.2, 2.3), wood],
            [part(new THREE.BoxGeometry(1.3, 1, 1.3).rotateY(0.6).rotateZ(0.25), -1.8, 0.35, 1.3), wood],                 // crate
            [part(new THREE.CylinderGeometry(0.5, 0.5, 1.4, 8).rotateZ(Math.PI / 2).rotateY(0.9), 0.6, 0.2, -2.4), dark]   // barrel
        ], 7);
    });
}

/** A barrage balloon, 22 units long: a fat silver fish with three tail fins, nose to +x. */
export function balloonModel() {
    return once('balloon', () => {
        const silver = color(0x8f989d);
        const shadow = color(0x5c666c);
        const fin = angle => part(new THREE.SphereGeometry(1, 8, 6).scale(3.4, 2.6, 0.7).translate(0, 3, 0).rotateX(angle), -8.2, 0, 0);
        const body = part(new THREE.SphereGeometry(1, 14, 10).scale(11, 4.6, 4.6), 0, 0, 0);
        const geometry = mergeWithColors([body, fin(0), fin(2.2), fin(-2.2)], [silver, silver, silver, silver], (tint, y) => {
            if (y < -1) {
                tint.copy(shadow);   // darker underneath
            }
        });
        return { geometry, length: 22 };
    });
}
