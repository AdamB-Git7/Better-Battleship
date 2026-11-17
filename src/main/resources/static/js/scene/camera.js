// The camera. It has two modes:
//
//  - "orbit": the aerial view of block 1. A tilted top-down camera driven by
//    OrbitControls (limited rotation, zoom and panning), with a few named
//    viewpoints (lobby, placement, battle).
//  - "bridge": the first-person view of block 3. The camera stands at the
//    captain's eye. It has two preset looks: down at the holographic board,
//    or out of the window. On top of that, the player looks around by moving
//    the mouse towards the edges of the screen (see pointAt below).
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
    board: THREE.MathUtils.degToRad(-30),    // at the holographic board, to aim
    window: THREE.MathUtils.degToRad(-9),    // out of the window, to watch the missiles
    ahead: THREE.MathUtils.degToRad(1)       // straight at the horizon (the defeat cinematic)
};

// Looking around on the bridge with the mouse. The middle of the screen, where
// the holographic board is, is a dead zone: the view only moves when the mouse
// gets close to an edge, so aiming at a cell never moves the board.
const EDGE = {
    up: { start: 0.62, angle: THREE.MathUtils.degToRad(45) },      // up to 45 degrees above the board
    down: { start: 0.8, angle: THREE.MathUtils.degToRad(10) },     // a little lower, to see the floor screens
    side: { start: 0.62, angle: THREE.MathUtils.degToRad(32) }     // left and right, never all the way round
};
const MIN_PITCH = THREE.MathUtils.degToRad(-50);
const MAX_PITCH = THREE.MathUtils.degToRad(16);   // slightly above the horizon, no higher
const EDGE_SPEED = 3.2;                           // how fast the view follows the mouse

/** 0 inside the dead zone, rising smoothly to 1 at the edge of the screen. */
function edgeAmount(value, start) {
    const t = THREE.MathUtils.clamp((Math.abs(value) - start) / (0.97 - start), 0, 1);
    return t * t * (3 - 2 * t);
}

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

    // First-person look direction on the bridge = a preset look (board or
    // window, chosen by the game) + an extra turn from the mouse position.
    const look = { pitch: LOOKS.window };            // the preset part, animated
    const edgeLook = { yaw: 0, pitch: 0 };           // the mouse part, animated
    const edgeGoal = { yaw: 0, pitch: 0 };           // where the mouse part is heading
    let lookGoal = null;         // { pitch, delay } while the preset look changes
    let locked = false;          // during the defeat cinematic the mouse does not turn the head
    const shaking = { strength: 0, left: 0, seconds: 1 };   // see shake()
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const helper = new THREE.Object3D();

    function bridgeQuaternion(target, time = 0) {
        // A tiny sway, as if the ship was rolling under the captain's feet. It is
        // kept very small so the cells of the holographic board stay easy to click.
        const pitch = THREE.MathUtils.clamp(look.pitch + edgeLook.pitch, MIN_PITCH, MAX_PITCH);
        // A shake (see shake()): a few fast sines of unrelated speeds look like
        // random jolts, but move smoothly and allocate nothing.
        const jolt = shaking.left > 0 ? shaking.strength * (shaking.left / shaking.seconds) : 0;
        euler.set(
            pitch + Math.sin(time * 0.55) * 0.0015 + jolt * (Math.sin(time * 61) + Math.sin(time * 37.3)) * 0.012,
            edgeLook.yaw + jolt * (Math.sin(time * 47.7) + Math.sin(time * 29.1)) * 0.012,
            Math.sin(time * 0.7) * 0.003 + jolt * Math.sin(time * 43.9) * 0.015
        );
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
            look.pitch = LOOKS.window;
            edgeLook.yaw = edgeLook.pitch = 0;
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
        shaking.left = Math.max(0, shaking.left - dt);
        if (currentView === 'bridge') {
            // Turn by itself towards the board or the window, when asked to.
            if (lookGoal) {
                lookGoal.delay -= dt;
                if (lookGoal.delay <= 0) {
                    look.pitch += (lookGoal.pitch - look.pitch) * (1 - Math.exp(-dt * 3.5));
                    if (Math.abs(lookGoal.pitch - look.pitch) < 0.002) {
                        lookGoal = null;
                    }
                }
            }
            // Follow the mouse towards the edges of the screen.
            const ease = 1 - Math.exp(-dt * EDGE_SPEED);
            edgeLook.yaw += (edgeGoal.yaw - edgeLook.yaw) * ease;
            edgeLook.pitch += (edgeGoal.pitch - edgeLook.pitch) * ease;
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

    /**
     * On the bridge: the mouse is at (x, y) pixels. Near the top edge the view
     * turns up (to watch the battlefield), near the sides it turns left or
     * right. In the middle of the screen nothing moves.
     * Call with null when the mouse leaves the window: the view comes back.
     */
    function pointAt(x, y) {
        if (x === null || locked) {
            edgeGoal.yaw = edgeGoal.pitch = 0;
            return;
        }
        const nx = (x / window.innerWidth) * 2 - 1;    // -1 left .. 1 right
        const ny = 1 - (y / window.innerHeight) * 2;   // -1 bottom .. 1 top
        edgeGoal.yaw = -Math.sign(nx) * edgeAmount(nx, EDGE.side.start) * EDGE.side.angle;
        edgeGoal.pitch = ny > 0
            ? edgeAmount(ny, EDGE.up.start) * EDGE.up.angle
            : -edgeAmount(ny, EDGE.down.start) * EDGE.down.angle;
    }

    /**
     * Cinematic mode (the defeat): the head stops following the mouse and
     * looks straight ahead, out of the window.
     */
    function setLocked(value) {
        locked = value;
        if (locked) {
            edgeGoal.yaw = edgeGoal.pitch = 0;
        }
    }

    /**
     * Shakes the first-person view: a jolt that dies out over `seconds`.
     * strength 1 = a heavy blast nearby; 0 stops a shake at once.
     */
    function shake(strength, seconds = 0.6) {
        shaking.strength = strength;
        shaking.seconds = Math.max(seconds, 0.01);
        shaking.left = strength > 0 ? seconds : 0;
    }

    function resize(width, height) {
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
    }

    return { camera, flyTo, lookAt, pointAt, setLocked, shake, update, resize, isOnBridge: () => currentView === 'bridge' };
}
