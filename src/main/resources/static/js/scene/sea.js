// The stormy sea.
//
// The old sea was a flat mirror with a wave picture on it. This one has real
// waves: the surface is a big grid of triangles that is pushed up and down in
// the vertex shader by a sum of sharp-crested waves, and the fragment shader
// paints it: dark green-grey water, the storm sky reflected at low angles,
// foam on the crests, wind streaks, rain pocks, and the glow of lightning,
// explosions and fires.
//
// The same wave formula exists twice, generated from one table (WAVES):
//  - in GLSL (WAVE_GLSL), for the sea itself and for anything that must lie
//    on the water (grid lines, wakes),
//  - in JavaScript (waveHeight / swellAt), so ships, markers and fires ride
//    the very same surface.

import * as THREE from 'three';
import { weather, WIND } from './weather.js';

// One line per wave: length (crest to crest), height (amplitude), direction
// (radians away from the wind) and sharpness (1 = sine, higher = peaked crest).
// The first FOUR really move the surface. The rest are too short for the
// triangle grid, so they only change the lighting (the "chop").
const WAVES = [
    { length: 150, amp: 1.05, turn: 0.0, sharp: 1.5 },
    { length: 88, amp: 0.62, turn: 0.38, sharp: 1.7 },
    { length: 53, amp: 0.4, turn: -0.5, sharp: 2.0 },
    { length: 33, amp: 0.24, turn: 0.75, sharp: 2.2 },
    { length: 19, amp: 0.15, turn: -1.0, sharp: 2.0 },
    { length: 11.5, amp: 0.09, turn: 0.25, sharp: 2.0 },
    { length: 6.7, amp: 0.05, turn: 1.3, sharp: 1.8 },
    { length: 3.9, amp: 0.028, turn: -0.6, sharp: 1.6 }
];
const SURFACE_WAVES = 4;

const windAngle = Math.atan2(WIND.y, WIND.x);
const waves = WAVES.map((wave, index) => {
    const k = (Math.PI * 2) / wave.length;                 // wave number
    return {
        ...wave,
        k,
        dx: Math.cos(windAngle + wave.turn),
        dz: Math.sin(windAngle + wave.turn),
        omega: k * 1.3 * Math.sqrt(wave.length),           // long waves travel faster
        phase: index * 1.7,
        // A gust raises the short waves a lot and the long swell a little.
        chopBase: index < 2 ? 0.88 : 0.7,
        chopGain: index < 2 ? 0.24 : 0.6
    };
});

/**
 * Uniforms shared by every material that lies on the water (the sea, the grid
 * lines, the wakes): the clock, the gust and the lightning flash.
 */
export const seaUniforms = {
    uTime: { value: 0 },
    uChop: { value: 0.5 },
    uFlash: { value: 0 }
};

const f = value => value.toFixed(5);

function waveTermGlsl(wave) {
    return `{
        float th = dot(p, vec2(${f(wave.dx)}, ${f(wave.dz)})) * ${f(wave.k)} - uTime * ${f(wave.omega)} + ${f(wave.phase)};
        float s = sin(th) * 0.5 + 0.5;
        float a = ${f(wave.amp)} * (${f(wave.chopBase)} + ${f(wave.chopGain)} * uChop);
        r.x += a * (2.0 * pow(s, ${f(wave.sharp)}) - 1.0);
        r.yz += a * ${f(wave.sharp)} * pow(s, ${f(wave.sharp - 1)}) * cos(th) * ${f(wave.k)} * vec2(${f(wave.dx)}, ${f(wave.dz)});
    }`;
}

/**
 * GLSL: waveSurface(p) returns (height, slope along x, slope along z) of the
 * moving surface at the sea position p; waveChop(p) the same for the short waves.
 */
export const WAVE_GLSL = /* glsl */`
    uniform float uTime;
    uniform float uChop;
    vec3 waveSurface(vec2 p) {
        vec3 r = vec3(0.0);
        ${waves.slice(0, SURFACE_WAVES).map(waveTermGlsl).join('\n')}
        return r;
    }
    vec3 waveChop(vec2 p) {
        vec3 r = vec3(0.0);
        ${waves.slice(SURFACE_WAVES).map(waveTermGlsl).join('\n')}
        return r;
    }
`;

// ---- The same waves in JavaScript ---------------------------------------------

const sample = { height: 0, slopeX: 0, slopeZ: 0 };

/** Fills `sample` with the height and slopes of the surface waves. */
function sampleWaves(x, z, time, weightOfShort) {
    const chop = seaUniforms.uChop.value;
    sample.height = sample.slopeX = sample.slopeZ = 0;
    for (let i = 0; i < SURFACE_WAVES; i++) {
        const wave = waves[i];
        const theta = (x * wave.dx + z * wave.dz) * wave.k - time * wave.omega + wave.phase;
        const s = Math.sin(theta) * 0.5 + 0.5;
        const amp = wave.amp * (wave.chopBase + wave.chopGain * chop) * (i < 2 ? 1 : weightOfShort);
        sample.height += amp * (2 * Math.pow(s, wave.sharp) - 1);
        const slope = amp * wave.sharp * Math.pow(s, wave.sharp - 1) * Math.cos(theta) * wave.k;
        sample.slopeX += slope * wave.dx;
        sample.slopeZ += slope * wave.dz;
    }
    return sample;
}

