// The warships of the battle in the background.
//
// Six squadrons steam in line on big oval tracks around the play area, in
// three pairs (west, east and far to the north, behind the fog bank). The two
// squadrons of a pair shell each other: gun flashes, tracers arcing across,
// water columns, hits, fires with tall smoke blown by the wind. A ship that
// has taken too much falls out of line and sinks, leaving burning oil, and a
// while later a new ship arrives out of the haze to take its place, so the
// battle never ends. A few escorts hold station on both sides of the player's
// own fleet, searchlights sweep the clouds and star shells drift down.
//
// Readability: every track, escort and wreck is outside the play zones and
// their margin BY CONSTRUCTION (see GROUPS, ESCORTS, WRECKS), and the effects
// refuse to draw anything near them anyway (battleFx.js).
//
// Anti-cheat: this module knows nothing about the game. It never reads a
// board, a view or a ship of either player; everything here is random
// decoration, and no background ship ever sails in or near the enemy fog.

import * as THREE from 'three';
import { distantShip, distantMaterial, silhouetteMaterial } from './distantModels.js';
import { createFire, reducedMotion } from './battleFx.js';
import { swellAt, waveLift } from './sea.js';
import { beamMaterial, createBeam } from './beams.js';
import { weather, WIND } from './weather.js';

// ---- Where everything is -----------------------------------------------------------
// The play zones cover x = -50..50, z = -112..112 and the fog bank reaches
// about x = -210..210, z = -230..0. Nothing below comes closer than that.

// One line per squadron: the oval it sails on (centre, half-width rx along x,
// half-depth rz along z), which way round, how big its ships are drawn (far
// ones are enlarged a little so they still read in the haze) and its enemy.
const GROUPS = [
    { centre: [-310, -190], rx: 62, rz: 190, turn: 1, scale: 1.15, far: false, foe: 1, types: ['CRUISER', 'BATTLESHIP', 'DESTROYER'] },
    { centre: [-575, -300], rx: 85, rz: 220, turn: -1, scale: 1.7, far: true, foe: 0, types: ['BATTLESHIP', 'CRUISER', 'DESTROYER'] },
    { centre: [310, -190], rx: 62, rz: 190, turn: -1, scale: 1.15, far: false, foe: 3, types: ['BATTLESHIP', 'DESTROYER', 'CRUISER'] },
    { centre: [575, -300], rx: 85, rz: 220, turn: 1, scale: 1.7, far: true, foe: 2, types: ['CRUISER', 'BATTLESHIP', 'DESTROYER'] },
    { centre: [0, -395], rx: 185, rz: 70, turn: 1, scale: 1.5, far: false, foe: 5, types: ['CRUISER', 'DESTROYER', 'BATTLESHIP'] },
    { centre: [0, -640], rx: 330, rz: 80, turn: -1, scale: 1.9, far: true, foe: 4, types: ['BATTLESHIP', 'CARRIER', 'CRUISER', 'DESTROYER'] }
];

// Escorts of the player's own task force: they hold station beside his zone,
// well outside the grid, bows to the enemy. Nobody shoots at them.
const ESCORTS = [
    { type: 'DESTROYER', x: -124, z: 44 },
    { type: 'CRUISER', x: -172, z: 118 },
    { type: 'DESTROYER', x: 128, z: 70 },
    { type: 'CRUISER', x: 176, z: 142 }
];

// Ships lost before the player arrived: half-sunk hulks that still burn.
const WRECKS = [
    { type: 'DESTROYER', x: -440, z: 20, heading: 0.9, scale: 1.3 },
    { type: 'CRUISER', x: 425, z: -250, heading: 2.4, scale: 1.4 },
    { type: 'DESTROYER', x: -130, z: -520, heading: -0.5, scale: 1.6 }
];

const SPEED = 4.5;             // world units per second along the track
const SPACING = 85;            // distance between two ships of a line
const ARRIVAL_DISTANCE = 650;  // a new ship appears this far out, hidden by the haze
const ARRIVAL_SPEED = 14;
const SINK_SECONDS = 30;
const HIT_CHANCE = 0.14;       // of one shell
const MAX_SHELLS = 16;
const MAX_OIL_FIRES = 4;
const MAX_FLARES = 2;
const BEAM_LENGTH = 420;

