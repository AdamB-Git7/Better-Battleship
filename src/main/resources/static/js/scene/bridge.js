// The captain's bridge (block 3).
//
// The player commands from a flagship that sits just behind (south of) his
// zone, so the whole fleet is in front of him and the enemy fog is in the
// distance. This file builds three things:
//
//  - the flagship seen from outside (visible in the aerial view),
//  - the inside of its bridge: a steel room with a wall of windows in front,
//    sloped roof windows above them (so looking up shows the storm, not a
//    ceiling), side windows, instrument consoles with glowing screens, and
//    red night lighting,
//  - the flagship's own foredeck and gun turrets, seen through the windows.
//
// Everything inside is placed relative to the captain's eye (BRIDGE_EYE), so
// the first-person camera only has to stand at that point (see camera.js).
// Sizes inside the bridge are not to scale with the sea: only the view matters.

import * as THREE from 'three';
import { ZONES, ZONE_SPAN } from '../config.js';
import { buildShipModel } from './shipModels.js';
import { swellAt } from './sea.js';
import { BOARD_POSITION } from './holoBoard.js';
import { panelTexture, rainGlassTexture } from './textures.js';
import { weather } from './weather.js';

/** Where the captain's eyes are, in world coordinates. */
export const BRIDGE_EYE = new THREE.Vector3(0, 12, ZONES.mine.center.z + ZONE_SPAN / 2 + 78);

const FLAGSHIP_SCALE = 1.5;      // the flagship in the aerial view
const FOREDECK_SCALE = 2.0;      // the same ship seen from its own bridge (bigger, so the guns show)
const TOWER_OFFSET = 2.5;        // the model's bridge tower is 2.5 units ahead of its centre
const FOREDECK_GAP = 3.5;        // the foredeck is pushed forward, so no turret pokes into the room

// The room, in metres from the eye (-z is forward, towards the enemy).
const EYE_HEIGHT = 3.2;          // eye above the floor
const HALF_WIDTH = 12;
const WINDOW_Z = -9.5;           // the front windows
const BACK_Z = 7;
const FLOOR_Y = -EYE_HEIGHT;
const SILL_Y = -2.5;             // bottom of the windows
const KNEE_Y = 4.0;              // where the upright windows end and the roof windows begin
const ROOF_Y = 8.2;              // the ceiling
const ROOF_Z = -4.0;             // where the roof windows meet the ceiling
const SIDE_WINDOW_END = -1.5;    // the side windows run from the front corner to here

const SCREEN_COLORS = { green: '#46f59a', cyan: '#4fd2f0', amber: '#ffb347' };

function box(w, h, d, material, x, y, z) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    return mesh;
}