/** Exact height of the water at a point: used by markers, splashes and fires. */
export function waveHeight(x, z, time) {
    return sampleWaves(x, z, time, 1).height;
}

const swell = { height: 0, roll: 0, pitch: 0 };

/**
 * How a ship floats at (x, z): it rides the long swell (a hull is too long to
 * follow every small wave) and leans with the slope of the water under it.
 * @param heading rotation.y of the ship (0 = bow towards +x)
 * @returns {{height: number, roll: number, pitch: number}} a shared object: read it at once
 */
export function swellAt(x, z, time, heading = 0) {
    const s = sampleWaves(x, z, time, 0.45);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const alongBow = s.slopeX * cos - s.slopeZ * sin;     // slope towards the bow
    const acrossBeam = s.slopeX * sin + s.slopeZ * cos;   // slope towards starboard
    swell.height = s.height * 0.85;
    swell.pitch = Math.atan(alongBow) * 0.8;
    // Ships roll more than the water slopes (and more in a gust), and keep
    // rocking a little between two waves.
    swell.roll = -Math.atan(acrossBeam) * (1.5 + 0.6 * weather.gust)
        + Math.sin(time * 0.9 + x * 0.05 + z * 0.07) * 0.02;
    return swell;
}

// ---- The sea mesh ---------------------------------------------------------------

// Explosions and fires that light the water: slots 0..3 belong to the player's
// own battle (effects.js), slots 4..5 to the battle in the background
// (battleFx.js), slot 6 to burning oil where a ship went down (sinking.js).
const MAX_GLOWS = 7;

/**
 * A square grid that is fine near the battlefield and stretches to the
 * horizon: the corner positions follow x = a*u + b*u^7, so the middle is
 * regular (about 4 units per triangle) and the outside grows very fast.
 */
