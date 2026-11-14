// The holographic tactical board (blocks 3 and 4).
//
// Two miniatures float in the bridge, in front of the windows: the enemy zone
// (with the results of my shots) and my own zone (with my ships). The player
// clicks cells of the enemy zone to fire.
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
// What makes it look like a projection and not like painted glass:
//  - a projector on the floor with a lens, and a faint cone of light going
//    up from it to the image,
//  - every surface is drawn by one small shader (HOLO_*): fine scanlines, a
//    brighter band that climbs through the image, a slight flicker, and
//    edges that glow more than faces (ships look like glass models),
//  - short bursts of interference, and more of it when lightning strikes.
//
// Like the rest of the scene, the board only shows what the server sent:
// enemy ships appear on it only once they are sunk.

import * as THREE from 'three';
import { CELL, GRID_SIZE, ROW_LABELS, ZONES, ZONE_SPAN, cellToWorld, worldToCell } from '../config.js';
import { placeOnGrid } from './fleet.js';
import { buildShipModel } from './shipModels.js';
import { labelTexture } from './textures.js';
import { weather } from './weather.js';

// Where the board floats, relative to the captain's eye (-z is forward), and
// how much its far side is raised towards him.
export const BOARD_POSITION = new THREE.Vector3(0, -2.0, -3.6);
const TILT = THREE.MathUtils.degToRad(30);

// The two places a zone can be in. scale: 1 sea cell (10 units) = scale * 10 on the board.
const MAIN = { x: 0, z: 0, scale: 0.034 };
const INSET = { x: 2.65, z: -0.6, scale: 0.014 };   // mirrored to the left for the enemy zone
const SLIDE_SPEED = 4;                              // how fast zones move when the focus changes

const MINE = 0x62cdea;
const ENEMY = 0xf0a45c;
const DANGER = 0xff4a3d;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- The hologram shader ----------------------------------------------------------

// Shared by every hologram material, so one update per frame drives them all.
const shared = {
    uTime: { value: 0 },
    uFlicker: { value: 1 },      // overall brightness, wobbling a little
    uGlitch: { value: 0 }        // 1 during a burst of interference
};

const HOLO_VERTEX = /* glsl */`
    uniform float uTime;
    uniform float uGlitch;
    varying vec3 vNormal;
    varying vec3 vToEye;
    varying float vHeight;
    void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        // Interference: for an instant, thin slices of the image jump sideways.
        world.x += uGlitch * 0.025 * sin(world.y * 70.0 + uTime * 40.0);
        vHeight = world.y;
        vec4 mvPosition = viewMatrix * world;
        vNormal = normalize(mat3(viewMatrix) * mat3(modelMatrix) * normal);
        vToEye = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const HOLO_FRAGMENT = /* glsl */`
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform float uRim;          // 0 = flat surface, 1 = glass model (edges glow, faces are faint)
    uniform float uTime;
    uniform float uFlicker;
    varying vec3 vNormal;
    varying vec3 vToEye;
    varying float vHeight;
    void main() {
        // Scanlines: the image is made of thin horizontal lines, slowly crawling.
        float scan = 0.8 + 0.2 * sin(gl_FragCoord.y * 1.9 - uTime * 5.0);
        // A brighter band climbs through the image every few seconds.
        float band = exp(-pow((fract(vHeight * 0.35 - uTime * 0.11) - 0.5) * 9.0, 2.0));
        float rim = pow(1.0 - abs(dot(normalize(vNormal), vToEye)), 2.0);
        float shape = mix(1.0, 0.3 + 1.5 * rim, uRim);
        float alpha = uOpacity * shape * scan * uFlicker * (1.0 + 0.5 * band);
        gl_FragColor = vec4(uColor, alpha);
        #include <colorspace_fragment>
    }
