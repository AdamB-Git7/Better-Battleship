// Motor torpedo boats: small, fast, and never still.
//
// Three packs of boats race round the whole battle on one big loop (a
// rounded rectangle that passes between the squadrons, outside the convoys),
// each boat dragging a long white wake and throwing spray. When a pack runs
// past the far enemy squadrons, a boat fires a torpedo: a line of bubbles
// runs across the water to a ship, and ends in an explosion or a miss.
//
// Readability: the loop is at least 420 units from the centre of the play
// area on every side (checked at start-up), and torpedoes only run from the
// loop OUTWARDS to the far squadrons, so no trail ever crosses the grids.
// Anti-cheat: nothing here knows anything about the game.
//
// Cost: one draw call for all the boats (instancing); wakes, spray and
// torpedo trails use the shared wake sheet and the background particle pool.

import * as THREE from 'three';
import { distantMaterial } from './distantModels.js';
import { torpedoBoatModel } from './propModels.js';
import { clearOfPlay, reducedMotion } from './battleFx.js';
import { swellAt, waveLift } from './sea.js';

// The loop: |x / HALF_X|^4 + |(z - CENTRE_Z) / HALF_Z|^4 = 1, a rectangle with round corners.
const HALF_X = 430;
const HALF_Z = 490;
const CENTRE_Z = -20;
const SPEED = 30;                 // world units per second
const BOAT_SCALE = 1.5;
const PACKS = 3;
const BOATS_PER_PACK = 3;
// Where each boat rides in its pack: [behind the leader, out of the line].
const STATIONS = [[0, 0], [20, 13], [38, -11]];
const MAX_TORPEDOES = 4;
const TORPEDO_SPEED = 44;
const TORPEDO_RANGE = 330;
const TORPEDO_HIT_CHANCE = 0.4;

/** Point of the loop for an angle (0..2 pi), and its direction of travel. */
function loopPoint(angle, target) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    target.x = HALF_X * Math.sign(cos) * Math.sqrt(Math.abs(cos));
    target.z = CENTRE_Z + HALF_Z * Math.sign(sin) * Math.sqrt(Math.abs(sin));
    return target;
}

/**
 * @param fx the background effects (battleFx.js)
 * @param fleet the background ships (backgroundFleet.js): the targets of the torpedoes
 * @param wakes the shared sheet of wakes (wakes.js)
 */
