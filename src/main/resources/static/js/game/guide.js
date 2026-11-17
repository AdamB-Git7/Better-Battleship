// The pirate's script: decides WHAT the pirate says.
//
// This file contains no drawing code and no network code. It only looks at
// what just happened in the game (the previous view, the new view, the shot)
// and returns a line of dialogue, or null to stay silent. The portrait and the
// speech bubble are in ui/pirate.js.
//
// To add or change dialogue, edit LINES. Several lines for one event means the
// pirate picks one at random, so he does not repeat himself too much.
// {ship} and {next} are replaced by ship names.

import { SHIP_LENGTHS } from '../config.js';

const LINES = {
    waiting: [
        'No enemy on the horizon yet. Send that room code to a rival, and we\'ll have ourselves a war.'
    ],
    intro: [
        'You finally woke up, captain! The war is about to begin. Place your ships, matey.'
    ],
    placedNext: [
        'Aye, the {ship} is in position. Now the {next}.',
        'A fine spot for the {ship}. Where does the {next} go?',
        'The {ship} drops anchor. Next up: the {next}.'
    ],
    fleetReady: [
        'The fleet is ready, captain! The enemy is still fumbling with their anchors.'
    ],
    battleFirst: [
        'Battle stations! You fire first, captain. Pick a square on the holo-board and we\'ll put a missile into that cursed fog.'
    ],
    battleSecond: [
        'Battle stations! They shoot first. Hold fast, captain!'
    ],
    myMiss: [
        'Nothing but water! Try another square.',
        'Splash! The fish are terrified. The enemy, less so.',
        'A miss. They\'re hiding somewhere in that fog, captain.'
    ],
    myHit: [
        'A hit! Something is burning in there. Fire near it again!',
        'Direct hit! Keep at it, she\'s still afloat.',
        'Ha! That one hurt them. Aim close by on your next turn.'
    ],
    mySunk: [
        'Down she goes! That was their {ship}.',
        'Their {ship} is feeding the fish now. Well done, captain!'
    ],
    theirMiss: [
        'Ha! They hit nothing but seaweed.',
        'They missed! Their gunner must be seasick.',
        'Wide of the mark. Our turn, captain.'
    ],
    theirHit: [
        'We\'re hit! The {ship} is on fire!',
        'Blast! They found our {ship}.',
        'The {ship} took a missile, but she\'s still floating.'
    ],
    theirSunk: [
        'We lost the {ship}! Make them pay for it, captain.',
        'The {ship} is gone... Don\'t let it be for nothing.'
    ],
    victory: [
        'Victory! The sea is ours, captain! I never doubted you. Well, almost never.'
    ],
    defeat: [
        'The fleet is lost... We\'ll get them next time, captain.'
    ],
    rematchAsked: [
        'They want another round! Hit the rematch button if you dare.'
    ],
    rematchWaiting: [
        'The challenge is sent. Let\'s see if they have the nerve.'
    ],
    rematchStart: [
        'A new battle! Place your ships again, matey.'
    ]
};

const shipName = type => type.toLowerCase();

/**
 * @param pick chooses one line from a list (random by default; tests can pass
 *             their own to get predictable results)
 */
export function createGuide(pick = list => list[Math.floor(Math.random() * list.length)]) {
    function say(key, values = {}) {
        return pick(LINES[key]).replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
    }

    /** Line for a room update (before the second player has joined). */
    function onRoom(room) {
        return room.status === 'WAITING_FOR_PLAYER' ? say('waiting') : null;
    }

    /**
     * Line for a new game view.
     * @param previous the view shown before (null for the first view of a room)
     * @param view the new view
     * @param shot the shot found between the two views, or null (see viewDiff.js)
     */
    function onView(previous, view, shot) {
        // The end of the game matters more than the last shot.
        if (view.status === 'FINISHED') {
            if (!previous || previous.status !== 'FINISHED') {
                return say(view.youWon ? 'victory' : 'defeat');
            }
            if (view.rematchRequestedByOpponent && !previous.rematchRequestedByOpponent) {
                return say('rematchAsked');
            }
            if (view.rematchRequestedByYou && !previous.rematchRequestedByYou) {
                return say('rematchWaiting');
            }
            return null;
        }

        if (view.status === 'PLACING_SHIPS') {
            if (!previous) {
                return say('intro');
            }
            if (previous.status === 'FINISHED') {
                return say('rematchStart');
            }
            // Did I just place a ship? (The opponent placing one changes nothing for me.)
            if (view.shipsToPlace.length < previous.shipsToPlace.length) {
                const placed = previous.shipsToPlace.find(type => !view.shipsToPlace.includes(type));
                return view.shipsToPlace.length > 0
                    ? say('placedNext', { ship: shipName(placed), next: shipName(view.shipsToPlace[0]) })
                    : say('fleetReady');
            }
            return null;
        }

        if (view.status === 'IN_PROGRESS') {
            if (!previous || previous.status !== 'IN_PROGRESS') {
                return say(view.yourTurn ? 'battleFirst' : 'battleSecond');
            }
            if (!shot) {
                return null;
            }
            if (shot.zone === 'enemy') {
                if (shot.result === 'MISS') {
                    return say('myMiss');
                }
                if (shot.result === 'SUNK') {
                    // The server reveals an enemy ship only once it is sunk.
                    const before = new Set(previous.opponentShips.map(ship => ship.type));
                    const sunk = view.opponentShips.find(ship => !before.has(ship.type));
                    return say('mySunk', { ship: sunk ? shipName(sunk.type) : 'ship' });
                }
                return say('myHit');
            }
            if (shot.result === 'MISS') {
                return say('theirMiss');
            }
            const ship = shipAt(view.yourShips, shot.row, shot.col);
            return say(shot.result === 'SUNK' ? 'theirSunk' : 'theirHit',
                { ship: ship ? shipName(ship.type) : 'ship' });
        }
        return null;
    }

    return { onRoom, onView };
}

/** Which of my ships covers a cell. */
function shipAt(ships, row, col) {
    return ships.find(ship => {
        const length = SHIP_LENGTHS[ship.type];
        return ship.orientation === 'HORIZONTAL'
            ? ship.row === row && col >= ship.col && col < ship.col + length
            : ship.col === col && row >= ship.row && row < ship.row + length;
    });
}
