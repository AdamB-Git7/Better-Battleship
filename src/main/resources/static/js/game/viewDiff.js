// The server only sends full "views" of the game, never "a shot was fired" events.
// To animate a shot we compare the previous view with the new one and look for
// the single cell that has just been fired at.

import { GRID_SIZE } from '../config.js';

const SHOT_STATES = new Set(['MISS', 'HIT', 'SUNK']);

/**
 * @returns {{zone: 'enemy'|'mine', row: number, col: number, result: string}|null}
 *   zone 'enemy' = I fired, zone 'mine' = the opponent fired at me.
 */
export function findNewShot(previous, next) {
    if (!previous || previous.status !== 'IN_PROGRESS') {
        return null;
    }
    for (let row = 0; row < GRID_SIZE; row++) {
        for (let col = 0; col < GRID_SIZE; col++) {
            // A freshly shot cell was not shot before. (Cells that only switch
            // from HIT to SUNK belong to older shots on the same ship.)
            const theirs = next.opponentBoard[row][col];
            if (SHOT_STATES.has(theirs) && !SHOT_STATES.has(previous.opponentBoard[row][col])) {
                return { zone: 'enemy', row, col, result: theirs };
            }
            const mine = next.yourBoard[row][col];
            if (SHOT_STATES.has(mine) && !SHOT_STATES.has(previous.yourBoard[row][col])) {
                return { zone: 'mine', row, col, result: mine };
            }
        }
    }
    return null;
}
