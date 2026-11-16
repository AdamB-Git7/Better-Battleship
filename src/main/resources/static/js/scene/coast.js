// The coast on the horizon, north of the battle.
//
// - Land: three ranges of hills one behind the other (each one taller and
//   paler in the haze than the one in front), an island, a headland and a few
//   rocks. They are flat dark walls with a jagged top: far away, at night,
//   land is only a silhouette, and lightning shows it for an instant.
// - A burning harbour town: a low skyline of sheds, cranes and chimneys,
//   scattered window lights, three big fires with smoke columns rising into
//   the clouds and an orange glow on the clouds above.
// - A lighthouse on the headland: two beams turning slowly, and its lamp
//   brightens each time a beam swings towards the camera.
// - Coastal batteries: now and then a gun on the shore fires out to sea at
//   the far squadrons (flash, tracers, a water column or a hit), and the sky
//   behind the hills glows with artillery further inland.
// - Two searchlights of the harbour sweep the clouds.
//
// Readability: everything here is at least 900 units from the play zones;
// the coastal guns only ever aim at the ships of the far squadrons.
// Anti-cheat: it knows nothing about the game.
// Photosensitivity: the inland glows rise and fall smoothly, seconds apart;
// the gun flashes go through the flash limiter of battleFx.js.
//
// Cost: 7 draw calls (land, skyline, town lights, lighthouse, 4 beams... the
// glows and smoke pillars are shared with the rest, see billboards.js).

import * as THREE from 'three';
import { reducedMotion } from './battleFx.js';
import { beamMaterial, createBeam } from './beams.js';
import { weather } from './weather.js';

const DEG = Math.PI / 180;
const CENTRE_Z = -100;         // the coast curves around this point (a little north of the play area)
const HAZE = 0.5;              // the land feels only half of the distance haze (else it would vanish)

/** A point on the sea given as a compass bearing (0 = north, positive = east) and a distance. */
function polar(bearing, distance, target = new THREE.Vector3()) {
    return target.set(Math.sin(bearing * DEG) * distance, 0, CENTRE_Z - Math.cos(bearing * DEG) * distance);
}

// Every piece of land: an arc at `distance`, between two bearings, `height`
// tall at most. `island` pieces fall to the sea at both ends.
const LAND = [
    { from: -100, to: 64, distance: 1560, height: 340, segments: 150, seed: 1 },     // the far mountains
    { from: -92, to: 56, distance: 1340, height: 215, segments: 150, seed: 2 },      // the hills
    { from: -84, to: 46, distance: 1160, height: 120, segments: 170, seed: 3 },      // the shore cliffs
    { from: -57, to: -44, distance: 930, height: 62, segments: 40, seed: 4, island: true },    // the lighthouse headland
    { from: 44, to: 63, distance: 930, height: 105, segments: 50, seed: 5, island: true },     // the island to the north-east
    { from: -99, to: -93, distance: 800, height: 46, segments: 20, seed: 6, island: true },    // rocks to the west
    { from: -88, to: -85.5, distance: 720, height: 30, segments: 12, seed: 7, island: true },
    { from: 86, to: 90, distance: 840, height: 52, segments: 16, seed: 8, island: true }       // a rock to the east
];

// The harbour town lies on the shore cliffs, a little west of straight ahead.
const TOWN = { from: -21, to: -5, distance: 1128 };
const FIRES = [-17.5, -12.5, -8];               // bearings of the three big fires
const BATTERIES = [-40, -29, 9, 31];            // bearings of the coastal guns
const LIGHTHOUSE = { bearing: -45.5, distance: 918, foot: 30, height: 64 };
const LAMP_TURN = 0.42;                         // radians per second: a beam passes every 7.5 s
const MAX_SHELLS = 6;

const landVertex = /* glsl */`
    varying float vHeight;
    varying float vDepth;
    void main() {
        vHeight = position.y;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
    }
`;
const landFragment = /* glsl */`
    uniform vec3 uColor;
    uniform float uFlash;
    uniform float uHaze;
    uniform vec3 fogColor;
    uniform float fogDensity;
    varying float vHeight;
    varying float vDepth;
    void main() {
        // Lightning lights the high ground a little; the land stays a silhouette.
        vec3 color = uColor + vec3(0.3, 0.36, 0.5) * uFlash * (0.03 + 0.1 * smoothstep(0.0, 250.0, vHeight));
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        float depth = vDepth * uHaze;
        float haze = 1.0 - exp(-fogDensity * fogDensity * depth * depth);
        // Spray and mist lie on the water at the foot of the cliffs.
        haze += (1.0 - haze) * 0.45 * (1.0 - smoothstep(0.0, 34.0, vHeight));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, haze);
    }
`;

