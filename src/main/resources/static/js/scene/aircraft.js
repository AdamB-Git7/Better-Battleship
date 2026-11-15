// The planes of the battle in the background.
//
// - Strike flights: three planes in a "V" come in from behind the player,
//   pass beside his fleet (or far out on a flank, or now and then high over
//   his bridge and the whole battlefield), dive on a ship of the distant enemy
//   squadrons, drop their bombs, and climb away into the haze. A while later
//   they come back for another run.
// - One patrol of four planes circles the whole battlefield, well outside the
//   play area.
// - Near the enemy ships the sky fills with flak (dark puffs with a spark) and
//   tracers climb towards the planes. Now and then a wingman is hit: he trails
//   fire and smoke and falls into the sea.
//
// All planes are drawn with ONE instanced mesh (plus one for the propeller
// discs): two draw calls for the whole air force.
//
// Readability: over the play area the planes are always high up and only
// passing through (most of them beside the grids, not over them). They only
// dive, and only release bombs, on a background ship (all of those are far
// away from the play area), and they are only shot down far from the play
// area, so nothing ever falls into it.

import * as THREE from 'three';
import { planeModel, distantMaterial } from './distantModels.js';
import { nearPlayArea } from './battleFx.js';

const STRIKE_FLIGHTS = 3;
const FLIGHT_SIZE = 3;
const PATROL_SIZE = 4;
const SPEED = 62;               // world units per second
const TURN_RATE = 0.45;         // radians per second
const CRUISE_HEIGHT = 66;       // on the way in, beside the player's fleet
const OVERHEAD_HEIGHT = 96;     // on the way in, when the flight passes right over the battlefield
const ATTACK_HEIGHT = 40;       // at the bottom of the dive
const DIVE_DISTANCE = 380;      // start going down this far from the target
const RELEASE_DISTANCE = 115;   // bombs keep the speed of the plane: they are let go early
const FLAK_RANGE = 430;         // the ships shoot at planes closer than this
const BOMB_GRAVITY = 30;
const BOMB_HIT_CHANCE = 0.3;
const LOST_CHANCE = 0.012;      // per flak burst: a wingman is hit
const WING_TIP = 5.6;

// Where each plane flies in the formation, relative to the leader:
// [metres behind, metres to the right, metres above].
const FORMATION = [[0, 0, 0], [11, 10, 1.5], [11, -10, -1.5], [22, 20, 3]];

// The patrol circles on this oval, far outside the play area.
const PATROL = { cx: 0, cz: -150, rx: 560, rz: 440, height: 150, points: 12 };

const FLYING = 0;
const FALLING = 1;
const LOST = 2;

/**
 * @param fx the background effects (battleFx.js)
 * @param fleet the background ships (backgroundFleet.js): the targets, and the guns that shoot back
 * @param sound for the drone of the engines
 */
