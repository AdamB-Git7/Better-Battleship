// The thunderstorm: sky, light, lightning and rain.
//
//  - Sky: a dome that follows the camera, painted by a shader with layers of
//    moving noise (dark, heavy clouds). Near the horizon it fades into the
//    haze colour, which is also the colour of the distance fog, so the sea
//    melts into the sky.
//  - Light: a dim, cold light from above the clouds. There is no sun.
//  - Lightning: every 6 to 15 seconds a branching bolt strikes somewhere in
//    front of the player. For a few frames it lights the clouds, the sea,
//    the ships, the fog and the bridge (weather.flash), and the thunder
//    follows after a delay that depends on the distance.
//  - Rain: thousands of streaks in a box that follows the camera. They are
//    moved entirely in the vertex shader (one draw call, nothing to update).
//
// Photosensitivity: flashes are short, never pure white, at least 6 seconds
// apart, and replaced by one soft glow when the system asks for reduced motion.

import * as THREE from 'three';
import { weather, updateGust, WIND } from './weather.js';

const HAZE = 0x39434b;                 // horizon and distance fog
const FLASH_COLOR = 0xa9c1ff;          // cold blue-white of lightning
const CLOUD_BASE = 430;                // height where bolts come out of the clouds
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- Sky ------------------------------------------------------------------------