/** Random numbers that are the same at every start (so the coast always has the same shape). */
function seededRandom(seed) {
    let state = seed * 7919 + 17;
    return () => {
        state = (state * 16807) % 2147483647;
        return state / 2147483647;
    };
}

/** The jagged top of a piece of land: a function from 0..1 (along it) to 0..1 (height). */
function ridgeProfile(piece) {
    const random = seededRandom(piece.seed);
    const waves = [];
    for (let i = 0; i < 6; i++) {
        waves.push({ frequency: (2 + i * 3.1 + random() * 2) * (piece.island ? 0.6 : 1.6), phase: random() * 6.28, weight: 1 / (1 + i * 0.8) });
    }
    const total = waves.reduce((sum, wave) => sum + wave.weight, 0);
    return u => {
        let value = 0;
        for (const wave of waves) {
            // 1 - |sin| has sharp peaks and round valleys, like a mountain ridge.
            value += wave.weight * (1 - Math.abs(Math.sin(u * wave.frequency + wave.phase)));
        }
        value /= total;
        const ends = piece.island
            ? Math.pow(Math.sin(Math.PI * u), 0.55)
            : THREE.MathUtils.smoothstep(u, 0, 0.06) * THREE.MathUtils.smoothstep(1 - u, 0, 0.06);
        return (0.3 + 0.7 * value) * ends;
    };
}

/**
 * Adds one wall to the lists of corners: it follows an arc and its top
 * follows heightAt(u) (in world units).
 */
function addWall(positions, from, to, distance, segments, heightAt) {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < segments; i++) {
        const u0 = i / segments;
        const u1 = (i + 1) / segments;
        polar(from + (to - from) * u0, distance, a);
        polar(from + (to - from) * u1, distance, b);
        const h0 = heightAt(u0);
        const h1 = heightAt(u1);
        // Two triangles: foot a, foot b, top b / foot a, top b, top a. The foot is under the water.
        positions.push(a.x, -3, a.z, b.x, -3, b.z, b.x, h1, b.z, a.x, -3, a.z, b.x, h1, b.z, a.x, h0, a.z);
    }
}

function wallMesh(positions, color) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.ShaderMaterial({
        vertexShader: landVertex,
        fragmentShader: landFragment,
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            uColor: { value: new THREE.Color(color) },
            uFlash: { value: 0 },
            uHaze: { value: HAZE }
        },
        fog: true,
        side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    return mesh;
}

/**
 * @param fx the background effects (battleFx.js)
 * @param fleet the background ships (backgroundFleet.js): what the coastal guns shoot at
 * @param billboards the shared glows and smoke pillars (billboards.js)
 */
