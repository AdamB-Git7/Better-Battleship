// Sky, sun and lighting. Uses the physically based Sky object from the Three.js
// examples, set up for a hazy late-afternoon sun: a wartime mood.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// Colour of the haze at the horizon. The scene fog uses the same colour so the
// sea melts into the sky instead of ending on a hard line.
export const HAZE_COLOR = 0x9c9690;

export function createSky(scene, renderer) {
    const sky = new Sky();
    sky.scale.setScalar(15000);
    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = 7;         // lots of haze in the air
    uniforms.rayleigh.value = 2.0;        // warm, reddish scattering
    uniforms.mieCoefficient.value = 0.012;
    uniforms.mieDirectionalG.value = 0.86;

    // Low sun, ahead of the player and a bit to the left (behind the enemy fog).
    const elevation = THREE.MathUtils.degToRad(9);
    const azimuth = THREE.MathUtils.degToRad(205);
    const sunDirection = new THREE.Vector3()
        .setFromSphericalCoords(1, Math.PI / 2 - elevation, azimuth);
    uniforms.sunPosition.value.copy(sunDirection);

    // Bake the sky into an environment map so ship hulls pick up its colours.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky);
    scene.environment = pmrem.fromScene(envScene).texture;
    pmrem.dispose();
    scene.add(sky);

    // Distance haze (this is the "Three.js fog" part; the thick fog bank over
    // the enemy zone is built separately in fog.js).
    scene.fog = new THREE.FogExp2(HAZE_COLOR, 0.00042);

    const sunLight = new THREE.DirectionalLight(0xffd2a1, 2.6);
    sunLight.position.copy(sunDirection).multiplyScalar(500);
    scene.add(sunLight);
    scene.add(new THREE.HemisphereLight(0xa9b8c9, 0x0b1c27, 1.1));

    return { sunDirection };
}
