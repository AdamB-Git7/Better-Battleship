// Effects of the battle in the background: gun flashes, tracers, water
// columns, explosions, burning ships, flak and flares, all far away.
//
// They use their own particle pool (one more draw call), so however busy the
// background gets it can never take a particle away from the player's own
// shots, and the player's effects (effects.js) stay exactly as they were.
//
// Three rules are enforced HERE, in one place, for everything in the background:
//  - Keep-out: nothing is ever drawn on the water in or around the two play
//    zones (see nearPlayArea). A caller that asks for it is simply ignored.
//  - Photosensitivity: the big glows that light the haze are modest, fade in
//    and out instead of popping, and are at least GLOW_GAP seconds apart.
//    With "reduce motion" they are dimmer, slower and rarer still.
//  - Quiet: every sound goes through the background volume of sound.js.

import * as THREE from 'three';
import { ZONES, ZONE_SPAN } from '../config.js';
import { createParticles } from './particles.js';
import { weather, WIND } from './weather.js';

const POOL_SIZE = 3000;
const SEA_FLASH_SLOT = 4;    // sea glow slots 4 and 5 belong to the background (see sea.js)
const SEA_STEADY_SLOT = 5;

export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const GLOW_GAP = reducedMotion ? 1.6 : 0.55;      // seconds between two big glows
const GLOW_STRENGTH = reducedMotion ? 0.4 : 1;

// The box around both play zones (they are centred on the origin) where the
// background battle may not put anything on the water: the zones themselves
// plus a wide margin on every side.
const KEEP_OUT_X = ZONE_SPAN / 2 + 80;                           // 130
const KEEP_OUT_Z = Math.abs(ZONES.enemy.center.z) + ZONE_SPAN / 2 + 88;   // 200

/** True if (x, z) is in or around the play zones, where the background must stay away. */
export function nearPlayArea(x, z, margin = 0) {
    return Math.abs(x) < KEEP_OUT_X + margin && Math.abs(z) < KEEP_OUT_Z + margin;
}

/** A fire that keeps burning: just three timers, advanced by fx.burn(). */
export function createFire() {
    return { flame: 0, smoke: Math.random() * 0.2, glow: Math.random() * 0.4 };
}

/**
 * @param sound the sound module
 * @param sea used to make the flashes shine on the water
 */