export function createCoast(scene, fx, fleet, billboards) {
    const root = new THREE.Group();
    scene.add(root);
    const point = new THREE.Vector3();

    // ---- Land ----------------------------------------------------------------
    const landPositions = [];
    const profiles = LAND.map(piece => ridgeProfile(piece));
    LAND.forEach((piece, index) => {
        addWall(landPositions, piece.from, piece.to, piece.distance, piece.segments, u => profiles[index](u) * piece.height);
    });
    const land = wallMesh(landPositions, 0x05070a);
    root.add(land);

    /** Height of the shore cliffs at a bearing (to stand guns and fires on them). */
    const shore = LAND[2];
    const shoreHeight = bearing => profiles[2]((bearing - shore.from) / (shore.to - shore.from)) * shore.height;

    // ---- The harbour town ------------------------------------------------------
    // A skyline of blocks in front of the cliffs: sheds, houses, a few chimneys and cranes.
    const random = seededRandom(42);
    const blocks = [];            // { from, to, height } along the town, in 0..1
    for (let u = 0; u < 1;) {
        const width = 0.008 + random() * 0.022;
        const kind = random();
        const height = kind < 0.08 ? 46 + random() * 22          // a chimney or a crane: thin and tall
            : kind < 0.3 ? 5 + random() * 6                      // a gap, a quay
                : 14 + random() * 20;                            // sheds and houses
        const size = kind < 0.08 ? 0.0035 : width;
        blocks.push({ from: u, to: u + size, height });
        u += size;
    }
    const skylinePositions = [];
    for (const block of blocks) {
        const fade = Math.min(1, Math.min(block.from, 1 - block.to) * 12 + 0.25);   // lower at both ends of the town
        addWall(skylinePositions, TOWN.from + (TOWN.to - TOWN.from) * block.from, TOWN.from + (TOWN.to - TOWN.from) * block.to,
            TOWN.distance, 1, () => block.height * fade);
    }
    const skyline = wallMesh(skylinePositions, 0x020304);
    root.add(skyline);

    // Window lights: small warm dots on the skyline and a few on the hills around.
    const lightPositions = [];
    for (let i = 0; i < 150; i++) {
        const inTown = i < 110;
        const bearing = inTown ? TOWN.from + (TOWN.to - TOWN.from) * random() : -70 + random() * 105;
        polar(bearing, inTown ? TOWN.distance - 4 : shore.distance - 6, point);
        lightPositions.push(point.x, inTown ? 3 + random() * 24 : 8 + random() * Math.max(4, shoreHeight(bearing) * 0.5), point.z);
    }
    const lightsGeometry = new THREE.BufferGeometry();
    lightsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lightPositions, 3));
    const lights = new THREE.Points(lightsGeometry, new THREE.PointsMaterial({
        color: 0xffb870, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.75,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false
    }));
    lights.frustumCulled = false;
    root.add(lights);

    // The three big fires: flames behind the skyline, a wide glow, a column of smoke.
    for (const bearing of FIRES) {
        polar(bearing, TOWN.distance + 14, point);          // between the skyline and the cliffs
        billboards.addGlow(point.x, 26, point.z, 150, 0xff8a30, 1.5, 1);
        billboards.addGlow(point.x, 60, point.z, 520, 0xff5a1c, 0.34, 0.7);
        billboards.addPillar(point.x, 12, point.z, 52 + random() * 24, 430 + random() * 140, 0.95);
    }
    // The whole town lights the underside of the clouds (the glow is behind the hills, which show against it).
    polar((TOWN.from + TOWN.to) / 2, 1450, point);
    billboards.addGlow(point.x, 300, point.z, 1500, 0xff5a22, 0.13, 0.5);

    // ---- The lighthouse ------------------------------------------------------------
    polar(LIGHTHOUSE.bearing, LIGHTHOUSE.distance, point);
    const lampAt = new THREE.Vector3(point.x, LIGHTHOUSE.foot + LIGHTHOUSE.height, point.z);
    const towerMaterial = new THREE.MeshBasicMaterial({ color: 0x59616a, fog: true });
    // Like the land, the tower feels only half of the haze.
    towerMaterial.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>\n\tvFogDepth *= ${HAZE.toFixed(2)};`);
    };
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 5.6, LIGHTHOUSE.height, 10), towerMaterial);
    tower.position.set(point.x, LIGHTHOUSE.foot + LIGHTHOUSE.height / 2 - 4, point.z);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1, 4.6, 7, 10), new THREE.MeshBasicMaterial({ color: 0x0c0e11 }));
    cap.position.set(point.x, lampAt.y + 5, point.z);
    root.add(tower, cap);

    const lampMaterial = beamMaterial(reducedMotion ? 0.16 : 0.3, 0xfff0c8, HAZE);
    const lampBeams = [0, Math.PI].map(offset => {
        const beam = createBeam(lampMaterial, 560, 17);
        beam.mesh.position.copy(lampAt);
        root.add(beam.mesh);
        return { beam, offset };
    });
    const lampGlow = billboards.addGlow(lampAt.x, lampAt.y, lampAt.z, 95, 0xfff0c8, 0.3, 0);
    const direction = new THREE.Vector3();

    function updateLighthouse(time, camera) {
        const toEyeX = camera.position.x - lampAt.x;
        const toEyeZ = camera.position.z - lampAt.z;
        const toEye = Math.atan2(toEyeZ, toEyeX);
        let brightest = 0;
        for (const { beam, offset } of lampBeams) {
            const angle = time * LAMP_TURN + offset;
            beam.point(direction.set(Math.cos(angle), -0.02, Math.sin(angle)).normalize());
            // How close this beam points to the camera: 1 = straight at it.
            brightest = Math.max(brightest, Math.cos(angle - toEye));
        }
        // The lamp swells smoothly as a beam swings past (about a second), then dims again.
        const pass = Math.pow(Math.max(0, brightest), reducedMotion ? 12 : 40);
        billboards.setGlow(lampGlow, 0.35 + (reducedMotion ? 0.9 : 2.4) * pass);
    }

    // ---- Harbour searchlights ---------------------------------------------------------
    const searchMaterial = beamMaterial(0.2, 0xcfe0ff, HAZE);
    const searchlights = [-19.5, -6.5].map((bearing, index) => {
        const beam = createBeam(searchMaterial, 640, 30);
        polar(bearing, TOWN.distance, beam.mesh.position);
        beam.mesh.position.y = 30;
        root.add(beam.mesh);
        // "home" points from the town out to sea; the beam swings around it, high up.
        return { beam, home: Math.atan2(-beam.mesh.position.z + CENTRE_Z, -beam.mesh.position.x), phase: index * 2.7 };
    });

    function updateSearchlights(time) {
        for (const light of searchlights) {
            const around = light.home + 0.9 * Math.sin(time * 0.16 + light.phase);
            const up = 0.75 + 0.3 * Math.sin(time * 0.11 + light.phase * 2);
            light.beam.point(direction.set(Math.cos(around) * Math.cos(up), Math.sin(up), Math.sin(around) * Math.cos(up)));
        }
    }

    // ---- Coastal batteries -----------------------------------------------------------
    const batteries = BATTERIES.map(bearing => {
        const at = polar(bearing, shore.distance - 12, new THREE.Vector3());
        at.y = Math.max(16, shoreHeight(bearing) * 0.55);
        return at;
    });
    const shells = [];
    for (let i = 0; i < MAX_SHELLS; i++) {
        shells.push({ active: false, time: 0, duration: 1, from: null, height: 0, target: null });
    }
    let batteryTimer = 6;

    function fireBattery() {
        const from = batteries[Math.floor(Math.random() * batteries.length)];
        fx.muzzle(from.x, from.y, from.z);
        // The far squadrons are the only thing in range (and the only thing they ever shoot at).
        const target = fleet.nearestFarShip(from.x, from.z);
        const range = fleet.nearestDistance();
        if (!target || range > 950) {
            return;
        }
        let count = 2;
        for (const shell of shells) {
            if (count > 0 && !shell.active) {
                shell.active = true;
                shell.time = -0.3 * count;
                shell.duration = THREE.MathUtils.clamp(range / 170, 2.4, 5);
                shell.from = from;
                shell.height = range * (0.16 + Math.random() * 0.05);
                shell.target = target;
                count--;
            }
        }
    }

    function updateShells(dt) {
        for (const shell of shells) {
            if (!shell.active) {
                continue;
            }
            shell.time += dt;
            if (shell.time < 0) {
                continue;
            }
            const p = Math.min(1, shell.time / shell.duration);
            const { from, target } = shell;
            fx.tracer(
                from.x + (target.x - from.x) * p,
                from.y + (3 - from.y) * p + 4 * shell.height * p * (1 - p),   // a parabola
                from.z + (target.z - from.z) * p, 2.6);
            if (p >= 1) {
                shell.active = false;
                fleet.strike(target, 0.1);
            }
        }
    }

    // ---- Artillery inland: the sky behind the hills glows, slowly -----------------------
    const inland = [0, 1].map(() => ({ glow: billboards.addGlow(0, 0, 0, 620, 0xffa55a, 0, 0), age: 99, peak: 0 }));
    let inlandTimer = 3;
    const RISE = reducedMotion ? 0.9 : 0.3;      // seconds to full brightness
    const FALL = reducedMotion ? 0.8 : 2.2;      // how fast it dies away (higher = faster)

    function updateInland(dt) {
        inlandTimer -= dt;
        if (inlandTimer <= 0) {
            inlandTimer = (reducedMotion ? 9 : 3.2) + Math.random() * 5;
            const flash = inland.find(candidate => candidate.age > 4);
            if (flash) {
                // Between the hills and the far mountains: both ranges in front show against it.
                polar(-85 + Math.random() * 135, 1450, point);
                billboards.moveGlow(flash.glow, point.x, 90 + Math.random() * 60, point.z);
                flash.age = 0;
                flash.peak = (reducedMotion ? 0.3 : 0.6) * (0.6 + Math.random() * 0.4);
            }
        }
        for (const flash of inland) {
            if (flash.age > 4) {
                continue;
            }
            flash.age += dt;
            const level = flash.age < RISE ? flash.age / RISE : Math.exp(-(flash.age - RISE) * FALL);
            billboards.setGlow(flash.glow, flash.age > 4 ? 0 : flash.peak * level);
        }
    }

    return {
        update(dt, time, camera) {
            land.material.uniforms.uFlash.value = weather.flash;
            skyline.material.uniforms.uFlash.value = weather.flash * 0.3;
            updateLighthouse(time, camera);
            updateSearchlights(time);
            batteryTimer -= dt;
            if (batteryTimer <= 0) {
                batteryTimer = (reducedMotion ? 16 : 6) + Math.random() * 9;
                fireBattery();
            }
            updateShells(dt);
            updateInland(dt);
        }
    };
}
