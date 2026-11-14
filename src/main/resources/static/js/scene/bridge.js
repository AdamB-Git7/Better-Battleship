// The captain's bridge (block 3).
//
// The player commands from a flagship that sits just behind (south of) his
// zone, so the whole fleet is in front of him and the enemy fog is in the
// distance. This file builds two things:
//
//  - the flagship seen from outside (visible in the aerial view),
//  - the inside of its bridge: floor, ceiling, a large front window, side
//    consoles with screens and the projector of the holographic board.
//
// Everything inside is placed relative to the captain's eye (BRIDGE_EYE), so
// the first-person camera only has to stand at that point (see camera.js).
// Sizes inside the bridge are not to scale with the sea: only the view matters.

import * as THREE from 'three';
import { ZONES, ZONE_SPAN } from '../config.js';
import { buildShipModel } from './shipModels.js';
import { swellAt } from './sea.js';
import { BOARD_POSITION } from './holoBoard.js';

/** Where the captain's eyes are, in world coordinates. */
export const BRIDGE_EYE = new THREE.Vector3(0, 12, ZONES.mine.center.z + ZONE_SPAN / 2 + 78);

const FLAGSHIP_SCALE = 1.5;
const EYE_HEIGHT = 3.2;          // eye above the bridge floor
const ROOM_WIDTH = 24;
const WINDOW_Z = -9.5;           // the front window, in front of the eye (-z is forward)

const metal = new THREE.MeshStandardMaterial({ color: 0x171d24, roughness: 0.75, metalness: 0.45 });
const trim = new THREE.MeshStandardMaterial({ color: 0x2b3642, roughness: 0.6, metalness: 0.5 });

function box(w, h, d, material, x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    return mesh;
}

export function createBridge(scene) {
    // ---- Flagship, seen from outside ------------------------------------------
    const flagship = buildShipModel('BATTLESHIP');
    flagship.scale.setScalar(FLAGSHIP_SCALE);
    flagship.rotation.y = Math.PI / 2;   // bow towards the enemy (north, -z)
    // The model's bridge tower is 2.5 units ahead of its centre: put it under the eye.
    flagship.position.set(BRIDGE_EYE.x, 0, BRIDGE_EYE.z + 2.5 * FLAGSHIP_SCALE);
    scene.add(flagship);

    // ---- Inside of the bridge ---------------------------------------------------
    const interior = new THREE.Group();
    interior.position.copy(BRIDGE_EYE);
    interior.visible = false;
    scene.add(interior);

    const floorY = -EYE_HEIGHT;
    const ceilingY = 4.3;
    const roomHeight = ceilingY - floorY;
    const half = ROOM_WIDTH / 2;

    interior.add(box(ROOM_WIDTH, 0.3, 17, metal, 0, floorY - 0.15, -1.5));          // floor
    interior.add(box(ROOM_WIDTH, 0.3, 17, metal, 0, ceilingY + 0.15, -1.5));        // ceiling
    interior.add(box(ROOM_WIDTH, roomHeight, 0.4, metal, 0, floorY + roomHeight / 2, 7));   // back wall
    for (const side of [-1, 1]) {
        interior.add(box(0.4, roomHeight, 17, metal, side * half, floorY + roomHeight / 2, -1.5));
    }

    // Front wall = one large window: a low sill, a top beam and a few slim pillars.
    const sillHeight = 1.0;
    interior.add(box(ROOM_WIDTH, sillHeight, 0.5, trim, 0, floorY + sillHeight / 2, WINDOW_Z));
    interior.add(box(ROOM_WIDTH, 0.8, 0.5, trim, 0, ceilingY - 0.4, WINDOW_Z));
    for (const x of [-half, -6.2, 6.2, half]) {
        interior.add(box(0.35, roomHeight, 0.5, trim, x, floorY + roomHeight / 2, WINDOW_Z));
    }
    const glass = new THREE.Mesh(
        new THREE.PlaneGeometry(ROOM_WIDTH, roomHeight),
        new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.05, depthWrite: false, fog: false })
    );
    glass.position.set(0, floorY + roomHeight / 2, WINDOW_Z + 0.3);
    glass.renderOrder = 3;
    interior.add(glass);

    // Side consoles with glowing screens (the centre is left free for the hologram).
    for (const side of [-1, 1]) {
        const desk = box(6.2, 1.5, 2.4, trim, side * 8.6, floorY + 0.75, WINDOW_Z + 2);
        interior.add(desk);
        const screen = new THREE.Mesh(
            new THREE.PlaneGeometry(5.4, 1.7),
            new THREE.MeshBasicMaterial({ map: screenTexture(side), fog: false })
        );
        screen.rotation.x = -1.05;   // tilted towards the captain
        screen.position.set(side * 8.6, floorY + 1.62, WINDOW_Z + 2.1);
        interior.add(screen);
    }

    // Projector of the holographic board: a low base with a glowing ring.
    const projector = new THREE.Group();
    projector.position.set(0, floorY, BOARD_POSITION.z);
    projector.add(new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.6, 0.35, 28), trim).translateY(0.17));
    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.05, 0.06, 8, 48).rotateX(Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0x58d6ff, fog: false })
    );
    ring.position.y = 0.38;
    projector.add(ring);
    interior.add(projector);

    // Soft cyan light from the hologram, so the room is not pitch black.
    const glow = new THREE.PointLight(0x58d6ff, 14, 16, 2);
    glow.position.set(0, -1.2, BOARD_POSITION.z);
    interior.add(glow);

    /** Shows the inside of the bridge (first person) or hides it (aerial view). */
    function setInside(inside) {
        interior.visible = inside;
    }

    function update(dt, time) {
        // The flagship floats like the other ships.
        const swell = swellAt(flagship.position.x, flagship.position.z, time);
        flagship.position.y = swell.height * 0.6;
        flagship.rotation.z = swell.roll * 0.5;
        // Screens and hologram light flicker a little.
        glow.intensity = 14 + Math.sin(time * 9) * 0.8;
        ring.material.color.copy(RING_COLOR).multiplyScalar(0.85 + 0.15 * Math.sin(time * 3));
    }

    // The holographic board is attached to this group (see holoBoard.js).
    return { interior, setInside, update };
}

