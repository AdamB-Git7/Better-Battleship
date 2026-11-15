// Cheap models for the battle in the background.
//
// A ship of the player's fleet is made of a dozen meshes, each with its own
// material and textures. Twenty more of those would cost hundreds of draw
// calls. A background ship is seen from far away, in the rain, so here every
// model is squeezed into ONE geometry: the colours of the materials are
// written into the corners of the triangles ("vertex colours") and a single
// shared material draws them all. One ship = one draw call.
//
// The planes are built the same way from a few boxes and cylinders.

import * as THREE from 'three';
import { buildShipModel } from './shipModels.js';

const HULL_GREY = new THREE.Color(0x565e66);
const HULL_RED = new THREE.Color(0x4a211c);     // anti-fouling paint below the waterline

/** The one material shared by every background ship and plane. */
export const distantMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.25 });

/**
 * Joins geometries (non-indexed, with position and normal) into one, giving
 * every corner of part i the colour colors[i]. `shade` may change the colour
 * of a single corner (it gets the colour to edit and the height of the corner).
 */
function mergeWithColors(geometries, colors, shade) {
    let count = 0;
    for (const geometry of geometries) {
        count += geometry.attributes.position.count;
    }
    const position = new Float32Array(count * 3);
    const normal = new Float32Array(count * 3);
    const color = new Float32Array(count * 3);
    const tint = new THREE.Color();
    let offset = 0;
    geometries.forEach((geometry, index) => {
        const points = geometry.attributes.position;
        position.set(points.array, offset * 3);
        normal.set(geometry.attributes.normal.array, offset * 3);
        for (let i = 0; i < points.count; i++) {
            tint.copy(colors[index]);
            if (shade) {
                shade(tint, points.getY(i), index);
            }
            color[(offset + i) * 3] = tint.r;
            color[(offset + i) * 3 + 1] = tint.g;
            color[(offset + i) * 3 + 2] = tint.b;
        }
        offset += points.count;
    });
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
    merged.computeBoundingSphere();
    return merged;
}

const shipCache = new Map();   // type -> { geometry, length }

/**
 * One-piece version of a ship of the fleet (same shape, no textures, no
 * railings, no lights). The bow points to +x, like the full models.
 * @returns {{ geometry: THREE.BufferGeometry, length: number }}
 */
export function distantShip(type) {
    if (!shipCache.has(type)) {
        const model = buildShipModel(type, { plain: true });
        const geometries = [];
        const colors = [];
        const painted = [];   // true for the parts whose colour came from a texture
        model.traverse(child => {
            // Only the solid, lit parts: the tiny lights and the line details are dropped.
            if (!child.isMesh || child.userData.detail || !child.material.isMeshStandardMaterial) {
                return;
            }
            const textured = child.material.map && child.material.color.getHex() === 0xffffff;
            geometries.push(child.geometry);
            colors.push(textured ? HULL_GREY : child.material.color);
            painted.push(Boolean(textured));
        });
        const geometry = mergeWithColors(geometries, colors, (tint, y, index) => {
            if (painted[index] && y < 0.15) {
                tint.copy(HULL_RED);
            }
        });
        shipCache.set(type, { geometry, length: model.userData.length });
    }
    return shipCache.get(type);
}

/** A part of the plane, already moved into place. */
function part(geometry, x, y, z) {
    const copy = geometry.index ? geometry.toNonIndexed() : geometry;
    return copy.translate(x, y, z);
}

let planeParts = null;

/**
 * A WWII-style single-engine plane, about 11.5 units from wingtip to wingtip:
 * fuselage, engine cowl, wings, tail and canopy in one geometry, and the
 * spinning propeller as a separate see-through disc. The nose points to +x.
 * @returns {{ body: THREE.BufferGeometry, propeller: THREE.BufferGeometry }}
 */
export function planeModel() {
    if (!planeParts) {
        const skin = new THREE.Color(0x56626b);
        const belly = new THREE.Color(0x7d878e);
        const dark = new THREE.Color(0x1d2226);
        const geometries = [
            // Fuselage: thick at the nose, thin at the tail (the cylinder is laid along x).
            part(new THREE.CylinderGeometry(0.62, 0.24, 8.4, 8).rotateZ(-Math.PI / 2), 0, 0, 0),
            part(new THREE.CylinderGeometry(0.66, 0.66, 1.1, 8).rotateZ(-Math.PI / 2), 4.4, 0, 0),     // engine cowl
            part(new THREE.ConeGeometry(0.3, 0.7, 6).rotateZ(-Math.PI / 2), 5.3, 0, 0),                // spinner
            part(new THREE.BoxGeometry(2.0, 0.16, 11.5), 1.1, -0.2, 0),                                // wings
            part(new THREE.BoxGeometry(1.1, 0.1, 4.2), -3.6, 0.1, 0),                                  // tailplane
            part(new THREE.BoxGeometry(1.4, 1.5, 0.12), -3.6, 0.85, 0),                                // fin
            part(new THREE.BoxGeometry(1.7, 0.5, 0.62), 0.9, 0.62, 0)                                  // canopy
        ];
        const colors = [skin, dark, dark, skin, skin, skin, dark];
        const body = mergeWithColors(geometries, colors, (tint, y, index) => {
            if (index === 3 && y < -0.2) {
                tint.copy(belly);   // paler under the wings, as on real naval aircraft
            }
        });
        const propeller = new THREE.CircleGeometry(1.55, 14).rotateY(Math.PI / 2).translate(5.45, 0, 0);
        planeParts = { body, propeller };
    }
    return planeParts;
}
