// The sinking of a ship, from the killing blow to the oil stain it leaves.
//
// fleet.js hands a ship over with start() the moment the server says it is
// sunk, and from then on this module moves it. The sequence takes about
// 10 to 14 seconds and is different every time (see makePlan):
//
//  1. Death blow (first second): a magazine goes up in a big fireball, more
//     blasts run along the hull, debris is thrown up and splashes down, a
//     burst of black smoke rises. The lights on board go out.
//  2. Taking water: the ship stops riding the waves, lists to one side and
//     settles by the bow or by the stern, its decks burning, steam pouring
//     out, small explosions now and then. The paint chars.
//  3. The plunge: the low end goes under and the other end rises out of the
//     water (steeply for the carrier and the battleship), then the hull slides
//     down. Some ships break in two near the middle first, some small ones
//     capsize, the submarine simply dives.
//  4. Aftermath: churning white foam and bubbles where it went down, a ring
//     of foam spreading out, an oil slick drifting downwind with patches of
//     burning oil, floating debris, smoke drifting away. Over two minutes it
//     calms down and leaves a dark oil stain and a few pieces of debris, so
//     the player always sees where a ship died.
//
// Everything runs in the background: nothing here delays the game.
//
// Cost: particles come from the effects pool, fires use the effects lights
// (no new light), each wreck adds ONE draw call (its slick), and all floating
// debris of all wrecks is ONE instanced mesh. Nothing is created per frame.
//
// Anti-cheat: this module only animates ships that fleet.js gives it, and
// fleet.js only knows ships the server has revealed.

import * as THREE from 'three';
import { CELL, SHIP_LENGTHS } from '../config.js';
import { WAVE_GLSL, seaUniforms, swellAt, waveHeight } from './sea.js';
import { blotTexture } from './textures.js';
import { weather, WIND } from './weather.js';

const BLOW_AT = 0.1;          // seconds after the sinking starts: the magazine goes up
const UNDER_Y = -3.2;         // a part is gone when all of it is below this (lower than any wave trough)
const REST_AFTER = 140;       // seconds after the hull went under: the wreck site is calm for good
const STAIN = 0.5;            // opacity of the oil stain that stays
const KEEPERS = 4;            // pieces of debris that never sink
const MAX_DEBRIS = 160;       // all wrecks together (10 ships x at most 14 pieces)
const MAX_SPLASHES = 48;      // debris about to hit the water
const CHAR = new THREE.Color(0x1b1714);   // burnt paint
const SEA_GLOW_SLOT = 6;      // see sea.js

const BIG = new Set(['CARRIER', 'BATTLESHIP']);
// Height of the deck where fires burn, in ship coordinates.
const DECK_Y = { CARRIER: 3.6, BATTLESHIP: 2.3, CRUISER: 2.2, DESTROYER: 2.1, SUBMARINE: 1.3 };

// Floating debris (all boxes, drawn as one instanced mesh): planks, a beam,
// a crate, an orange life raft, an oil drum, a hatch cover.
const DEBRIS_KINDS = [
    { size: [2.4, 0.22, 0.45], color: 0x4a3a2a },
    { size: [3.4, 0.3, 0.55], color: 0x3a2e21 },
    { size: [0.8, 0.6, 0.8], color: 0x5a4832 },
    { size: [1.7, 0.38, 1.3], color: 0xa3451f },
    { size: [0.6, 0.6, 0.9], color: 0x2c3338 },
    { size: [1.9, 0.16, 1.4], color: 0x463a2d }
];

// Particle recipes. emit() copies one into a shared options object, so
// spawning a particle allocates nothing.
const LOOKS = {
    fireball: { size: [8, 26], color: 0xffc070, colorEnd: 0xb3300a, additive: true, drag: 1.6 },
    blackSmoke: { size: [8, 40], color: 0x3a2618, colorEnd: 0x0e0f10, opacity: 0.7, smoke: true, drag: 0.5, wind: 0.5, fadeIn: 4 },
    chunk: { size: [1.1, 0.9], color: 0x14110f, opacity: 0.95, gravity: 1, wind: 0.05 },
    ember: { size: [1.0, 0.3], color: 0xffc35a, colorEnd: 0xff5a1a, additive: true, gravity: 1, wind: 0.2 },
    steam: { size: [3, 16], color: 0x9ea8ad, colorEnd: 0x4d5459, opacity: 0.34, smoke: true, drag: 0.6, wind: 0.65, fadeIn: 3 },
    spray: { size: [1.4, 3.2], color: 0xaebbc4, opacity: 0.75, gravity: 1, wind: 0.15 },
    foam: { size: [4, 11], color: 0xa7b3ba, opacity: 0.38, smoke: true, drag: 1.5, wind: 0.3, fadeIn: 3 },
    bubble: { size: [0.6, 1.5], color: 0xd2dbe0, opacity: 0.6 },
    pall: { size: [9, 36], color: 0x2b2a29, colorEnd: 0x101112, opacity: 0.42, smoke: true, drag: 0.3, wind: 0.6, fadeIn: 2 }
};

const smooth = (edge0, edge1, x) => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};
const clamp01 = x => Math.min(1, Math.max(0, x));
const random = (low, high) => low + Math.random() * (high - low);
const windAngle = Math.atan2(WIND.y, WIND.x);

// ---- The oil slick and the foam: one sheet lying on the waves --------------------

const slickVertex = /* glsl */`
    ${WAVE_GLSL}
    varying vec2 vUv;
    #include <fog_pars_vertex>
    void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        world.y = waveSurface(world.xz).x + 0.14;   // just above the water, like the wakes
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
    }
`;

