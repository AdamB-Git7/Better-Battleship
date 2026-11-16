// Two kinds of big, cheap "pictures" that always face the camera, for the
// things the particles cannot do well far away:
//
//  - Smoke pillars: the huge columns of black smoke that rise from a burning
//    harbour or a burning tanker into the clouds. A particle column that tall
//    would need hundreds of particles; here it is ONE flat sheet whose shader
//    scrolls a cloudy noise upwards, widens with height and leans downwind.
//  - Glows: soft discs of light (the fire under a smoke pillar, a burning town
//    lighting the clouds, the lamp of the lighthouse). They flicker slowly and
//    smoothly (two slow sine waves): never a flash, never a strobe.
//
// All pillars are one draw call and all glows are one draw call (instancing).
// Both feel only a part of the distance haze, so they can stand on the
// horizon and still be seen, like the dark ships of the far squadrons.

import * as THREE from 'three';
import { cloudNoiseTexture } from './textures.js';
import { weather, WIND } from './weather.js';

const pillarVertex = /* glsl */`
    attribute vec3 aBase;      // where the column stands, on the water
    attribute vec4 aShape;     // width at the foot, height, seed, strength (0..1)
    uniform vec2 uLean;        // how far the top is blown away, per unit of height
    varying vec2 vUv;
    varying vec3 vShape;
    varying float vDepth;
    void main() {
        vUv = uv;
        vShape = aShape.yzw;
        float up = position.y;                                   // 0 at the foot, 1 at the top
        vec2 toEye = cameraPosition.xz - aBase.xz;
        vec2 side = normalize(vec2(-toEye.y, toEye.x));          // across the line of sight
        float width = aShape.x * (0.45 + 2.2 * up);              // the column spreads as it rises
        vec3 world = aBase + vec3(side.x, 0.0, side.y) * position.x * width;
        world.y += up * aShape.y;
        world.xz += uLean * pow(up, 1.5) * aShape.y;             // bent by the wind, more and more
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        vDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
    }
`;
const pillarFragment = /* glsl */`
    uniform sampler2D uNoise;
    uniform float uTime;
    uniform float uFlash;
    uniform float uHaze;
    uniform vec3 fogColor;
    uniform float fogDensity;
    varying vec2 vUv;
    varying vec3 vShape;       // height, seed, strength
    varying float vDepth;
    void main() {
        float seed = vShape.y;
        float tall = vShape.x / 160.0;
        // Two layers of noise climbing at different speeds: billows that roll upwards.
        float big = min(1.0, 1.9 * texture2D(uNoise, vec2(vUv.x * 0.5 + seed, vUv.y * tall * 0.7 - uTime * 0.035 + seed * 3.0)).r);
        float fine = min(1.0, 1.9 * texture2D(uNoise, vec2(vUv.x * 1.1 - seed, vUv.y * tall * 1.6 - uTime * 0.06)).r);
        float middle = 1.0 - abs(vUv.x * 2.0 - 1.0);             // 1 on the axis of the column, 0 at its edges
        float body = smoothstep(0.08, 0.75, middle + (big - 0.5) * 0.9 + (fine - 0.5) * 0.35);
        float foot = smoothstep(0.0, 0.03, vUv.y);
        float top = 1.0 - smoothstep(0.45, 1.0, vUv.y);          // it thins out into the clouds
        float alpha = body * foot * top * (0.7 + 0.3 * fine) * vShape.z;
        // Nearly black, a little lighter where the smoke is thin; orange at the
        // foot, where the fire lights it from below; grey when lightning strikes.
        vec3 color = mix(vec3(0.012, 0.012, 0.014), vec3(0.05, 0.052, 0.058), fine);
        color += vec3(1.0, 0.36, 0.08) * pow(1.0 - vUv.y, 16.0) * (0.15 + 0.4 * big);
        color += vec3(0.5, 0.56, 0.7) * uFlash * 0.22 * (0.4 + fine);
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        float depth = vDepth * uHaze;
        float haze = 1.0 - exp(-fogDensity * fogDensity * depth * depth);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, haze);
    }
`;

