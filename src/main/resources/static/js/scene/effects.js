// Visual effects for shots: the shell and its arc, explosions, fire and smoke
// on damaged ships, water splashes and the foam rings spreading on the sea.
//
// All particles live in ONE object (THREE.Points) with a fixed number of
// slots: a single draw call, and nothing is created while the game runs.
// Each slot has a position, a size, a colour, an opacity and a kind (glowing
// flame / spark, or soft smoke / spray), stored in typed arrays that are sent
// to the graphics card every frame.
//
// The storm acts on everything here: the wind (weather.js) bends the flames
// and carries the smoke and the embers away, lightning lights the smoke and
// the spray, and fires shine on the water and on the ships around them.

import * as THREE from 'three';
import { puffTexture, softDiscTexture } from './textures.js';
import { weather, WIND } from './weather.js';
import { waveHeight } from './sea.js';

const POOL_SIZE = 2400;
const GRAVITY = 30;
const FIRE_LIGHTS = 2;      // real lights, on the fires closest to the camera
const SEA_GLOWS = 3;        // fires reflected in the water (slot 0 is for explosions)

const vertexShader = /* glsl */`
    attribute vec4 aLook;      // size, opacity, kind (0 = disc, 1 = puff), rotation
    attribute vec4 aColor;     // rgb, additive (1 = glowing)
    uniform float uScale;      // half the height of the canvas, in pixels
    varying vec4 vLook;
    varying vec4 vColor;
    varying float vDepth;
    void main() {
        vLook = aLook;
        vColor = aColor;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
        // Same size on screen as a square of aLook.x world units at that distance.
        gl_PointSize = aLook.x * uScale * projectionMatrix[1][1] / max(vDepth, 0.1);
        if (aLook.y <= 0.0) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // unused slot: off screen
        }
    }
`;

const fragmentShader = /* glsl */`
    uniform sampler2D uDisc;
    uniform sampler2D uPuff;
    uniform vec3 fogColor;
    uniform float fogDensity;
    uniform float uFlash;
    varying vec4 vLook;
    varying vec4 vColor;
    varying float vDepth;
    void main() {
        // Turn the square so that no two puffs look the same.
        float c = cos(vLook.w);
        float s = sin(vLook.w);
        vec2 uv = mat2(c, -s, s, c) * (gl_PointCoord - 0.5) + 0.5;
        float shape = mix(texture2D(uDisc, uv).a, texture2D(uPuff, uv).a, vLook.z);
        float alpha = shape * vLook.y;
        float additive = vColor.a;
        float haze = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
        // Smoke and spray have no light of their own: lightning shows them.
        vec3 color = vColor.rgb * (1.0 + (1.0 - additive) * uFlash * 2.5);
        color = mix(color, fogColor, haze * (1.0 - additive));
        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        alpha *= 1.0 - haze * additive * 0.7;
        // Premultiplied output: glowing particles add light, the others cover.
        gl_FragColor = vec4(gl_FragColor.rgb * alpha, alpha * (1.0 - additive));
    }
`;

/**
 * @param sound the sound module
 * @param sea used to make explosions and fires shine on the water
 */
