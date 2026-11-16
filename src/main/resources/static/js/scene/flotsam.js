// What floats on the water around the battle: channel buoys with blinking
// lamps, drifting mines, lifeboats full of survivors (now and then one of
// them fires a red distress rocket), wreckage, and two patches of burning oil.
//
// They do not move (they only ride the waves), but they fill the empty water
// of the foreground and give the eye something to measure the sea against.
//
// Readability: every object is placed by scatter(), which refuses any spot
// in the play zones, their margin, the fog bank, the lanes of the convoys or
// the water around the player's flagship. The burning oil lies where the wind
// carries its smoke AWAY from the grids.
// Anti-cheat: the layout comes from a fixed list of random numbers; it never
// changes and has nothing to do with the game.
//
// Cost: four draw calls (one per kind of object, instancing).

import * as THREE from 'three';
import { distantMaterial } from './distantModels.js';
import { buoyModel, mineModel, lifeboatModel, wreckageModel } from './propModels.js';
import { createFire, clearOfPlay } from './battleFx.js';
import { CONVOY_TRACKS } from './convoy.js';
import { waveHeight, swellAt, waveLift } from './sea.js';

const BUOYS = 12;
const MINES = 16;
const LIFEBOATS = 9;
const WRECKAGE = 18;
const RED = 0xd23a30;
const GREEN = 0x35c46a;

// Burning oil: [x, z, size]. Both are downwind (east or south) of the grids.
const OIL_FIRES = [[-140, 262, 0.6], [246, -66, 0.7]];

/** Random numbers that are the same at every start. */
function seededRandom(seed) {
    let state = seed;
    return () => {
        state = (state * 16807) % 2147483647;
        return state / 2147483647;
    };
}

/** True if a spot is free water where something may float. */
function freeWater(x, z) {
    if (!clearOfPlay(x, z, 6)) {
        return false;
    }
    // The player's flagship and its escorts lie south of his zone.
    if (Math.abs(x) < 60 && z > 150 && z < 330) {
        return false;
    }
    // The lanes of the two convoys: keep the ring the ships sail on clear,
    // allow the water inside and outside it.
    for (const track of CONVOY_TRACKS) {
        const ring = Math.hypot((x - track.centre[0]) / track.rx, (z - track.centre[1]) / track.rz);
        if (ring > 0.5 && ring < 1.5) {
            return false;
        }
    }
    return true;
}

/**
 * @param fx the background effects (battleFx.js)
 */
export function createFlotsam(scene, fx) {
    const random = seededRandom(20240607);
    const items = [];      // everything that floats: { mesh, index, x, z, turn, scale, ... }

    /** Picks free spots in a ring around the play area, denser near it. */
    function scatter(count, minDistance, maxDistance, place) {
        let placed = 0;
        for (let attempt = 0; attempt < count * 40 && placed < count; attempt++) {
            const angle = random() * Math.PI * 2;
            const distance = minDistance + (maxDistance - minDistance) * random() * random();
            const x = Math.cos(angle) * distance * 1.1;
            const z = 30 + Math.sin(angle) * distance;
            if (freeWater(x, z)) {
                place(x, z, placed++);
            }
        }
        return placed;
    }

    function group(model, count, tinted) {
        const mesh = new THREE.InstancedMesh(model.geometry, distantMaterial, count);
        mesh.frustumCulled = false;
        if (tinted) {
            mesh.setColorAt(0, new THREE.Color(1, 1, 1));   // creates the per-instance colours
        }
        scene.add(mesh);
        return mesh;
    }

    const tint = new THREE.Color();
    const buoys = group(buoyModel(), BUOYS, true);
    buoys.count = scatter(BUOYS, 150, 420, (x, z, index) => {
        const green = index % 2 === 0;
        buoys.setColorAt(index, tint.set(green ? 0x2f8a52 : 0xa8342c));
        items.push({ mesh: buoys, index, x, z, turn: random() * 6, scale: 1.5, tilt: 2.2,
            lamp: buoyModel().lamp * 1.5, color: green ? GREEN : RED, blink: random() * 3, every: 2.6 + random() });
    });
    const mines = group(mineModel(), MINES);
    mines.count = scatter(MINES, 170, 480, (x, z, index) => {
        items.push({ mesh: mines, index, x, z, turn: random() * 6, scale: 1.5, tilt: 1, sink: 0.5 });
    });
    const lifeboats = group(lifeboatModel(), LIFEBOATS);
    const boats = [];
    lifeboats.count = scatter(LIFEBOATS, 150, 440, (x, z, index) => {
        const boat = { mesh: lifeboats, index, x, z, turn: random() * 6, scale: 1.5, tilt: 1.3,
            lamp: 2.6, color: 0xffcf8a, blink: random() * 4, every: 4.5 + random() * 2, lampSize: 1.6 };
        items.push(boat);
        if (clearOfPlay(x, z, 70)) {
            boats.push(boat);   // only boats well away from the grids fire rockets
        }
    });
    const wreckage = group(wreckageModel(), WRECKAGE);
    wreckage.count = scatter(WRECKAGE, 140, 460, (x, z, index) => {
        items.push({ mesh: wreckage, index, x, z, turn: random() * 6, scale: 1.2 + random() * 0.8, tilt: 1 });
    });

    const oil = OIL_FIRES.filter(([x, z]) => freeWater(x, z)).map(([x, z, size]) => ({ x, z, size, fire: createFire() }));

    // One distress rocket at a time, from a lifeboat chosen at random.
    const rocket = { life: 0, x: 0, y: 0, z: 0, vy: 0 };
    let rocketTimer = 14;

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const size = new THREE.Vector3();

    return {
        update(dt, time) {
            for (const item of items) {
                // Small things follow every wave and lean with the slope of the water.
                const lift = waveLift(item.x, item.z);
                const y = waveHeight(item.x, item.z, time) * lift;
                const swell = swellAt(item.x, item.z, time, item.turn);
                position.set(item.x, y - (item.sink ?? 0), item.z);
                euler.set(swell.roll * item.tilt * lift, item.turn, swell.pitch * item.tilt * lift);
                item.mesh.setMatrixAt(item.index, matrix.compose(position, quaternion.setFromEuler(euler), size.setScalar(item.scale)));
                if (item.lamp) {
                    item.blink -= dt;
                    if (item.blink <= 0) {
                        item.blink = item.every;
                        fx.lamp(item.x, y + item.lamp, item.z, item.color, item.lampSize ?? 3.2, 1.2);
                    }
                }
            }
            buoys.instanceMatrix.needsUpdate = true;
            mines.instanceMatrix.needsUpdate = true;
            lifeboats.instanceMatrix.needsUpdate = true;
            wreckage.instanceMatrix.needsUpdate = true;

            for (const patch of oil) {
                fx.burn(patch.fire, patch.x, 1.5, patch.z, patch.size, dt);
            }

            rocketTimer -= dt;
            if (rocketTimer <= 0 && rocket.life <= 0) {
                rocketTimer = 35 + Math.random() * 40;
                const boat = boats[Math.floor(Math.random() * boats.length)];
                if (boat) {
                    rocket.life = 9;
                    rocket.x = boat.x;
                    rocket.y = 3;
                    rocket.z = boat.z;
                    rocket.vy = 34;
                }
            }
            if (rocket.life > 0) {
                // Up fast, slower and slower, then it hangs and sinks while it burns out.
                rocket.life -= dt;
                rocket.vy = Math.max(-4, rocket.vy - 11 * dt);
                rocket.y += rocket.vy * dt;
                fx.rocket(rocket.x, rocket.y, rocket.z, dt);
            }
        }
    };
}
