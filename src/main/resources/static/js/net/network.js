// Network layer: a thin wrapper around the STOMP WebSocket client.
// The protocol is exactly the one of the original 2D game, the server is unchanged.
// The rest of the front end never touches STOMP directly, it only uses this module.

/* global StompJs */

/**
 * @param handlers {{
 *   onConnection: (connected: boolean) => void,
 *   onRoom: (room: object) => void,
 *   onGame: (view: object) => void,
 *   onError: (message: string) => void,
 *   onLeft: (message: string) => void
 * }}
 */
export function createNetwork(handlers) {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const client = new StompJs.Client({
        brokerURL: `${protocol}://${location.host}/ws`,
        reconnectDelay: 0
    });

    client.onConnect = () => {
        // Each player only ever receives their own private view of the game.
        client.subscribe('/user/queue/room', m => handlers.onRoom(JSON.parse(m.body)));
        client.subscribe('/user/queue/game', m => handlers.onGame(JSON.parse(m.body)));
        client.subscribe('/user/queue/errors', m => handlers.onError(JSON.parse(m.body).message));
        client.subscribe('/user/queue/left', m => handlers.onLeft(JSON.parse(m.body).message));
        handlers.onConnection(true);
    };
    client.onWebSocketClose = () => handlers.onConnection(false);

    function send(destination, body) {
        client.publish(body === undefined
            ? { destination }
            : { destination, body: JSON.stringify(body) });
    }

    return {
        connect: () => client.activate(),
        createRoom: () => send('/app/create'),
        joinRoom: code => send('/app/join', { code }),
        placeShip: (code, type, row, col, orientation) =>
            send('/app/place', { code, type, row, col, orientation }),
        fire: (code, row, col) => send('/app/fire', { code, row, col }),
        rematch: () => send('/app/rematch'),
        leave: () => send('/app/leave')
    };
}
