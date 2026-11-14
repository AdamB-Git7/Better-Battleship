// The fog bank that covers the enemy zone.
//
// It is made of two parts:
//  1. A stack of horizontal planes drawn with an animated noise shader. Seen
//     from above they blend into one thick, slowly moving layer of fog.
//  2. A few big mist sprites drifting over the bank, for volume and life.
//
// A 10 x 10 "reveal mask" texture tells the shader where the fog has to open:
// one pixel per grid cell. When a cell has been shot, its pixel fades to white
// and the fog parts above it.
//
// In the storm the bank is dark and rain-soaked: it drifts with the wind
// (weather.js) and lights up from inside when lightning strikes.
//
// The fog is only decoration. The enemy ships are not hidden by it: they are
// simply not in the scene, because the server never sends their positions.

import * as THREE from 'three';
import { GRID_SIZE, ZONES, ZONE_SPAN } from '../config.js';
import { puffTexture } from './textures.js';
import { weather, WIND } from './weather.js';

const LAYERS = 6;
const LAYER_BOTTOM = 3.4;  // above the highest waves
const LAYER_STEP = 0.7;    // a thin stack: holes stay lined up when seen at an angle
const BANK_WIDTH = 420;    // the bank is wider and deeper than the grid,
const BANK_DEPTH = 330;    // so it looks like weather, not like a lid
const REVEAL_SPEED = 1.6;  // how fast a hole opens (1 / seconds)

const vertexShader = /* glsl */`
    varying vec2 vWorld;
    varying vec2 vUv;
    void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
    }
`;

