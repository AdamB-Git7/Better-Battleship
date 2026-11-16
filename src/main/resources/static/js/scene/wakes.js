// Wakes: the foam a moving ship leaves on the water.
//
// Every ship and boat of the battle in the background (squadrons, escorts,
// convoys, torpedo boats) gets one flat sheet of foam that follows it. All the
// sheets are drawn together as ONE instanced mesh: one draw call, however many
// ships there are. The sheets lie on the same waves as the sea (WAVE_GLSL).

import * as THREE from 'three';
import { WAVE_GLSL, seaUniforms } from './sea.js';
import { foamTexture, wakeMaskTexture } from './textures.js';

const wakeVertex = /* glsl */`
    ${WAVE_GLSL}
    attribute float aOpacity;
    varying vec2 vUv;
    varying float vOpacity;
    #include <fog_pars_vertex>
    void main() {
        vUv = uv;
        vOpacity = aOpacity;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        // Same waves as the sea, which is flat far away (see sea.js).
        float lift = 1.0 - smoothstep(420.0, 1200.0, length(world.xz));
        world.y = waveSurface(world.xz).x * lift + 0.15;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
    }
`;
const wakeFragment = /* glsl */`
    uniform sampler2D uFoam;
    uniform sampler2D uMask;
    uniform vec2 uScroll;
    uniform float uFlash;
    varying vec2 vUv;
    varying float vOpacity;
    #include <fog_pars_fragment>
    void main() {
        vec3 foam = texture2D(uFoam, vUv * vec2(2.0, 1.0) + uScroll).rgb;
        float alpha = texture2D(uMask, vUv).r * min(vOpacity, 1.0) * (0.4 + 0.6 * foam.r);
        // An opacity above 1 also makes the foam whiter (fast boats churn the water).
        gl_FragColor = vec4(foam * (0.34 * max(vOpacity, 1.0) + uFlash * 1.2), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
    }
`;

/**
 * @param capacity the largest number of wakes that will ever be reserved
 * @returns {{ reserve(): number, set(index, x, z, heading, length, width, opacity), update(dt) }}
 */
export function createWakes(scene, capacity) {
    const foamScroll = new THREE.Vector2();
    const geometry = new THREE.PlaneGeometry(1, 1, 12, 4).rotateX(-Math.PI / 2);
    const opacity = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aOpacity', opacity);
    const mesh = new THREE.InstancedMesh(geometry, new THREE.ShaderMaterial({
        vertexShader: wakeVertex,
        fragmentShader: wakeFragment,
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            ...seaUniforms,
            uFoam: { value: foamTexture() },
            uMask: { value: wakeMaskTexture() },
            uScroll: { value: foamScroll }
        },
        transparent: true,
        depthWrite: false,
        fog: true
    }), capacity);
    mesh.frustumCulled = false;   // the vertices are moved in the shader
    mesh.renderOrder = -5;
    // Until a slot is used its sheet has no size at all.
    const nothing = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) {
        mesh.setMatrixAt(i, nothing);
    }
    scene.add(mesh);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const size = new THREE.Vector3();
    const UP = new THREE.Vector3(0, 1, 0);
    let reserved = 0;

    return {
        /** Books one wake for a ship; keep the number and pass it to set(). */
        reserve() {
            if (reserved >= capacity) {
                throw new Error('wakes.js: capacity too small');
            }
            return reserved++;
        },
        /**
         * Lays the wake of one ship for this frame.
         * @param x, z the middle of the sheet (a little behind the middle of the ship)
         * @param heading rotation.y of the ship (0 = bow towards +x)
         * @param length, width size of the sheet on the water
         * @param opacityValue 0 = no wake, 0.5 = a ship, more than 1 = the white wake of a fast boat
         */
        set(index, x, z, heading, length, width, opacityValue) {
            position.set(x, 0, z);
            quaternion.setFromAxisAngle(UP, heading);
            size.set(length, 1, width);
            mesh.setMatrixAt(index, matrix.compose(position, quaternion, size));
            opacity.array[index] = opacityValue;
        },
        update(dt) {
            foamScroll.x += dt * 0.12;
            mesh.instanceMatrix.needsUpdate = true;
            opacity.needsUpdate = true;
        }
    };
}