const slickFragment = /* glsl */`
    uniform float uTime;
    uniform float uFlash;
    uniform sampler2D uBlot;
    uniform vec2 uSeed;
    uniform float uOil;      // 0..1 how much oil there is
    uniform float uSpread;   // 0..1 how far it has spread
    uniform float uRing;     // radius of the spreading ring of foam (0..1)
    uniform float uFoam;     // brightness of that ring
    uniform float uChurn;    // churned white water in the middle
    uniform float uBurn;     // 0..1 burning oil: a faint orange glow on the slick
    varying vec2 vUv;
    #include <fog_pars_fragment>
    void main() {
        vec2 p = vUv * 2.0 - 1.0;   // -1..1 across the sheet, +x = downwind
        float n1 = texture2D(uBlot, vUv * 0.8 + uSeed).r;
        float n2 = texture2D(uBlot, vUv * 2.1 - uSeed.yx + uTime * 0.003).r;

        // Oil: a ragged blob that spreads and is drawn out downwind.
        vec2 q = p - vec2(0.28 * uSpread, 0.0);
        q.x /= 1.0 + 0.35 * uSpread;
        float edge = uSpread * (0.5 + 0.6 * n1);
        float oil = 1.0 - smoothstep(edge * 0.6, edge, length(q));
        float thick = 0.55 + 0.45 * smoothstep(0.1, 0.6, n2);

        // Foam: a ring spreading out from where the ship went down, and the
        // churned water in the middle, both broken up by the blotches.
        float r = length(p);
        float ringWidth = 0.05 + 0.12 * uRing;
        float ring = exp(-pow((r - uRing) / ringWidth, 2.0)) * uFoam;
        float churn = (1.0 - smoothstep(0.05, 0.45, r)) * uChurn;
        float foam = clamp((ring + churn) * smoothstep(0.15, 0.55, n2 + n1 * 0.4) * 1.6, 0.0, 1.0);

        // Oil is darker and smoother than the sea. Thin oil has a faint rainbow
        // sheen, seen mostly when lightning strikes.
        float film = n2 * 7.0 + r * 4.0;
        vec3 sheen = 0.5 + 0.5 * cos(6.2832 * (film + vec3(0.0, 0.33, 0.67)));
        vec3 oilColor = vec3(0.012, 0.012, 0.011) + sheen * (0.012 + 0.1 * uFlash) * (1.0 - thick * 0.5);
        oilColor += vec3(1.0, 0.42, 0.12) * uBurn * 0.07 * (1.0 - smoothstep(0.0, 0.8, r));
        vec3 foamColor = vec3(0.6, 0.66, 0.7) * (0.32 + uFlash * 1.2);   // as bright as the wake foam

        float oilAlpha = oil * thick * uOil;
        float alpha = foam + oilAlpha * (1.0 - foam);
        vec3 color = (foamColor * foam + oilColor * oilAlpha * (1.0 - foam)) / max(alpha, 0.001);
        alpha *= 1.0 - smoothstep(0.85, 1.0, max(abs(p.x), abs(p.y)));   // never a hard square edge
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
    }
`;

/**
 * @param effects the effects module (particle pool, explosions, fires)
 * @param sea used to make burning oil shine on the water
 * @param sound the sound module
 */