const fragmentShader = /* glsl */`
    uniform float uTime;
    uniform float uSeed;
    uniform float uOpacity;
    uniform float uFlash;
    uniform vec2 uWind;
    uniform vec3 uColor;
    uniform vec3 uShade;
    uniform sampler2D uMask;
    uniform vec2 uZoneMin;      // north-west corner of the enemy grid (x, z)
    uniform float uZoneSpan;
    varying vec2 vWorld;
    varying vec2 vUv;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
        float value = 0.0;
        float amplitude = 0.5;
        for (int i = 0; i < 4; i++) {
            value += amplitude * noise(p);
            p = p * 2.03 + 11.7;
            amplitude *= 0.5;
        }
        return value;
    }

    void main() {
        // Two noise fields sliding in different directions = billowing motion.
        // The whole pattern slides downwind; the second field slides a bit
        // sideways too, which makes the fog roll instead of just moving.
        vec2 p = vWorld * 0.016 + uSeed * 9.3 - uWind * uTime * 0.11;
        float n = fbm(p);
        n += 0.5 * fbm(p * 2.1 + vec2(uTime * 0.03, -uTime * 0.05));
        float density = smoothstep(0.25, 0.95, n);

        // Thick over the grid, thinner (patchy) around it.
        vec2 zoneUv = (vWorld - uZoneMin) / uZoneSpan;
        vec2 outside = max(max(-zoneUv, zoneUv - 1.0), 0.0);
        float core = 1.0 - smoothstep(0.0, 0.5, length(outside));
        float alpha = mix(density * 0.75, 0.55 + 0.45 * density, core);

        // Fade out at the borders of the plane, and quickly on the player's side
        // so my own zone stays perfectly clear.
        vec2 border = smoothstep(0.0, 0.22, vUv) * smoothstep(0.0, 0.22, 1.0 - vUv);
        alpha *= border.x * border.y;
        alpha *= 1.0 - smoothstep(0.02, 0.2, zoneUv.y - 1.0);

        // Holes above the cells that have been shot.
        float inZone = step(0.0, zoneUv.x) * step(zoneUv.x, 1.0) * step(0.0, zoneUv.y) * step(zoneUv.y, 1.0);
        float reveal = smoothstep(0.1, 0.4, texture2D(uMask, zoneUv).r) * inZone;
        alpha *= 1.0 - reveal;

        // Lightning lights the bank from inside, more where it is thick.
        vec3 color = mix(uShade, uColor, density) * (1.0 + uFlash * (1.5 + 2.5 * density));
        gl_FragColor = vec4(color, alpha * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

export function createFog(scene) {
    const root = new THREE.Group();
    scene.add(root);
    const zone = ZONES.enemy.center;

    // ---- Reveal mask ------------------------------------------------------
    const cells = GRID_SIZE * GRID_SIZE;
    const target = new Float32Array(cells);     // 1 = fog open over this cell
    const current = new Float32Array(cells);
    const pixels = new Uint8Array(cells);
    const mask = new THREE.DataTexture(pixels, GRID_SIZE, GRID_SIZE, THREE.RedFormat);
    mask.magFilter = THREE.LinearFilter;         // soft-edged holes
    mask.minFilter = THREE.LinearFilter;
    mask.unpackAlignment = 1;                    // rows are 10 bytes, not a multiple of 4
    mask.needsUpdate = true;

    // ---- Shader layers ----------------------------------------------------
    const geometry = new THREE.PlaneGeometry(BANK_WIDTH, BANK_DEPTH).rotateX(-Math.PI / 2);
    const layers = [];
    for (let i = 0; i < LAYERS; i++) {
        const material = new THREE.ShaderMaterial({
            vertexShader,
            fragmentShader,
            transparent: true,
            depthWrite: false,
            uniforms: {
                uTime: { value: 0 },
                uSeed: { value: i + 1 },
                uOpacity: { value: 0.7 },
                uFlash: { value: 0 },
                uWind: { value: WIND },
                uColor: { value: new THREE.Color(0x87919a) },
                uShade: { value: new THREE.Color(0x2e363d) },
                uMask: { value: mask },
                uZoneMin: { value: new THREE.Vector2(zone.x - ZONE_SPAN / 2, zone.z - ZONE_SPAN / 2) },
                uZoneSpan: { value: ZONE_SPAN }
            }
        });
        const layer = new THREE.Mesh(geometry, material);
        // Centred a bit north of the grid so the bank stretches away from the player.
        layer.position.set(zone.x, LAYER_BOTTOM + i * LAYER_STEP, zone.z - 55);
        layer.renderOrder = 1;
        root.add(layer);
        layers.push(layer);
    }

    // ---- Drifting mist sprites --------------------------------------------
    const puffMap = puffTexture();
    const puffColor = new THREE.Color(0x68727a);
    const wallColor = new THREE.Color(0x6f7a83);
    const sprites = [];   // every sprite with its colour in calm weather, for the lightning
    const puffs = [];
    for (let i = 0; i < 16; i++) {
        const material = new THREE.SpriteMaterial({
            map: puffMap, color: puffColor, transparent: true, opacity: 0, depthWrite: false, fog: false
        });
        const sprite = new THREE.Sprite(material);
        sprites.push({ material, color: puffColor });
        const size = 70 + Math.random() * 70;
        sprite.scale.set(size, size * 0.55, 1);
        sprite.renderOrder = 2;
        root.add(sprite);
        puffs.push({
            sprite,
            baseX: zone.x + (Math.random() - 0.5) * 300,
            z: zone.z - 75 - Math.random() * 130,   // behind the grid, so holes stay clear
            y: 11 + Math.random() * 9,
            speed: 4 + Math.random() * 5,     // the wind pushes them along
            phase: Math.random() * 100,
            opacity: 0.2 + Math.random() * 0.18
        });
    }

    // ---- Fog wall for the bridge view -----------------------------------------
    // Seen from the captain's bridge (low and far away) the flat layers above
    // are almost edge-on, so the bank needs height: these taller sprites stand
    // over the enemy zone. They are hidden in the aerial view, where they
    // would cover the enemy grid.
    const wall = [];
    for (let i = 0; i < 70; i++) {
        const material = new THREE.SpriteMaterial({
            map: puffMap, color: wallColor, transparent: true, opacity: 0.5 + Math.random() * 0.3,
            depthWrite: false, fog: false
        });
        const sprite = new THREE.Sprite(material);
        sprites.push({ material, color: wallColor });
        const size = 130 + Math.random() * 110;
        sprite.scale.set(size, size * 0.3, 1);   // wide and low: a bank, not a cloud
        sprite.renderOrder = 2;
        sprite.visible = false;
        root.add(sprite);
        wall.push({
            sprite,
            x: zone.x + (Math.random() - 0.5) * 520,
            y: 5 + Math.random() * 16,
            z: zone.z + ZONE_SPAN / 2 + 6 - Math.random() * 150,
            phase: Math.random() * 100
        });
    }

    /** true = first-person view from the bridge, false = aerial view. */
    function setBridgeMode(onBridge) {
        for (const item of wall) {
            item.sprite.visible = onBridge;
        }
    }

    /** Opens (or closes) the fog above one cell of the enemy grid. */
    function setRevealed(row, col, revealed, instant = false) {
        const index = row * GRID_SIZE + col;
        target[index] = revealed ? 1 : 0;
        if (instant) {
            current[index] = target[index];
        }
    }

    function reset() {
        target.fill(0);
    }

    let lastFlash = 0;

    function update(dt, time) {
        // Move every mask pixel towards its target and upload only if it changed.
        let changed = false;
        for (let i = 0; i < cells; i++) {
            if (current[i] !== target[i]) {
                const step = REVEAL_SPEED * dt;
                current[i] = current[i] < target[i]
                    ? Math.min(target[i], current[i] + step)
                    : Math.max(target[i], current[i] - step);
            }
            const value = Math.round(current[i] * 255);
            if (pixels[i] !== value) {
                pixels[i] = value;
                changed = true;
            }
        }
        if (changed) {
            mask.needsUpdate = true;
        }

        for (const layer of layers) {
            layer.material.uniforms.uTime.value = time;
            layer.material.uniforms.uFlash.value = weather.flash;
        }
        // The mist sprites brighten with the lightning too (only touched when it changes).
        if (weather.flash !== lastFlash) {
            lastFlash = weather.flash;
            for (const item of sprites) {
                item.material.color.copy(item.color).multiplyScalar(1 + lastFlash * 3.5);
            }
        }
        for (const item of wall) {
            // The wall barely moves: a slow sideways drift.
            item.sprite.position.set(item.x + Math.sin(time * 0.05 + item.phase) * 14, item.y, item.z);
        }
        for (const puff of puffs) {
            // Drift sideways, wrap around, and fade in / out at the ends of the path.
            const travel = ((time * puff.speed + puff.phase * 10) % 300) / 300;   // 0..1
            puff.sprite.position.set(puff.baseX - 150 + travel * 300, puff.y, puff.z);
            puff.sprite.material.opacity = puff.opacity * Math.sin(travel * Math.PI);
        }
    }

    return { setRevealed, setBridgeMode, reset, update };
}