`;

/** Glowing, see-through material: the "hologram" look. */
function holo(color, opacity, rim = 0) {
    return new THREE.ShaderMaterial({
        vertexShader: HOLO_VERTEX,
        fragmentShader: HOLO_FRAGMENT,
        uniforms: {
            ...shared,
            uColor: { value: new THREE.Color(color) },
            uOpacity: { value: opacity },
            uRim: { value: rim }
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
    });
}

/** Thin glowing lines (grid, outlines of the ships). */
function holoLine(color, opacity) {
    const material = new THREE.LineBasicMaterial({
        color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    });
    material.userData.baseOpacity = opacity;
    return material;
}

// The cone of light between the projector and the image: bright at the lens,
// fading upwards, with faint rays turning slowly inside it.
const BEAM_VERTEX = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const BEAM_FRAGMENT = /* glsl */`
    uniform vec3 uColor;
    uniform float uTime;
    uniform float uFlicker;
    varying vec2 vUv;
    void main() {
        float rays = 0.6 + 0.4 * sin(vUv.x * 150.0 + uTime * 0.7) * sin(vUv.x * 61.0 - uTime * 1.3);
        float fade = pow(1.0 - vUv.y, 2.2);      // vUv.y = 0 at the lens, 1 at the top
        gl_FragColor = vec4(uColor, 0.16 * fade * rays * uFlicker);
        #include <colorspace_fragment>
    }