const glowVertex = /* glsl */`
    attribute vec3 aBase;      // centre of the glow
    attribute vec4 aLook;      // size, brightness, seed, how much it flickers (0..1)
    attribute vec3 aColor;
    uniform float uTime;
    varying vec2 vUv;
    varying vec3 vColor;
    varying float vDepth;
    void main() {
        vUv = uv * 2.0 - 1.0;
        // Two slow sine waves that never line up: the glow of a fire breathes.
        float flicker = 1.0 + aLook.w * (0.16 * sin(uTime * 2.3 + aLook.z * 40.0) + 0.1 * sin(uTime * 3.7 + aLook.z * 91.0));
        vColor = aColor * aLook.y * flicker;
        vec4 mvPosition = viewMatrix * vec4(aBase, 1.0);
        mvPosition.xy += position.xy * aLook.x;                  // a square that faces the camera
        vDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
    }
`;
const glowFragment = /* glsl */`
    uniform float uHaze;
    uniform float fogDensity;
    varying vec2 vUv;
    varying vec3 vColor;
    varying float vDepth;
    void main() {
        float r = dot(vUv, vUv);
        float shape = exp(-r * 4.5) * (1.0 - smoothstep(0.7, 1.0, r));   // bright heart, wide soft halo
        float depth = vDepth * uHaze;
        float haze = 1.0 - exp(-fogDensity * fogDensity * depth * depth);
        gl_FragColor = vec4(vColor * shape * (1.0 - 0.75 * haze), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

/** Copies a plane into an instanced geometry with room for `capacity` copies. */
function instancedPlane(plane, capacity, attributes) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = plane.index;
    geometry.setAttribute('position', plane.attributes.position);
    geometry.setAttribute('uv', plane.attributes.uv);
    const arrays = {};
    for (const [name, itemSize] of Object.entries(attributes)) {
        arrays[name] = new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize).setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(name, arrays[name]);
    }
    geometry.instanceCount = 0;
    return { geometry, arrays };
}

/**
 * @param haze how much of the distance haze they feel (1 = all of it)
 * @returns {{ addPillar(...), addGlow(...), setGlow(index, brightness), moveGlow(index, x, y, z), update(time) }}
 */
export function createBillboards(scene, { maxPillars = 12, maxGlows = 40, haze = 0.5 } = {}) {
    const fogUniforms = () => THREE.UniformsUtils.clone(THREE.UniformsLib.fog);

    // ---- Smoke pillars ----
    const pillarPlane = new THREE.PlaneGeometry(1, 1, 1, 14).translate(0, 0.5, 0);   // y from 0 (foot) to 1 (top)
    const pillars = instancedPlane(pillarPlane, maxPillars, { aBase: 3, aShape: 4 });
    const lean = new THREE.Vector2();
    const pillarMaterial = new THREE.ShaderMaterial({
        vertexShader: pillarVertex,
        fragmentShader: pillarFragment,
        uniforms: {
            ...fogUniforms(),
            uNoise: { value: cloudNoiseTexture() },
            uTime: { value: 0 },
            uFlash: { value: 0 },
            uHaze: { value: haze },
            uLean: { value: lean }
        },
        fog: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide          // the sheet turns with the camera: either face may be the one we see
    });
    const pillarMesh = new THREE.Mesh(pillars.geometry, pillarMaterial);
    pillarMesh.frustumCulled = false;   // the shader places the sheets
    pillarMesh.renderOrder = -4;        // far away: drawn before the fog bank, the rain and the particles
    scene.add(pillarMesh);

    // ---- Glows ----
    const glowPlane = new THREE.PlaneGeometry(1, 1);
    const glows = instancedPlane(glowPlane, maxGlows, { aBase: 3, aLook: 4, aColor: 3 });
    const glowMaterial = new THREE.ShaderMaterial({
        vertexShader: glowVertex,
        fragmentShader: glowFragment,
        uniforms: { ...fogUniforms(), uTime: { value: 0 }, uHaze: { value: haze } },
        fog: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
    });
    const glowMesh = new THREE.Mesh(glows.geometry, glowMaterial);
    glowMesh.frustumCulled = false;
    glowMesh.renderOrder = -3;
    scene.add(glowMesh);

    const tint = new THREE.Color();

    return {
        /**
         * A column of smoke standing at (x, y, z).
         * @param width at the foot (it gets about 2.5 times wider at the top)
         * @param strength 0..1 how thick the smoke is
         */
        addPillar(x, y, z, width, height, strength = 1) {
            const index = pillars.geometry.instanceCount++;
            pillars.arrays.aBase.setXYZ(index, x, y, z);
            pillars.arrays.aShape.setXYZW(index, width, height, Math.random(), strength);
            return index;
        },
        /**
         * A soft disc of light centred on (x, y, z).
         * @param size width of the whole halo, in world units
         * @param brightness 1 = a strong fire
         * @param flicker 0 = steady (a lamp), 1 = a fire
         * @returns its number, for setGlow / moveGlow
         */
        addGlow(x, y, z, size, color, brightness = 1, flicker = 1) {
            const index = glows.geometry.instanceCount++;
            glows.arrays.aBase.setXYZ(index, x, y, z);
            glows.arrays.aLook.setXYZW(index, size, brightness, Math.random(), flicker);
            tint.set(color);
            glows.arrays.aColor.setXYZ(index, tint.r, tint.g, tint.b);
            return index;
        },
        setGlow(index, brightness) {
            glows.arrays.aLook.setY(index, brightness);
            glows.arrays.aLook.needsUpdate = true;
        },
        moveGlow(index, x, y, z) {
            glows.arrays.aBase.setXYZ(index, x, y, z);
            glows.arrays.aBase.needsUpdate = true;
        },
        update(time) {
            pillarMaterial.uniforms.uTime.value = time;
            pillarMaterial.uniforms.uFlash.value = weather.flash;
            glowMaterial.uniforms.uTime.value = time;
            // A gust bends the columns further over.
            lean.copy(WIND).multiplyScalar(0.3 + 0.25 * weather.gust);
        }
    };
}