export function createEffects(scene, sound, sea) {
    const root = new THREE.Group();
    scene.add(root);

    // ---- Particle pool ------------------------------------------------------
    const positions = new Float32Array(POOL_SIZE * 3);
    const looks = new Float32Array(POOL_SIZE * 4);
    const colors = new Float32Array(POOL_SIZE * 4);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aLook', new THREE.BufferAttribute(looks, 4).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            uDisc: { value: softDiscTexture() },
            uPuff: { value: puffTexture() },
            uScale: { value: 400 },
            uFlash: { value: 0 }
        },
        fog: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 8;
    root.add(points);

    // What the shader does not need stays in plain objects.
    const particles = [];
    for (let i = 0; i < POOL_SIZE; i++) {
        particles.push({
            active: false, age: 0, life: 1, vx: 0, vy: 0, vz: 0,
            sizeStart: 1, sizeEnd: 1, opacity: 1, gravity: 0, drag: 0, wind: 0,
            from: new THREE.Color(), to: new THREE.Color()
        });
    }
    let cursor = 0;
    const tint = new THREE.Color();

    /**
     * Starts one particle.
     * options: position, velocity, life (s), size [start, end], color, colorEnd,
     *          opacity, gravity (0..1), drag, wind (0..1: how much the wind
     *          carries it), additive (glow) or not, smoke (puff texture)
     */
    function spawn(options) {
        // Take the next free slot; if the pool is full, recycle the oldest one.
        let index = cursor;
        for (let i = 0; i < POOL_SIZE; i++) {
            const candidate = (cursor + i) % POOL_SIZE;
            if (!particles[candidate].active) {
                index = candidate;
                break;
            }
        }
        cursor = (index + 1) % POOL_SIZE;
        const particle = particles[index];
        particle.active = true;
        particle.age = 0;
        particle.life = options.life;
        particle.vx = options.velocity.x;
        particle.vy = options.velocity.y;
        particle.vz = options.velocity.z;
        particle.sizeStart = options.size[0];
        particle.sizeEnd = options.size[1];
        particle.opacity = options.opacity ?? 1;
        particle.gravity = options.gravity ?? 0;
        particle.drag = options.drag ?? 0;
        particle.wind = options.wind ?? 0;
        particle.from.set(options.color);
        particle.to.set(options.colorEnd ?? options.color);
        positions[index * 3] = options.position.x;
        positions[index * 3 + 1] = options.position.y;
        positions[index * 3 + 2] = options.position.z;
        looks[index * 4 + 2] = options.smoke ? 1 : 0;
        looks[index * 4 + 3] = Math.random() * Math.PI * 2;
        colors[index * 4 + 3] = options.additive ? 1 : 0;
    }

    function updateParticles(dt) {
        // The wind right now, in world units per second.
        const speed = 9 + 16 * weather.gust;
        const windX = WIND.x * speed;
        const windZ = WIND.y * speed;
        for (let i = 0; i < POOL_SIZE; i++) {
            const particle = particles[i];
            if (!particle.active) {
                continue;
            }
            particle.age += dt;
            const t = particle.age / particle.life;
            if (t >= 1) {
                particle.active = false;
                looks[i * 4 + 1] = 0;
                continue;
            }
            particle.vy -= GRAVITY * particle.gravity * dt;
            const keep = Math.max(0, 1 - particle.drag * dt);
            particle.vx *= keep;
            particle.vy *= keep;
            particle.vz *= keep;
            // Light things (smoke, embers) end up moving with the wind.
            const pull = Math.min(1, particle.wind * dt * 1.5);
            particle.vx += (windX - particle.vx) * pull;
            particle.vz += (windZ - particle.vz) * pull;
            positions[i * 3] += particle.vx * dt;
            positions[i * 3 + 1] += particle.vy * dt;
            positions[i * 3 + 2] += particle.vz * dt;
            looks[i * 4] = particle.sizeStart + (particle.sizeEnd - particle.sizeStart) * t;
            // Fade in quickly, fade out over the second half of the life.
            looks[i * 4 + 1] = particle.opacity * Math.min(1, t * 8) * Math.min(1, (1 - t) * 2);
            // The colour changes early in the life (smoke leaves the glow of the fire fast).
            tint.copy(particle.from).lerp(particle.to, Math.min(1, t * 3));
            colors[i * 4] = tint.r;
            colors[i * 4 + 1] = tint.g;
            colors[i * 4 + 2] = tint.b;
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.aLook.needsUpdate = true;
        geometry.attributes.aColor.needsUpdate = true;
    }

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

    // ---- Shells -----------------------------------------------------------
    const shellGeometry = new THREE.SphereGeometry(0.5, 8, 6);
    // A glowing tracer round: a dark shell would be invisible in the storm.
    const shellMaterial = new THREE.MeshBasicMaterial({ color: 0xffb46a, fog: false });
    const shells = [];

    // One light for the brightest thing happening: a muzzle flash or an explosion.
    const flash = new THREE.PointLight(0xffa64d, 0, 160, 1.5);
    root.add(flash);
    let seaFlash = 0;   // the same flash, reflected in the water

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
        for (let i = 0; i < 9; i++) {
            spawn({ position: from, velocity: burst(10, 3 + Math.random() * 5), life: 0.22,
                size: [3, 9], color: 0xffd08a, additive: true });
            spawn({ position: from, velocity: burst(6, 2 + Math.random() * 3), life: 2.2,
                size: [2.5, 11], color: 0x8d8a86, colorEnd: 0x3d4043, opacity: 0.5, smoke: true, drag: 1, wind: 0.5 });
        }
        flash.position.copy(from).y += 3;
        flash.intensity = Math.max(flash.intensity, 500);
        sea.setGlow(0, from, 1.2);
        seaFlash = Math.max(seaFlash, 1.2);
        sound.cannon(distanceTo(from));
    }

    function updateShells(dt) {
        for (let i = shells.length - 1; i >= 0; i--) {
            const shell = shells[i];
            shell.time += dt;
            const p = Math.min(shell.time / shell.duration, 1);
            shell.mesh.position.lerpVectors(shell.from, shell.to, p);
            shell.mesh.position.y += 4 * shell.height * p * (1 - p);   // parabola
            // A hot glow around the shell and a thin trail behind it.
            spawn({ position: shell.mesh.position, velocity: scratch.set(0, 0, 0), life: 0.22,
                size: [3.4, 0.6], color: 0xff9a45, opacity: 0.8, additive: true });
            spawn({ position: shell.mesh.position, velocity: scratch.set(0, 0.5, 0), life: 0.9,
                size: [1.2, 3.4], color: 0x9c9c9c, opacity: 0.28, smoke: true, wind: 0.4 });
            if (p >= 1) {
                root.remove(shell.mesh);
                shells.splice(i, 1);
                shell.onImpact();
            }
        }
    }

    // ---- Impacts ------------------------------------------------------------

    function explosion(position) {
        for (let i = 0; i < 22; i++) {   // fireball
            spawn({ position, velocity: burst(18, 4 + Math.random() * 12), life: 0.55 + Math.random() * 0.4,
                size: [4, 14], color: i % 3 === 0 ? 0xfff0b0 : 0xff7a1f, colorEnd: 0xb3300a, additive: true, drag: 2.5 });
        }
        for (let i = 0; i < 26; i++) {   // sparks and burning debris, carried by the wind
            spawn({ position, velocity: burst(46, 12 + Math.random() * 26), life: 1 + Math.random() * 0.9,
                size: [1.1, 0.3], color: 0xffc35a, colorEnd: 0xff5a1a, additive: true, gravity: 1, wind: 0.25 });
        }
        for (let i = 0; i < 16; i++) {   // smoke: lit orange from inside at first, then black
            spawn({ position, velocity: burst(9, 5 + Math.random() * 8), life: 3 + Math.random() * 1.5,
                size: [5, 22], color: 0x8a4a1c, colorEnd: 0x141517, opacity: 0.75, smoke: true, drag: 0.6, wind: 0.6 });
        }
        flash.position.copy(position).y += 4;
        flash.intensity = 1400;
        sea.setGlow(0, position, 3.5);
        seaFlash = 3.5;
        sound.explosion(distanceTo(position));
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

    function updateFires(dt, time) {
        for (const fire of fires.values()) {
            // The burning deck goes up and down with the ship.
            fire.position.y = fire.base + waveHeight(fire.position.x, fire.position.z, time) * 0.7;
            fire.flameTimer -= dt;
            fire.smokeTimer -= dt;
            if (fire.flameTimer <= 0) {
                fire.flameTimer = 0.07;
                // Flames lean with the wind and are torn off in gusts.
                spawn({ position: fire.position, velocity: windBlown(2, 4 + Math.random() * 3, 0.3), life: 0.5 + Math.random() * 0.2,
                    size: [3.6, 0.8], color: Math.random() < 0.3 ? 0xffe08a : 0xff6a1a, colorEnd: 0xc22e08, additive: true });
                if (Math.random() < 0.18) {   // an ember
                    spawn({ position: fire.position, velocity: windBlown(5, 6 + Math.random() * 6, 0.4), life: 1.4 + Math.random(),
                        size: [0.7, 0.2], color: 0xffb04a, colorEnd: 0xff4a12, additive: true, gravity: 0.25, wind: 0.5 });
                }
            }
            if (fire.smokeTimer <= 0) {
                fire.smokeTimer = 0.17;
                // Thick smoke: glowing orange just above the fire, then black, blown downwind.
                spawn({ position: fire.position, velocity: windBlown(1.5, 5 + Math.random() * 2, 0.15), life: 4.2 + Math.random(),
                    size: [3, 17], color: 0x7a3d16, colorEnd: 0x121315, opacity: 0.6, smoke: true, drag: 0.1, wind: 0.55 });
            }
        }

        // The closest fires get the real lights and the reflections on the sea.
        nearestTimer -= dt;
        if (nearestTimer <= 0 && listener) {
            nearestTimer = 1;
            nearest = [...fires.values()]
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

    function clear() {
        fires.clear();
        nearest = [];
        nearestTimer = 0;
        for (let i = 0; i < POOL_SIZE; i++) {
            particles[i].active = false;
            looks[i * 4 + 1] = 0;
        }
        geometry.attributes.aLook.needsUpdate = true;
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
        seaFlash = 0;
    }

    /** @param camera where the player is: for sound distance and to choose the lit fires */
    function update(dt, time, camera) {
        listener = camera;
        updateShells(dt);
        updateFires(dt, time);
        updateRings(dt, time);
        updateParticles(dt);
        material.uniforms.uFlash.value = weather.flash;
        // The flash of a gun or an explosion dies in a fraction of a second.
        flash.intensity = Math.max(0, flash.intensity - 3200 * dt);
        seaFlash = Math.max(0, seaFlash - 7 * dt);
        sea.setGlow(0, flash.position, seaFlash);
    }

    /** The shader needs the height of the canvas (in real pixels) to size the particles. */
    function resize(pixelHeight) {
        material.uniforms.uScale.value = pixelHeight / 2;
    }

    return { fireShell, explosion, splash, syncFires, clear, update, resize };
}