const RING_COLOR = new THREE.Color(0x58d6ff);

/** A fake instrument screen (radar circles, bars, text lines) drawn on a canvas. */
function screenTexture(side) {
    const element = document.createElement('canvas');
    element.width = 512;
    element.height = 160;
    const ctx = element.getContext('2d');
    ctx.fillStyle = '#04121a';
    ctx.fillRect(0, 0, 512, 160);
    ctx.strokeStyle = '#2fb6dc';
    ctx.fillStyle = '#2fb6dc';
    ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, 500, 148);
    // Radar
    const radarX = side < 0 ? 90 : 422;
    for (const radius of [22, 44, 64]) {
        ctx.beginPath();
        ctx.arc(radarX, 80, radius, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(radarX - 64, 80);
    ctx.lineTo(radarX + 64, 80);
    ctx.moveTo(radarX, 16);
    ctx.lineTo(radarX, 144);
    ctx.stroke();
    ctx.fillStyle = '#ffb054';
    for (const [dx, dy] of [[20, -30], [-35, 12], [8, 40]]) {
        ctx.fillRect(radarX + dx, 80 + dy, 5, 5);
    }
    // Bars and text lines
    const left = side < 0 ? 190 : 24;
    ctx.fillStyle = '#2fb6dc';
    for (let i = 0; i < 9; i++) {
        const height = 20 + ((i * 37) % 70);
        ctx.fillRect(left + i * 18, 136 - height, 10, height);
    }
    ctx.globalAlpha = 0.7;
    for (let i = 0; i < 6; i++) {
        ctx.fillRect(left + 176, 26 + i * 20, 60 + ((i * 53) % 70), 6);
    }
    const texture = new THREE.CanvasTexture(element);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}