const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};
const pick = list => list[Math.floor(Math.random() * list.length)];

/**
 * @param fx the background effects (battleFx.js)
 * @param wakes the shared sheet of wakes (wakes.js)
 * @returns {{ update(dt, time, camera), pickTarget(), strike(ship, chance), nearestFarShip(x, z) }}
 */
export function createBackgroundFleet(scene, fx, wakes) {
    const root = new THREE.Group();
    scene.add(root);

    // ---- Ships ---------------------------------------------------------------
    const ships = [];       // every ship that needs a wake: squadrons first, then escorts
    const groups = GROUPS.map(settings => {
        const [cx, cz] = settings.centre;
        const away = Math.hypot(cx, cz);
        return { ...settings, cx, cz, outX: cx / away, outZ: cz / away, ships: [] };
    });

    function addShip(type, scale, material) {
        const { geometry, length } = distantShip(type);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.order = 'YXZ';   // heading first, then roll and pitch (like the player's fleet)
        mesh.scale.setScalar(scale);
        root.add(mesh);
        const ship = {
            mesh, scale, length: length * scale,
            x: 0, z: 0, heading: 0,
            theta: 0,                  // where its place in the line is, on the oval
            arriving: 0,               // distance still to sail before it has joined the line
            health: 3,
            burning: 0,                // seconds the fire will still burn
            sinking: -1,               // seconds since it began to sink, -1 = afloat
            gone: 0,                   // seconds until a replacement arrives (while sunk)
            fire: createFire(),
            fireAt: (Math.random() - 0.5) * 0.5,   // where along the hull the fire is
            wake: 1,                   // 1 = full wake, 0 = none (stopped or sunk)
            wakeIndex: wakes.reserve()
        };
        ships.push(ship);
        return ship;
    }

    for (const group of groups) {
        const step = SPACING / ((group.rx + group.rz) / 2);
        const start = Math.random() * Math.PI * 2;
        group.types.forEach((type, index) => {
            const ship = addShip(type, group.scale, silhouetteMaterial);
            ship.theta = start - group.turn * step * index;
            group.ships.push(ship);
        });
    }
    // The battle has been going on for a while when the player arrives.
    groups[1].ships[1].burning = 90;
    groups[1].ships[1].health = 2;
    groups[3].ships[2].burning = 70;
    groups[5].ships[0].burning = 110;
    groups[5].ships[0].health = 2;

    const escorts = ESCORTS.map(escort => {
        const ship = addShip(escort.type, 1, distantMaterial);
        ship.x = escort.x;
        ship.z = escort.z;
        ship.heading = Math.PI / 2;   // bow to the north, where the enemy is
        return ship;
    });

    const wrecks = WRECKS.map(wreck => {
        const mesh = new THREE.Mesh(distantShip(wreck.type).geometry, silhouetteMaterial);
        mesh.rotation.order = 'YXZ';
        mesh.rotation.set(0.5, wreck.heading, 0.14);
        mesh.scale.setScalar(wreck.scale);
        mesh.position.set(wreck.x, -2.6 * wreck.scale, wreck.z);
        root.add(mesh);
        return { ...wreck, fire: createFire() };
    });

    const direction = new THREE.Vector3();

    /** Floats one ship on the swell and lays its wake behind it. */
    function floatShip(ship, time, sunk) {
        const lift = waveLift(ship.x, ship.z);
        const swell = swellAt(ship.x, ship.z, time, ship.heading);
        const afloat = 1 - sunk;
        ship.mesh.position.set(ship.x, swell.height * lift * afloat - 3.6 * ship.scale * sunk, ship.z);
        ship.mesh.rotation.set(swell.roll * lift * afloat + 0.42 * sunk, ship.heading, swell.pitch * lift * afloat + 0.2 * sunk);

        const cos = Math.cos(ship.heading);
        const sin = Math.sin(ship.heading);
        wakes.set(ship.wakeIndex, ship.x - cos * ship.length * 0.3, ship.z + sin * ship.length * 0.3,
            ship.heading, ship.length * 1.5, 15 * ship.scale, 0.5 * ship.wake * afloat);
    }

    // ---- Squadrons: sailing, burning, sinking, being replaced --------------------

    const oilFires = [];
    for (let i = 0; i < MAX_OIL_FIRES; i++) {
        oilFires.push({ time: 0, x: 0, z: 0, fire: createFire() });
    }
    let nextOilFire = 0;

    function updateSquadronShip(ship, group, dt) {
        // Its place in the line moves on at a steady speed, whatever happens to the ship.
        const sin = Math.sin(ship.theta);
        const cos = Math.cos(ship.theta);
        let vx = -group.rx * sin * group.turn;
        let vz = group.rz * cos * group.turn;
        const length = Math.hypot(vx, vz);
        ship.theta += (group.turn * SPEED * dt) / length;
        vx *= SPEED / length;
        vz *= SPEED / length;

        if (ship.gone > 0) {
            // Sunk. After a while a new ship comes in from far away to take the place.
            ship.gone -= dt;
            if (ship.gone <= 0) {
                ship.health = 3;
                ship.burning = 0;
                ship.sinking = -1;
                ship.arriving = ARRIVAL_DISTANCE;
                ship.wake = 1;
                ship.mesh.visible = true;
            }
            return;
        }

        if (ship.sinking >= 0) {
            // Falls out of the line (away from the play area), slows down, lists and goes under.
            ship.sinking += dt;
            const p = Math.min(1, ship.sinking / SINK_SECONDS);
            const way = 1 - p;
            ship.x += (Math.cos(ship.heading) * SPEED * way + group.outX * 3) * dt;
            ship.z += (-Math.sin(ship.heading) * SPEED * way + group.outZ * 3) * dt;
            ship.wake = way;
            if (p < 0.85) {
                fx.burn(ship.fire, ship.x, 5 * ship.scale * way + 1, ship.z, 1.25 * ship.scale, dt);
            }
            if (p >= 1) {
                ship.mesh.visible = false;
                ship.wake = 0;
                ship.gone = 25 + Math.random() * 30;
                const oil = oilFires[nextOilFire];
                nextOilFire = (nextOilFire + 1) % MAX_OIL_FIRES;
                oil.time = 60 + Math.random() * 40;
                oil.x = ship.x;
                oil.z = ship.z;
            }
            return;
        }

        // In the line, or on the way to it.
        if (ship.arriving > 0) {
            const rate = Math.min(ARRIVAL_SPEED, ship.arriving * 0.4 + 0.5);
            ship.arriving = Math.max(0, ship.arriving - rate * dt);
            vx -= group.outX * rate;
            vz -= group.outZ * rate;
        }
        ship.x = group.cx + group.rx * cos + group.outX * ship.arriving;
        ship.z = group.cz + group.rz * sin + group.outZ * ship.arriving;
        ship.heading = Math.atan2(-vz, vx);   // models point to +x

        if (ship.burning > 0) {
            ship.burning -= dt;
            const along = ship.fireAt * ship.length;
            fx.burn(ship.fire, ship.x + Math.cos(ship.heading) * along, 5 * ship.scale,
                ship.z - Math.sin(ship.heading) * along, (ship.health === 1 ? 1.15 : 0.85) * ship.scale, dt);
        }
    }

    const inAction = ship => ship.sinking < 0 && ship.gone <= 0 && ship.arriving < 60;

    /**
     * A shell or a bomb arrives at a ship: with luck `chance` it hits (an
     * explosion, a fire, and after three hits the ship sinks), otherwise it
     * throws up a column of water beside it.
     */
    function strike(ship, chance) {
        if (inAction(ship) && Math.random() < chance) {
            fx.blast(ship.x, 5 * ship.scale, ship.z, ship.scale);
            ship.health -= 1;
            ship.burning = 70 + Math.random() * 60;
            ship.fireAt = (Math.random() - 0.5) * 0.5;
            if (ship.health <= 0) {
                ship.sinking = 0;
            }
        } else {
            const angle = Math.random() * Math.PI * 2;
            const miss = 28 + Math.random() * 40;
            fx.splash(ship.x + Math.cos(angle) * miss, ship.z + Math.sin(angle) * miss, ship.scale);
        }
    }

    // ---- Gunnery: one salvo at a time, somewhere on the battlefield ------------------

    const shells = [];
    for (let i = 0; i < MAX_SHELLS; i++) {
        shells.push({ active: false, time: 0, duration: 1, fromX: 0, fromY: 0, fromZ: 0, height: 0, target: null });
    }
    let salvoTimer = 2;
    const duels = groups.filter(group => group.far);   // one per pair of squadrons

    function fireSalvo() {
        // Pick a pair, then who shoots: either side.
        const far = pick(duels);
        const near = groups[far.foe];
        const [shooters, targets] = Math.random() < 0.5 ? [far, near] : [near, far];
        const shooter = pick(shooters.ships);
        const target = pick(targets.ships);
        if (!inAction(shooter) || !inAction(target)) {
            return;
        }
        const muzzleY = 6 * shooter.scale;
        fx.muzzle(shooter.x, muzzleY, shooter.z);
        const distance = Math.hypot(target.x - shooter.x, target.z - shooter.z);
        let count = 1 + Math.floor(Math.random() * 3);
        for (const shell of shells) {
            if (count === 0) {
                break;
            }
            if (!shell.active) {
                shell.active = true;
                shell.time = -0.18 * count;   // the guns of a salvo fire one after the other
                shell.duration = THREE.MathUtils.clamp(distance / 150, 1.6, 3.6);
                shell.fromX = shooter.x;
                shell.fromY = muzzleY;
                shell.fromZ = shooter.z;
                shell.height = distance * (0.14 + Math.random() * 0.06);
                shell.target = target;
                count--;
            }
        }
    }

    function updateShells(dt) {
        for (const shell of shells) {
            if (!shell.active) {
                continue;
            }
            shell.time += dt;
            if (shell.time < 0) {
                continue;
            }
            const p = Math.min(1, shell.time / shell.duration);
            const target = shell.target;
            fx.tracer(
                shell.fromX + (target.x - shell.fromX) * p,
                shell.fromY + (3 - shell.fromY) * p + 4 * shell.height * p * (1 - p),   // parabola
                shell.fromZ + (target.z - shell.fromZ) * p, target.scale);
            if (p >= 1) {
                shell.active = false;
                strike(target, HIT_CHANCE);
            }
        }
    }

    // ---- Searchlights -------------------------------------------------------------

    const searchlightMaterial = beamMaterial();
    // One lamp on the leading ships of the far squadrons. It sweeps the sky on
    // the side AWAY from the play area, so a beam never crosses it.
    const searchlights = [groups[1].ships[0], groups[3].ships[0], groups[5].ships[0], groups[5].ships[2]].map((ship, index) => {
        const beam = createBeam(searchlightMaterial, BEAM_LENGTH);
        root.add(beam.mesh);
        const group = groups.find(candidate => candidate.ships.includes(ship));
        return { beam, mesh: beam.mesh, ship, phase: index * 2.1, outward: Math.atan2(group.outZ, group.outX) };
    });

    function updateSearchlights(time) {
        for (const light of searchlights) {
            const ship = light.ship;
            light.mesh.visible = inAction(ship);
            if (!light.mesh.visible) {
                continue;
            }
            const around = light.outward + 1.15 * Math.sin(time * 0.19 + light.phase);
            const up = 0.85 + 0.3 * Math.sin(time * 0.13 + light.phase * 2);
            direction.set(Math.cos(around) * Math.cos(up), Math.sin(up), Math.sin(around) * Math.cos(up));
            light.mesh.position.set(ship.x, 8 * ship.scale, ship.z);
            light.beam.point(direction);
        }
    }

    // ---- Star shells ----------------------------------------------------------------

    const flares = [];
    for (let i = 0; i < MAX_FLARES; i++) {
        flares.push({ life: 0, x: 0, y: 0, z: 0 });
    }
    let flareTimer = 9;

    function updateFlares(dt) {
        flareTimer -= dt;
        if (flareTimer <= 0) {
            flareTimer = 22 + Math.random() * 26;
            const over = pick(pick(duels).ships);
            const flare = flares.find(candidate => candidate.life <= 0);
            if (flare && inAction(over)) {
                flare.life = 17;
                flare.x = over.x + (Math.random() - 0.5) * 160;
                flare.y = 150 + Math.random() * 40;
                flare.z = over.z + (Math.random() - 0.5) * 160;
            }
        }
        const drift = (9 + 16 * weather.gust) * 0.25;
        for (const flare of flares) {
            if (flare.life <= 0) {
                continue;
            }
            flare.life -= dt;
            flare.x += WIND.x * drift * dt;
            flare.z += WIND.y * drift * dt;
            flare.y -= 6 * dt;   // slowly down, under its parachute
            fx.flare(flare.x, flare.y, flare.z, dt);
        }
    }

    // ---- Every frame ------------------------------------------------------------------

    function update(dt, time, camera) {
        for (const group of groups) {
            for (const ship of group.ships) {
                updateSquadronShip(ship, group, dt);
                floatShip(ship, time, ship.sinking < 0 ? 0 : smoothstep(0, 1, ship.sinking / SINK_SECONDS));
            }
        }
        for (const ship of escorts) {
            floatShip(ship, time, 0);
        }

        for (const wreck of wrecks) {
            fx.burn(wreck.fire, wreck.x, 4, wreck.z, 0.9, dt);
        }
        for (const oil of oilFires) {
            if (oil.time > 0) {
                oil.time -= dt;
                fx.burn(oil.fire, oil.x, 1.5, oil.z, Math.min(1, oil.time / 15) * 0.9 + 0.1, dt);
            }
        }

        salvoTimer -= dt;
        if (salvoTimer <= 0) {
            salvoTimer = (0.8 + Math.random() * 1.6) * (reducedMotion ? 2.5 : 1);
            fireSalvo();
        }
        updateShells(dt);
        updateSearchlights(time);
        updateFlares(dt);
        updateSteadyGlow(camera);
    }

    /** One light shines steadily on the water: a flare if there is one, else the closest fire. */
    function updateSteadyGlow(camera) {
        for (const flare of flares) {
            if (flare.life > 0) {
                fx.setSteadyGlow(flare.x, 30, flare.z, 2.5 * Math.min(1, flare.life / 3));
                return;
            }
        }
        let best = null;
        let bestDistance = Infinity;
        for (const group of groups) {
            for (const ship of group.ships) {
                if (ship.gone > 0 || (ship.burning <= 0 && ship.sinking < 0)) {
                    continue;
                }
                const distance = Math.hypot(ship.x - camera.position.x, ship.z - camera.position.z);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = ship;
                }
            }
        }
        if (best) {
            fx.setSteadyGlow(best.x, 8, best.z, 2.2);
        } else {
            fx.setSteadyGlow(0, 0, 0, 0);
        }
    }

    // ---- For the planes (aircraft.js) ---------------------------------------------------

    /** A ship of the far squadrons that is still fighting, or null. */
    function pickTarget() {
        for (let attempt = 0; attempt < 6; attempt++) {
            const ship = pick(pick(duels).ships);
            if (inAction(ship)) {
                return ship;
            }
        }
        return null;
    }

    let nearestDistance = Infinity;
    /** The fighting ship of the far squadrons closest to (x, z), or null; see nearestDistance(). */
    function nearestFarShip(x, z) {
        let best = null;
        nearestDistance = Infinity;
        for (const group of duels) {
            for (const ship of group.ships) {
                if (!inAction(ship)) {
                    continue;
                }
                const distance = Math.hypot(ship.x - x, ship.z - z);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    best = ship;
                }
            }
        }
        return best;
    }

    return { update, pickTarget, strike, nearestFarShip, nearestDistance: () => nearestDistance, isInAction: inAction, groups };
}
