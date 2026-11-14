// The camera. It has two modes:
//
//  - "orbit": the aerial view of block 1. A tilted top-down camera driven by
//    OrbitControls (limited rotation, zoom and panning), with a few named
//    viewpoints (lobby, placement, battle).
//  - "bridge": the first-person view of block 3. The camera stands at the
//    captain's eye and can only look around (limited yaw and pitch). It has
//    two preset looks: down at the holographic board, or out of the window.
//
// flyTo() moves smoothly from any viewpoint to any other one.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ZONES } from '../config.js';
import { BRIDGE_EYE } from './bridge.js';

const ORBIT_FOV = 45;
const BRIDGE_FOV = 55;
const ORBIT_NEAR = 1;
const BRIDGE_NEAR = 0.3;   // the bridge consoles are close to the eye

const VIEWS = {
    // Low, distant shot used behind the lobby menu.
    lobby: { position: new THREE.Vector3(150, 42, 330), target: new THREE.Vector3(-50, 0, -70) },
    // Above my own zone, to place ships.
    placement: { position: new THREE.Vector3(0, 150, ZONES.mine.center.z + 120), target: ZONES.mine.center.clone() },
    // Both zones in view, to fight from above.
    battle: { position: new THREE.Vector3(0, 290, 190), target: new THREE.Vector3(0, 0, 26) }
};

// Preset looks on the bridge (pitch in radians, negative = looking down).
const LOOKS = {
    board: THREE.MathUtils.degToRad(-28),    // at the holographic board, to aim
    window: THREE.MathUtils.degToRad(-9)     // out of the window, to watch the shells
};
const MAX_YAW = 1.0;
const MIN_PITCH = THREE.MathUtils.degToRad(-66);
const MAX_PITCH = THREE.MathUtils.degToRad(14);

// Half a turn around the vertical axis (see flyTo).
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

export function createCameraRig(domElement) {
    const camera = new THREE.PerspectiveCamera(ORBIT_FOV, window.innerWidth / window.innerHeight, ORBIT_NEAR, 30000);
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

    let currentView = 'lobby';   // 'lobby' | 'placement' | 'battle' | 'bridge'
    let flight = null;           // the transition in progress, if any

    // First-person look direction on the bridge.
    const look = { yaw: 0, pitch: LOOKS.window };
    let lookGoal = null;         // { pitch, delay } while the camera turns by itself
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const helper = new THREE.Object3D();

    function bridgeQuaternion(target, time = 0) {
        // A very small sway, as if the ship was rolling under the captain's feet.
        euler.set(look.pitch + Math.sin(time * 0.55) * 0.004, look.yaw, Math.sin(time * 0.7) * 0.007);
        return target.setFromEuler(euler);
    }

    /** Smoothly moves the camera to a named viewpoint ('bridge' included). */
    function flyTo(name, seconds = 2.4) {
        if (name === currentView && !flight) {
            return;
        }
        currentView = name;
        const toPosition = new THREE.Vector3();
        const toQuaternion = new THREE.Quaternion();
        if (name === 'bridge') {
            look.yaw = 0;
            look.pitch = LOOKS.window;
            lookGoal = null;
            toPosition.copy(BRIDGE_EYE);
            bridgeQuaternion(toQuaternion);
            camera.near = BRIDGE_NEAR;
        } else {
            // On narrow windows, back away so the grids still fit on screen.
            const view = VIEWS[name];
            const fit = name === 'lobby' ? 1 : Math.max(1, 1.2 / camera.aspect);
            toPosition.copy(view.position).sub(view.target).multiplyScalar(fit).add(view.target);
            helper.position.copy(toPosition);
            helper.up.set(0, 1, 0);
            helper.lookAt(view.target);
            // Object3D.lookAt points +z at the target, a camera looks along -z.
            toQuaternion.copy(helper.quaternion).multiply(FLIP);
        }
        flight = {
            fromPosition: camera.position.clone(),
            fromQuaternion: camera.quaternion.clone(),
            fromFov: camera.fov,
            toPosition,
            toQuaternion,
            toFov: name === 'bridge' ? BRIDGE_FOV : ORBIT_FOV,
            time: 0,
            seconds
        };
        controls.enabled = false;
    }

    function endFlight() {
        flight = null;
        if (currentView === 'bridge') {
            return;
        }
        camera.near = ORBIT_NEAR;
        camera.updateProjectionMatrix();
        controls.target.copy(VIEWS[currentView].target);
        controls.enabled = currentView !== 'lobby';
        controls.update();
    }

    function update(dt, time) {
        if (flight) {
            flight.time += dt;
            const p = Math.min(flight.time / flight.seconds, 1);
            const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
            camera.position.lerpVectors(flight.fromPosition, flight.toPosition, eased);
            camera.quaternion.slerpQuaternions(flight.fromQuaternion, flight.toQuaternion, eased);
            camera.fov = THREE.MathUtils.lerp(flight.fromFov, flight.toFov, eased);
            camera.updateProjectionMatrix();
            if (p >= 1) {
                endFlight();
            }
            return;
        }
        if (currentView === 'bridge') {
            // Turn by itself towards the board or the window, when asked to.
            if (lookGoal) {
                lookGoal.delay -= dt;
                if (lookGoal.delay <= 0) {
                    const ease = 1 - Math.exp(-dt * 3.5);
                    look.pitch += (lookGoal.pitch - look.pitch) * ease;
                    look.yaw += (0 - look.yaw) * ease;
                    if (Math.abs(lookGoal.pitch - look.pitch) < 0.002 && Math.abs(look.yaw) < 0.002) {
                        lookGoal = null;
                    }
                }
            }
            camera.position.copy(BRIDGE_EYE);
            bridgeQuaternion(camera.quaternion, time);
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

    /**
     * On the bridge: turns the head by itself towards a preset look.
     * @param name 'board' or 'window'
     * @param delay seconds to wait first (e.g. to keep watching an explosion)
     */
    function lookAt(name, delay = 0) {
        lookGoal = { pitch: LOOKS[name], delay };
    }

    /** On the bridge: the player drags the mouse to look around. */
    function drag(dx, dy) {
        if (currentView !== 'bridge' || flight) {
            return;
        }
        lookGoal = null;   // the player takes over
        look.yaw = THREE.MathUtils.clamp(look.yaw + dx * 0.0028, -MAX_YAW, MAX_YAW);
        look.pitch = THREE.MathUtils.clamp(look.pitch + dy * 0.0028, MIN_PITCH, MAX_PITCH);
    }

    function resize(width, height) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }

    return { camera, flyTo, lookAt, drag, update, resize, isOnBridge: () => currentView === 'bridge' };
}
