// Curtains of rain and mist, far out on the water.
//
// In a real storm the rain does not fall evenly: grey shafts of heavier rain
// hang under the clouds here and there, and everything behind one is paler.
// That is what tells the eye how far away things are. Here each curtain is
// one tall, see-through sheet standing on the sea, facing the play area; its
// shader slides a cloudy noise down it, so it is never still, and lightning
// lights it up for an instant.
//
// Readability: the curtains stand 430 units or more from the centre, in a
// ring, so they are never between an aerial camera and the grids.
// Cost: one draw call (all the sheets are one geometry), no textures of its own.

import * as THREE from 'three';
import { cloudNoiseTexture } from './textures.js';
import { weather } from './weather.js';

const DEG = Math.PI / 180;
const CENTRE_Z = -40;

// One line per curtain: compass bearing from the centre (0 = north, positive
// = east), distance, width and height.
const CURTAINS = [
    [-104, 500, 300, 170], [-76, 610, 380, 210], [-50, 470, 300, 180], [-26, 720, 420, 230],
    [-4, 560, 340, 190], [22, 760, 440, 230], [44, 520, 320, 180], [70, 640, 380, 210],
    [100, 520, 300, 170], [140, 640, 380, 190], [-142, 620, 380, 190]
];

const vertexShader = /* glsl */`
    attribute float aSeed;
    varying vec2 vUv;
    varying float vSeed;
    varying float vDepth;
    void main() {
        vUv = uv;
        vSeed = aSeed;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
    }
`;
const fragmentShader = /* glsl */`
    uniform sampler2D uNoise;
    uniform float uTime;
    uniform float uFlash;
    uniform vec3 fogColor;
    varying vec2 vUv;
    varying float vSeed;
    varying float vDepth;
    void main() {
        // Big soft patches that drift sideways, and long streaks that fall.
        float patches = min(1.0, 1.9 * texture2D(uNoise, vec2(vUv.x * 1.3 + vSeed + uTime * 0.006, vUv.y * 0.5 + vSeed * 2.0 + uTime * 0.012)).r);
        float streaks = min(1.0, 1.9 * texture2D(uNoise, vec2(vUv.x * 5.0 + vSeed, vUv.y * 0.22 + uTime * 0.07)).r);
        float sides = smoothstep(0.0, 0.3, vUv.x) * smoothstep(0.0, 0.3, 1.0 - vUv.x);
        float top = 1.0 - smoothstep(0.35, 1.0, vUv.y);
        float alpha = sides * top * smoothstep(0.15, 0.75, patches) * (0.55 + 0.45 * streaks) * 0.5;
        alpha *= smoothstep(120.0, 320.0, vDepth);              // never a wall right in front of the camera
        // A little paler than the haze; much paler while lightning strikes.
        vec3 color = fogColor * 1.16 + vec3(0.2, 0.24, 0.32) * uFlash * (0.3 + patches);
        gl_FragColor = vec4(color, alpha);
    }
`;

export function createMist(scene) {
    const positions = [];
    const uvs = [];
    const seeds = [];
    CURTAINS.forEach(([bearing, distance, width, height], index) => {
        const cx = Math.sin(bearing * DEG) * distance;
        const cz = CENTRE_Z - Math.cos(bearing * DEG) * distance;
        // The sheet stands across the line from the centre to it.
        const ax = Math.cos(bearing * DEG) * width / 2;
        const az = Math.sin(bearing * DEG) * width / 2;
        const corners = [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]];
        for (const [side, up] of corners) {
            positions.push(cx + ax * side, up * height - 2, cz + az * side);
            uvs.push((side + 1) / 2, up);
            seeds.push(index * 0.37);
        }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 1));
    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            uNoise: { value: cloudNoiseTexture() },
            uTime: { value: 0 },
            uFlash: { value: 0 }
        },
        fog: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 0;   // after the far smoke and glows, before the fog bank, the rain and the particles
    scene.add(mesh);

    return {
        update(time) {
            material.uniforms.uTime.value = time;
            material.uniforms.uFlash.value = weather.flash;
        }
    };
}