export function createBattleFx(scene, sound, sea) {
    const particles = createParticles(POOL_SIZE);
    scene.add(particles.points);
    const spawn = particles.spawn;

    // Reusable vectors: spawn() copies the numbers, so nothing is created per frame.
    const at = new THREE.Vector3();
    const speed = new THREE.Vector3();
    const zero = new THREE.Vector3();
    const seaFlashAt = new THREE.Vector3();
    const steadyAt = new THREE.Vector3();
    let seaFlash = 0;
    let steady = 0;
    let clock = 0;
    let lastGlow = -10;
    let listener = null;   // the camera: sounds are quieter and later far away

    const spread = amount => (Math.random() - 0.5) * amount;
    const burst = (wide, up) => speed.set(spread(wide), up, spread(wide));
    /** Like burst, but already leaning with the wind (flames, smoke). */
    const windBlown = (wide, up, lean) => {
        const push = (9 + 16 * weather.gust) * lean;
        return speed.set(spread(wide) + WIND.x * push, up, spread(wide) + WIND.y * push);
    };

    function distanceTo(x, y, z) {
        return listener ? listener.position.distanceTo(at.set(x, y, z)) : 600;
    }

    /**
     * A big soft glow that lights the haze and the clouds for a moment, and
     * shines on the water. Returns false (and does nothing) when the last one
     * was too recent: this is what prevents any strobing.
     */
    function glow(x, y, z, size, strength) {
        if (clock - lastGlow < GLOW_GAP) {
            return false;
        }
        lastGlow = clock;
        const life = reducedMotion ? 1.3 : 0.6;
        const fadeIn = reducedMotion ? 2 : 5;
        const level = strength * GLOW_STRENGTH;
        // Low: the light on the smoke and the spray around the ship...
        spawn({ position: at.set(x, y + 10, z), velocity: zero, life, fadeIn,
            size: [size * 0.6, size], color: 0xff9a52, opacity: 0.16 * level, additive: true });
        // ...and high: the underside of the clouds.
        spawn({ position: at.set(x, y + 70, z), velocity: zero, life: life * 1.3, fadeIn,
            size: [size * 1.6, size * 2.4], color: 0xff8a4a, opacity: 0.05 * level, additive: true });
        seaFlashAt.set(x, y + 6, z);
        seaFlash = Math.max(seaFlash, 5 * level);
        return true;
    }

    /** A ship fires its guns: a flash at the muzzles, a cloud of smoke, a distant boom. */
    function muzzle(x, y, z) {
        for (let i = 0; i < 3; i++) {
            spawn({ position: at.set(x + spread(5), y, z + spread(5)), velocity: burst(8, 2 + Math.random() * 4),
                life: reducedMotion ? 0.6 : 0.32, fadeIn: reducedMotion ? 3 : 8,
                size: [8, 18], color: 0xffd9a0, opacity: 0.85 * GLOW_STRENGTH, additive: true });
            spawn({ position: at, velocity: windBlown(5, 2 + Math.random() * 3, 0.1), life: 4 + Math.random() * 2,
                size: [7, 28], color: 0x8d8a86, colorEnd: 0x3d4043, opacity: 0.4, smoke: true, drag: 0.8, wind: 0.5 });
        }
        glow(x, y, z, 150, 0.8);
        sound.distantGuns(distanceTo(x, y, z));
    }

    /**
     * A shell in flight: call every frame with its position. The glowing dots
     * left behind fade quickly, which draws a short streak (a tracer).
     */
    function tracer(x, y, z) {
        spawn({ position: at.set(x, y, z), velocity: zero, life: 0.16,
            size: [3.2, 1.2], color: 0xffc27a, opacity: 0.8, additive: true });
    }

    /** One anti-aircraft tracer round, flying on its own (vx, vy, vz in units per second). */
    function aaRound(x, y, z, vx, vy, vz, life) {
        spawn({ position: at.set(x, y, z), velocity: speed.set(vx, vy, vz), life, gravity: 0.25,
            size: [2.4, 1.4], color: 0xffb060, colorEnd: 0xff5a30, opacity: 0.8, additive: true });
    }

    /** A shell or a bomb that misses: a tall column of water, torn by the wind. */
    function splash(x, z, size = 1) {
        if (nearPlayArea(x, z)) {
            return;
        }
        for (let i = 0; i < 14; i++) {
            spawn({ position: at.set(x + spread(4), 0.5, z + spread(4)), velocity: burst(7, 20 + Math.random() * 30 * size),
                life: 1.7 + Math.random() * 0.9, size: [4 * size, 9 * size], color: 0xaebbc4, opacity: 0.8, gravity: 1, wind: 0.15 });
        }
        for (let i = 0; i < 5; i++) {
            spawn({ position: at.set(x, 3, z), velocity: burst(10, 7 + Math.random() * 9), life: 2.6 + Math.random(),
                size: [8 * size, 30 * size], color: 0x9aa7b0, opacity: 0.4, smoke: true, drag: 1.1, wind: 0.7 });
        }
    }

    /** A hit: a fireball, burning debris, black smoke, a glow in the haze and a distant boom. */
    function blast(x, y, z, size = 1) {
        if (nearPlayArea(x, z)) {
            return;
        }
        for (let i = 0; i < 9; i++) {
            spawn({ position: at.set(x + spread(6), y, z + spread(6)), velocity: burst(20, 5 + Math.random() * 14),
                life: (reducedMotion ? 1.2 : 0.7) + Math.random() * 0.4, fadeIn: reducedMotion ? 3 : 8,
                size: [8 * size, 26 * size], color: i % 3 === 0 ? 0xfff0b0 : 0xff7a1f, colorEnd: 0xb3300a,
                opacity: 0.85 * GLOW_STRENGTH, additive: true, drag: 2.5 });
        }
        for (let i = 0; i < 8; i++) {
            spawn({ position: at.set(x, y, z), velocity: burst(50, 14 + Math.random() * 26), life: 1.2 + Math.random(),
                size: [2.2, 0.8], color: 0xffc35a, colorEnd: 0xff5a1a, additive: true, gravity: 1, wind: 0.25 });
        }
        for (let i = 0; i < 6; i++) {
            spawn({ position: at.set(x, y, z), velocity: burst(9, 6 + Math.random() * 8), life: 5 + Math.random() * 2,
                size: [9 * size, 40 * size], color: 0x8a4a1c, colorEnd: 0x141517, opacity: 0.7, smoke: true, drag: 0.5, wind: 0.6 });
        }
        glow(x, y, z, 210 * size, 1.1);
        sound.distantBlast(distanceTo(x, y, z));
    }

    /**
     * Keeps a fire burning at (x, y, z): flames bent by the wind, a tall
     * column of black smoke carried downwind, and a steady glow in the haze.
     * Call it every frame with the same `fire` (from createFire).
     */
    function burn(fire, x, y, z, size, dt) {
        if (nearPlayArea(x, z)) {
            return;
        }
        fire.flame -= dt;
        fire.smoke -= dt;
        fire.glow -= dt;
        if (fire.flame <= 0) {
            fire.flame = 0.11;
            spawn({ position: at.set(x + spread(5 * size), y, z + spread(5 * size)), velocity: windBlown(3, 7 + Math.random() * 5, 0.3),
                life: 0.6 + Math.random() * 0.3, size: [7 * size, 1.5 * size],
                color: Math.random() < 0.3 ? 0xffe08a : 0xff6a1a, colorEnd: 0xc22e08, additive: true });
        }
        if (fire.smoke <= 0) {
            fire.smoke = 0.24;
            spawn({ position: at.set(x, y + 2, z), velocity: windBlown(2, 9 + Math.random() * 3, 0.12), life: 9 + Math.random() * 3,
                size: [7 * size, 46 * size], color: 0x6a3414, colorEnd: 0x0d0e10, opacity: 0.62, smoke: true, drag: 0.08, wind: 0.45 });
        }
        if (fire.glow <= 0) {
            // Overlapping slow glows: together they flicker gently, like a fire seen through rain.
            fire.glow = 0.4;
            spawn({ position: at.set(x, y + 14, z), velocity: zero, life: 1.1, fadeIn: 2,
                size: [80 * size, 105 * size], color: 0xff7a2a, opacity: 0.05, additive: true });
        }
    }

    /** An anti-aircraft shell bursting: a small dark puff that drifts away, with a brief spark. */
    function flak(x, y, z) {
        for (let i = 0; i < 2; i++) {
            spawn({ position: at.set(x + spread(3), y + spread(3), z + spread(3)), velocity: burst(5, spread(4)),
                life: 5 + Math.random() * 2, size: [5, 19], color: 0x4a4d52, colorEnd: 0x1a1c1f, opacity: 0.75,
                smoke: true, drag: 1.5, wind: 0.35 });
        }
        if (!reducedMotion) {
            spawn({ position: at.set(x, y, z), velocity: zero, life: 0.22, size: [9, 3], color: 0xffd9a0, opacity: 0.7, additive: true });
        }
        sound.flak(distanceTo(x, y, z));
    }

    /** A plane that has been hit: call every frame, it leaves fire and smoke behind. */
    function trail(x, y, z) {
        spawn({ position: at.set(x, y, z), velocity: burst(3, 1), life: 0.5, size: [5, 1.5],
            color: 0xffb04a, colorEnd: 0xd23a0a, additive: true });
        if (Math.random() < 0.5) {
            spawn({ position: at, velocity: burst(3, 2), life: 5 + Math.random() * 2, size: [4, 22],
                color: 0x3a3c40, colorEnd: 0x101113, opacity: 0.6, smoke: true, drag: 0.4, wind: 0.4 });
        }
    }

    /** A falling bomb: a faint grey streak, so the eye can follow it down. */
    function bombTrail(x, y, z) {
        spawn({ position: at.set(x, y, z), velocity: zero, life: 0.35, size: [2.2, 3.5],
            color: 0x9aa2a8, opacity: 0.35, smoke: true });
    }

    /** A star shell hanging under its parachute: call every frame with its position. */
    function flare(x, y, z, dt) {
        spawn({ position: at.set(x, y, z), velocity: zero, life: 0.25, size: [8, 5],
            color: 0xfff0d2, opacity: 0.55, additive: true });
        if (Math.random() < dt * 3) {
            // The pool of pale light around it, and the smoke it leaves above.
            spawn({ position: at, velocity: zero, life: 1.2, fadeIn: 2, size: [110, 140],
                color: 0xffe2b8, opacity: 0.045, additive: true });
            spawn({ position: at, velocity: burst(2, 3), life: 6, size: [4, 16],
                color: 0x8b9096, colorEnd: 0x3a3d41, opacity: 0.3, smoke: true, wind: 0.4 });
        }
    }

    /** A small light that blinks once (navigation lights of the planes). */
    function blink(x, y, z, vx, vy, vz, color) {
        spawn({ position: at.set(x, y, z), velocity: speed.set(vx, vy, vz), life: 0.28, fadeIn: 4,
            size: [2.6, 2.6], color, opacity: 0.9, additive: true });
    }

    /**
     * The one steady light that shines on the water (a flare, or the fire
     * closest to the camera). strength 0 switches it off.
     */
    function setSteadyGlow(x, y, z, strength) {
        steadyAt.set(x, y, z);
        steady = strength;
    }

    /** @param camera where the player is: for the distance of the sounds */
    function update(dt, time, camera) {
        listener = camera;
        clock += dt;
        particles.update(dt);
        seaFlash = Math.max(0, seaFlash - 6 * dt);
        sea.setGlow(SEA_FLASH_SLOT, seaFlashAt, seaFlash);
        // Two sines of different speeds: an irregular flicker, with no random jumps.
        const flicker = 0.8 + 0.14 * Math.sin(time * 9) + 0.08 * Math.sin(time * 21.3);
        sea.setGlow(SEA_STEADY_SLOT, steadyAt, steady * flicker);
    }

    return {
        muzzle, tracer, aaRound, splash, blast, burn, flak, trail, bombTrail, flare, blink, glow,
        setSteadyGlow, update,
        resize: particles.resize
    };
}