export function createAircraft(scene, fx, fleet, sound) {
    const flights = [];
    const planes = [];

    function addFlight(size, patrol) {
        const flight = {
            patrol,
            active: false,
            wait: 0,                 // seconds until the next sortie
            x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0,
            goalX: 0, goalY: 0, goalZ: 0,
            stage: 0,                // strike: 0 = way in, 1 = attack, 2 = way out; patrol: next point of the oval
            lane: 0,
            target: null,
            flakTimer: 0,
            tracerTimer: 0,
            planes: []
        };
        for (let i = 0; i < size; i++) {
            const plane = {
                state: FLYING, slot: FORMATION[i],
                x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, fall: 0,
                blink: Math.random() * 1.4,
                index: planes.length
            };
            flight.planes.push(plane);
            planes.push(plane);
        }
        flights.push(flight);
        return flight;
    }

    for (let i = 0; i < STRIKE_FLIGHTS; i++) {
        addFlight(FLIGHT_SIZE, false).wait = 1 + i * 13;
    }
    const patrol = addFlight(PATROL_SIZE, true);
    patrol.active = true;
    patrol.x = PATROL.cx - PATROL.rx;
    patrol.y = PATROL.height;
    patrol.z = PATROL.cz;
    patrol.heading = Math.PI / 2;   // towards the north

    // ---- The two instanced meshes ------------------------------------------------
    const model = planeModel();
    const bodies = new THREE.InstancedMesh(model.body, distantMaterial, planes.length);
    const propellers = new THREE.InstancedMesh(model.propeller, new THREE.MeshBasicMaterial({
        color: 0xaab4bc, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false
    }), planes.length);
    propellers.instanceMatrix = bodies.instanceMatrix;   // the discs simply follow the bodies
    bodies.frustumCulled = propellers.frustumCulled = false;
    scene.add(bodies, propellers);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler(0, 0, 0, 'YZX');   // heading, then nose up / down, then bank
    const scale = new THREE.Vector3(1, 1, 1);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

    // ---- Bombs ---------------------------------------------------------------------
    const bombs = [];
    for (let i = 0; i < FLIGHT_SIZE * STRIKE_FLIGHTS; i++) {
        bombs.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, target: null });
    }

    function dropBomb(plane, target) {
        const bomb = bombs.find(candidate => !candidate.active);
        if (!bomb) {
            return;
        }
        bomb.active = true;
        bomb.x = plane.x;
        bomb.y = plane.y - 1;
        bomb.z = plane.z;
        bomb.vx = Math.cos(plane.heading) * SPEED;
        bomb.vy = Math.sin(plane.pitch) * SPEED;
        bomb.vz = -Math.sin(plane.heading) * SPEED;
        bomb.target = target;
    }

    function updateBombs(dt) {
        for (const bomb of bombs) {
            if (!bomb.active) {
                continue;
            }
            bomb.vy -= BOMB_GRAVITY * dt;
            bomb.x += bomb.vx * dt;
            bomb.y += bomb.vy * dt;
            bomb.z += bomb.vz * dt;
            fx.bombTrail(bomb.x, bomb.y, bomb.z);
            if (bomb.y <= 1) {
                bomb.active = false;
                // The fleet decides: an explosion on the ship, or a water column beside it.
                fleet.strike(bomb.target, BOMB_HIT_CHANCE);
            }
        }
    }

    // ---- Sorties -------------------------------------------------------------------

    /** Sends a strike flight on a new run, from far behind the player towards an enemy ship. */
    function launch(flight) {
        const target = fleet.pickTarget();
        if (!target) {
            flight.wait = 5;
            return;
        }
        // Stay on the side of the target, so the flight never crosses over the grids.
        const side = Math.abs(target.x) > 60 ? Math.sign(target.x) : (Math.random() < 0.5 ? -1 : 1);
        const route = Math.random();
        if (route < 0.25) {
            flight.lane = (Math.random() - 0.5) * 50;           // right over the bridge, high up
        } else if (route < 0.6) {
            flight.lane = side * (330 + Math.random() * 150);   // far out on the flank
        } else {
            flight.lane = side * (70 + Math.random() * 40);     // beside the player's fleet
        }
        flight.active = true;
        flight.target = target;
        flight.stage = 0;
        flight.x = flight.lane + (Math.random() - 0.5) * 60;
        flight.y = (Math.abs(flight.lane) < 60 ? OVERHEAD_HEIGHT : CRUISE_HEIGHT) + Math.random() * 18;
        flight.z = 1050 + Math.random() * 250;
        flight.heading = Math.PI / 2;
        flight.pitch = flight.roll = 0;
        flight.goalX = flight.lane;
        flight.goalY = flight.y;
        flight.goalZ = 130;
        for (const plane of flight.planes) {
            plane.state = FLYING;
        }
    }

    function patrolGoal(flight) {
        const angle = Math.PI + (flight.stage / PATROL.points) * Math.PI * 2;
        flight.goalX = PATROL.cx + PATROL.rx * Math.cos(angle);
        flight.goalZ = PATROL.cz + PATROL.rz * Math.sin(angle);
        flight.goalY = PATROL.height;
    }
    patrolGoal(patrol);

    /** Chooses where a strike flight goes next. */
    function steerStrike(flight, toGoal) {
        const target = flight.target;
        if (flight.stage === 0 && toGoal < 70) {
            flight.stage = 1;
        }
        if (flight.stage === 1) {
            // Fly at the ship; near it, dive.
            flight.goalX = target.x;
            flight.goalZ = target.z;
            const away = Math.hypot(target.x - flight.x, target.z - flight.z);
            flight.goalY = away < DIVE_DISTANCE ? ATTACK_HEIGHT : flight.goalY;
            if (away < RELEASE_DISTANCE) {
                if (fleet.isInAction(target)) {
                    for (const plane of flight.planes) {
                        if (plane.state === FLYING) {
                            dropBomb(plane, target);
                        }
                    }
                }
                // Pull up and leave, straight on and then away from the battle.
                flight.stage = 2;
                const out = Math.hypot(target.x, target.z);
                flight.goalX = target.x + (target.x / out) * 1300 + Math.cos(flight.heading) * 500;
                flight.goalZ = target.z + (target.z / out) * 1300 - Math.sin(flight.heading) * 500;
                flight.goalY = 170;
            }
        } else if (flight.stage === 2 && Math.hypot(flight.x, flight.z) > 1700) {
            flight.active = false;                    // out of sight in the haze
            flight.wait = 8 + Math.random() * 22;
        }
    }

    function steerPatrol(flight, toGoal) {
        if (toGoal < 90) {
            flight.stage = (flight.stage + 1) % PATROL.points;
            patrolGoal(flight);
        }
    }

    /** Turns, climbs and moves the leader of a flight towards its goal. */
    function fly(flight, dt) {
        const toGoal = Math.hypot(flight.goalX - flight.x, flight.goalZ - flight.z);
        if (flight.patrol) {
            steerPatrol(flight, toGoal);
        } else {
            steerStrike(flight, toGoal);
        }
        // Turn towards the goal, at most TURN_RATE, and bank into the turn.
        const wanted = Math.atan2(-(flight.goalZ - flight.z), flight.goalX - flight.x);
        let error = wanted - flight.heading;
        error = Math.atan2(Math.sin(error), Math.cos(error));   // shortest way round
        const turn = THREE.MathUtils.clamp(error * 1.5, -TURN_RATE, TURN_RATE);
        flight.heading += turn * dt;
        flight.roll += (-turn * 1.5 - flight.roll) * Math.min(1, dt * 2.5);
        // Climb or dive towards the wanted height.
        const climb = THREE.MathUtils.clamp((flight.goalY - flight.y) * 0.9, -32, 24);
        flight.pitch += (Math.atan2(climb, SPEED) - flight.pitch) * Math.min(1, dt * 2);
        flight.x += Math.cos(flight.heading) * SPEED * dt;
        flight.z -= Math.sin(flight.heading) * SPEED * dt;
        flight.y += Math.sin(flight.pitch) * SPEED * dt;
    }

    /** Flak bursts and tracers around a flight that is close to the enemy ships. */
    function defend(flight, dt) {
        flight.flakTimer -= dt;
        flight.tracerTimer -= dt;
        if (flight.flakTimer > 0 && flight.tracerTimer > 0) {
            return;
        }
        const gun = fleet.nearestFarShip(flight.x, flight.z);
        if (!gun || fleet.nearestDistance() > FLAK_RANGE) {
            flight.flakTimer = flight.tracerTimer = 0.5;   // nobody in range: look again in a moment
            return;
        }
        const plane = flight.planes[Math.floor(Math.random() * flight.planes.length)];
        if (plane.state !== FLYING) {
            return;
        }
        const aheadX = Math.cos(plane.heading) * SPEED;
        const aheadZ = -Math.sin(plane.heading) * SPEED;
        if (flight.flakTimer <= 0) {
            flight.flakTimer = 0.22 + Math.random() * 0.4;
            // The gunners rarely get it exactly right.
            fx.flak(plane.x + aheadX * 0.4 + (Math.random() - 0.5) * 70,
                plane.y + (Math.random() - 0.5) * 30,
                plane.z + aheadZ * 0.4 + (Math.random() - 0.5) * 70);
            const wingman = plane !== flight.planes[0];
            if (wingman && !flight.patrol && Math.random() < LOST_CHANCE && !nearPlayArea(plane.x, plane.z, 260)) {
                plane.state = FALLING;
                plane.fall = 0;
            }
        }
        if (flight.tracerTimer <= 0) {
            flight.tracerTimer = 0.1;
            // Aim where the plane will be when the round gets there (roughly).
            const fromY = 7 * gun.scale;
            const away = Math.hypot(plane.x - gun.x, plane.y - fromY, plane.z - gun.z);
            const seconds = away / 240;
            const dx = plane.x + aheadX * seconds + (Math.random() - 0.5) * 40 - gun.x;
            const dy = plane.y + (Math.random() - 0.5) * 30 - fromY;
            const dz = plane.z + aheadZ * seconds + (Math.random() - 0.5) * 40 - gun.z;
            const length = Math.hypot(dx, dy, dz);
            fx.aaRound(gun.x, fromY, gun.z, (dx / length) * 240, (dy / length) * 240 + 4 * seconds, (dz / length) * 240,
                Math.min(1.8, seconds * 1.15));
        }
    }

    /** A plane that has been hit: it rolls, noses down and trails fire until it hits the sea. */
    function fall(plane, dt) {
        plane.fall += dt;
        plane.pitch = Math.max(-0.9, plane.pitch - 0.35 * dt);
        plane.roll += 1.3 * dt;
        plane.heading += 0.2 * dt;
        const forward = SPEED * 0.85 * Math.cos(plane.pitch);
        plane.x += Math.cos(plane.heading) * forward * dt;
        plane.z -= Math.sin(plane.heading) * forward * dt;
        plane.y += (Math.sin(plane.pitch) * SPEED - 6 * plane.fall) * dt;
        fx.trail(plane.x, plane.y, plane.z);
        if (plane.y <= 1) {
            plane.state = LOST;
            // The effects ignore anything near the play area (it cannot happen: see defend).
            fx.splash(plane.x, plane.z, 1);
            fx.blast(plane.x, 2, plane.z, 0.7);
        }
    }

    // ---- Every frame -------------------------------------------------------------------

    function update(dt, time, camera) {
        let closest = Infinity;      // the plane nearest to the camera, for the engine sound
        let closing = 0;             // how fast it comes closer (units per second)

        for (const flight of flights) {
            if (!flight.active) {
                flight.wait -= dt;
                if (flight.wait <= 0) {
                    launch(flight);
                }
            }
            if (flight.active) {
                fly(flight, dt);
                defend(flight, dt);
            }
            const cos = Math.cos(flight.heading);
            const sin = Math.sin(flight.heading);
            for (const plane of flight.planes) {
                if (!flight.active || plane.state === LOST) {
                    bodies.setMatrixAt(plane.index, hidden);
                    continue;
                }
                if (plane.state === FALLING) {
                    fall(plane, dt);
                } else {
                    // In formation: behind and beside the leader, bobbing a little.
                    const [back, right, above] = plane.slot;
                    plane.x = flight.x - cos * back + sin * right;
                    plane.z = flight.z + sin * back + cos * right;
                    plane.y = flight.y + above + Math.sin(time * 1.3 + plane.index * 1.9) * 0.7;
                    plane.heading = flight.heading;
                    plane.pitch = flight.pitch;
                    plane.roll = flight.roll + Math.sin(time * 0.9 + plane.index) * 0.04;
                }
                position.set(plane.x, plane.y, plane.z);
                quaternion.setFromEuler(euler.set(plane.roll, plane.heading, plane.pitch));
                bodies.setMatrixAt(plane.index, matrix.compose(position, quaternion, scale));

                const vx = Math.cos(plane.heading) * SPEED;
                const vz = -Math.sin(plane.heading) * SPEED;
                // Navigation lights: red on the left wingtip, green on the right, blinking.
                plane.blink -= dt;
                if (plane.blink <= 0 && plane.state === FLYING) {
                    plane.blink = 1.4;
                    const tipX = Math.sin(plane.heading) * WING_TIP;
                    const tipZ = Math.cos(plane.heading) * WING_TIP;
                    fx.blink(plane.x - tipX, plane.y, plane.z - tipZ, vx, 0, vz, 0xff3a2a);
                    fx.blink(plane.x + tipX, plane.y, plane.z + tipZ, vx, 0, vz, 0x3aff7a);
                }

                const dx = plane.x - camera.position.x;
                const dy = plane.y - camera.position.y;
                const dz = plane.z - camera.position.z;
                const distance = Math.hypot(dx, dy, dz);
                if (distance < closest) {
                    closest = distance;
                    closing = -(vx * dx + vz * dz) / Math.max(distance, 1);
                }
            }
        }
        bodies.instanceMatrix.needsUpdate = true;
        updateBombs(dt);

        // The drone of the nearest plane: louder when close, and higher while it
        // approaches than while it leaves (the Doppler effect, a little exaggerated).
        const level = closest === Infinity ? 0 : 1 / (1 + Math.pow(closest / 170, 2));
        sound.setEngine(level, 1 + THREE.MathUtils.clamp(closing / 340, -0.2, 0.2) * 1.4);
    }

    return { update, flights };
}
