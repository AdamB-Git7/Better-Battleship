// The battle in the background: everything that fills the sea and the sky
// around the play area, so the player feels part of a much bigger fight.
//
//   battleFx.js          particles, flashes and sounds of the far-away fight
//   backgroundFleet.js   squadrons shelling each other, escorts, wrecks, searchlights, flares
//   aircraft.js          strike flights, the patrol, bombs, flak, planes shot down
//   distantModels.js     the one-piece ship and plane models they use
//   coast.js             the land on the horizon: burning harbour, lighthouse, coastal guns
//   convoy.js            merchant ships under escort, barrage balloons, a burning tanker
//   smallCraft.js        torpedo boats racing round the battle, and their torpedoes
//   flotsam.js           buoys, mines, lifeboats, wreckage, burning oil
//   mist.js              curtains of rain at different distances
//   propModels.js        the one-piece models of all those
//   billboards.js        big glows and smoke pillars; wakes.js: all the wakes; beams.js: light beams
//
// It is pure decoration with its own random life:
//  - it never touches the play zones, the sea between them or the fog bank
//    (ships sail on fixed tracks far outside, effects refuse to appear there),
//  - it never reads anything about the game, so it cannot give away where the
//    enemy ships are,
//  - it goes on by itself behind the menu, during placement and during the
//    battle, whatever the players do.
//
// Cost: about 80 draw calls (one per ship, one for all wakes, two for all
// planes, one for all particles, one per light beam, one per kind of floating
// object, a handful for the coast), no extra lights and no shadows.

import { createBattleFx } from './battleFx.js';
import { createWakes } from './wakes.js';
import { createBillboards } from './billboards.js';
import { createCoast } from './coast.js';
import { createConvoys } from './convoy.js';
import { createSmallCraft } from './smallCraft.js';
import { createFlotsam } from './flotsam.js';
import { createMist } from './mist.js';
import { createBackgroundFleet } from './backgroundFleet.js';
import { createAircraft } from './aircraft.js';

/**
 * @param sound the sound module (distant guns, flak, engines)
 * @param sea used to make distant flashes and fires shine on the water
 * @returns {{ update(dt, time, camera), resize(pixelHeight) }}
 */
export function createBattlefield(scene, sound, sea) {
    const fx = createBattleFx(scene, sound, sea);
    const wakes = createWakes(scene, 64);            // one sheet of foam per ship or boat, one draw call
    const billboards = createBillboards(scene);      // the big glows and smoke columns of the horizon
    const fleet = createBackgroundFleet(scene, fx, wakes);
    const coast = createCoast(scene, fx, fleet, billboards);
    const convoys = createConvoys(scene, fx, wakes, billboards);
    const craft = createSmallCraft(scene, fx, fleet, wakes);
    const flotsam = createFlotsam(scene, fx);
    const mist = createMist(scene);
    const aircraft = createAircraft(scene, fx, fleet, sound);

    return {
        /** @param camera where the player is: distant sounds are quieter and arrive later */
        update(dt, time, camera) {
            fleet.update(dt, time, camera);
            aircraft.update(dt, time, camera);
            coast.update(dt, time, camera);
            convoys.update(dt, time);
            craft.update(dt, time);
            flotsam.update(dt, time);
            mist.update(time);
            wakes.update(dt);
            billboards.update(time);
            fx.update(dt, time, camera);   // last: it draws what the two others asked for
        },
        /** The particles need the height of the canvas (in real pixels) to keep their size. */
        resize(pixelHeight) {
            fx.resize(pixelHeight);
        },
        // For the ?debug hook only (to jump to a plane or a ship when testing).
        fleet,
        aircraft,
        convoys,
        craft
    };
}
