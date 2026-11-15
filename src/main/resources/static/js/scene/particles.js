// A pool of particles drawn as ONE object (THREE.Points): a single draw call,
// and nothing is created while the game runs.
//
// Each slot has a position, a size, a colour, an opacity and a kind (glowing
// flame / spark, or soft smoke / spray), stored in typed arrays that are sent
// to the graphics card every frame.
//
// Two pools exist in the game: one for the player's own shots (effects.js) and
// one for the battle in the background (battleFx.js). They are separate so
// that a busy background can never steal a slot from a real hit or miss.
//
// The storm acts on every particle: the wind (weather.js) carries the light
// ones away, and lightning lights the smoke and the spray.

import * as THREE from 'three';
import { puffTexture, softDiscTexture } from './textures.js';
import { weather, WIND } from './weather.js';

const GRAVITY = 30;

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

// The two small textures are shared by every pool.
let discTexture = null;
let smokeTexture = null;

/**
 * @param poolSize number of slots (when all are busy, the oldest is recycled)
 * @returns {{ points, spawn(options), update(dt), clear(), resize(pixelHeight) }}
 */
export function createParticles(poolSize) {
    discTexture ??= softDiscTexture();
    smokeTexture ??= puffTexture();

    const positions = new Float32Array(poolSize * 3);
    const looks = new Float32Array(poolSize * 4);
    const colors = new Float32Array(poolSize * 4);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aLook', new THREE.BufferAttribute(looks, 4).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            uDisc: { value: discTexture },
            uPuff: { value: smokeTexture },
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

    // What the shader does not need stays in plain objects.
    const particles = [];
    for (let i = 0; i < poolSize; i++) {
        particles.push({
            active: false, age: 0, life: 1, vx: 0, vy: 0, vz: 0,
            sizeStart: 1, sizeEnd: 1, opacity: 1, fadeIn: 8, gravity: 0, drag: 0, wind: 0,
            from: new THREE.Color(), to: new THREE.Color()
        });
    }
    let cursor = 0;
    const tint = new THREE.Color();

    /**
     * Starts one particle.
     * options: position, velocity, life (s), size [start, end], color, colorEnd,
     *          opacity, gravity (0..1), drag, wind (0..1: how much the wind
     *          carries it), additive (glow) or not, smoke (puff texture),
     *          fadeIn (how fast it appears: 8 = at once, 2 = over half its life)
     */
    function spawn(options) {
        // Take the next free slot; if the pool is full, recycle the oldest one.
        let index = cursor;
        for (let i = 0; i < poolSize; i++) {
            const candidate = (cursor + i) % poolSize;
            if (!particles[candidate].active) {
                index = candidate;
                break;
            }
        }
        cursor = (index + 1) % poolSize;
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
        particle.fadeIn = options.fadeIn ?? 8;
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

    function update(dt) {
        // The wind right now, in world units per second.
        const speed = 9 + 16 * weather.gust;
        const windX = WIND.x * speed;
        const windZ = WIND.y * speed;
        for (let i = 0; i < poolSize; i++) {
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
            looks[i * 4 + 1] = particle.opacity * Math.min(1, t * particle.fadeIn) * Math.min(1, (1 - t) * 2);
            // The colour changes early in the life (smoke leaves the glow of the fire fast).
            tint.copy(particle.from).lerp(particle.to, Math.min(1, t * 3));
            colors[i * 4] = tint.r;
            colors[i * 4 + 1] = tint.g;
            colors[i * 4 + 2] = tint.b;
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.aLook.needsUpdate = true;
        geometry.attributes.aColor.needsUpdate = true;
        material.uniforms.uFlash.value = weather.flash;
    }

    /** Removes every particle at once. */
    function clear() {
        for (let i = 0; i < poolSize; i++) {
            particles[i].active = false;
            looks[i * 4 + 1] = 0;
        }
        geometry.attributes.aLook.needsUpdate = true;
    }

    /** The shader needs the height of the canvas (in real pixels) to size the particles. */
    function resize(pixelHeight) {
        material.uniforms.uScale.value = pixelHeight / 2;
    }

    return { points, spawn, update, clear, resize };
}
