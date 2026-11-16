// Beams of light in the rain: searchlights sweeping the clouds and the beam
// of the lighthouse.
//
// A beam is a long, hollow cone drawn with additive blending. The shader makes
// it bright where we look through the middle of the cone and invisible at its
// edges, which is what makes a hollow cone look like a shaft of light. It
// fades along its length and in the haze. No real light is created: a beam
// lights nothing, it is only seen.

import * as THREE from 'three';

const beamVertex = /* glsl */`
    varying float vAlong;     // 0 at the lamp, 1 at the far end
    varying vec3 vNormal;
    varying vec3 vToEye;
    varying float vDepth;
    void main() {
        vAlong = position.y;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalMatrix * normal;
        vToEye = -mvPosition.xyz;
        vDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
    }
`;
const beamFragment = /* glsl */`
    uniform vec3 uColor;
    uniform float uPower;
    uniform float uHaze;      // how much of the distance haze the beam feels (1 = all of it)
    uniform float fogDensity;
    varying float vAlong;
    varying vec3 vNormal;
    varying vec3 vToEye;
    varying float vDepth;
    void main() {
        // Bright where we look through the middle of the cone, nothing at its
        // edges: that is what makes a hollow cone look like a beam in the rain.
        float through = abs(dot(normalize(vNormal), normalize(vToEye)));
        float alpha = through * through * pow(1.0 - vAlong, 1.5) * uPower;
        float depth = vDepth * uHaze;
        alpha *= 1.0 - 0.7 * (1.0 - exp(-fogDensity * fogDensity * depth * depth));
        gl_FragColor = vec4(uColor * alpha, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

// A cone 1 unit long along +y, with its point (the lamp) at the origin.
const beamGeometry = new THREE.CylinderGeometry(1, 0.05, 1, 16, 1, true).translate(0, 0.5, 0);

/**
 * A material for beams; every beam made with the same material has the same colour and strength.
 * @param power brightness (0.085 = a searchlight seen from a few hundred units)
 * @param haze 1 = fades in the haze like everything else, less = still seen from far away
 */
export function beamMaterial(power = 0.085, color = 0xcfe0ff, haze = 1) {
    return new THREE.ShaderMaterial({
        vertexShader: beamVertex,
        fragmentShader: beamFragment,
        uniforms: {
            ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
            uColor: { value: new THREE.Color(color) },
            uPower: { value: power },
            uHaze: { value: haze }
        },
        fog: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
    });
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * One beam. Move its lamp with mesh.position and aim it with point().
 * @param length how far the light reaches
 * @param radius how wide the cone is at its far end
 */
export function createBeam(material, length, radius = 24) {
    const mesh = new THREE.Mesh(beamGeometry, material);
    mesh.scale.set(radius, length, radius);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    return {
        mesh,
        /** Aims the beam along a direction (a vector of length 1). */
        point(direction) {
            mesh.quaternion.setFromUnitVectors(UP, direction);
        }
    };
}