export function createSmallCraft(scene, fx, fleet, wakes) {
    const model = torpedoBoatModel();
    const count = PACKS * BOATS_PER_PACK;
    const mesh = new THREE.InstancedMesh(model.geometry, distantMaterial, count);
    mesh.frustumCulled = false;
    scene.add(mesh);

    const here = { x: 0, z: 0 };
    const ahead = { x: 0, z: 0 };
    const packs = [];
    for (let p = 0; p < PACKS; p++) {
        const pack = {
            angle: (p / PACKS) * Math.PI * 2 + 0.4,
            x: 0, z: 0, tx: 1, tz: 0,
            reload: 8 + p * 9,          // seconds until it may fire a torpedo again
            boats: []
        };
        for (let b = 0; b < BOATS_PER_PACK; b++) {
            pack.boats.push({ station: STATIONS[b], x: 0, z: 0, spray: Math.random() * 0.2, phase: Math.random() * 6, wakeIndex: wakes.reserve() });
        }
        packs.push(pack);
    }

    // A check at start-up: the loop must stay clear of the play area and the fog.
    for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
        loopPoint(angle, here);
        if (!clearOfPlay(here.x, here.z, 150)) {
            throw new Error('smallCraft.js: the loop comes too close to the play area');
        }
    }

    const torpedoes = [];
    for (let i = 0; i < MAX_TORPEDOES; i++) {
        torpedoes.push({ active: false, x: 0, z: 0, vx: 0, vz: 0, time: 0, bubble: 0, target: null });
    }

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const scale = new THREE.Vector3(BOAT_SCALE, BOAT_SCALE, BOAT_SCALE);

    function movePack(pack, dt) {
        // Step along the loop: measure a short piece of it to keep a steady speed.
        loopPoint(pack.angle, here);
        loopPoint(pack.angle + 0.002, ahead);
        const piece = Math.hypot(ahead.x - here.x, ahead.z - here.z);
        pack.angle = (pack.angle + (SPEED * dt * 0.002) / Math.max(piece, 0.01)) % (Math.PI * 2);
        pack.x = here.x;
        pack.z = here.z;
        pack.tx = (ahead.x - here.x) / Math.max(piece, 0.01);
        pack.tz = (ahead.z - here.z) / Math.max(piece, 0.01);
    }

    function launchTorpedo(pack) {
        const target = fleet.nearestFarShip(pack.x, pack.z);
        if (!target || fleet.nearestDistance() > TORPEDO_RANGE) {
            pack.reload = 2;   // nobody in range: look again soon
            return;
        }
        const torpedo = torpedoes.find(candidate => !candidate.active);
        if (!torpedo) {
            return;
        }
        pack.reload = (reducedMotion ? 40 : 18) + Math.random() * 16;
        const boat = pack.boats[Math.floor(Math.random() * pack.boats.length)];
        // Aim a little ahead of the ship: it moves on while the torpedo runs.
        const seconds = fleet.nearestDistance() / TORPEDO_SPEED;
        const aimX = target.x + Math.cos(target.heading) * 4.5 * seconds;
        const aimZ = target.z - Math.sin(target.heading) * 4.5 * seconds;
        const distance = Math.hypot(aimX - boat.x, aimZ - boat.z);
        torpedo.active = true;
        torpedo.x = boat.x;
        torpedo.z = boat.z;
        torpedo.vx = ((aimX - boat.x) / distance) * TORPEDO_SPEED;
        torpedo.vz = ((aimZ - boat.z) / distance) * TORPEDO_SPEED;
        torpedo.time = distance / TORPEDO_SPEED;
        torpedo.target = target;
        fx.foam(boat.x, boat.z, 2.2, 1.6);   // the splash as it leaves the tube
    }

    function updateTorpedoes(dt) {
        for (const torpedo of torpedoes) {
            if (!torpedo.active) {
                continue;
            }
            torpedo.x += torpedo.vx * dt;
            torpedo.z += torpedo.vz * dt;
            torpedo.time -= dt;
            torpedo.bubble -= dt;
            if (torpedo.bubble <= 0) {
                torpedo.bubble = 0.09;
                fx.foam(torpedo.x, torpedo.z, 0.9, 3.2);   // the line of bubbles it leaves
            }
            if (torpedo.time <= 0) {
                torpedo.active = false;
                // The fleet decides: an explosion on the ship, or a column of water beside it.
                fleet.strike(torpedo.target, TORPEDO_HIT_CHANCE);
            }
        }
    }

    return {
        update(dt, time) {
            let index = 0;
            for (const pack of packs) {
                movePack(pack, dt);
                const heading = Math.atan2(-pack.tz, pack.tx);
                for (const boat of pack.boats) {
                    const [back, side] = boat.station;
                    // Each boat weaves a little around its place in the pack.
                    const weave = Math.sin(time * 0.8 + boat.phase) * 2.5;
                    boat.x = pack.x - pack.tx * back + pack.tz * (side + weave);
                    boat.z = pack.z - pack.tz * back - pack.tx * (side + weave);
                    const lift = waveLift(boat.x, boat.z);
                    const swell = swellAt(boat.x, boat.z, time, heading);
                    // Planing: the bow rides high and slams on the waves.
                    position.set(boat.x, swell.height * lift + 0.25, boat.z);
                    euler.set(swell.roll * lift * 0.7, heading, 0.09 + swell.pitch * lift * 1.6 + Math.sin(time * 5 + boat.phase) * 0.025);
                    mesh.setMatrixAt(index++, matrix.compose(position, quaternion.setFromEuler(euler), scale));
                    // A long, bright wake...
                    wakes.set(boat.wakeIndex, boat.x - pack.tx * 26, boat.z - pack.tz * 26, heading, 62, 9, 1.7);
                    // ...and spray thrown up at the bow.
                    boat.spray -= dt;
                    if (boat.spray <= 0) {
                        boat.spray = 0.16;
                        fx.foam(boat.x + pack.tx * 5, boat.z + pack.tz * 5, 1.5, 1.1);
                    }
                }
                pack.reload -= dt;
                if (pack.reload <= 0) {
                    launchTorpedo(pack);
                }
            }
            mesh.instanceMatrix.needsUpdate = true;
            updateTorpedoes(dt);
        },
        packs
    };
}
