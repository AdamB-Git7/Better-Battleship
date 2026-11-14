// The pirate guide in the bottom-left corner: HOW the pirate speaks.
//
// It shows a portrait and a speech bubble, and "types" each line letter by
// letter while the mouth moves. What he says is decided in game/guide.js;
// this file only displays the text it is given.
//
// The portrait itself is an inline SVG in index.html (#pirate).

const TYPE_INTERVAL = 26;        // milliseconds between two letters
const MIN_VISIBLE = 5000;        // a finished line stays at least this long
const READ_TIME_PER_CHAR = 70;   // extra reading time for longer lines

/**
 * @param sound the sound module (for the small "talking" blips)
 */
export function createPirate(sound) {
    const el = {
        root: document.getElementById('pirate'),
        portrait: document.getElementById('pirate-portrait'),
        bubble: document.getElementById('pirate-bubble'),
        text: document.getElementById('pirate-text'),
        live: document.getElementById('pirate-live')
    };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let enabled = true;      // turned off with the "Guide" button
    let inRoom = false;      // the pirate is only on screen during a game
    let lastLine = null;     // so a click on the portrait can repeat it
    let typing = null;       // interval id while a line is being typed
    let hideTimer = null;

    function stopTimers() {
        clearInterval(typing);
        clearTimeout(hideTimer);
        typing = null;
        hideTimer = null;
        el.root.classList.remove('talking');
    }

    function finish(line) {
        stopTimers();
        el.text.textContent = line;
        hideTimer = setTimeout(() => { el.bubble.hidden = true; },
            Math.max(MIN_VISIBLE, line.length * READ_TIME_PER_CHAR));
    }

    /** Says one line. null or an empty line is ignored. */
    function say(line) {
        if (!line) {
            return;
        }
        lastLine = line;
        if (!enabled || !inRoom) {
            return;
        }
        stopTimers();
        el.bubble.hidden = false;
        el.live.textContent = line;   // screen readers get the whole line at once
        if (reducedMotion) {
            finish(line);
            return;
        }
        let shown = 0;
        el.text.textContent = '';
        el.root.classList.add('talking');
        typing = setInterval(() => {
            shown++;
            el.text.textContent = line.slice(0, shown);
            if (shown % 3 === 0 && line[shown - 1] !== ' ') {
                sound.talk();
            }
            if (shown >= line.length) {
                finish(line);
            }
        }, TYPE_INTERVAL);
    }

    function refreshVisibility() {
        el.root.hidden = !(enabled && inRoom);
        if (el.root.hidden) {
            stopTimers();
            el.bubble.hidden = true;
        }
    }

    // Click on the bubble: show the whole line at once, or close it if it is complete.
    el.bubble.addEventListener('click', () => {
        if (typing) {
            finish(lastLine);
        } else {
            stopTimers();
            el.bubble.hidden = true;
        }
    });

    // Click on the pirate: he repeats his last line.
    el.portrait.addEventListener('click', () => say(lastLine));

    return {
        say,
        /** The pirate appears when the player enters a room... */
        enter() {
            inRoom = true;
            refreshVisibility();
        },
        /** ...and leaves when the player goes back to the lobby. */
        leave() {
            inRoom = false;
            lastLine = null;
            refreshVisibility();
        },
        /** Turns the guide on or off. @returns {boolean} the new state */
        toggle() {
            enabled = !enabled;
            refreshVisibility();
            return enabled;
        }
    };
}
