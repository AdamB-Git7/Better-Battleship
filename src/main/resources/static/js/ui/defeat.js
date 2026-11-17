// The end of a lost game: the screen that comes after the defeat cinematic.
//
// Three layers over the 3D scene, under the HUD (so the status panel with its
// Rematch and Leave buttons, and the pirate, stay on top and usable):
//
//   - a flash: the blast lighting up the window, once, for a fraction of a second,
//   - a black curtain that fades in over the scene,
//   - the title: "DEFEAT" and a line under it, fading in on the black.
//
// The timing of the cinematic itself (camera, missile, sound) is in main.js;
// this file only draws. While the screen is up, <body> has the class
// "defeated": the CSS uses it to hide what no longer matters (the fleet
// panel, the turn indicator, the old Defeat banner) and to centre the panel.

const byId = id => document.getElementById(id);

export function createDefeatScreen() {
    const el = {
        root: byId('defeat'),
        flash: byId('defeat-flash')
    };

    return {
        /** The cinematic starts: the HUD clears away (fleet panel, turn, view switch, banner). */
        begin() {
            document.body.classList.add('defeated');
        },

        /** The blast lights up the window: one short flash, never repeated. */
        flash() {
            el.root.hidden = false;
            el.flash.classList.remove('on');
            void el.flash.offsetWidth;   // restart the CSS animation
            el.flash.classList.add('on');
        },

        /**
         * Cuts to black, then the title fades in.
         * @param seconds how long the fade to black takes
         */
        show(seconds = 0.6) {
            el.root.hidden = false;
            el.root.style.setProperty('--fade', `${seconds}s`);
            document.body.classList.add('defeated');
            // Reading the size forces the browser to draw the transparent state
            // first, so the change below is animated instead of instant.
            void el.root.offsetWidth;
            // The curtain fades in; the title follows once it is dark (see style.css).
            el.root.classList.add('black');
        },

        /** Back to the game (rematch) or to the lobby: everything is removed at once. */
        hide() {
            document.body.classList.remove('defeated');
            el.root.classList.remove('black');
            el.flash.classList.remove('on');
            el.root.hidden = true;
        }
    };
}