`;

/**
 * @param parent the bridge interior group (its origin is the captain's eye)
 * @param floorY height of the bridge floor in that group (where the projector stands)
 */
export function createHoloBoard(parent, floorY = -3.2) {
    const board = new THREE.Group();
    board.position.copy(BOARD_POSITION);
    board.rotation.x = TILT;
    parent.add(board);

    // ---- Projector --------------------------------------------------------------
    const projector = new THREE.Group();
    projector.position.set(BOARD_POSITION.x, floorY, BOARD_POSITION.z + 0.2);
    parent.add(projector);
    const steel = new THREE.MeshStandardMaterial({ color: 0x20262c, roughness: 0.5, metalness: 0.7 });
    projector.add(new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.75, 0.22, 32), steel).translateY(0.11));
    projector.add(new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.2, 0.2, 32), steel).translateY(0.32));
    for (let i = 0; i < 6; i++) {   // cooling fins around the base
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.1), steel);
        const angle = (i / 6) * Math.PI * 2;
        fin.position.set(Math.cos(angle) * 1.45, 0.28, Math.sin(angle) * 1.45);
        fin.rotation.y = -angle;
        projector.add(fin);
    }
    // The lens: a bright disc with a ring of light around it.
    const lens = new THREE.Mesh(
        new THREE.CircleGeometry(0.2, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xbfefff, fog: false }));
    lens.position.y = 0.43;
    projector.add(lens);
    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.42, 0.02, 8, 48).rotateX(Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: MINE, fog: false }));
    ring.position.y = 0.44;
    projector.add(ring);
    const beamHeight = BOARD_POSITION.y - floorY + 0.5;
    const beam = new THREE.Mesh(
        // Open cone: narrow at the lens, as wide as the image at the top.
        new THREE.CylinderGeometry(3.0, 0.25, beamHeight, 48, 1, true),
        new THREE.ShaderMaterial({
            vertexShader: BEAM_VERTEX,
            fragmentShader: BEAM_FRAGMENT,
            uniforms: { ...shared, uColor: { value: new THREE.Color(MINE) } },
            transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
        }));
    // CylinderGeometry puts v = 1 at the top already; only move it above the lens.
    beam.position.y = 0.43 + beamHeight / 2;
    beam.renderOrder = 10;
    projector.add(beam);

    // ---- The two miniatures ----------------------------------------------------
    // slot  = the group that slides and scales on the board,
    // inner = shifted so that the centre of the zone is the centre of the slot;
    //         its children use sea coordinates.
    const zones = {};
    const lineMaterials = [];
    const labelGeometry = new THREE.PlaneGeometry(5, 5).rotateX(-Math.PI / 2);
    for (const zone of Object.keys(ZONES)) {
        const slot = new THREE.Group();
        const inner = new THREE.Group();
        inner.position.copy(ZONES[zone].center).negate();
        slot.add(inner);
        board.add(slot);
        zones[zone] = { slot, inner, markers: new THREE.Group(), ships: new THREE.Group() };
        inner.add(zones[zone].markers, zones[zone].ships);

        const color = zone === 'enemy' ? ENEMY : MINE;
        const center = ZONES[zone].center;
        // Faint plate under the zone, so the grid reads as a surface.
        const plate = new THREE.Mesh(
            new THREE.PlaneGeometry(ZONE_SPAN + 6, ZONE_SPAN + 6).rotateX(-Math.PI / 2), holo(color, 0.07));
        plate.position.copy(center).y = -0.4;
        inner.add(plate);
        for (const [positions, opacity] of gridLines(zone)) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            const material = holoLine(color, opacity);
            lineMaterials.push(material);
            inner.add(new THREE.LineSegments(geometry, material));
        }
        // Coordinates around the zone (letters on the left, numbers on top),
        // like on the sea: they make the board read as an instrument.
        const half = ZONE_SPAN / 2;
        const labelColor = zone === 'enemy' ? '#ffcf96' : '#a5eaff';
        for (let i = 0; i < GRID_SIZE; i++) {
            const offset = -half + (i + 0.5) * CELL;
            for (const [text, x, z] of [
                [ROW_LABELS[i], center.x - half - 5.5, center.z + offset],
                [String(i + 1), center.x + offset, center.z - half - 5.5]
            ]) {
                const label = new THREE.Mesh(labelGeometry, new THREE.MeshBasicMaterial({
                    map: labelTexture(text, labelColor), transparent: true, opacity: 0.75,
                    blending: THREE.AdditiveBlending, depthWrite: false, fog: false
                }));
                label.position.set(x, 0, z);
                inner.add(label);
            }
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
    // Miss: a pale ring with a dot. Hit: a bright cross. Sunk: the same cross on
    // a red tile. Three different shapes, so they also read without colour.
    const markers = new Map();   // "zone:row:col" -> { state, object }
    const ringGeometry = new THREE.RingGeometry(CELL * 0.22, CELL * 0.31, 24).rotateX(-Math.PI / 2);
    const dotGeometry = new THREE.CircleGeometry(CELL * 0.07, 12).rotateX(-Math.PI / 2);
    const barGeometry = new THREE.PlaneGeometry(CELL * 0.8, CELL * 0.16).rotateX(-Math.PI / 2);
    const tileGeometry = new THREE.PlaneGeometry(CELL * 0.92, CELL * 0.92).rotateX(-Math.PI / 2);
    const materials = {
        MISS: holo(0xd9ecf5, 0.6),
        HIT: holo(0xff6a2a, 1),
        SUNK: holo(DANGER, 0.38)
    };

    function buildMarker(state) {
        const group = new THREE.Group();
        if (state === 'MISS') {
            group.add(new THREE.Mesh(ringGeometry, materials.MISS), new THREE.Mesh(dotGeometry, materials.MISS));
            return group;
        }
        if (state === 'SUNK') {
            group.add(new THREE.Mesh(tileGeometry, materials.SUNK));
        }
        for (const angle of [Math.PI / 4, -Math.PI / 4]) {
            const bar = new THREE.Mesh(barGeometry, materials.HIT);
            bar.rotation.y = angle;
            bar.position.y = 0.3;
            group.add(bar);
        }
        return group;
    }

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
            const object = buildMarker(shown);
            // Hits float above the ship holograms so they are not hidden inside them.
            cellToWorld(zone, row, col, object.position).y = shown === 'MISS' ? 0.4 : 6.5;
            zones[zone].markers.add(object);
            markers.set(key, { state: shown, object });
        }
    }

    // ---- Miniature ships ------------------------------------------------------
    // Each one is a faint glass model (faces) with glowing outlines (edges).
    const ships = new Map();   // "zone:type" -> { key, object }
    const shipLooks = {
        mine: { fill: holo(MINE, 0.07, 1), edge: holoLine(0x9fe6ff, 0.3) },
        lost: { fill: holo(DANGER, 0.06, 1), edge: holoLine(DANGER, 0.25) },      // one of my ships, sunk
        enemy: { fill: holo(DANGER, 0.09, 1), edge: holoLine(0xff7a66, 0.35) }    // an enemy ship (only shown once sunk)
    };
    for (const look of Object.values(shipLooks)) {
        lineMaterials.push(look.edge);
    }
    const edgeCache = new Map();   // geometry -> its outline, computed once per ship type

    function buildHologram(type, look) {
        const object = buildShipModel(type, { plain: true });
        for (const child of [...object.children]) {
            if (!child.isMesh) {
                continue;
            }
            child.material = look.fill;
            if (!edgeCache.has(child.geometry)) {
                edgeCache.set(child.geometry, new THREE.EdgesGeometry(child.geometry, 30));
            }
            object.add(new THREE.LineSegments(edgeCache.get(child.geometry), look.edge));
        }
        return object;
    }

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
            const look = zone === 'enemy' ? shipLooks.enemy : layout.sunk ? shipLooks.lost : shipLooks.mine;
            const object = buildHologram(layout.type, look);
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
    // The cell under the mouse lights up: a filled tile with a brighter outline.
    const hoverMaterial = holo(0xffffff, 0.5);
    const hoverEdge = holoLine(0xffffff, 0.95);
    const outlineGeometry = new THREE.EdgesGeometry(tileGeometry);
    const hoverTiles = [];
    for (let i = 0; i < 5; i++) {
        const tile = new THREE.Mesh(tileGeometry, hoverMaterial);
        tile.add(new THREE.LineSegments(outlineGeometry, hoverEdge));
        tile.visible = false;
        hoverTiles.push(tile);
    }

    function showHover(zone, cells, color) {
        hoverMaterial.uniforms.uColor.value.set(color);
        hoverEdge.color.set(color);
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

    // ---- Animation ------------------------------------------------------------
    let glitchTime = 0;                          // seconds left in the current burst of interference
    let nextGlitch = 4 + Math.random() * 5;

    function update(dt, time) {
        if (pendingFocus) {
            pendingFocus.delay -= dt;
            if (pendingFocus.delay <= 0) {
                focus = pendingFocus.zone;
                pendingFocus = null;
            }
        }
        applySlots(1 - Math.exp(-dt * SLIDE_SPEED));

        // Interference: a short burst now and then, and whenever lightning
        // strikes (the projector does not like the electricity in the air).
        nextGlitch -= dt;
        if (nextGlitch <= 0 && !reducedMotion) {
            glitchTime = 0.08 + Math.random() * 0.1;
            nextGlitch = 5 + Math.random() * 8;
        }
        glitchTime = Math.max(0, glitchTime - dt);
        const disturbed = !reducedMotion && (glitchTime > 0 || weather.flash > 0.25);
        shared.uTime.value = time;
        shared.uGlitch.value = disturbed ? 1 : 0;
        // A steady image with a very slight shimmer; dimmer while disturbed.
        const shimmer = 0.94 + 0.06 * Math.sin(time * 17) * Math.sin(time * 3.1);
        shared.uFlicker.value = shimmer * (disturbed ? 0.6 + 0.3 * Math.sin(time * 90) : 1);
        for (const material of lineMaterials) {
            material.opacity = material.userData.baseOpacity * shared.uFlicker.value;
        }
        // Hit markers pulse, so damage draws the eye.
        materials.HIT.uniforms.uOpacity.value = 0.75 + 0.25 * Math.sin(time * 5);
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
    // Corner brackets just outside the frame: the look of a targeting display.
    const reach = half + 3;
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
            const x = center.x + sx * reach;
            const z = center.z + sz * reach;
            frame.push(x, 0, z, x - sx * 9, 0, z, x, 0, z, x, 0, z - sz * 9);
        }
    }
    return [[inner, 0.42], [frame, 1]];
}
