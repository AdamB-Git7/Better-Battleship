// Visual effects for shots: the shell and its arc, explosions, fire and smoke
// on damaged ships, water splashes and the rings spreading on the sea.
//
// All particles are sprites taken from one fixed-size pool, so the number of
// objects stays bounded and nothing is allocated while the game runs.

import * as THREE from 'three';
import { puffTexture, softDiscTexture } from './textures.js';

const POOL_SIZE = 700;
const GRAVITY = 30;

export function createEffects(scene, sound) {
    const root = new THREE.Group();
    scene.add(root);

    const discMap = softDiscTexture();
    const puffMap = puffTexture();

    // ---- Particle pool ------------------------------------------------------
    const particles = [];
    for (let i = 0; i < POOL_SIZE; i++) {
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: discMap, transparent: true, depthWrite: false, fog: false
        }));
        sprite.visible = false;
        sprite.renderOrder = 8;
        root.add(sprite);
        particles.push({ sprite, velocity: new THREE.Vector3(), active: false });
    }
    let cursor = 0;

    /**
     * Starts one particle.
     * options: position, velocity, life (s), size [start, end], color, opacity,
     *          gravity (0..1), drag, additive (glow) or not, smoke (puff texture)
     */
    function spawn(options) {
        // Take the next free particle; if the pool is full, recycle the oldest slot.
        let particle = null;
        for (let i = 0; i < POOL_SIZE; i++) {
            const candidate = particles[(cursor + i) % POOL_SIZE];
            if (!candidate.active) {
                particle = candidate;
                cursor = (cursor + i + 1) % POOL_SIZE;
                break;
            }
        }
        if (!particle) {
            particle = particles[cursor];
            cursor = (cursor + 1) % POOL_SIZE;
        }
        const material = particle.sprite.material;
        material.map = options.smoke ? puffMap : discMap;
        material.blending = options.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
        material.color.set(options.color);
        material.rotation = Math.random() * Math.PI * 2;
        particle.sprite.position.copy(options.position);
        particle.sprite.visible = true;
        particle.velocity.copy(options.velocity);
        particle.active = true;
        particle.age = 0;
        particle.life = options.life;
        particle.sizeStart = options.size[0];
        particle.sizeEnd = options.size[1];
        particle.opacity = options.opacity ?? 1;
        particle.gravity = options.gravity ?? 0;
        particle.drag = options.drag ?? 0;
    }

    function updateParticles(dt) {
        for (const particle of particles) {
            if (!particle.active) {
                continue;
            }
            particle.age += dt;
            const t = particle.age / particle.life;
            if (t >= 1) {
                particle.active = false;
                particle.sprite.visible = false;
                continue;
            }
            particle.velocity.y -= GRAVITY * particle.gravity * dt;
            particle.velocity.multiplyScalar(Math.max(0, 1 - particle.drag * dt));
            particle.sprite.position.addScaledVector(particle.velocity, dt);
            const size = particle.sizeStart + (particle.sizeEnd - particle.sizeStart) * t;
            particle.sprite.scale.set(size, size, 1);
            // Fade in quickly, fade out over the second half of the life.
            const fade = Math.min(1, t * 8) * Math.min(1, (1 - t) * 2);
            particle.sprite.material.opacity = particle.opacity * fade;
        }
    }

    const scratch = new THREE.Vector3();
    const randomDirection = (spread, up) => scratch.set(
        (Math.random() - 0.5) * spread, up, (Math.random() - 0.5) * spread).clone();

    // ---- Shells -----------------------------------------------------------
    const shellGeometry = new THREE.SphereGeometry(0.55, 8, 6);
    const shellMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.4, metalness: 0.8 });
    const shells = [];

    /**
     * Fires a shell along an arc. onImpact is called when it lands.
     * The game result is only shown at that moment (see main.js).
     */
    function fireShell(from, to, onImpact) {
        const mesh = new THREE.Mesh(shellGeometry, shellMaterial);
        mesh.position.copy(from);
        root.add(mesh);
        const distance = from.distanceTo(to);
        shells.push({
            mesh,
            from: from.clone(),
            to: to.clone(),
            height: distance * 0.3,
            duration: THREE.MathUtils.clamp(distance / 130, 0.9, 1.7),
            time: 0,
            onImpact
        });
        // Muzzle flash and smoke at the gun.
        for (let i = 0; i < 6; i++) {
            spawn({ position: from, velocity: randomDirection(8, 3 + Math.random() * 4), life: 0.25,
                size: [2, 7], color: 0xffc46b, additive: true });
            spawn({ position: from, velocity: randomDirection(5, 2 + Math.random() * 3), life: 1.6,
                size: [2, 8], color: 0x9a9a9a, opacity: 0.5, smoke: true, drag: 1 });
        }
        sound.cannon();
    }

    function updateShells(dt) {
        for (let i = shells.length - 1; i >= 0; i--) {
            const shell = shells[i];
            shell.time += dt;
            const p = Math.min(shell.time / shell.duration, 1);
            shell.mesh.position.lerpVectors(shell.from, shell.to, p);
            shell.mesh.position.y += 4 * shell.height * p * (1 - p);   // parabola
            spawn({ position: shell.mesh.position, velocity: scratch.set(0, 0.5, 0), life: 0.7,
                size: [1.2, 3], color: 0xbdbdbd, opacity: 0.35, smoke: true });
            if (p >= 1) {
                root.remove(shell.mesh);
                shells.splice(i, 1);
                shell.onImpact();
            }
        }
    }

    // ---- Impacts ------------------------------------------------------------
    const flash = new THREE.PointLight(0xffa64d, 0, 120, 1.5);
    root.add(flash);

    function explosion(position) {
        for (let i = 0; i < 14; i++) {
            spawn({ position, velocity: randomDirection(16, 4 + Math.random() * 10), life: 0.5 + Math.random() * 0.3,
                size: [3, 11], color: i % 3 === 0 ? 0xfff0b0 : 0xff7a1f, additive: true, drag: 2.5 });
        }
        for (let i = 0; i < 16; i++) {   // sparks and debris
            spawn({ position, velocity: randomDirection(40, 12 + Math.random() * 22), life: 0.9 + Math.random() * 0.6,
                size: [1, 0.3], color: 0xffc35a, additive: true, gravity: 1 });
        }
        for (let i = 0; i < 10; i++) {
            spawn({ position, velocity: randomDirection(7, 5 + Math.random() * 6), life: 2.2 + Math.random(),
                size: [4, 15], color: 0x2a2a2a, opacity: 0.7, smoke: true, drag: 0.6 });
        }
        flash.position.copy(position).y += 4;
        flash.intensity = 900;
        sound.explosion();
    }

    // Rings spreading on the water after a miss.
    const ringGeometry = new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2);
    const rings = [];

    function splash(position) {
        for (let i = 0; i < 30; i++) {   // column of spray
            spawn({ position, velocity: randomDirection(9, 14 + Math.random() * 20), life: 1 + Math.random() * 0.6,
                size: [1.6, 3.6], color: 0xf2f8ff, opacity: 0.85, gravity: 1 });
        }
        for (let i = 0; i < 8; i++) {    // mist at the base
            spawn({ position, velocity: randomDirection(10, 2), life: 1.4, size: [3, 10],
                color: 0xe6eef5, opacity: 0.45, smoke: true, drag: 1.5 });
        }
        for (let i = 0; i < 3; i++) {
            const material = new THREE.MeshBasicMaterial({
                color: 0xffffff, transparent: true, opacity: 0, depthWrite: false
            });
            const mesh = new THREE.Mesh(ringGeometry, material);
            mesh.position.copy(position).y = 0.2;
            mesh.visible = false;
            root.add(mesh);
            rings.push({ mesh, delay: i * 0.45, time: 0 });
        }
        sound.splash();
    }

    function updateRings(dt) {
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
            ring.mesh.scale.setScalar(1.5 + t * 9);
            ring.mesh.material.opacity = 0.55 * (1 - t);
        }
    }

    // ---- Lasting fire and smoke on damaged cells ---------------------------
    const fires = new Map();   // key -> { position, flameTimer, smokeTimer }

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
                fires.set(fire.key, { position: fire.position.clone(), flameTimer: 0, smokeTimer: Math.random() * 0.3 });
            }
        }
    }

    function updateFires(dt) {
        for (const fire of fires.values()) {
            fire.flameTimer -= dt;
            fire.smokeTimer -= dt;
            if (fire.flameTimer <= 0) {
                fire.flameTimer = 0.12;
                spawn({ position: fire.position, velocity: randomDirection(1.5, 3 + Math.random() * 2), life: 0.5,
                    size: [3.2, 0.8], color: Math.random() < 0.3 ? 0xffe08a : 0xff6a1a, additive: true });
            }
            if (fire.smokeTimer <= 0) {
                fire.smokeTimer = 0.3;
                spawn({ position: fire.position, velocity: randomDirection(1.5, 4.5 + Math.random() * 2), life: 2.6,
                    size: [2.5, 9], color: 0x24262a, opacity: 0.55, smoke: true, drag: 0.15 });
            }
        }
    }

    function clear() {
        fires.clear();
        for (const particle of particles) {
            particle.active = false;
            particle.sprite.visible = false;
        }
        for (const shell of shells) {
            root.remove(shell.mesh);
        }
        shells.length = 0;
        for (const ring of rings) {
            root.remove(ring.mesh);
            ring.mesh.material.dispose();
        }
        rings.length = 0;
        flash.intensity = 0;
    }

    function update(dt) {
        updateShells(dt);
        updateFires(dt);
        updateRings(dt);
        updateParticles(dt);
        flash.intensity = Math.max(0, flash.intensity - 3000 * dt);
    }

    return { fireShell, explosion, splash, syncFires, clear, update };
}
