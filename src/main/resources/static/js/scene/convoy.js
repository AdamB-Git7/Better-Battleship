// The convoys: merchant ships crossing the battle under escort.
//
// Two convoys steam slowly round long ovals on both flanks of the player's
// zone, close enough to give the foreground and the middle distance some
// big, fat ships: freighters and tankers in two columns, a destroyer ahead
// and one astern. Barrage balloons fly over some of the freighters at the end
// of a cable, nose to the wind. The merchants show a dim masthead light, and
// every so often an escort sends a stream of tracers up into the dark.
//
// One tanker did not make it: it lies stopped and burning far out to the
// north-west, under a column of smoke that reaches the clouds.
//
// Readability: both ovals stay beside the player's own zone (z > 20), outside
// the keep-out box and south of the fog bank BY CONSTRUCTION; the tracers are
// fired outwards, away from the grids.
// Anti-cheat: nothing here knows anything about the game.
//
// Cost: one draw call per ship (14), one for the balloons, one for the cables.

import * as THREE from 'three';
import { distantShip, distantMaterial, silhouetteMaterial } from './distantModels.js';
import { freighterModel, tankerModel, balloonModel } from './propModels.js';
import { createFire, clearOfPlay, reducedMotion } from './battleFx.js';
import { swellAt, waveLift } from './sea.js';
import { weather, WIND } from './weather.js';

// The two ovals (centre, half-width rx, half-depth rz) and which way round.
// With the columns 14 units to each side they cover x = 164..296 and z = 21..429:
// the inner column passes close beside the player's zone, the outer one far out.
export const CONVOY_TRACKS = [
    { centre: [-230, 225], rx: 52, rz: 190, turn: 1 },
    { centre: [230, 225], rx: 52, rz: 190, turn: -1 }
];
const TRACKS = CONVOY_TRACKS;

// The ships of one convoy: how far behind the leader, and how far out of the
// line (positive = the outer column).
const LINE_UP = [
    { kind: 'DESTROYER', back: 0, side: 0 },
    { kind: 'freighter', back: 72, side: -14, balloon: true },
    { kind: 'tanker', back: 78, side: 14 },
    { kind: 'tanker', back: 152, side: -14 },
    { kind: 'freighter', back: 146, side: 14, balloon: true },
    { kind: 'freighter', back: 222, side: 0 },
    { kind: 'DESTROYER', back: 290, side: 0 }
];

const SPEED = 3.4;               // world units per second: merchants are slow
const MERCHANT_SCALE = 0.85;
const BALLOON_HEIGHT = 56;
const TRACER_SPEED = 240;

// The tanker that was torpedoed before the player arrived.
const STRAGGLER = { x: -455, z: -575, heading: 0.6, scale: 1.9 };

/**
 * @param fx the background effects (battleFx.js)
 * @param wakes the shared sheet of wakes (wakes.js)
 * @param billboards the shared glows and smoke pillars (billboards.js)
 */
