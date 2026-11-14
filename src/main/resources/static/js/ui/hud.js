// The 2D interface drawn over the 3D scene: lobby, turn indicator, ships
// remaining, status line, buttons, victory / defeat banner and loading screen.
// It only reads the view sent by the server and never changes game state.

import { FLEET_SIZE, SHIP_LENGTHS } from '../config.js';

const byId = id => document.getElementById(id);

/**
 * @param actions {{ onCreate, onJoin(code), onRotate, onRematch, onLeave, onMute }}
 */
export function createHud(actions) {
    const el = {
        connection: byId('connection'),
        mute: byId('mute'),
        turn: byId('turn'),
        lobby: byId('lobby'),
        create: byId('create'),
        join: byId('join'),
        code: byId('code'),
        notice: byId('notice'),
        fleets: byId('fleets'),
        yourPips: byId('your-pips'),
        yourCount: byId('your-count'),
        enemyPips: byId('enemy-pips'),
        enemyCount: byId('enemy-count'),
        room: byId('room'),
        roomCode: byId('room-code'),
        roomPlayers: byId('room-players'),
        status: byId('status'),
        error: byId('error'),
        rotate: byId('rotate'),
        rematch: byId('rematch'),
        leave: byId('leave'),
        banner: byId('banner'),
        loading: byId('loading'),
        loadingBar: byId('loading-bar'),
        loadingText: byId('loading-text')
    };

    el.create.addEventListener('click', actions.onCreate);
    el.join.addEventListener('click', () => actions.onJoin(el.code.value));
    el.code.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            actions.onJoin(el.code.value);
        }
    });
    el.rotate.addEventListener('click', actions.onRotate);
    el.rematch.addEventListener('click', actions.onRematch);
    el.leave.addEventListener('click', actions.onLeave);
    el.mute.addEventListener('click', () => {
        el.mute.textContent = actions.onMute() ? 'SOUND OFF' : 'SOUND ON';
    });

    function setPips(container, counter, afloat) {
        container.replaceChildren();
        for (let i = 0; i < FLEET_SIZE; i++) {
            const pip = document.createElement('span');
            pip.className = i < afloat ? 'pip' : 'pip lost';
            container.appendChild(pip);
        }
        counter.textContent = `${afloat}/${FLEET_SIZE}`;
    }

    function setTurn(text, kind) {
        el.turn.hidden = text === null;
        el.turn.textContent = text ?? '';
        el.turn.className = `turn ${kind ?? ''}`;
    }

    function statusText(view, orientation) {
        if (view.status === 'PLACING_SHIPS') {
            if (view.shipsToPlace.length > 0) {
                const ship = view.shipsToPlace[0];
                const direction = orientation === 'HORIZONTAL' ? 'horizontal' : 'vertical';
                return `Place your ${ship.toLowerCase()} (${SHIP_LENGTHS[ship]} cells, ${direction}). `
                    + 'Press R or right-click to rotate.';
            }
            return 'Fleet in position. Waiting for your opponent to place their ships.';
        }
        if (view.status === 'IN_PROGRESS') {
            return view.yourTurn ? 'Pick a target in the fog.' : 'Brace: the enemy is aiming…';
        }
        if (view.status === 'FINISHED') {
            const result = view.youWon ? 'All enemy ships are sunk.' : 'All your ships are sunk.';
            if (view.rematchRequestedByYou) {
                return `${result} Waiting for your opponent to accept the rematch…`;
            }
            if (view.rematchRequestedByOpponent) {
                return `${result} Your opponent wants a rematch!`;
            }
            return result;
        }
        return '';
    }

    return {
        isTypingCode: target => target === el.code,

        setConnected(connected) {
            el.connection.textContent = connected ? 'Connected' : 'Disconnected. Refresh the page.';
            el.create.disabled = !connected;
            el.join.disabled = !connected;
        },

        setLoading(progress, text) {
            el.loadingBar.style.width = `${Math.round(progress * 100)}%`;
            if (text) {
                el.loadingText.textContent = text;
            }
        },

        hideLoading() {
            el.loading.classList.add('done');
        },

        /** Back to the menu. message is shown if the opponent left. */
        showLobby(message) {
            el.lobby.hidden = false;
            el.room.hidden = true;
            el.fleets.hidden = true;
            el.banner.hidden = true;
            el.error.hidden = true;
            el.code.value = '';
            el.notice.textContent = message ?? '';
            el.notice.hidden = !message;
            setTurn(null);
        },

        showRoom(room) {
            el.lobby.hidden = true;
            el.room.hidden = false;
            el.roomCode.textContent = room.code;
            el.roomPlayers.textContent = room.players;
            if (room.status === 'WAITING_FOR_PLAYER') {
                el.status.textContent = 'Waiting for a second player. Share the room code.';
                el.rotate.hidden = true;
                el.rematch.hidden = true;
            }
        },

        /** Redraws everything that depends on the game view. */
        showGame(view, orientation) {
            el.error.hidden = true;
            el.status.textContent = statusText(view, orientation);

            const placing = view.status === 'PLACING_SHIPS' && view.shipsToPlace.length > 0;
            el.rotate.hidden = !placing;
            el.rematch.hidden = view.status !== 'FINISHED';
            el.rematch.disabled = view.rematchRequestedByYou;
            el.rematch.textContent = view.rematchRequestedByOpponent ? 'Accept rematch' : 'Rematch';

            // Ships remaining. The enemy list only contains sunk ships.
            el.fleets.hidden = false;
            setPips(el.yourPips, el.yourCount, FLEET_SIZE - view.yourShips.filter(ship => ship.sunk).length);
            setPips(el.enemyPips, el.enemyCount, FLEET_SIZE - view.opponentShips.length);

            if (view.status === 'PLACING_SHIPS') {
                setTurn('Deploy your fleet', 'neutral');
            } else if (view.status === 'IN_PROGRESS') {
                setTurn(view.yourTurn ? 'Your turn' : "Opponent's turn", view.yourTurn ? 'mine' : 'theirs');
            } else {
                setTurn(null);
            }

            const finished = view.status === 'FINISHED';
            el.banner.hidden = !finished;
            if (finished) {
                el.banner.textContent = view.youWon ? 'Victory' : 'Defeat';
                el.banner.className = `banner ${view.youWon ? 'win' : 'lose'}`;
            }
        },

        /** Shown while a shell is in the air, before the result is known. */
        showShellInFlight(mine) {
            setTurn(mine ? 'Shell away…' : 'Incoming!', mine ? 'mine' : 'theirs');
        },

        showError(message) {
            // In the lobby the room panel is hidden, so use the lobby's own line.
            const line = el.lobby.hidden ? el.error : el.notice;
            line.textContent = message;
            line.hidden = false;
        }
    };
}
