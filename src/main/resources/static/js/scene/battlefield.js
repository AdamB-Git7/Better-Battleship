// The battle in the background: everything that fills the sea and the sky
// around the play area, so the player feels part of a much bigger fight.
//
//   battleFx.js          particles, flashes and sounds of the far-away fight
//   backgroundFleet.js   squadrons shelling each other, escorts, wrecks, searchlights, flares
//   aircraft.js          strike flights, the patrol, bombs, flak, planes shot down
//   distantModels.js     the one-piece ship and plane models they use
//
// It is pure decoration with its own random life:
//  - it never touches the play zones, the sea between them or the fog bank
//    (ships sail on fixed tracks far outside, effects refuse to appear there),
//  - it never reads anything about the game, so it cannot give away where the
//    enemy ships are,
//  - it goes on by itself behind the menu, during placement and during the
//    battle, whatever the players do.
//
// Cost: about 30 draw calls (one per ship, one for all wakes, two for all
// planes, one for all particles, one per searchlight), no extra lights and
// no shadows.

import { createBattleFx } from './battleFx.js';
import { createBackgroundFleet } from './backgroundFleet.js';
import { createAircraft } from './aircraft.js';

/**
 * @param sound the sound module (distant guns, flak, engines)
 * @param sea used to make distant flashes and fires shine on the water
 * @returns {{ update(dt, time, camera), resize(pixelHeight) }}
 */
export function createBattlefield(scene, sound, sea) {
    const fx = createBattleFx(scene, sound, sea);
    const fleet = createBackgroundFleet(scene, fx);
    const aircraft = createAircraft(scene, fx, fleet, sound);

    return {
        /** @param camera where the player is: distant sounds are quieter and arrive later */
        update(dt, time, camera) {
            fleet.update(dt, time, camera);
            aircraft.update(dt, time, camera);
            fx.update(dt, time, camera);   // last: it draws what the two others asked for
        },
        /** The particles need the height of the canvas (in real pixels) to keep their size. */
        resize(pixelHeight) {
            fx.resize(pixelHeight);
        }
    };
}