export function createConvoys(scene, fx, wakes, billboards) {
    const root = new THREE.Group();
    scene.add(root);

    const models = {
        freighter: freighterModel(),
        tanker: tankerModel(),
        DESTROYER: distantShip('DESTROYER')
    };

    // ---- Ships -----------------------------------------------------------------
    const ships = [];
    const balloons = [];       // the ships that fly one
    TRACKS.forEach((track, trackIndex) => {
        const [cx, cz] = track.centre;
        const start = trackIndex * 2.2 + 0.6;
        const average = (track.rx + track.rz) / 2;
        for (const place of LINE_UP) {
            const model = models[place.kind];
            const merchant = place.kind !== 'DESTROYER';
            const scale = merchant ? MERCHANT_SCALE : 1;
            const mesh = new THREE.Mesh(model.geometry, distantMaterial);
            mesh.rotation.order = 'YXZ';   // heading first, then roll and pitch
            mesh.scale.setScalar(scale);
            root.add(mesh);
            const ship = {
                mesh, track, cx, cz, scale, merchant,
                side: place.side,
                theta: start - track.turn * place.back / average,
                x: 0, z: 0, heading: 0,
                length: model.length * scale,
                mast: (model.mast ?? 0) * scale,
                lamp: Math.random() * 3,
                wakeIndex: wakes.reserve()
            };
            ships.push(ship);
            if (place.balloon) {
                balloons.push({ ship, phase: Math.random() * 6 });
            }
        }
    });

    function sail(ship, dt, time) {
        const { track } = ship;
        const sin = Math.sin(ship.theta);
        const cos = Math.cos(ship.theta);
        // Which way the oval goes here, and how fast the angle must grow for a steady speed.
        let tx = -track.rx * sin * track.turn;
        let tz = track.rz * cos * track.turn;
        const length = Math.hypot(tx, tz);
        ship.theta += (track.turn * SPEED * dt) / length;
        tx /= length;
        tz /= length;
        // The columns sail beside the oval: `side` units out along its normal.
        ship.x = ship.cx + track.rx * cos + track.turn * tz * ship.side;
        ship.z = ship.cz + track.rz * sin - track.turn * tx * ship.side;
        ship.heading = Math.atan2(-tz, tx);   // models point to +x

        const lift = waveLift(ship.x, ship.z);
        const swell = swellAt(ship.x, ship.z, time, ship.heading);
        ship.y = swell.height * lift;
        ship.mesh.position.set(ship.x, ship.y, ship.z);
        // Deep-laden merchants roll less than warships.
        ship.mesh.rotation.set(swell.roll * lift * (ship.merchant ? 0.6 : 1), ship.heading, swell.pitch * lift);
        wakes.set(ship.wakeIndex, ship.x - tx * ship.length * 0.3, ship.z - tz * ship.length * 0.3,
            ship.heading, ship.length * 1.45, 15 * ship.scale, 0.42);

        // The masthead light of a merchant: it swells and fades every few seconds.
        if (ship.merchant) {
            ship.lamp -= dt;
            if (ship.lamp <= 0) {
                ship.lamp = 3;
                fx.lamp(ship.x + tx * ship.length * 0.25, ship.y + ship.mast + 0.6, ship.z + tz * ship.length * 0.25, 0xffd9a0, 2.6, 2.4);
            }
        }
    }

    // ---- Barrage balloons --------------------------------------------------------
    const balloonMesh = new THREE.InstancedMesh(balloonModel().geometry, distantMaterial, balloons.length);
    balloonMesh.frustumCulled = false;
    root.add(balloonMesh);
    const cablePositions = new Float32Array(balloons.length * 6);
    const cableGeometry = new THREE.BufferGeometry();
    cableGeometry.setAttribute('position', new THREE.BufferAttribute(cablePositions, 3).setUsage(THREE.DynamicDrawUsage));
    const cables = new THREE.LineSegments(cableGeometry, new THREE.LineBasicMaterial({ color: 0x1b2024, transparent: true, opacity: 0.7 }));
    cables.frustumCulled = false;
    root.add(cables);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler(0, 0, 0, 'YZX');
    const one = new THREE.Vector3(1, 1, 1);
    const intoWind = Math.atan2(WIND.y, -WIND.x);   // a balloon turns its nose into the wind

    function updateBalloons(time) {
        // The wind pushes the balloons downwind of their ship, further in a gust.
        const drift = 9 + 12 * weather.gust;
        balloons.forEach((balloon, index) => {
            const { ship, phase } = balloon;
            const x = ship.x + WIND.x * drift + Math.sin(time * 0.31 + phase) * 2.5;
            const y = BALLOON_HEIGHT - 5 * weather.gust + Math.sin(time * 0.43 + phase * 2) * 1.6;
            const z = ship.z + WIND.y * drift + Math.cos(time * 0.27 + phase) * 2.5;
            position.set(x, y, z);
            euler.set(Math.sin(time * 0.5 + phase) * 0.06, intoWind + Math.sin(time * 0.22 + phase) * 0.12, 0.1 + 0.06 * weather.gust);
            balloonMesh.setMatrixAt(index, matrix.compose(position, quaternion.setFromEuler(euler), one));
            // The cable: from the deck of the ship to the belly of the balloon.
            const at = index * 6;
            cablePositions[at] = ship.x;
            cablePositions[at + 1] = ship.y + 4;
            cablePositions[at + 2] = ship.z;
            cablePositions[at + 3] = x;
            cablePositions[at + 4] = y - 4;
            cablePositions[at + 5] = z;
        });
        balloonMesh.instanceMatrix.needsUpdate = true;
        cableGeometry.attributes.position.needsUpdate = true;
    }

    // ---- Tracers: an escort hoses the sky for a second or two ------------------------
    const guns = TRACKS.map((track, index) => ({
        escorts: ships.filter(ship => ship.track === track && !ship.merchant),
        outward: Math.sign(track.centre[0]),
        wait: 5 + index * 6,          // seconds until the next burst
        burst: 0,                     // seconds left of the burst in progress
        round: 0,
        ship: null, around: 0, up: 0, sweep: 0
    }));

    function updateGuns(dt) {
        for (const gun of guns) {
            if (gun.burst <= 0) {
                gun.wait -= dt;
                if (gun.wait <= 0) {
                    gun.wait = (reducedMotion ? 22 : 9) + Math.random() * 12;
                    gun.burst = 1.4 + Math.random() * 1.2;
                    gun.ship = gun.escorts[Math.floor(Math.random() * gun.escorts.length)];
                    // Always outwards (away from the grids), high into the sky.
                    gun.around = (gun.outward > 0 ? 0 : Math.PI) + (Math.random() - 0.5) * 1.6;
                    gun.up = 0.6 + Math.random() * 0.45;
                    gun.sweep = (Math.random() - 0.5) * 0.5;
                }
                continue;
            }
            gun.burst -= dt;
            gun.around += gun.sweep * dt;
            gun.round -= dt;
            if (gun.round <= 0) {
                gun.round = 0.085;
                const around = gun.around + (Math.random() - 0.5) * 0.05;
                const up = gun.up + (Math.random() - 0.5) * 0.05;
                fx.aaRound(gun.ship.x, gun.ship.y + 7, gun.ship.z,
                    Math.cos(around) * Math.cos(up) * TRACER_SPEED, Math.sin(up) * TRACER_SPEED, Math.sin(around) * Math.cos(up) * TRACER_SPEED,
                    1.1 + Math.random() * 0.3);
            }
        }
    }

    // ---- The burning tanker --------------------------------------------------------
    const straggler = new THREE.Mesh(tankerModel().geometry, silhouetteMaterial);
    straggler.rotation.order = 'YXZ';
    straggler.rotation.set(0.17, STRAGGLER.heading, -0.05);     // listing, down by the stern
    straggler.scale.setScalar(STRAGGLER.scale);
    straggler.position.set(STRAGGLER.x, -2.2, STRAGGLER.z);
    root.add(straggler);
    const fires = [
        { fire: createFire(), dx: 6, dz: -3, y: 9, size: 1.7 },      // the cargo, amidships
        { fire: createFire(), dx: 44, dz: 30, y: 1.5, size: 1.0 }    // oil burning on the water beside it
    ];
    billboards.addGlow(STRAGGLER.x + 6, 20, STRAGGLER.z - 3, 100, 0xff8a30, 1.1, 1);
    billboards.addGlow(STRAGGLER.x + 6, 48, STRAGGLER.z - 3, 420, 0xff8a3a, 0.13, 0.7);
    billboards.addPillar(STRAGGLER.x + 6, 10, STRAGGLER.z - 3, 40, 430, 1);

    // A check at start-up: a convoy must never be able to enter the play area or the fog.
    for (const track of TRACKS) {
        for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
            const reach = 16;   // the outer column, plus half a ship
            const x = track.centre[0] + (track.rx + reach) * Math.cos(angle);
            const z = track.centre[1] + (track.rz + reach) * Math.sin(angle);
            const inner = track.centre[0] + (track.rx - reach) * Math.cos(angle);
            if (!clearOfPlay(x, z) || !clearOfPlay(inner, z)) {
                throw new Error('convoy.js: a track crosses the play area');
            }
        }
    }

    return {
        update(dt, time) {
            for (const ship of ships) {
                sail(ship, dt, time);
            }
            updateBalloons(time);
            updateGuns(dt);
            for (const { fire, dx, dz, y, size } of fires) {
                fx.burn(fire, STRAGGLER.x + dx, y, STRAGGLER.z + dz, size, dt);
            }
        },
        ships
    };
}
