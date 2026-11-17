// Visual effects for shots: the missiles (see missiles.js), explosions, fire and smoke
// on damaged ships, water splashes and the foam rings spreading on the sea.
//
// The particles themselves live in a pool that is drawn in one draw call
// (see particles.js).
//
// The storm acts on everything here: the wind (weather.js) bends the flames
// and carries the smoke and the embers away, lightning lights the smoke and
// the spray, and fires shine on the water and on the ships around them.
//
// The sinking of a ship (sinking.js) borrows this module's pool, explosions
// and fires (see "loose fires" below), so it adds no draw call and no light.

import * as THREE from 'three';
import { createParticles } from './particles.js';
import { weather, WIND } from './weather.js';
import { waveHeight } from './sea.js';
import { createMissiles } from './missiles.js';

const POOL_SIZE = 3600;      // room for a sinking ship on top of the usual fires
const FIRE_LIGHTS = 2;      // real lights, on the fires closest to the camera
const SEA_GLOWS = 3;        // fires reflected in the water (slot 0 is for explosions)
// With "reduce motion", explosions light the scene much less.
const FLASH_SCALE = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.35 : 1;

/**
 * @param sound the sound module
 * @param sea used to make explosions and fires shine on the water
 */
export function createEffects(scene, sound, sea) {
    const root = new THREE.Group();
    scene.add(root);

    // ---- Particle pool ------------------------------------------------------
    const particles = createParticles(POOL_SIZE);
    root.add(particles.points);
    const spawn = particles.spawn;

    // A reusable vector for particle velocities (spawn copies the numbers).
    const scratch = new THREE.Vector3();
    const burst = (spread, up) => scratch.set((Math.random() - 0.5) * spread, up, (Math.random() - 0.5) * spread);
    /** Like burst, but already leaning with the wind (flames, smoke). */
    const windBlown = (spread, up, lean) => {
        const speed = (9 + 16 * weather.gust) * lean;
        return scratch.set((Math.random() - 0.5) * spread + WIND.x * speed, up, (Math.random() - 0.5) * spread + WIND.y * speed);
    };

    let listener = null;   // the camera: sounds are quieter far away
    const distanceTo = position => (listener ? listener.position.distanceTo(position) : 0);

    // One light for the brightest thing happening: a launch, a missile's motor or an explosion.
    const flash = new THREE.PointLight(0xffa64d, 0, 160, 1.5);
    root.add(flash);
    let seaFlash = 0;   // the same flash, reflected in the water

    /** Lights the flash at a position, unless something brighter already holds it. */
    function glow(position, intensity) {
        const level = intensity * FLASH_SCALE;
        if (level >= flash.intensity) {
            flash.position.copy(position).y += 2;
            flash.intensity = level;
        }
    }

    // ---- Missiles -------------------------------------------------------------
    // The shots of the game are guided missiles (missiles.js). They use this
    // module's particle pool and flash light, so they add no draw call for
    // their flames and smoke, and no light.
    const missiles = createMissiles(root, { spawn, glow, sound, distanceTo });

    /**
     * Fires a missile at a target. onImpact is called when it lands: the game
     * result is only shown at that moment (see main.js).
     * @param options see missiles.launch (style, kind, duration, onCancel)
     * @returns the flight time in seconds
     */
    function fireMissile(from, to, onImpact, options) {
        const seconds = missiles.launch(from, to, onImpact, options);
        sea.setGlow(0, from, 1.2 * FLASH_SCALE);   // the launch lights the water around the ship
        seaFlash = Math.max(seaFlash, 1.2 * FLASH_SCALE);
        return seconds;
    }

    // ---- Impacts ------------------------------------------------------------

    /**
     * A fireball with sparks and smoke.
     * @param size 1 = a shell hit; smaller for the little blasts on a sinking
     *        ship, bigger for the killing blow
     * @param options light: false = no flash of light (for blasts that follow
     *        each other quickly, so the scene never strobes); silent: true = no sound
     */
    function explosion(position, size = 1, { light = true, silent = false } = {}) {
        const count = n => Math.max(2, Math.round(n * Math.min(size, 1.6)));
        for (let i = 0, n = count(22); i < n; i++) {   // fireball
            spawn({ position, velocity: burst(18 * size, (4 + Math.random() * 12) * size), life: 0.55 + Math.random() * 0.4,
                size: [4 * size, 14 * size], color: i % 3 === 0 ? 0xfff0b0 : 0xff7a1f, colorEnd: 0xb3300a, additive: true, drag: 2.5 });
        }
        for (let i = 0, n = count(26); i < n; i++) {   // sparks and burning debris, carried by the wind
            spawn({ position, velocity: burst(46 * size, (12 + Math.random() * 26) * Math.sqrt(size)), life: 1 + Math.random() * 0.9,
                size: [1.1, 0.3], color: 0xffc35a, colorEnd: 0xff5a1a, additive: true, gravity: 1, wind: 0.25 });
        }
        for (let i = 0, n = count(16); i < n; i++) {   // smoke: lit orange from inside at first, then black
            spawn({ position, velocity: burst(9 * size, (5 + Math.random() * 8) * size), life: 3 + Math.random() * 1.5,
                size: [5 * size, 22 * size], color: 0x8a4a1c, colorEnd: 0x141517, opacity: 0.75, smoke: true, drag: 0.6, wind: 0.6 });
        }
        if (light) {
            flash.position.copy(position).y += 4;
            flash.intensity = Math.max(flash.intensity, 1400 * Math.min(size, 1.5) * FLASH_SCALE);
            sea.setGlow(0, position, 3.5 * FLASH_SCALE);
            seaFlash = Math.max(seaFlash, 3.5 * Math.min(size, 1.3) * FLASH_SCALE);
        }
        if (!silent) {
            sound.explosion(distanceTo(position));
        }
    }

    // Foam rings spreading on the water after a miss.
    const ringGeometry = new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2);
    const rings = [];

    function splash(position) {
        for (let i = 0; i < 46; i++) {   // a heavy column of water
            spawn({ position, velocity: burst(8, 16 + Math.random() * 26), life: 1.2 + Math.random() * 0.8,
                size: [1.8, 4.2], color: 0xaebbc4, opacity: 0.8, gravity: 1, wind: 0.15 });
        }
        for (let i = 0; i < 12; i++) {   // spray torn off by the wind
            spawn({ position, velocity: burst(12, 6 + Math.random() * 8), life: 1.8 + Math.random(), size: [4, 15],
                color: 0x9aa7b0, opacity: 0.4, smoke: true, drag: 1.2, wind: 0.7 });
        }
        for (let i = 0; i < 3; i++) {
            const ringMaterial = new THREE.MeshBasicMaterial({
                color: 0x9fadb6, transparent: true, opacity: 0, depthWrite: false
            });
            const mesh = new THREE.Mesh(ringGeometry, ringMaterial);
            mesh.position.copy(position);
            mesh.visible = false;
            root.add(mesh);
            rings.push({ mesh, delay: i * 0.45, time: 0 });
        }
        sound.splash(distanceTo(position));
    }

    function updateRings(dt, time) {
        for (let i = rings.length - 1; i >= 0; i--) {
            const ring = rings[i];
            ring.time += dt;
            const t = (ring.time - ring.delay) / 2.4;
            if (t < 0) {
                continue;
            }
            if (t >= 1) {
                root.remove(ring.mesh);
                ring.mesh.material.dispose();
                rings.splice(i, 1);
                continue;
            }
            ring.mesh.visible = true;
            ring.mesh.scale.setScalar(1.5 + t * 7);
            // Float on the crest of the local waves, so the ring is not cut by them.
            ring.mesh.position.y = waveHeight(ring.mesh.position.x, ring.mesh.position.z, time) + 0.9;
            ring.mesh.material.opacity = 0.4 * (1 - t);
        }
    }

    // ---- Lasting fire and smoke on damaged cells ---------------------------
    const fires = new Map();   // key -> { position, base, flameTimer, smokeTimer, flicker }
    // "Loose" fires belong to someone else (the decks and the burning oil of a
    // sinking ship, see sinking.js): the owner moves them and removes them,
    // this module burns them and lets them compete for the lights.
    const looseFires = new Set();
    let nearest = [];          // the fires closest to the camera, refreshed now and then
    let nearestTimer = 0;

    const fireLights = [];
    for (let i = 0; i < FIRE_LIGHTS; i++) {
        const light = new THREE.PointLight(0xff7a2a, 0, 70, 1.6);
        root.add(light);
        fireLights.push(light);
    }

    /** Makes the fires in the scene match the given list ({ key, position }). */
    function syncFires(wanted) {
        const keys = new Set(wanted.map(fire => fire.key));
        for (const key of [...fires.keys()]) {
            if (!keys.has(key)) {
                fires.delete(key);
            }
        }
        for (const fire of wanted) {
            if (!fires.has(fire.key)) {
                fires.set(fire.key, {
                    position: fire.position.clone(), base: fire.position.y,
                    flameTimer: 0, smokeTimer: Math.random() * 0.2, phase: Math.random() * 10
                });
            }
        }
        nearestTimer = 0;   // choose again which fires get a light
    }

    /**
     * One frame of a fire: flames, embers and smoke at fire.position.
     * fire.scale (optional, default 1) makes the flames and the smoke bigger or smaller.
     */
    function burn(fire, dt) {
        const scale = fire.scale ?? 1;
        fire.flameTimer -= dt;
        fire.smokeTimer -= dt;
        if (fire.flameTimer <= 0) {
            fire.flameTimer = 0.07;
            // Flames lean with the wind and are torn off in gusts.
            spawn({ position: fire.position, velocity: windBlown(2 * scale, (4 + Math.random() * 3) * scale, 0.3), life: 0.5 + Math.random() * 0.2,
                size: [3.6 * scale, 0.8 * scale], color: Math.random() < 0.3 ? 0xffe08a : 0xff6a1a, colorEnd: 0xc22e08, additive: true });
            if (Math.random() < 0.18) {   // an ember
                spawn({ position: fire.position, velocity: windBlown(5, 6 + Math.random() * 6, 0.4), life: 1.4 + Math.random(),
                    size: [0.7, 0.2], color: 0xffb04a, colorEnd: 0xff4a12, additive: true, gravity: 0.25, wind: 0.5 });
            }
        }
        if (fire.smokeTimer <= 0) {
            fire.smokeTimer = 0.17;
            // Thick smoke: glowing orange just above the fire, then black, blown downwind.
            spawn({ position: fire.position, velocity: windBlown(1.5, (5 + Math.random() * 2) * Math.sqrt(scale), 0.15), life: 4.2 + Math.random(),
                size: [3 * scale, 17 * scale], color: 0x7a3d16, colorEnd: 0x121315, opacity: 0.6, smoke: true, drag: 0.1, wind: 0.55 });
        }
    }

    function updateFires(dt, time) {
        for (const fire of fires.values()) {
            // The burning deck goes up and down with the ship.
            fire.position.y = fire.base + waveHeight(fire.position.x, fire.position.z, time) * 0.7;
            burn(fire, dt);
        }
        for (const fire of looseFires) {
            burn(fire, dt);
        }

        // The closest fires get the real lights and the reflections on the sea.
        nearestTimer -= dt;
        if (nearestTimer <= 0 && listener) {
            nearestTimer = 1;
            nearest = [...fires.values(), ...looseFires]
                .sort((a, b) => listener.position.distanceToSquared(a.position) - listener.position.distanceToSquared(b.position))
                .slice(0, SEA_GLOWS);
        }
        for (let i = 0; i < SEA_GLOWS; i++) {
            const fire = nearest[i];
            // Two sines of different speeds: an irregular flicker, with no random jumps.
            const flicker = fire ? 0.75 + 0.18 * Math.sin(time * 11 + fire.phase) + 0.12 * Math.sin(time * 23.7 + fire.phase * 2) : 0;
            if (fire) {
                sea.setGlow(i + 1, fire.position, 0.9 * flicker);
            } else {
                sea.setGlow(i + 1, scratch.set(0, 0, 0), 0);
            }
            if (i < FIRE_LIGHTS) {
                fireLights[i].intensity = 260 * flicker;
                if (fire) {
                    fireLights[i].position.copy(fire.position).y += 3;
                }
            }
        }
    }

    /**
     * Hands a fire to this module (see looseFires).
     * @param fire { position, scale? } (the timers are added here)
     */
    function addFire(fire) {
        fire.flameTimer = 0;
        fire.smokeTimer = Math.random() * 0.2;
        fire.phase = Math.random() * 10;
        looseFires.add(fire);
        nearestTimer = 0;
    }

    function removeFire(fire) {
        if (looseFires.delete(fire)) {
            nearestTimer = 0;   // its light goes to another fire at once
        }
    }

    function clear() {
        fires.clear();
        looseFires.clear();
        nearest = [];
        nearestTimer = 0;
        particles.clear();
        missiles.clear();
        for (const ring of rings) {
            root.remove(ring.mesh);
            ring.mesh.material.dispose();
        }
        rings.length = 0;
        flash.intensity = 0;
        seaFlash = 0;
    }

    /** @param camera where the player is: for sound distance and to choose the lit fires */
    function update(dt, time, camera) {
        listener = camera;
        missiles.update(dt, time);
        updateFires(dt, time);
        updateRings(dt, time);
        particles.update(dt);
        // The flash of a gun or an explosion dies in a fraction of a second.
        flash.intensity = Math.max(0, flash.intensity - 3200 * dt);
        seaFlash = Math.max(0, seaFlash - 7 * dt);
        sea.setGlow(0, flash.position, seaFlash);
    }

    /** The particles need the height of the canvas (in real pixels) to keep their size. */
    function resize(pixelHeight) {
        particles.resize(pixelHeight);
    }

    return {
        fireMissile, explosion, splash, syncFires, clear, update, resize,
        // Used by the sinking (sinking.js):
        spawn, addFire, removeFire, distanceTo
    };
}
