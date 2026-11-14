// Aerial camera: a tilted top-down view with limited OrbitControls and smooth
// fly-to transitions between a few named viewpoints.
//
// Later blocks (captain's bridge, first person) can add their own viewpoints
// to VIEWS or swap this rig for another one: nothing else depends on it.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ZONES } from '../config.js';

const VIEWS = {
    // Low, distant shot used behind the lobby menu.
    lobby: { position: new THREE.Vector3(150, 42, 330), target: new THREE.Vector3(-50, 0, -70) },
    // Above my own zone, to place ships.
    placement: { position: new THREE.Vector3(0, 150, ZONES.mine.center.z + 120), target: ZONES.mine.center.clone() },
    // Both zones in view, to fight.
    battle: { position: new THREE.Vector3(0, 290, 190), target: new THREE.Vector3(0, 0, 26) }
};

export function createCameraRig(domElement) {
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, 30000);
    camera.position.copy(VIEWS.lobby.position);

    const controls = new OrbitControls(camera, domElement);
    controls.target.copy(VIEWS.lobby.target);
    controls.enableDamping = true;            // smooth movement
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = false;      // pan along the sea, not up / down
    controls.minDistance = 90;                // limited zoom
    controls.maxDistance = 640;
    controls.minPolarAngle = 0.12;            // never perfectly vertical
    controls.maxPolarAngle = 1.2;             // never down to (or under) the sea
    controls.minAzimuthAngle = -Math.PI / 3;  // limited rotation
    controls.maxAzimuthAngle = Math.PI / 3;
    controls.enabled = false;                 // enabled once a game starts
    controls.update();

    let flight = null;   // the transition in progress, if any
    let currentView = 'lobby';

    /** Smoothly moves the camera to one of the named viewpoints. */
    function flyTo(name, seconds = 2.4) {
        if (name === currentView && !flight) {
            return;
        }
        currentView = name;
        // On narrow windows, back away so the grids still fit on screen.
        const view = VIEWS[name];
        const fit = name === 'lobby' ? 1 : Math.max(1, 1.2 / camera.aspect);
        const position = view.position.clone().sub(view.target).multiplyScalar(fit).add(view.target);
        flight = {
            fromPosition: camera.position.clone(),
            fromTarget: controls.target.clone(),
            to: { position, target: view.target },
            time: 0,
            seconds
        };
        controls.enabled = false;
    }

    function update(dt) {
        if (flight) {
            flight.time += dt;
            const p = Math.min(flight.time / flight.seconds, 1);
            const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
            camera.position.lerpVectors(flight.fromPosition, flight.to.position, eased);
            controls.target.lerpVectors(flight.fromTarget, flight.to.target, eased);
            camera.lookAt(controls.target);
            if (p >= 1) {
                flight = null;
                controls.enabled = currentView !== 'lobby';
            }
            return;
        }
        if (currentView === 'lobby') {
            return;
        }
        // Keep the point we look at near the battlefield and on the surface.
        controls.target.x = THREE.MathUtils.clamp(controls.target.x, -90, 90);
        controls.target.z = THREE.MathUtils.clamp(controls.target.z, -150, 150);
        controls.target.y = 0;
        controls.update();
        if (camera.position.y < 12) {
            camera.position.y = 12;   // safety net: stay above the water
        }
    }

    function resize(width, height) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }

    return { camera, flyTo, update, resize };
}