// Rain running down a window: the same texture read twice at different sizes
// and speeds, plus a very faint sheen so the glass is felt even where it is dry.
const glassVertex = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const glassFragment = /* glsl */`
    uniform sampler2D uDrops;
    uniform vec2 uRepeat;
    uniform float uTime;
    uniform float uFlash;
    uniform float uGust;
    varying vec2 vUv;
    void main() {
        vec2 uv = vUv * uRepeat;
        float slow = texture2D(uDrops, uv + vec2(0.0, uTime * 0.035)).a;
        float fast = texture2D(uDrops, uv * 1.7 + vec2(0.31, uTime * (0.09 + 0.08 * uGust))).a;
        float drops = slow * 0.55 + fast * 0.4;
        // Drops catch the light: dim grey normally, bright during lightning.
        vec3 color = vec3(0.5, 0.58, 0.64) * (0.55 + uFlash * 4.0);
        gl_FragColor = vec4(color, drops * 0.55 + 0.035);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

export function createBridge(scene) {
    // ---- Flagship, seen from outside ------------------------------------------
    const flagship = buildShipModel('BATTLESHIP');
    flagship.scale.setScalar(FLAGSHIP_SCALE);
    flagship.rotation.order = 'YXZ';     // heading first, then roll and pitch in the ship's own axes
    flagship.rotation.y = Math.PI / 2;   // bow towards the enemy (north, -z)
    flagship.position.set(BRIDGE_EYE.x, 0, BRIDGE_EYE.z + TOWER_OFFSET * FLAGSHIP_SCALE);   // tower under the eye
    scene.add(flagship);

    // ---- Its foredeck, seen from the bridge --------------------------------------
    // The same ship without its tower (the room stands in its place). Only
    // shown in the first-person view; it pitches with the swell while the
    // room stays still, which gives the feeling of a moving ship without
    // moving the camera (the holographic board must stay easy to click).
    const foredeck = buildShipModel('BATTLESHIP', { foredeckOnly: true });
    foredeck.scale.setScalar(FOREDECK_SCALE);
    foredeck.rotation.order = 'YXZ';
    foredeck.rotation.y = Math.PI / 2;
    foredeck.position.set(BRIDGE_EYE.x, 0, BRIDGE_EYE.z + TOWER_OFFSET * FOREDECK_SCALE - FOREDECK_GAP);
    foredeck.visible = false;
    scene.add(foredeck);

    // ---- Inside of the bridge ---------------------------------------------------
    const interior = new THREE.Group();
    interior.position.copy(BRIDGE_EYE);
    interior.visible = false;
    scene.add(interior);

    const panels = panelTexture();
    const metalMap = panels.clone();
    metalMap.repeat.set(3, 1.5);
    metalMap.needsUpdate = true;     // a cloned texture must be uploaded once too
    const floorMap = panels.clone();
    floorMap.repeat.set(8, 6);
    floorMap.needsUpdate = true;
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a3138, map: metalMap, roughness: 0.7, metalness: 0.5 });
    const floor = new THREE.MeshStandardMaterial({ color: 0x15181b, map: floorMap, roughness: 0.9, metalness: 0.2 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x1b2026, roughness: 0.55, metalness: 0.6 });
    const brass = new THREE.MeshStandardMaterial({ color: 0x8a6a2e, roughness: 0.35, metalness: 0.9 });
    const depth = BACK_Z - WINDOW_Z;
    const midZ = (BACK_Z + WINDOW_Z) / 2;

    interior.add(box(HALF_WIDTH * 2, 0.3, depth, floor, 0, FLOOR_Y - 0.15, midZ));
    interior.add(box(HALF_WIDTH * 2, 0.3, BACK_Z - ROOF_Z, metal, 0, ROOF_Y + 0.15, (BACK_Z + ROOF_Z) / 2));   // ceiling
    interior.add(box(HALF_WIDTH * 2, ROOF_Y - FLOOR_Y, 0.4, metal, 0, (ROOF_Y + FLOOR_Y) / 2, BACK_Z));         // back wall

    // Front: a low wall under the windows, then glass up to the "knee", then
    // roof windows sloping back to the ceiling.
    interior.add(box(HALF_WIDTH * 2, SILL_Y - FLOOR_Y, 0.5, metal, 0, (SILL_Y + FLOOR_Y) / 2, WINDOW_Z));
    interior.add(box(HALF_WIDTH * 2, 0.16, 0.9, trim, 0, SILL_Y + 0.08, WINDOW_Z + 0.2));     // sill
    interior.add(box(HALF_WIDTH * 2, 0.34, 0.5, trim, 0, KNEE_Y, WINDOW_Z));                   // knee beam
    interior.add(box(HALF_WIDTH * 2, 0.34, 0.5, trim, 0, ROOF_Y, ROOF_Z));                     // roof beam
    const slopeLength = Math.hypot(ROOF_Z - WINDOW_Z, ROOF_Y - KNEE_Y);
    const slopeAngle = -Math.atan2(ROOF_Y - KNEE_Y, ROOF_Z - WINDOW_Z);   // rotation that lays a box along the slope
    const slopeY = (KNEE_Y + ROOF_Y) / 2;
    const slopeZ = (WINDOW_Z + ROOF_Z) / 2;
    for (const x of [-HALF_WIDTH, -7.2, -2.4, 2.4, 7.2, HALF_WIDTH]) {
        interior.add(box(0.24, KNEE_Y - SILL_Y, 0.4, trim, x, (KNEE_Y + SILL_Y) / 2, WINDOW_Z));   // mullion
        const rafter = box(0.24, 0.3, slopeLength, trim, x, slopeY, slopeZ);
        rafter.rotation.x = slopeAngle;
        interior.add(rafter);
    }
    // A grab rail under the windows: every real bridge has one for heavy weather.
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, HALF_WIDTH * 2 - 1, 8).rotateZ(Math.PI / 2), brass);
    rail.position.set(0, SILL_Y + 0.42, WINDOW_Z + 0.75);
    interior.add(rail);

    // Side walls: solid below the sill and behind the side windows; above the
    // knee a plate cut to follow the sloped roof.
    const sideLength = SIDE_WINDOW_END - WINDOW_Z;
    const upper = new THREE.Shape();           // drawn in the (z, y) plane
    upper.moveTo(WINDOW_Z, KNEE_Y);
    upper.lineTo(ROOF_Z, ROOF_Y);
    upper.lineTo(BACK_Z, ROOF_Y);
    upper.lineTo(BACK_Z, KNEE_Y);
    upper.closePath();
    const upperGeometry = new THREE.ExtrudeGeometry(upper, { depth: 0.4, bevelEnabled: false }).rotateY(-Math.PI / 2);
    for (const side of [-1, 1]) {
        const x = side * HALF_WIDTH;
        interior.add(box(0.4, SILL_Y - FLOOR_Y, depth, metal, x, (SILL_Y + FLOOR_Y) / 2, midZ));
        interior.add(box(0.4, KNEE_Y - SILL_Y, BACK_Z - SIDE_WINDOW_END, metal, x, (KNEE_Y + SILL_Y) / 2, (BACK_Z + SIDE_WINDOW_END) / 2));
        const plate = new THREE.Mesh(upperGeometry, metal);
        plate.position.x = x + 0.2;   // the extrusion goes from -0.4 to 0
        interior.add(plate);
        interior.add(box(0.44, 0.34, depth, trim, x, KNEE_Y, midZ));
        for (const z of [WINDOW_Z + sideLength / 2, SIDE_WINDOW_END]) {
            interior.add(box(0.44, KNEE_Y - SILL_Y, 0.24, trim, x, (KNEE_Y + SILL_Y) / 2, z));
        }
    }

    // ---- Glass with rain on it --------------------------------------------------
    const drops = rainGlassTexture();
    const glassPanes = [];
    function glass(width, height, repeatX, repeatY) {
        const material = new THREE.ShaderMaterial({
            vertexShader: glassVertex,
            fragmentShader: glassFragment,
            uniforms: {
                uDrops: { value: drops },
                uRepeat: { value: new THREE.Vector2(repeatX, repeatY) },
                uTime: { value: 0 },
                uFlash: { value: 0 },
                uGust: { value: 0.5 }
            },
            transparent: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        const pane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        pane.renderOrder = 9;   // after the rain and the smoke outside
        glassPanes.push(material);
        interior.add(pane);
        return pane;
    }
    glass(HALF_WIDTH * 2, KNEE_Y - SILL_Y, 6, 1.6).position.set(0, (KNEE_Y + SILL_Y) / 2, WINDOW_Z + 0.05);
    const roofGlass = glass(HALF_WIDTH * 2, slopeLength, 6, 1.7);
    roofGlass.position.set(0, slopeY, slopeZ);
    roofGlass.rotation.x = slopeAngle + Math.PI / 2;   // drops run down towards the knee
    for (const side of [-1, 1]) {
        const pane = glass(sideLength, KNEE_Y - SILL_Y, 2, 1.6);
        pane.position.set(side * (HALF_WIDTH - 0.05), (KNEE_Y + SILL_Y) / 2, WINDOW_Z + sideLength / 2);
        pane.rotation.y = Math.PI / 2;
    }

    // ---- Consoles with glowing screens -------------------------------------------
    // One on each side; the centre is left free for the hologram.
    const screens = [];
    function screen(texture, width, height) {
        const material = new THREE.MeshBasicMaterial({ map: texture, fog: false });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
        screens.push(material);
        return mesh;
    }
    const sweeps = [];
    for (const side of [-1, 1]) {
        const desk = new THREE.Group();
        desk.position.set(side * 7.4, FLOOR_Y, WINDOW_Z + 1.9);
        desk.rotation.y = -side * 0.32;        // turned a little towards the captain
        desk.add(box(6.6, 1.15, 2.2, metal, 0, 0.575, 0));
        desk.add(box(6.7, 0.08, 2.3, trim, 0, 1.19, 0));
        // The instrument panel leans back so the captain can read it.
        const panel = new THREE.Group();
        panel.position.set(0, 1.5, -0.25);
        panel.rotation.x = -0.95;
        panel.add(box(6.5, 1.7, 0.16, trim, 0, 0, -0.1));
        const radar = screen(radarTexture(), 1.5, 1.5);
        radar.position.set(-side * 2.3, 0, 0);
        panel.add(radar);
        // The rotating beam of the radar: a thin bright wedge turning on the screen.
        const sweep = new THREE.Mesh(
            new THREE.CircleGeometry(0.68, 12, 0, 0.5),
            new THREE.MeshBasicMaterial({ color: 0x46f59a, transparent: true, opacity: 0.35, fog: false, depthWrite: false }));
        sweep.position.copy(radar.position).z += 0.01;
        panel.add(sweep);
        sweeps.push(sweep);
        const chart = screen(dataTexture(side < 0 ? 'cyan' : 'amber', side), 2.5, 1.5);
        chart.position.set(-side * 0.05, 0, 0);
        panel.add(chart);
        const gauges = screen(dataTexture('green', -side), 1.6, 1.5);
        gauges.position.set(side * 2.25, 0, 0);
        panel.add(gauges);
        desk.add(panel);
        // A row of lit switches along the front edge.
        const switches = screen(switchTexture(), 6.0, 0.22);
        switches.rotation.x = -Math.PI / 2;
        switches.position.set(0, 1.24, 0.8);
        desk.add(switches);
        interior.add(desk);
    }

    // Two pedestals in front of the windows: engine telegraph and compass.
    for (const side of [-1, 1]) {
        const pedestal = new THREE.Group();
        pedestal.position.set(side * 3.6, FLOOR_Y, WINDOW_Z + 1.3);
        pedestal.add(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.1, 12), trim).translateY(0.55));
        const head = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.22, 20), brass);
        head.position.y = 1.2;
        if (side < 0) {
            head.rotation.z = Math.PI / 2;     // the telegraph dial faces sideways
        }
        pedestal.add(head);
        const dial = screen(dialTexture(), 0.5, 0.5);
        dial.rotation.x = -Math.PI / 2;
        dial.position.y = 1.32;
        if (side > 0) {
            pedestal.add(dial);
        }
        interior.add(pedestal);
    }

    // ---- Light inside -------------------------------------------------------------
    // Warships keep the bridge dark at night, with dim red lamps that do not
    // spoil the crew's night vision. The other light comes from the hologram.
    const lampMaterial = new THREE.MeshBasicMaterial({ color: 0xff3a22, fog: false });
    for (const x of [-9.6, -4.8, 4.8, 9.6]) {
        interior.add(box(0.5, 0.08, 0.22, lampMaterial, x, KNEE_Y - 0.2, WINDOW_Z + 0.28));
    }
    const nightLight = new THREE.PointLight(0xff3a22, 22, 26, 1.8);
    nightLight.position.set(0, KNEE_Y - 0.8, WINDOW_Z + 3.5);
    interior.add(nightLight);
    const glow = new THREE.PointLight(0x62d4f5, 7, 14, 2);
    glow.position.set(0, BOARD_POSITION.y + 0.8, BOARD_POSITION.z);
    interior.add(glow);

    // Where the room is, in world coordinates: the rain must stay out of it.
    const roomBox = new THREE.Box3(
        new THREE.Vector3(-HALF_WIDTH, FLOOR_Y, WINDOW_Z).add(BRIDGE_EYE),
        new THREE.Vector3(HALF_WIDTH, ROOF_Y, BACK_Z).add(BRIDGE_EYE));
    const roofNormal = new THREE.Vector3(0, ROOF_Z - WINDOW_Z, -(ROOF_Y - KNEE_Y)).normalize();   // points up and forward
    const roofPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        roofNormal, new THREE.Vector3(0, KNEE_Y, WINDOW_Z).add(BRIDGE_EYE));

    /** Shows the inside of the bridge (first person) or hides it (aerial view). */
    function setInside(inside) {
        interior.visible = inside;
        foredeck.visible = inside;
        flagship.visible = !inside;
    }

    function update(dt, time) {
        // The flagship floats like the other ships (bow to the north = heading 90 degrees).
        const swell = swellAt(flagship.position.x, flagship.position.z, time, Math.PI / 2);
        flagship.position.y = swell.height * 0.6;
        flagship.rotation.x = swell.roll * 0.5;
        flagship.rotation.z = swell.pitch * 0.6;
        if (!interior.visible) {
            return;
        }
        // From the bridge: the bow rises and falls against the horizon.
        foredeck.position.y = swell.height * 0.5;
        foredeck.rotation.z = swell.pitch * 0.9;
        foredeck.rotation.x = swell.roll * 0.25;

        for (const material of glassPanes) {
            material.uniforms.uTime.value = time;
            material.uniforms.uFlash.value = weather.flash;
            material.uniforms.uGust.value = weather.gust;
        }
        // Screens flicker a little; the radar beam goes round.
        const flicker = 0.9 + 0.06 * Math.sin(time * 13) + 0.04 * Math.sin(time * 31.7);
        for (const material of screens) {
            material.color.setScalar(flicker);
        }
        for (const sweep of sweeps) {
            sweep.rotation.z = -time * 1.6;
        }
        glow.intensity = 7 + Math.sin(time * 9) * 0.5 + weather.flash * 4;
    }

    // The holographic board is attached to `interior` (see holoBoard.js).
    return { interior, setInside, update, roomBox, roofPlane, floorY: FLOOR_Y };
}

// ---- Instrument screens, drawn on a canvas ----------------------------------------

function screenCanvas(width, height) {
    const element = document.createElement('canvas');
    element.width = width;
    element.height = height;
    const ctx = element.getContext('2d');
    ctx.fillStyle = '#020a0d';
    ctx.fillRect(0, 0, width, height);
    return { element, ctx };
}

function finish(element) {
    const texture = new THREE.CanvasTexture(element);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

/** A round radar display: range rings, bearing lines and a few contacts. */
function radarTexture() {
    const { element, ctx } = screenCanvas(256, 256);
    ctx.strokeStyle = SCREEN_COLORS.green;
    ctx.fillStyle = SCREEN_COLORS.green;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.8;
    for (const radius of [38, 76, 114]) {
        ctx.beginPath();
        ctx.arc(128, 128, radius, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(128, 128);
        ctx.lineTo(128 + Math.cos(angle) * 114, 128 + Math.sin(angle) * 114);
        ctx.stroke();
    }
    // Clutter from the rain and the waves, then a few solid echoes.
    for (let i = 0; i < 260; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * 112;
        ctx.globalAlpha = Math.random() * 0.35;
        ctx.fillRect(128 + Math.cos(angle) * radius, 128 + Math.sin(angle) * radius, 2, 2);
    }
    ctx.globalAlpha = 1;
    for (const [dx, dy] of [[-20, -52], [6, -40], [24, -58], [-36, -30], [14, -74]]) {
        ctx.fillRect(128 + dx, 128 + dy, 6, 4);
    }
    return finish(element);
}

/** A data screen: a title bar, a graph, columns of numbers. */
function dataTexture(colorName, seed) {
    const { element, ctx } = screenCanvas(384, 224);
    const color = SCREEN_COLORS[colorName];
    // A tiny repeatable random generator, so both consoles differ but never change.
    let state = seed > 0 ? 7 : 19;
    const random = () => {
        state = (state * 16807) % 2147483647;
        return state / 2147483647;
    };
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.strokeRect(5, 5, 374, 214);
    ctx.fillRect(5, 5, 374, 20);
    ctx.fillStyle = '#020a0d';
    ctx.font = '600 14px Consolas, monospace';
    ctx.fillText(colorName === 'green' ? 'ENGINE / POWER' : colorName === 'cyan' ? 'NAV  HDG 000  SPD 12' : 'WEATHER  WIND 9  SEA 7', 12, 20);
    ctx.fillStyle = color;
    // Graph on the left.
    ctx.beginPath();
    for (let x = 0; x <= 190; x += 6) {
        const y = 120 + Math.sin(x * 0.07 + seed) * 26 + (random() - 0.5) * 22;
        if (x === 0) {
            ctx.moveTo(16 + x, y);
        } else {
            ctx.lineTo(16 + x, y);
        }
    }
    ctx.stroke();
    ctx.globalAlpha = 0.3;
    for (let y = 50; y <= 200; y += 30) {
        ctx.fillRect(16, y, 190, 1);
    }
    // Bars and numbers on the right.
    ctx.globalAlpha = 0.85;
    ctx.font = '13px Consolas, monospace';
    for (let i = 0; i < 8; i++) {
        const y = 48 + i * 21;
        ctx.fillText((1000 + Math.floor(random() * 8999)).toString(), 222, y + 6);
        ctx.fillRect(270, y - 4, 20 + random() * 80, 8);
    }
    return finish(element);
}

/** A strip of small lit switches. */
function switchTexture() {
    const { element, ctx } = screenCanvas(512, 20);
    const colors = ['#ff5a3a', '#46f59a', '#ffb347', '#4fd2f0'];
    for (let i = 0; i < 40; i++) {
        ctx.fillStyle = i % 7 === 3 ? colors[0] : colors[1 + (i % 3)];
        ctx.globalAlpha = i % 5 === 1 ? 0.25 : 0.9;
        ctx.fillRect(8 + i * 12.5, 6, 7, 8);
    }
    return finish(element);
}

/** The lit card of the compass. */
function dialTexture() {
    const { element, ctx } = screenCanvas(128, 128);
    ctx.strokeStyle = SCREEN_COLORS.amber;
    ctx.fillStyle = SCREEN_COLORS.amber;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(64, 64, 54, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 36; i++) {
        const angle = (i / 36) * Math.PI * 2;
        const inner = i % 9 === 0 ? 36 : 46;
        ctx.beginPath();
        ctx.moveTo(64 + Math.cos(angle) * inner, 64 + Math.sin(angle) * inner);
        ctx.lineTo(64 + Math.cos(angle) * 54, 64 + Math.sin(angle) * 54);
        ctx.stroke();
    }
    ctx.font = '700 22px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', 64, 36);
    return finish(element);
}
