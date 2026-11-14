// The sea: the Water object from the Three.js examples (animated normal map,
// mirror reflection of the sky and ships, fresnel colour change with the angle).

import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';

export function createSea(scene, normalsTexture, sunDirection) {
    normalsTexture.wrapS = normalsTexture.wrapT = THREE.RepeatWrapping;

    // A huge plane so the sea reaches the horizon, far beyond the grid.
    const water = new Water(new THREE.PlaneGeometry(30000, 30000), {
        textureWidth: 512,
        textureHeight: 512,
        waterNormals: normalsTexture,
        sunDirection: sunDirection.clone(),
        sunColor: 0xffd9ae,
        waterColor: 0x00243a,     // deep blue
        distortionScale: 3.2,
        alpha: 0.94,              // slight transparency: sunk hulls stay faintly visible
        fog: true
    });
    water.rotation.x = -Math.PI / 2;
    water.material.transparent = true;
    water.material.uniforms.size.value = 0.28;   // scale of the wave pattern
    water.renderOrder = -10;                      // draw before the other transparent objects
    scene.add(water);

    return {
        update(dt) {
            water.material.uniforms.time.value += dt * 0.55;
        }
    };
}

/**
 * Gentle swell used to make ships float. The Water shader only fakes waves
 * with lighting (the surface is flat), so ships follow this simple function
 * instead: slow sine waves whose phase depends on the position.
 * @returns {{height: number, roll: number, pitch: number}}
 */
export function swellAt(x, z, time) {
    const phase = x * 0.045 + z * 0.06;
    return {
        height: Math.sin(time * 0.9 + phase) * 0.22,
        roll: Math.sin(time * 0.7 + phase * 1.3) * 0.035,
        pitch: Math.sin(time * 0.55 + phase * 0.8) * 0.016
    };
}