function seaGeometry() {
    const segments = 300;
    const warp = u => 560 * u + 12000 * Math.pow(u, 7);
    const positions = new Float32Array((segments + 1) * (segments + 1) * 3);
    let offset = 0;
    for (let j = 0; j <= segments; j++) {
        for (let i = 0; i <= segments; i++) {
            positions[offset++] = warp(-1 + (2 * i) / segments);
            positions[offset++] = 0;
            positions[offset++] = warp(-1 + (2 * j) / segments);
        }
    }
    const indices = new Uint32Array(segments * segments * 6);
    offset = 0;
    for (let j = 0; j < segments; j++) {
        for (let i = 0; i < segments; i++) {
            const a = j * (segments + 1) + i;
            const b = a + segments + 1;
            indices.set([a, b, a + 1, a + 1, b, b + 1], offset);
            offset += 6;
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    return geometry;
}

const vertexShader = /* glsl */`
    ${WAVE_GLSL}
    varying vec3 vWorld;
    varying float vLift;       // 1 near the battlefield, 0 where the surface is flat
    #include <fog_pars_vertex>
    void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        // Far away the triangles are too big for waves: flatten the surface there.
        vLift = 1.0 - smoothstep(420.0, 1200.0, length(world.xz));
        world.y += waveSurface(world.xz).x * vLift;
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
    }
`;

const fragmentShader = /* glsl */`
    ${WAVE_GLSL}
    uniform sampler2D uNormals;
    uniform vec3 uDeep;          // colour of deep water
    uniform vec3 uScatter;       // light coming through the crests
    uniform vec3 uHorizon;       // sky colours, for the reflection
    uniform vec3 uZenith;
    uniform vec3 uFoam;
    uniform vec3 uFlashColor;
    uniform vec3 uFlashDir;
    uniform float uFlash;
    uniform vec2 uWind;
    uniform vec4 uGlow[${MAX_GLOWS}];      // xyz = position, w = strength
    uniform vec3 uGlowColor;
    varying vec3 vWorld;
    varying float vLift;
    #include <fog_pars_fragment>

    void main() {
        vec2 p = vWorld.xz;
        vec3 toEye = cameraPosition - vWorld;
        float dist = length(toEye);
        vec3 V = toEye / dist;

        // ---- Shape of the surface at this pixel ----
        vec3 big = waveSurface(p);
        vec3 chop = waveChop(p);
        // The short waves are dropped quickly with distance: seen from far away
        // they would only make a shimmering checker pattern.
        float chopFade = 1.0 - smoothstep(50.0, 420.0, dist);
        vec2 slope = big.yz * (1.0 - smoothstep(1500.0, 6000.0, dist)) + chop.yz * chopFade;
        // Fine ripples: two copies of a normal map sliding with the wind.
        vec2 drift = uWind * uTime;
        vec3 n1 = texture2D(uNormals, p * 0.019 + drift * 0.016).xyz;
        vec3 n2 = texture2D(uNormals, p * 0.047 - drift.yx * 0.021 + 0.37).xyz;
        vec2 ripple = (n1.xy + n2.xy - 1.0) * (0.55 / (1.0 + dist * 0.0025));
        // Rain: a fast flicker of tiny dents, only near the camera.
        vec2 pock = texture2D(uNormals, p * 0.31 + floor(uTime * 14.0) * vec2(0.37, 0.61)).xy - 0.5;
        ripple += pock * 0.5 * (1.0 - smoothstep(20.0, 260.0, dist));
        vec3 N = normalize(vec3(-slope.x - ripple.x, 1.0, -slope.y - ripple.y));

        // ---- Water colour ----
        float height = big.x * vLift;
        float facing = max(dot(N, V), 0.0);
        float fresnel = 0.025 + 0.975 * pow(1.0 - facing, 5.0);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        float towardsFlash = max(dot(R, uFlashDir), 0.0);
        vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, R.y));
        sky += uFlashColor * uFlash * (0.35 + 2.2 * pow(towardsFlash, 12.0));
        // Crests are thinner, so more light comes through them.
        float crest = smoothstep(-0.4, 1.7, height + chop.x * 2.0);
        vec3 body = mix(uDeep, uScatter, crest * crest * 0.55);
        // The dim daylight comes from one side: wave faces turned to it are
        // lighter, the others darker. This is what shows the waves from above.
        float lit = clamp(1.0 - dot(slope + ripple * 0.25, vec2(0.5, 0.75)) * 2.6, 0.25, 2.0);
        body *= lit * (1.0 + uFlash * 1.5);
        // A rough sea always reflects a little sky, even seen from straight above.
        vec3 color = mix(body, sky, max(fresnel, 0.14));

        // ---- Foam ----
        float noiseA = texture2D(uNormals, p * 0.031 + drift * 0.03).r;
        float noiseB = texture2D(uNormals, p * 0.113 - drift * 0.06).g;
        float patchy = noiseA * noiseB * 2.2;
        // Whitecaps: small, broken, and only where the waves peak...
        float caps = smoothstep(0.5, 1.0, height * 0.5 + chop.x * 2.6 + 0.15 * uChop) * smoothstep(0.3, 0.75, patchy);
        // ...and long streaks of foam blown along the wind.
        vec2 along = vec2(dot(p, uWind), dot(p, vec2(-uWind.y, uWind.x)));
        float streaks = texture2D(uNormals, along * vec2(0.0035, 0.045) + vec2(uTime * 0.012, 0.0)).r;
        streaks = smoothstep(0.6, 0.85, streaks * (0.75 + noiseB * 0.5)) * 0.13;
        float foam = clamp(caps * (0.5 + 0.5 * noiseB) + streaks, 0.0, 1.0);
        foam *= 1.0 - smoothstep(900.0, 2600.0, dist);
        color = mix(color, uFoam * (1.0 + uFlash * 2.5), foam * 0.85);

        // ---- Fires and explosions shining on the water ----
        for (int i = 0; i < ${MAX_GLOWS}; i++) {
            vec3 L = uGlow[i].xyz - vWorld;
            float d2 = dot(L, L);
            float shine = pow(max(dot(R, normalize(L)), 0.0), 5.0);
            color += uGlowColor * uGlow[i].w * (0.12 + shine) / (1.0 + d2 * 0.0035);
        }

        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
    }
`;

export function createSea(scene, normalsTexture) {
    normalsTexture.wrapS = normalsTexture.wrapT = THREE.RepeatWrapping;

    const glows = [];
    for (let i = 0; i < MAX_GLOWS; i++) {
        glows.push(new THREE.Vector4(0, 0, 0, 0));
    }
    const material = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        fog: true,
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            ...seaUniforms,
            uNormals: { value: normalsTexture },
            uDeep: { value: new THREE.Color(0x15323b) },
            uScatter: { value: new THREE.Color(0x24554e) },
            uHorizon: { value: new THREE.Color(0x66737c) },
            uZenith: { value: new THREE.Color(0x2a333a) },
            uFoam: { value: new THREE.Color(0x7d898e) },
            uFlashColor: { value: new THREE.Color(0xa9c1ff) },
            uFlashDir: { value: weather.flashDirection },
            uWind: { value: WIND },
            uGlow: { value: glows },
            uGlowColor: { value: new THREE.Color(0xff7a2a) }
        }
    });
    const sea = new THREE.Mesh(seaGeometry(), material);
    sea.frustumCulled = false;   // the vertices move in the shader
    sea.renderOrder = -10;
    scene.add(sea);

    return {
        /** time is the scene clock; the gust and the flash come from weather.js. */
        update(time) {
            seaUniforms.uTime.value = time;
            seaUniforms.uChop.value = weather.gust;
            seaUniforms.uFlash.value = weather.flash;
        },
        /**
         * Makes a fire or an explosion shine on the water.
         * @param index 0..6 (see MAX_GLOWS for who owns which slot)
         * @param strength 0 = off
         */
        setGlow(index, position, strength) {
            glows[index].set(position.x, position.y, position.z, strength);
        }
    };
}