const skyVertex = /* glsl */`
    varying vec3 vDirection;
    void main() {
        vDirection = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const skyFragment = /* glsl */`
    uniform float uTime;
    uniform vec2 uWind;
    uniform vec3 uHaze;
    uniform vec3 uCloudDark;
    uniform vec3 uCloudLight;
    uniform vec3 uFlashColor;
    uniform vec3 uFlashDir;
    uniform float uFlash;
    varying vec3 vDirection;

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
        for (int i = 0; i < 5; i++) {
            value += amplitude * noise(p);
            p = p * 2.07 + 13.1;
            amplitude *= 0.5;
        }
        return value;
    }

    void main() {
        vec3 dir = normalize(vDirection);
        float up = max(dir.y, 0.0);
        // Project the view direction onto a flat cloud ceiling: clouds get
        // smaller and denser towards the horizon, like a real overcast sky.
        vec2 uv = dir.xz / (up + 0.14);
        vec2 drift = uWind * uTime;
        // Two layers moving at different speeds; the first one bends the second.
        float low = fbm(uv * 0.55 + drift * 0.012);
        float high = fbm(uv * 1.5 + drift * 0.03 + low * 1.4);
        float density = smoothstep(0.3, 0.72, low * 0.7 + high * 0.45);
        // Thick cloud is dark underneath; thin places let a little light through.
        vec3 color = mix(uCloudLight, uCloudDark, density);
        color *= 0.75 + 0.5 * high;

        // Lightning inside the clouds: a wide glow, strongest around the bolt,
        // broken up by the cloud shapes.
        float near = pow(max(dot(dir, uFlashDir), 0.0), 5.0);
        color += uFlashColor * uFlash * (0.22 + 1.6 * near) * (0.35 + 0.9 * high);

        // Haze: everything near (and below) the horizon is one flat colour.
        float haze = 1.0 - smoothstep(0.0, 0.3, dir.y);
        color = mix(color, uHaze, haze * haze);

        gl_FragColor = vec4(color, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

// ---- Rain -------------------------------------------------------------------------

const RAIN_COUNT = 9000;
const RAIN_BOX = new THREE.Vector3(90, 60, 90);   // size of the box of rain around the camera

const rainVertex = /* glsl */`
    attribute vec3 seed;         // where the streak starts inside the box (0..1)
    attribute float variation;   // 0..1, different for every streak
    uniform float uTime;
    uniform float uGust;
    uniform vec3 uBox;
    uniform vec3 uVelocity;      // how the rain falls (down + wind)
    uniform vec3 uRoomMin;       // the inside of the bridge: no rain there
    uniform vec3 uRoomMax;
    uniform vec4 uRoof;          // plane of the sloped roof windows (inside = negative)
    uniform float uIndoors;
    varying float vAlpha;
    varying vec2 vCorner;

    void main() {
        vCorner = position.xy;
        // Fall, then wrap around so the streak stays in the box around the camera.
        vec3 fall = uVelocity * (0.85 + 0.3 * variation);
        vec3 offset = mod(seed * uBox + fall * uTime - cameraPosition, uBox) - uBox * 0.5;
        vec3 centre = cameraPosition + offset;
        float dist = length(offset);

        // A flat ribbon along the fall direction, turned to face the camera.
        vec3 along = normalize(fall);
        vec3 side = normalize(cross(along, offset));
        float width = max(0.012, dist * 0.0011);
        float len = (1.6 + 1.6 * variation) * (0.8 + 0.5 * uGust);
        vec3 world = centre + along * position.y * len + side * position.x * width;

        // Fade in close to the eye and out at the edge of the box.
        vAlpha = smoothstep(1.5, 6.0, dist) * (1.0 - smoothstep(30.0, 44.0, dist));
        // In a lull some of the streaks are switched off: lighter rain.
        vAlpha *= step(variation, 0.5 + 0.5 * uGust);

        bool indoors = uIndoors > 0.5
            && all(greaterThan(centre, uRoomMin)) && all(lessThan(centre, uRoomMax))
            && dot(uRoof.xyz, centre) + uRoof.w < 0.0;
        gl_Position = indoors ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(world, 1.0);
    }
`;

const rainFragment = /* glsl */`
    uniform vec3 uColor;
    uniform float uFlash;
    varying float vAlpha;
    varying vec2 vCorner;
    void main() {
        // Soft across the ribbon and at both ends.
        float shape = (1.0 - abs(vCorner.x)) * (1.0 - vCorner.y * vCorner.y * 4.0);
        gl_FragColor = vec4(uColor * (1.0 + uFlash * 3.0), vAlpha * shape * 0.34);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

function createRain() {
    const geometry = new THREE.InstancedBufferGeometry();
    // One thin quad: x = -1..1 across, y = -0.5..0.5 along.
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(
        [-1, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, -1, 0.5, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(RAIN_COUNT * 3);
    const variations = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
        seeds[i * 3] = Math.random();
        seeds[i * 3 + 1] = Math.random();
        seeds[i * 3 + 2] = Math.random();
        variations[i] = Math.random();
    }
    geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 3));
    geometry.setAttribute('variation', new THREE.InstancedBufferAttribute(variations, 1));
    geometry.instanceCount = RAIN_COUNT;

    const material = new THREE.ShaderMaterial({
        vertexShader: rainVertex,
        fragmentShader: rainFragment,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
            uTime: { value: 0 },
            uGust: { value: 0.5 },
            uFlash: { value: 0 },
            uBox: { value: RAIN_BOX },
            uVelocity: { value: new THREE.Vector3() },
            uColor: { value: new THREE.Color(0x93a4b1) },
            uRoomMin: { value: new THREE.Vector3() },
            uRoomMax: { value: new THREE.Vector3() },
            uRoof: { value: new THREE.Vector4(0, 1, 0, 0) },
            uIndoors: { value: 0 }
        }
    });
    const rain = new THREE.Mesh(geometry, material);
    rain.frustumCulled = false;   // the streaks are placed in the shader
    rain.renderOrder = 7;
    return rain;
}

// ---- Lightning bolt ---------------------------------------------------------------

const MAX_SEGMENTS = 160;

const boltVertex = /* glsl */`
    attribute vec2 edge;     // x = -1..1 across the ribbon, y = brightness of this branch
    varying vec2 vEdge;
    void main() {
        vEdge = edge;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const boltFragment = /* glsl */`
    uniform vec3 uColor;
    uniform float uPower;
    varying vec2 vEdge;
    void main() {
        // A thin white-hot core inside a wider, softer glow.
        float across = 1.0 - abs(vEdge.x);
        float glow = across * across * 0.35 + smoothstep(0.72, 0.95, across);
        gl_FragColor = vec4(uColor * glow * vEdge.y * uPower, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

function createBolt() {
    const positions = new Float32Array(MAX_SEGMENTS * 6 * 3);
    const edges = new Float32Array(MAX_SEGMENTS * 6 * 2);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('edge', new THREE.BufferAttribute(edges, 2));
    geometry.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
        vertexShader: boltVertex,
        fragmentShader: boltFragment,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
            uColor: { value: new THREE.Color(0xc4d4ff) },
            uPower: { value: 0 }
        }
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;   // behind the fog bank and the rain
    mesh.visible = false;

    let count = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const side = new THREE.Vector3();
    const toEye = new THREE.Vector3();

    /** Adds one straight piece of the bolt as a ribbon facing the camera. */
    function segment(from, to, halfWidth, brightness, eye) {
        if (count >= MAX_SEGMENTS) {
            return;
        }
        side.subVectors(to, from).cross(toEye.subVectors(eye, from)).normalize().multiplyScalar(halfWidth);
        const corners = [
            [from, -1], [from, 1], [to, 1],
            [from, -1], [to, 1], [to, -1]
        ];
        corners.forEach(([point, sign], i) => {
            const index = count * 6 + i;
            positions[index * 3] = point.x + side.x * sign;
            positions[index * 3 + 1] = point.y + side.y * sign;
            positions[index * 3 + 2] = point.z + side.z * sign;
            edges[index * 2] = sign;
            edges[index * 2 + 1] = brightness;
        });
        count++;
    }

    /** A jagged path from `start` towards `end`; may fork into thinner branches. */
    function path(start, end, steps, jitter, halfWidth, brightness, eye, forks) {
        a.copy(start);
        for (let i = 1; i <= steps; i++) {
            b.lerpVectors(start, end, i / steps);
            if (i < steps) {
                b.x += (Math.random() - 0.5) * jitter;
                b.y += (Math.random() - 0.5) * jitter * 0.4;
                b.z += (Math.random() - 0.5) * jitter;
            }
            segment(a, b, halfWidth, brightness, eye);
            if (forks > 0 && i > 2 && i < steps - 2 && Math.random() < 0.3) {
                // A branch leaves sideways and dies before reaching the sea.
                const length = (start.y - end.y) * (0.15 + Math.random() * 0.25);
                const angle = Math.random() * Math.PI * 2;
                const from = b.clone();
                const to = new THREE.Vector3(
                    from.x + Math.cos(angle) * length * 0.8, from.y - length, from.z + Math.sin(angle) * length * 0.8);
                const keep = b.clone();
                path(from, to, 7, jitter * 0.6, halfWidth * 0.45, brightness * 0.5, eye, forks - 1);
                b.copy(keep);
            }
            a.copy(b);
        }
    }

    /** Builds a new bolt that hits the sea at `target`, seen from `eye`. */
    function strike(target, eye) {
        count = 0;
        const distance = target.distanceTo(eye);
        const start = new THREE.Vector3(
            target.x + (Math.random() - 0.5) * 220, CLOUD_BASE, target.z + (Math.random() - 0.5) * 220);
        path(start, target, 26, 34, distance * 0.007, 1, eye, 2);
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.edge.needsUpdate = true;
        geometry.setDrawRange(0, count * 6);
        mesh.visible = true;
        return start;
    }

    return { mesh, material, strike };
}

// ---- Everything together ----------------------------------------------------------

/**
 * @param sound used for the thunder
 * @returns {{ update(dt, time, camera), setRoom(box, roof) }}
 */
export function createStorm(scene, renderer, sound) {
    const haze = new THREE.Color(HAZE);
    const hazeNow = new THREE.Color(HAZE);     // the haze brightens during a flash
    const flashColor = new THREE.Color(FLASH_COLOR);

    // ---- Sky dome ----
    const skyUniforms = {
        uTime: { value: 0 },
        uWind: { value: WIND },
        uHaze: { value: hazeNow },
        uCloudDark: { value: new THREE.Color(0x06090c) },
        uCloudLight: { value: new THREE.Color(0x6a757e) },
        uFlashColor: { value: flashColor },
        uFlashDir: { value: weather.flashDirection },
        uFlash: { value: 0 }
    };
    const sky = new THREE.Mesh(
        new THREE.SphereGeometry(14000, 32, 16),
        new THREE.ShaderMaterial({
            vertexShader: skyVertex, fragmentShader: skyFragment, uniforms: skyUniforms,
            side: THREE.BackSide, depthWrite: false, depthTest: false
        })
    );
    sky.renderOrder = -100;       // painted first, everything else goes over it
    sky.frustumCulled = false;

    // Bake the storm sky into an environment map, so the wet hulls reflect
    // the same dark clouds instead of a sunny default.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky);
    scene.environment = pmrem.fromScene(envScene, 0, 1, 20000).texture;
    pmrem.dispose();
    scene.add(sky);

    // Distance haze, the same colour as the bottom of the sky.
    scene.fog = new THREE.FogExp2(HAZE, 0.0011);
    scene.fog.color = hazeNow;

    // ---- Light ----
    // "moon" is the little daylight left under the clouds; during a strike it
    // becomes the lightning itself (it jumps to the bolt and turns bright).
    const calmDirection = new THREE.Vector3(-0.35, 0.8, -0.45).normalize();
    const calmColor = new THREE.Color(0x8ea2b8);
    const moon = new THREE.DirectionalLight(calmColor, 1.5);
    moon.position.copy(calmDirection).multiplyScalar(500);
    scene.add(moon);
    const ambient = new THREE.HemisphereLight(0x7d8c9b, 0x10181c, 2.4);
    scene.add(ambient);

    // ---- Rain and bolt ----
    const rain = createRain();
    scene.add(rain);
    const bolt = createBolt();
    scene.add(bolt.mesh);

    // ---- Lightning timing ----
    // A strike is a few very short pulses (the bolt flickers), then darkness.
    let nextStrike = 4 + Math.random() * 4;     // the first one comes early, to set the mood
    let strikeAge = -1;                         // seconds since the current strike began, -1 = none
    let strikePower = 0;
    let pulses = [];
    const boltTop = new THREE.Vector3();
    const target = new THREE.Vector3();

    function startStrike(camera) {
        // Somewhere in the half of the world the player is looking at (north).
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
        const distance = 520 + Math.random() * 1100;
        target.set(camera.position.x + Math.cos(angle) * distance, 0, Math.min(camera.position.z, 150) + Math.sin(angle) * distance);
        boltTop.copy(bolt.strike(target, camera.position));
        weather.flashDirection.subVectors(boltTop, camera.position).normalize();
        const heard = target.distanceTo(camera.position);
        strikePower = THREE.MathUtils.clamp(1.25 - heard / 1700, 0.4, 1);
        strikeAge = 0;
        pulses = reducedMotion
            ? []
            : [{ at: 0, amp: 1 }, { at: 0.11 + Math.random() * 0.05, amp: 0.55 }, { at: 0.24 + Math.random() * 0.08, amp: 0.8 }];
        sound.thunder(heard);
    }

    /** Brightness 0..1 of the strike, `age` seconds after it began. */
    function strikeLevel(age) {
        if (reducedMotion) {
            // One slow, soft glow instead of flicker.
            return age < 1.2 ? 0.3 * Math.sin((age / 1.2) * Math.PI) : 0;
        }
        let level = 0;
        for (const pulse of pulses) {
            if (age >= pulse.at) {
                level = Math.max(level, pulse.amp * Math.exp(-(age - pulse.at) / 0.075));
            }
        }
        return level;
    }

    function update(dt, time, camera) {
        updateGust(time);

        // ---- Lightning ----
        nextStrike -= dt;
        if (nextStrike <= 0 && strikeAge < 0) {
            startStrike(camera);
            nextStrike = 6 + Math.random() * 9;
        }
        let level = 0;
        if (strikeAge >= 0) {
            strikeAge += dt;
            level = strikeLevel(strikeAge) * strikePower;
            if (strikeAge > 1.3) {
                strikeAge = -1;
                bolt.mesh.visible = false;
            }
        }
        weather.flash = level;
        bolt.material.uniforms.uPower.value = reducedMotion ? level * 3 : Math.min(1, level * 2.2) * 5;

        // Light: calm most of the time; during a flash it comes from the bolt.
        if (level > 0.02) {
            moon.position.copy(weather.flashDirection).multiplyScalar(500);
            moon.color.copy(flashColor);
        } else {
            moon.position.copy(calmDirection).multiplyScalar(500);
            moon.color.copy(calmColor);
        }
        moon.intensity = 1.5 + level * 9;
        ambient.intensity = 2.4 + level * 3.5;
        scene.environmentIntensity = 1 + level * 5;
        hazeNow.copy(haze).lerp(flashColor, level * 0.35);

        // ---- Sky and rain follow the camera ----
        sky.position.copy(camera.position);
        skyUniforms.uTime.value = time;
        skyUniforms.uFlash.value = level;
        const uniforms = rain.material.uniforms;
        uniforms.uTime.value = time;
        uniforms.uGust.value = weather.gust;
        uniforms.uFlash.value = level;
        // The harder the wind, the more the rain leans.
        const push = 16 + 26 * weather.gust;
        uniforms.uVelocity.value.set(WIND.x * push, -62, WIND.y * push);
    }

    /**
     * Tells the rain where the inside of the bridge is, so it never falls
     * through the room (null = the camera is outside).
     * @param box THREE.Box3 of the room, in world coordinates
     * @param roof THREE.Plane of the sloped roof windows (the room is on its negative side)
     */
    /** Strikes at once (used by the ?debug hook to test the lightning). */
    function strikeNow() {
        nextStrike = 0;
    }

    function setRoom(box, roof) {
        const uniforms = rain.material.uniforms;
        uniforms.uIndoors.value = box ? 1 : 0;
        if (box) {
            uniforms.uRoomMin.value.copy(box.min);
            uniforms.uRoomMax.value.copy(box.max);
            uniforms.uRoof.value.set(roof.normal.x, roof.normal.y, roof.normal.z, roof.constant);
        }
    }

    return { update, setRoom, strikeNow };
}