export function createSinking(scene, effects, sea, sound) {
    const root = new THREE.Group();
    scene.add(root);

    const wrecks = new Map();   // fleet entry -> wreck

    // Reusable objects: nothing below creates anything per frame.
    const at = new THREE.Vector3();
    const vel = new THREE.Vector3();
    const corner = new THREE.Vector3();
    const glowAt = new THREE.Vector3();
    const spec = {
        position: at, velocity: vel, life: 1, size: [1, 1], color: 0, colorEnd: 0,
        opacity: 1, gravity: 0, drag: 0, wind: 0, additive: false, smoke: false, fadeIn: 8
    };

    /** Spawns one particle with a look from LOOKS, at `position`, moving at `velocity`. */
    function emit(look, position, velocity, life, scale = 1) {
        spec.position = position;
        spec.velocity = velocity;
        spec.life = life;
        spec.size[0] = look.size[0] * scale;
        spec.size[1] = look.size[1] * scale;
        spec.color = look.color;
        spec.colorEnd = look.colorEnd ?? look.color;
        spec.opacity = look.opacity ?? 1;
        spec.gravity = look.gravity ?? 0;
        spec.drag = look.drag ?? 0;
        spec.wind = look.wind ?? 0;
        spec.additive = look.additive ?? false;
        spec.smoke = look.smoke ?? false;
        spec.fadeIn = look.fadeIn ?? 8;
        effects.spawn(spec);
    }

    const spread = amount => (Math.random() - 0.5) * amount;
    const burst = (wide, up) => vel.set(spread(wide), up, spread(wide));
    const distance = position => effects.distanceTo(position);

    // ---- Shared resources -------------------------------------------------------
    const slickGeometry = new THREE.PlaneGeometry(2, 2, 32, 32).rotateX(-Math.PI / 2);
    const blot = blotTexture();
    const breakMaterial = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1, metalness: 0 });
    const breakGeometry = new THREE.BoxGeometry(1, 1, 1);

    // ---- Floating debris: one instanced mesh for every wreck ----------------------
    const debrisMesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.1 }),
        MAX_DEBRIS);
    debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    debrisMesh.frustumCulled = false;   // the pieces are spread over the whole battlefield
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    const pieces = [];
    const tint = new THREE.Color();
    for (let i = 0; i < MAX_DEBRIS; i++) {
        pieces.push({
            state: 'off',   // 'off' | 'flying' | 'rising' | 'floating' | 'sinking'
            wreck: null, keeper: false, kind: DEBRIS_KINDS[0],
            x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, depth: 0, yaw: 0, spin: 0, tumble: 0, phase: 0, sinkAt: 0
        });
        debrisMesh.setMatrixAt(i, hidden);
        debrisMesh.setColorAt(i, tint.set(0xffffff));   // creates the colour buffer now, so no shader is compiled mid-game
    }
    root.add(debrisMesh);
    const pieceMatrix = new THREE.Matrix4();
    const pieceQuaternion = new THREE.Quaternion();
    const pieceEuler = new THREE.Euler();
    const piecePosition = new THREE.Vector3();
    const pieceScale = new THREE.Vector3();

    /** Takes a free piece of debris for a wreck, or null when all are in use. */
    function takePiece(wreck, keeper) {
        const piece = pieces.find(candidate => candidate.state === 'off');
        if (!piece) {
            return null;
        }
        const index = pieces.indexOf(piece);
        piece.wreck = wreck;
        piece.keeper = keeper;
        piece.kind = DEBRIS_KINDS[Math.floor(Math.random() * DEBRIS_KINDS.length)];
        piece.yaw = Math.random() * Math.PI * 2;
        piece.spin = spread(0.25);
        piece.tumble = 0;
        piece.phase = Math.random() * 10;
        piece.depth = 0;
        piece.sinkAt = random(25, 85);
        // A little variety of shade, so two planks are never the same.
        debrisMesh.setColorAt(index, tint.set(piece.kind.color).multiplyScalar(random(0.75, 1.15)));
        debrisMesh.instanceColor.needsUpdate = true;
        return piece;
    }

    function freePieces(wreck) {
        pieces.forEach((piece, index) => {
            if (piece.wreck === wreck) {
                piece.state = 'off';
                piece.wreck = null;
                debrisMesh.setMatrixAt(index, hidden);
            }
        });
        debrisMesh.instanceMatrix.needsUpdate = true;
    }

    // ---- Debris falling back into the sea: a small splash when it lands ------------
    const splashes = [];
    for (let i = 0; i < MAX_SPLASHES; i++) {
        splashes.push({ active: false, delay: 0, x: 0, z: 0, size: 1 });
    }

    /** Something thrown from (x, y, z) with upward speed vy will land after this many seconds. */
    const fallTime = (y, vy, gravity) => (vy + Math.sqrt(vy * vy + 2 * gravity * Math.max(y, 0))) / gravity;

    function scheduleSplash(x, z, delay, size) {
        const slot = splashes.find(splash => !splash.active);
        if (slot) {
            Object.assign(slot, { active: true, delay, x, z, size });
        }
    }

    function updateSplashes(dt, time) {
        for (const splash of splashes) {
            if (!splash.active) {
                continue;
            }
            splash.delay -= dt;
            if (splash.delay > 0) {
                continue;
            }
            splash.active = false;
            at.set(splash.x, waveHeight(splash.x, splash.z, time) + 0.2, splash.z);
            for (let i = 0; i < 7; i++) {
                emit(LOOKS.spray, at, burst(3 * splash.size, random(5, 11) * splash.size), random(0.6, 1.1), splash.size);
            }
        }
    }

    // ---- How a ship goes down: chosen once per ship, so no two sinkings match ------

    function makePlan(type, length, top) {
        const big = BIG.has(type);
        const style = type === 'SUBMARINE' ? 'dive'
            : big ? (Math.random() < 0.55 ? 'break' : 'plunge')
            : (Math.random() < 0.4 ? 'capsize' : 'plunge');
        const plunge = (big ? 6.4 : 5.2) + Math.random() * 1.6;         // when the plunge starts
        const under = plunge + (big ? 5.2 : 3.8) + Math.random() * 1.0; // when the hull should be gone
        const down = Math.random() < 0.5 ? 1 : -1;                       // 1 = bow first, -1 = stern first
        const plan = {
            style,
            down: style === 'dive' ? 1 : down,
            side: Math.random() < 0.5 ? 1 : -1,                          // the side it lists to
            list: style === 'dive' ? 0.05 : random(0.14, 0.34),
            settle: random(0.03, 0.08),                                  // pitch while it fills with water
            awash: type === 'SUBMARINE' ? 0.9 : random(1.0, 1.4),        // how low it settles before the plunge
            angle: style === 'dive' ? random(0.22, 0.32)
                : style === 'capsize' ? random(0.28, 0.45)
                : style === 'break' ? random(0.26, 0.34)
                : big ? random(0.95, 1.2) : random(0.4, 0.65),
            roll: style === 'capsize' ? random(1.9, 2.4) : 0,            // rolls over during the plunge
            bend: random(0.35, 0.5),                                     // break: how much steeper the front half dives
            rise: random(0.7, 0.9),                                      // break: how high the other half stands up
            cut: spread(0.14) * length,                                  // break: where the hull gives way
            yaw: spread(0.25),                                           // it swings a little as it goes
            phase: Math.random() * 10,
            plunge,
            under
        };
        plan.pivot = style === 'break' ? plan.cut : plan.down * length * 0.16;
        // How far the pivot must go down for everything to be under at the end.
        const lever = length / 2 + Math.abs(plan.pivot);
        const steepest = plan.angle + (style === 'break' ? plan.rise : 0);
        plan.depth = lever * Math.sin(Math.min(steepest, 1.3)) + top * 0.5 + 3;
        return plan;
    }

    // ---- Starting a sinking ---------------------------------------------------------

    /**
     * Takes over a ship of the fleet.
     * @param entry the fleet entry: { anchor, body, wake, type, zone }
     * @param instant true = no animation: show the calm wreck site at once
     */
    function start(entry, instant = false) {
        forget(entry);
        const { anchor, body, type } = entry;
        const length = body.userData.length;
        anchor.updateMatrixWorld(true);
        const bounds = localBounds(body);
        const plan = makePlan(type, length, bounds.max.y);
        const wreck = {
            entry, type, length, plan,
            beam: bounds.max.z - bounds.min.z,
            age: 0,
            goneAt: -1,               // age when the last of the hull went under
            rest: false,              // true = only the stain and a few pieces of debris are left
            rig: null, parts: [],
            fires: [], oilFires: [],
            materials: [], geometries: [],
            center: anchor.localToWorld(new THREE.Vector3(plan.pivot * 0.6, 0, 0)).setY(0),
            drift: new THREE.Vector2(),
            radius: length * 0.42 + 9,
            wakeOpacity: entry.wake.material.uniforms.uOpacity.value,
            charFrom: entry.zone === 'enemy' ? 0.5 : 0,   // an enemy ship is first seen already burning
            done: {},                                     // one-off events already played
            nextBlast: 0, blasts: 0, steamTimer: 0, foamTimer: 0, bubbleTimer: 0, boilTimer: 0, smokeTimer: 0
        };
        wrecks.set(entry, wreck);
        wreck.slick = buildSlick(wreck);

        if (instant) {
            settle(wreck);
            return;
        }
        entry.wake.visible = true;
        charMaterials(wreck, body);
        buildRig(wreck, bounds);
        // Fires on every cell (the cells that were burning a moment ago, so the
        // flames carry on where they were), a little apart.
        const cells = SHIP_LENGTHS[type];
        for (let i = 0; i < cells; i++) {
            addDeckFire(wreck, (i - (cells - 1) / 2) * CELL + spread(3), random(1.0, 1.4));
        }
        // The blasts that follow the death blow, close together, then rarer.
        wreck.nextBlast = BLOW_AT + random(0.3, 0.45);
    }

    /** Bounding box of a ship model in its own coordinates. */
    function localBounds(body) {
        const bounds = new THREE.Box3();
        const box = new THREE.Box3();
        for (const child of body.children) {
            if (!child.geometry) {
                continue;
            }
            if (!child.geometry.boundingBox) {
                child.geometry.computeBoundingBox();
            }
            if (child.matrixAutoUpdate) {
                child.updateMatrix();   // (the hull numbers keep the matrix they were given)
            }
            bounds.union(box.copy(child.geometry.boundingBox).applyMatrix4(child.matrix));
        }
        return bounds;
    }

    /**
     * Gives the sinking ship its own copies of the materials, so its paint
     * can char and its lights go out without touching the other ships.
     * (Same kind of material: no new shader to compile.)
     */
    function charMaterials(wreck, body) {
        const copies = new Map();
        body.traverse(child => {
            if (!child.material) {
                return;
            }
            if (!copies.has(child.material)) {
                const copy = child.material.clone();
                copy.userData.base = copy.color ? copy.color.clone() : null;
                copies.set(child.material, copy);
            }
            child.material = copies.get(child.material);
        });
        wreck.materials = [...copies.values()];
    }

    /**
     * Puts the hull on a "rig": a group turning around a pivot point on the
     * keel line. A ship that will break in two is cut into two halves first,
     * each on its own hinge at the break.
     *
     *   anchor (grid position) -> rig (pivot: sinks, lists, pitches)
     *                          -> part (hinge: only moves when breaking) -> hull
     */
    function buildRig(wreck, bounds) {
        const { entry, plan } = wreck;
        const { anchor, body } = entry;
        const rig = new THREE.Group();
        rig.rotation.order = 'ZYX';   // roll around the hull first, then pitch
        rig.position.set(plan.pivot, 0, 0);
        anchor.add(rig);
        wreck.rig = rig;
        if (plan.style === 'break') {
            anchor.remove(body);
            splitModel(body, plan.cut, wreck).forEach((half, index) => {
                const part = new THREE.Group();
                part.rotation.order = 'ZYX';
                part.add(half);
                rig.add(part);   // the hinge is at the rig pivot, which is the cut
                half.position.x = -plan.cut;
                const side = index === 1 ? 1 : -1;   // 1 = the bow half
                addPart(wreck, part, half, side, half.userData.bounds);
            });
        } else {
            const part = new THREE.Group();
            part.position.x = -plan.pivot;
            body.position.set(0, 0, 0);
            body.rotation.set(0, 0, 0);
            part.add(body);
            rig.add(part);
            addPart(wreck, part, body, 0, bounds);
        }
    }

    function addPart(wreck, group, holder, side, bounds) {
        const corners = [];
        for (const x of [bounds.min.x, bounds.max.x]) {
            for (const y of [bounds.min.y, bounds.max.y]) {
                for (const z of [bounds.min.z, bounds.max.z]) {
                    corners.push(new THREE.Vector3(x, y, z));
                }
            }
        }
        wreck.parts.push({ group, holder, side, corners, gone: false });
    }

    /**
     * Cuts a ship model in two at x = cut. The merged meshes are split
     * triangle by triangle (a ragged edge, like torn steel); small separate
     * parts go whole to the side they are on. A dark bulkhead closes each
     * half, so nobody looks into an empty hull.
     * @returns [stern half, bow half], groups in ship coordinates
     */
    function splitModel(body, cut, wreck) {
        const halves = [new THREE.Group(), new THREE.Group()];
        for (const child of body.children) {
            const plain = child.matrixAutoUpdate && child.position.lengthSq() === 0
                && child.rotation.x === 0 && child.rotation.y === 0 && child.rotation.z === 0 && child.scale.x === 1;
            if ((child.isMesh || child.isLineSegments) && !child.geometry.index && plain) {
                const stride = child.isLineSegments ? 2 : 3;
                splitGeometry(child.geometry, cut, stride).forEach((geometry, index) => {
                    if (geometry) {
                        const Kind = child.isLineSegments ? THREE.LineSegments : THREE.Mesh;
                        halves[index].add(new Kind(geometry, child.material));
                        wreck.geometries.push(geometry);
                    }
                });
            } else {
                const x = child.matrixAutoUpdate ? child.position.x : child.matrix.elements[12];
                halves[x > cut ? 1 : 0].add(child.clone());
            }
        }
        const height = DECK_Y[wreck.type] + 0.6;
        halves.forEach((half, index) => {
            const seal = new THREE.Mesh(breakGeometry, breakMaterial);
            seal.scale.set(0.5, height, wreck.beam * 0.78);
            seal.position.set(cut + (index === 1 ? 0.3 : -0.3), height / 2 - 1.3, 0);
            half.add(seal);
            half.userData.bounds = localBounds(half);
        });
        return halves;
    }

    /** Splits a non-indexed geometry: [primitives with centre x < cut, the others]. */
    function splitGeometry(geometry, cut, stride) {
        const position = geometry.attributes.position;
        const lists = [[], []];
        for (let v = 0; v < position.count; v += stride) {
            let x = 0;
            for (let k = 0; k < stride; k++) {
                x += position.getX(v + k);
            }
            lists[x / stride > cut ? 1 : 0].push(v);
        }
        return lists.map(list => {
            if (list.length === 0) {
                return null;
            }
            const result = new THREE.BufferGeometry();
            for (const [name, attribute] of Object.entries(geometry.attributes)) {
                const size = attribute.itemSize;
                const array = new attribute.array.constructor(list.length * stride * size);
                let offset = 0;
                for (const v of list) {
                    array.set(attribute.array.subarray(v * size, (v + stride) * size), offset);
                    offset += stride * size;
                }
                result.setAttribute(name, new THREE.BufferAttribute(array, size));
            }
            return result;
        });
    }

    /** A fire on deck at ship coordinate x. It goes out when the water reaches it. */
    function addDeckFire(wreck, x, scale) {
        const { plan, parts } = wreck;
        // Which part of the hull it burns on (the two halves of a broken ship).
        const part = parts.length === 1 ? parts[0] : parts[x > plan.cut ? 1 : 0];
        const local = new THREE.Vector3(x, DECK_Y[wreck.type], spread(wreck.beam * 0.35));
        const fire = { position: new THREE.Vector3(), scale };
        part.holder.localToWorld(fire.position.copy(local));
        wreck.fires.push({ part, local, fire, out: false });
        effects.addFire(fire);
    }

    /** The oil slick (with the foam), a sheet on the waves. Hidden until oil leaks out. */
    function buildSlick(wreck) {
        const uniforms = {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            uTime: seaUniforms.uTime,
            uChop: seaUniforms.uChop,
            uFlash: seaUniforms.uFlash,
            uBlot: { value: blot },
            uSeed: { value: new THREE.Vector2(Math.random(), Math.random()) },
            uOil: { value: 0 },
            uSpread: { value: 0.12 },
            uRing: { value: 0 },
            uFoam: { value: 0 },
            uChurn: { value: 0 },
            uBurn: { value: 0 }
        };
        const mesh = new THREE.Mesh(slickGeometry, new THREE.ShaderMaterial({
            vertexShader: slickVertex,
            fragmentShader: slickFragment,
            uniforms,
            transparent: true,
            depthWrite: false,
            fog: true
        }));
        mesh.position.copy(wreck.center);
        mesh.rotation.y = -windAngle;                 // +x of the sheet points downwind
        mesh.scale.set(wreck.radius * 1.5, 1, wreck.radius);
        mesh.frustumCulled = false;                   // the vertices move in the shader
        mesh.renderOrder = -6;                        // on the sea, under the wakes and the markers
        mesh.visible = false;
        root.add(mesh);
        return { mesh, uniforms };
    }

    /** The calm wreck site, straight away: used for a ship already sunk when the player joins. */
    function settle(wreck) {
        const { entry, slick } = wreck;
        entry.body.visible = false;
        entry.wake.visible = false;
        wreck.rest = true;
        wreck.goneAt = 0;
        wreck.age = REST_AFTER;
        slick.mesh.visible = true;
        slick.uniforms.uOil.value = STAIN;
        slick.uniforms.uSpread.value = 1;
        for (let i = 0; i < KEEPERS; i++) {
            const piece = takePiece(wreck, true);
            if (piece) {
                placeAround(wreck, piece, 0.6);
                piece.state = 'floating';
            }
        }
    }

    /** Puts a piece of debris somewhere on the slick (radius as a fraction of the slick). */
    function placeAround(wreck, piece, radius) {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * wreck.radius * radius;
        piece.x = wreck.center.x + wreck.drift.x + Math.cos(angle) * r * 1.3 + WIND.x * wreck.radius * 0.2;
        piece.z = wreck.center.z + wreck.drift.y + Math.sin(angle) * r + WIND.y * wreck.radius * 0.2;
    }

    // ---- Every frame -----------------------------------------------------------------

    function update(dt, time) {
        let brightest = null;
        for (const wreck of wrecks.values()) {
            if (!wreck.rest) {
                wreck.age += dt;
                if (wreck.goneAt < 0) {
                    animateShip(wreck, dt, time);
                }
                animateSite(wreck, dt, time);
            }
            if (!brightest || wreck.slick.uniforms.uBurn.value > brightest.slick.uniforms.uBurn.value) {
                brightest = wreck;
            }
        }
        updatePieces(dt, time);
        updateSplashes(dt, time);
        // The burning oil of one wreck (the brightest) shines on the water.
        const burn = brightest ? brightest.slick.uniforms.uBurn.value : 0;
        if (burn > 0) {
            glowAt.copy(brightest.center).setY(0.5);
            sea.setGlow(SEA_GLOW_SLOT, glowAt, burn * (0.75 + 0.15 * Math.sin(time * 9.3) + 0.1 * Math.sin(time * 21.1)));
        } else {
            sea.setGlow(SEA_GLOW_SLOT, glowAt, 0);
        }
    }

    // ---- 1 to 3: the ship itself ------------------------------------------------------

    function animateShip(wreck, dt, time) {
        const { plan, rig, entry, length } = wreck;
        const t = wreck.age;
        const anchor = entry.anchor;
        const span = plan.under - plan.plunge;
        const along = (t - plan.plunge) / span;   // < 0 before the plunge, 1 = should be gone
        const u = clamp01(along);

        // How much it still rides the waves: less and less as it fills, nothing in the plunge.
        const swell = swellAt(anchor.position.x, anchor.position.z, time, anchor.rotation.y);
        const ride = (1 - 0.75 * smooth(0, 3, t)) * (1 - smooth(0, 0.5, u));
        let y = swell.height * ride;
        let roll = swell.roll * ride;
        const pitch = swell.pitch * ride;   // + = bow up

        // 1. The death blow lifts the hull for an instant and kicks it over.
        const kick = t - BLOW_AT;
        if (kick > 0 && kick < 0.7) {
            y += 0.45 * Math.sin(Math.PI * kick / 0.7);
        }
        if (kick > 0) {
            roll += plan.side * 0.1 * Math.exp(-2.2 * kick) * Math.sin(6.5 * kick);
        }
        // 2. Taking water: it settles, lists, goes down by one end and wallows heavily.
        const flooding = smooth(0.4, plan.plunge, t);
        y -= plan.awash * flooding;
        roll += plan.side * plan.list * smooth(0.3, plan.plunge * 0.9, t) + 0.03 * Math.sin(t * 1.05 + plan.phase) * (1 - u);
        let dip = plan.settle * flooding;   // + = the low end is lower
        // 3. The plunge: steeper and steeper, then it slides down, faster and faster.
        if (along > 0) {
            dip += (plan.angle - plan.settle) * smooth(0, 0.75, u);
            roll += plan.side * plan.roll * smooth(0, 0.7, u);
            y -= plan.depth * Math.pow(along, 1.9);
        }
        rig.position.set(plan.pivot + plan.down * length * 0.1 * u * u, y, 0);
        rig.rotation.set(roll, plan.yaw * smooth(1, plan.under, t), pitch - plan.down * dip);

        // Breaking in two: the hull gives way at the cut (it hogs: both ends
        // drop a little), the low half dives steeper, then the other half
        // stands up, almost vertical, before it follows.
        if (plan.style === 'break') {
            const give = smooth(0.12, 0.38, u);
            for (const part of wreck.parts) {
                const low = part.side === plan.down;
                const extra = low
                    ? plan.bend * give
                    : -0.22 * give + plan.rise * smooth(0.42, 0.92, u);
                part.group.rotation.z = -plan.down * extra;
                part.group.position.x = low ? plan.down * 1.4 * give : 0;   // a gap opens
            }
            if (give > 0.05 && !wreck.done.broke) {
                wreck.done.broke = true;
                breakUp(wreck);
            }
        }
        anchor.updateMatrixWorld(true);

        // Hide each part once all of it is under the waves.
        if (t > plan.plunge) {
            let allGone = true;
            for (const part of wreck.parts) {
                if (!part.gone && isUnder(part)) {
                    part.gone = true;
                    part.group.visible = false;
                }
                allGone = allGone && part.gone;
            }
            // Safety net: whatever happens, the hull is gone a few seconds late at most.
            if (allGone || along > 1.8) {
                hullGone(wreck);
                return;
            }
        }

        updateCharring(wreck, t);
        updateDeckFires(wreck, time);
        deathBlow(wreck, t);
        smallBlasts(wreck, t, plan);
        steamAndFoam(wreck, dt, time, t, u);
        cues(wreck, t, u);

        // The wake fades: the ship has stopped.
        const wake = entry.wake;
        wake.material.uniforms.uOpacity.value = wreck.wakeOpacity * (1 - smooth(0, 2.5, t));
        wake.visible = t < 2.5;
    }

    function isUnder(part) {
        const matrix = part.holder.matrixWorld;
        for (const point of part.corners) {
            if (corner.copy(point).applyMatrix4(matrix).y > UNDER_Y) {
                return false;
            }
        }
        return true;
    }

    /** The paint darkens in the fire; the lights on board go out with the death blow. */
    function updateCharring(wreck, t) {
        if (t > 8) {
            return;
        }
        const amount = 0.6 * (wreck.charFrom + (1 - wreck.charFrom) * smooth(0, 7, t));
        const lightsOut = t > BLOW_AT;
        for (const material of wreck.materials) {
            if (material.userData.base) {
                material.color.copy(material.userData.base).lerp(CHAR, material.isMeshBasicMaterial && lightsOut ? 0.92 : amount);
            }
            if (material.emissiveIntensity !== undefined && lightsOut) {
                material.emissiveIntensity = 0;
            }
        }
    }

    function updateDeckFires(wreck, time) {
        for (const deckFire of wreck.fires) {
            if (deckFire.out) {
                continue;
            }
            const position = deckFire.part.holder.localToWorld(deckFire.fire.position.copy(deckFire.local));
            // The sea reaches the fire: it dies in a puff of steam.
            if (deckFire.part.gone || position.y < waveHeight(position.x, position.z, time) + 0.25) {
                deckFire.out = true;
                effects.removeFire(deckFire.fire);
                for (let i = 0; i < 5; i++) {
                    emit(LOOKS.steam, position, burst(3, random(4, 8)), random(2.5, 4));
                }
                sound.steam(distance(position), 2.2);
            }
        }
    }

    /** A point on deck at ship coordinate x (on whichever half holds it). */
    function deckPoint(wreck, x, target) {
        const part = wreck.parts.length === 1 ? wreck.parts[0] : wreck.parts[x > wreck.plan.cut ? 1 : 0];
        return part.holder.localToWorld(target.set(x, DECK_Y[wreck.type], spread(wreck.beam * 0.4)));
    }

    /** 1. The magazine goes up: fireball, black smoke, debris raining down. */
    function deathBlow(wreck, t) {
        if (wreck.done.blow || t < BLOW_AT) {
            return;
        }
        wreck.done.blow = true;
        const big = BIG.has(wreck.type);
        const scale = big ? 1.5 : 1.15;
        const blowX = spread(wreck.length * 0.5);   // where the magazine is
        const blowAt = deckPoint(wreck, blowX, new THREE.Vector3());
        effects.explosion(blowAt, scale * 1.2, { silent: true });
        sound.deathBlow(distance(blowAt));
        // A column of fire, rising and rolling.
        for (let i = 0; i < 14; i++) {
            emit(LOOKS.fireball, blowAt, burst(8 * scale, random(10, 22) * scale), random(0.7, 1.2), scale * random(0.7, 1.1));
        }
        // A burst of black smoke that hangs over the wreck.
        for (let i = 0; i < 22; i++) {
            emit(LOOKS.blackSmoke, blowAt, burst(14 * scale, random(4, 14) * scale), random(6, 9), scale * random(0.8, 1.2));
        }
        // Dark pieces and burning bits thrown up; the big ones splash down.
        for (let i = 0; i < 34; i++) {
            const up = random(12, 30);
            burst(40 * scale, up);
            emit(i % 3 === 0 ? LOOKS.ember : LOOKS.chunk, blowAt, vel, 4, random(0.6, 1.3));
            if (i % 4 === 0) {
                const fall = fallTime(blowAt.y, up, 30);
                scheduleSplash(blowAt.x + vel.x * fall, blowAt.z + vel.z * fall, fall, random(0.5, 0.9));
            }
        }
        // A few real pieces of debris fly out and land in the water, where they will float.
        for (let i = 0, n = big ? 5 : 3; i < n; i++) {
            const piece = takePiece(wreck, i < 2);
            if (piece) {
                piece.state = 'flying';
                piece.x = blowAt.x;
                piece.y = blowAt.y;
                piece.z = blowAt.z;
                piece.vx = spread(26);
                piece.vy = random(12, 22);
                piece.vz = spread(26);
            }
        }
        // More fires where it blew.
        addDeckFire(wreck, blowX, 1.5);
    }

    /** 1 and 2. Blasts along the hull: quick ones right after the death blow, then now and then. */
    function smallBlasts(wreck, t, plan) {
        if (t < wreck.nextBlast || t > plan.plunge + 1) {
            return;
        }
        wreck.blasts++;
        const quick = wreck.blasts <= (BIG.has(wreck.type) ? 4 : 2);
        wreck.nextBlast = t + (quick ? random(0.4, 0.6) : random(1.4, 2.8));
        deckPoint(wreck, spread(wreck.length * 0.8), at);
        // No flash of light: blasts this close together would make the scene strobe.
        effects.explosion(at, quick ? random(0.6, 0.85) : random(0.4, 0.6), { light: false, silent: true });
        sound.secondaryBlast(distance(at));
        if (wreck.fires.length < (BIG.has(wreck.type) ? 9 : 6) && Math.random() < 0.45) {
            addDeckFire(wreck, spread(wreck.length * 0.8), random(0.9, 1.3));
        }
    }

    /** 2 and 3. Steam pouring out, foam and spray where the hull meets the sea. */
    function steamAndFoam(wreck, dt, time, t, u) {
        const { plan, length } = wreck;
        // Steam and smoke from the middle of the ship (boilers, funnels) and the flooded end.
        wreck.steamTimer -= dt;
        if (t > 1.2 && wreck.steamTimer <= 0) {
            wreck.steamTimer = 0.12;
            deckPoint(wreck, spread(length * 0.25), at).y += 1.5;
            if (at.y > waveHeight(at.x, at.z, time)) {
                emit(LOOKS.steam, at, burst(2, random(5, 9)), random(3, 4.5), random(0.8, 1.2));
            }
        }
        // Where the water pours over the deck or swallows the hull: churning foam.
        wreck.foamTimer -= dt;
        if (t > 2 && wreck.foamTimer <= 0) {
            wreck.foamTimer = u > 0 ? 0.035 : 0.12;
            waterline(wreck, time, at);
            emit(LOOKS.spray, at, burst(5, random(3, u > 0 ? 12 : 6)), random(0.5, 1.0), u > 0 ? 1.2 : 0.8);
            if (Math.random() < 0.4) {
                emit(LOOKS.foam, at, burst(6, random(0.5, 2)), random(1.5, 2.5), u > 0 ? 1.3 : 0.9);
            }
        }
        // The boilers meet the sea: a great cloud of steam.
        if (u > 0.45 && !wreck.done.boilers && plan.style !== 'dive') {
            wreck.done.boilers = true;
            waterline(wreck, time, at);
            for (let i = 0; i < 26; i++) {
                emit(LOOKS.steam, at, burst(10, random(8, 18)), random(4, 6), random(1.4, 2.2));
            }
            sound.steam(distance(at), 4.5);
        }
        // The submarine blows the last air from its tanks: big boils of bubbles.
        if (plan.style === 'dive' && u > 0.1 && Math.random() < dt * 4) {
            waterline(wreck, time, at);
            for (let i = 0; i < 8; i++) {
                emit(LOOKS.spray, at, burst(6, random(6, 13)), random(0.7, 1.2));
            }
        }
    }

    /**
     * Where the hull crosses the water line, along its length: the end that
     * is under water before the plunge, the point where it disappears during it.
     */
    function waterline(wreck, time, target) {
        const { plan, parts } = wreck;
        // The half that is still out of the water (or the whole ship).
        const part = parts.find(candidate => !candidate.gone && candidate.side !== plan.down) || parts[0];
        const matrix = part.holder.matrixWorld.elements;
        // Ship axis in the world: origin + s * direction (columns of the matrix).
        const slope = matrix[1];                // how much y changes per unit along the ship
        const height = matrix[13];
        let s = Math.abs(slope) > 0.03 ? -height / slope : plan.down * wreck.length * 0.42;
        const half = wreck.length / 2;
        s = Math.max(-half, Math.min(half, s));
        part.holder.localToWorld(target.set(s, 0, spread(wreck.beam * 0.6)));
        target.y = waveHeight(target.x, target.z, time) + 0.3;
        return target;
    }

    /** The hull gives way: a blast at the cut, fire and smoke pouring out. */
    function breakUp(wreck) {
        const part = wreck.parts[0];
        part.holder.localToWorld(at.set(wreck.plan.cut, DECK_Y[wreck.type], 0));
        effects.explosion(at, 0.9, { light: false, silent: true });
        for (let i = 0; i < 16; i++) {
            emit(LOOKS.blackSmoke, at, burst(10, random(6, 14)), random(5, 7), random(0.8, 1.1));
        }
        sound.groan(distance(at), 2.2);
        sound.secondaryBlast(distance(at));
    }

    /** Sounds that belong to moments of the sequence: groans of metal, the plunge. */
    function cues(wreck, t, u) {
        const { plan, done } = wreck;
        const centre = wreck.center;
        if (!done.groan && t > plan.plunge - 1.8) {
            done.groan = true;
            sound.groan(distance(centre), 1);
        }
        if (!done.plunge && u > 0.25) {
            done.plunge = true;
            sound.plunge(distance(centre));
        }
        if (!done.groan2 && u > 0.55 && BIG.has(wreck.type)) {
            done.groan2 = true;
            sound.groan(distance(centre), 1.3);
        }
    }

    /** The last of the hull is under: the aftermath begins. */
    function hullGone(wreck) {
        wreck.goneAt = wreck.age;
        for (const part of wreck.parts) {
            part.group.visible = false;
        }
        for (const deckFire of wreck.fires) {
            if (!deckFire.out) {
                deckFire.out = true;
                effects.removeFire(deckFire.fire);
            }
        }
        wreck.entry.wake.visible = false;
        // A last eruption of air and water where it went down.
        at.copy(wreck.center).setY(0.5);
        for (let i = 0; i < 30; i++) {
            emit(LOOKS.spray, at, burst(10, random(8, 20)), random(0.8, 1.5), random(1, 1.6));
        }
        for (let i = 0; i < 8; i++) {
            emit(LOOKS.foam, at, burst(14, random(1, 3)), random(2.5, 4), 1.6);
        }
        // The burning oil catches, and the debris comes up.
        const big = BIG.has(wreck.type);
        for (let i = 0, n = big ? 5 : 3; i < n; i++) {
            const fire = { position: new THREE.Vector3(), scale: random(0.7, 1.1) };
            const angle = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * wreck.radius * 0.45;
            wreck.oilFires.push({
                fire,
                x: Math.cos(angle) * r * 1.3 + WIND.x * wreck.radius * 0.15,
                z: Math.sin(angle) * r + WIND.y * wreck.radius * 0.15,
                start: random(0, 2.5),
                life: random(14, 34),
                size: fire.scale,
                lit: false
            });
        }
        for (let i = 0, n = big ? 10 : 6; i < n; i++) {
            const piece = takePiece(wreck, i < KEEPERS - 2);
            if (piece) {
                placeAround(wreck, piece, 0.55);
                piece.state = 'rising';
                piece.depth = random(1.5, 2.5) + i * 0.35;   // they come up one after the other
            }
        }
    }

    // ---- 4: the aftermath --------------------------------------------------------------

    function animateSite(wreck, dt, time) {
        const { plan, slick } = wreck;
        const uniforms = slick.uniforms;
        const t = wreck.age;
        const gone = wreck.goneAt >= 0;
        const a = gone ? t - wreck.goneAt : -1;   // seconds since the hull went under

        // Oil leaks out while it settles, spreads widely after, then thins to a stain.
        const leaking = smooth(plan.plunge * 0.5, plan.under, t);
        if (leaking > 0) {
            slick.mesh.visible = true;
        }
        if (!gone) {
            uniforms.uOil.value = 0.6 * leaking;
            uniforms.uSpread.value = 0.12 + 0.25 * leaking;
            uniforms.uChurn.value = 0.9 * smooth(0.25, 1, clamp01((t - plan.plunge) / (plan.under - plan.plunge)));
        } else {
            uniforms.uOil.value = (0.6 + 0.3 * smooth(0, 4, a)) * (1 - smooth(40, 110, a)) + STAIN * smooth(40, 110, a);
            uniforms.uSpread.value = 0.37 + 0.63 * (1 - Math.exp(-a / 22));
            uniforms.uChurn.value = 0.9 * Math.exp(-a / 7);
            uniforms.uRing.value = 0.1 + 0.85 * (1 - Math.exp(-a / 5));
            uniforms.uFoam.value = 0.95 * (1 - smooth(0, 16, a));
        }

        // The slick (and everything floating on it) drifts slowly downwind.
        if (gone && wreck.drift.length() < 6) {
            const dx = WIND.x * 0.1 * dt;
            const dz = WIND.y * 0.1 * dt;
            wreck.drift.x += dx;
            wreck.drift.y += dz;
            slick.mesh.position.x += dx;
            slick.mesh.position.z += dz;
            for (const piece of pieces) {
                if (piece.wreck === wreck && piece.state !== 'flying') {
                    piece.x += dx;
                    piece.z += dz;
                }
            }
        }
        if (!gone) {
            return;
        }

        const centreX = wreck.center.x + wreck.drift.x;
        const centreZ = wreck.center.z + wreck.drift.y;

        // Air still escaping from the wreck: bubbles popping, now and then a boil.
        if (a < 25) {
            wreck.bubbleTimer -= dt;
            while (wreck.bubbleTimer <= 0) {
                wreck.bubbleTimer += 1 / (28 * Math.exp(-a / 7) + 0.5);
                const angle = Math.random() * Math.PI * 2;
                const r = Math.sqrt(Math.random()) * wreck.radius * 0.35;
                at.set(centreX + Math.cos(angle) * r, 0, centreZ + Math.sin(angle) * r);
                at.y = waveHeight(at.x, at.z, time) + 0.2;
                emit(LOOKS.bubble, at, vel.set(0, random(1, 3), 0), random(0.35, 0.7));
            }
            wreck.boilTimer -= dt;
            if (wreck.boilTimer <= 0) {
                wreck.boilTimer = random(0.3, 0.6) * Math.exp(a / 6);
                at.set(centreX + spread(wreck.radius * 0.5), 0, centreZ + spread(wreck.radius * 0.4));
                at.y = waveHeight(at.x, at.z, time) + 0.2;
                for (let i = 0; i < 6; i++) {
                    emit(LOOKS.spray, at, burst(4, random(3, 8)), random(0.5, 0.9), 0.8);
                }
                emit(LOOKS.foam, at, burst(3, 1), random(1.5, 2.5));
            }
        }

        // Burning oil: patches that catch one after the other and die down.
        let burning = 0;
        for (const oil of wreck.oilFires) {
            const age = a - oil.start;
            if (age < 0 || oil.life <= 0) {
                continue;
            }
            if (!oil.lit) {
                oil.lit = true;
                effects.addFire(oil.fire);
            }
            const left = 1 - age / oil.life;
            if (left <= 0) {
                oil.life = 0;
                effects.removeFire(oil.fire);
                continue;
            }
            oil.fire.scale = oil.size * Math.min(1, left * 3);   // shrinks in its last third
            const x = centreX + oil.x;
            const z = centreZ + oil.z;
            oil.fire.position.set(x, waveHeight(x, z, time) + 0.25, z);
            burning += Math.min(1, left * 3);
        }
        uniforms.uBurn.value = Math.min(1, burning / 3);

        // Smoke still drifting away from the site for a while.
        if (a < 60) {
            wreck.smokeTimer -= dt;
            if (wreck.smokeTimer <= 0) {
                wreck.smokeTimer = 0.3 * (1 + a / 12);
                at.set(centreX + spread(wreck.radius * 0.4), 0.8, centreZ + spread(wreck.radius * 0.3));
                emit(LOOKS.pall, at, burst(2, random(2, 4)), random(7, 9), 1 - a / 80);
            }
        }

        if (a > REST_AFTER) {
            wreck.rest = true;   // only the stain and the keepers are left: nothing to animate
            uniforms.uChurn.value = uniforms.uFoam.value = uniforms.uBurn.value = 0;
        }
    }

    // ---- Floating debris ---------------------------------------------------------------

    function updatePieces(dt, time) {
        let changed = false;
        for (let index = 0; index < MAX_DEBRIS; index++) {
            const piece = pieces[index];
            if (piece.state === 'off') {
                continue;
            }
            changed = true;
            const kind = piece.kind;
            const water = waveHeight(piece.x, piece.z, time);
            let tiltX = 0.12 * Math.sin(time * 1.3 + piece.phase);
            let tiltZ = 0.1 * Math.sin(time * 1.1 + piece.phase * 1.7);
            if (piece.state === 'flying') {
                // Thrown by the blast, tumbling, until it hits the water.
                piece.vy -= 30 * dt;
                piece.x += piece.vx * dt;
                piece.y += piece.vy * dt;
                piece.z += piece.vz * dt;
                piece.tumble += dt * 7;
                tiltX = piece.tumble;
                tiltZ = piece.tumble * 0.6;
                if (piece.y < water && piece.vy < 0) {
                    piece.state = 'floating';
                    scheduleSplash(piece.x, piece.z, 0, 0.6);
                }
            } else {
                const wreckAge = piece.wreck.goneAt >= 0 ? piece.wreck.age - piece.wreck.goneAt : 0;
                if (piece.state === 'rising') {
                    piece.depth -= dt * 1.6;
                    if (piece.depth <= 0) {
                        piece.depth = 0;
                        piece.state = 'floating';
                    }
                } else if (piece.state === 'floating' && !piece.keeper && wreckAge > piece.sinkAt) {
                    piece.state = 'sinking';   // waterlogged: it slowly goes down
                } else if (piece.state === 'sinking') {
                    piece.depth += dt * 0.35;
                    if (piece.depth > 2.5) {
                        piece.state = 'off';
                        piece.wreck = null;
                        debrisMesh.setMatrixAt(index, hidden);
                        continue;
                    }
                }
                piece.yaw += piece.spin * dt;
                // Half under water, riding the waves.
                piece.y = water - kind.size[1] * 0.2 - piece.depth;
            }
            piecePosition.set(piece.x, piece.y, piece.z);
            pieceQuaternion.setFromEuler(pieceEuler.set(tiltX, piece.yaw, tiltZ));
            pieceScale.set(kind.size[0], kind.size[1], kind.size[2]);
            debrisMesh.setMatrixAt(index, pieceMatrix.compose(piecePosition, pieceQuaternion, pieceScale));
        }
        if (changed) {
            debrisMesh.instanceMatrix.needsUpdate = true;
        }
    }

    // ---- Cleaning up -------------------------------------------------------------------

    /** Removes everything a ship left behind (the ship itself belongs to fleet.js). */
    function forget(entry) {
        const wreck = wrecks.get(entry);
        if (!wreck) {
            return;
        }
        wrecks.delete(entry);
        for (const deckFire of wreck.fires) {
            effects.removeFire(deckFire.fire);
        }
        for (const oil of wreck.oilFires) {
            effects.removeFire(oil.fire);
        }
        freePieces(wreck);
        for (const splash of splashes) {
            splash.active = false;
        }
        root.remove(wreck.slick.mesh);
        wreck.slick.mesh.material.dispose();
        for (const material of wreck.materials) {
            material.dispose();
        }
        for (const geometry of wreck.geometries) {
            geometry.dispose();
        }
        if (wreck.rig) {
            entry.anchor.remove(wreck.rig);
        }
    }

    /** Forgets every wreck (a rematch, or back to the menu). */
    function clear() {
        for (const entry of [...wrecks.keys()]) {
            forget(entry);
        }
        sea.setGlow(SEA_GLOW_SLOT, glowAt, 0);
    }

    return { start, forget, clear, update };
}
