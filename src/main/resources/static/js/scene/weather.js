// The state of the storm, shared by everything that reacts to it.
//
// One small object instead of many callbacks: storm.js writes it once per
// frame, and the sea, the ships, the rain, the smoke, the fog and the sound
// all read the same numbers. That is what keeps sight and sound in step: a
// gust slants the rain, raises the chop, rolls the ships and makes the wind
// howl, all at the same moment.

import * as THREE from 'three';

// Where the wind blows TO, on the sea plane (x, z). From the bridge this is
// from the left to the right and a little towards the player.
const WIND_ANGLE = 0.33;
export const WIND = new THREE.Vector2(Math.cos(WIND_ANGLE), Math.sin(WIND_ANGLE));

export const weather = {
    gust: 0.5,                                      // 0 = lull, 1 = strongest gust
    flash: 0,                                       // 0..1 brightness of the lightning right now
    flashDirection: new THREE.Vector3(0, 0.3, -1)   // from the camera towards the bolt
};

/** Slow, irregular rise and fall of the wind: a few sine waves that never line up. */
export function updateGust(time) {
    const value = 0.5
        + 0.27 * Math.sin(time * 0.21)
        + 0.17 * Math.sin(time * 0.53 + 1.7)
        + 0.1 * Math.sin(time * 1.13 + 0.4);
    weather.gust = Math.min(1, Math.max(0, value));
}
