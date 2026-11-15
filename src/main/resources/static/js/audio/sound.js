// All the sound of the game, with the Web Audio API.
//
// The storm (rain and thunder) uses real recordings, in static/assets/audio
// (CC0, from OpenGameArt; see the README credits). Guns, explosions,
// splashes and the background battle are synthesised.
//
// Signal path:
//
//   one-shot effects (cannon, explosion, splash, thunder) --> effects filter --+
//   storm ambience (recorded rain) -------> ambience filter -----------------+--> master --> limiter --> speakers
//   bridge-only layers (rain on the roof, hull hum) ---------------------------+
//
//   background battle (distant guns, flak, plane engines) --> background gain --> effects filter
//
// - "master" is the single volume knob; SOUND ON / OFF simply turns it to 0.
// - The limiter (a compressor) keeps thunder + explosion + ambience from clipping.
// - The background battle has its own small volume knob in front of the effects
//   filter, so it always stays behind the player's own guns, the thunder and
//   the pirate.
// - The two filters change with the place: on the bridge the storm is heard
//   through steel and glass (muffled), in the aerial view it is open and wide.
//
// The synthesised sounds are made from filtered white noise and sine "thumps".

const MASTER_VOLUME = 0.42;
const FADE_IN = 4;            // seconds: the sound fades in when it first starts, never a sudden blast
const SPEED_OF_SOUND = 340;   // world units per second, for the thunder delay

// How each place sounds: ambience volume and brightness, effects brightness,
// and the two layers that only exist inside the bridge.
const PLACES = {
    lobby: { ambience: 0.14, ambienceTone: 5000, effectsTone: 12000, roof: 0, hum: 0, background: 0.3 },
    aerial: { ambience: 0.38, ambienceTone: 12000, effectsTone: 18000, roof: 0, hum: 0, background: 0.85 },
    bridge: { ambience: 0.3, ambienceTone: 900, effectsTone: 2600, roof: 0.16, hum: 0.03, background: 0.75 }
};

const ENGINE_NOTES = [86, 92.5, 43];   // two slightly detuned engines and their octave below

// ---- Recorded storm --------------------------------------------------------
// The files are fetched while the page loads, and decoded once audio starts.
const RAIN_URL = 'assets/audio/rain-loop.mp3';      // 27 s of heavy rain, loopable
const THUNDER_URL = 'assets/audio/thunder.mp3';     // one long thunderclap and its roll, 24 s

function fetchAudio(url) {
    return fetch(url).then(response => {
        if (!response.ok) {
            throw new Error(`Could not load ${url}`);
        }
        return response.arrayBuffer();
    });
}

export function createSound() {
    const rainBytes = fetchAudio(RAIN_URL);
    const thunderBytes = fetchAudio(THUNDER_URL);
    let thunderBuffer = null;   // decoded thunder, once ready
    let context = null;
    let noiseBuffer = null;
    let master = null;
    let effectsBus = null;
    let backgroundBus = null;   // everything that belongs to the battle in the background
    let engine = null;          // the drone of the planes, once started
    let lastDistant = 0;        // when the last distant boom / flak pop was started
    let lastFlak = 0;
    let lastSecondary = 0;      // the sinking sounds are rate-limited too
    let lastGroan = 0;
    let lastSteam = 0;
    let lastEngineUpdate = 0;
    let ambience = null;        // the nodes of the storm ambience, once started
    let muted = false;
    let place = 'lobby';
    let lastGustUpdate = 0;

    // Browsers only allow audio after a user gesture, so everything is created
    // lazily on the first click or key press. The ambience starts then too.
    function unlock() {
        if (!context) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) {
                return;
            }
            context = new AudioCtx();
            // Four seconds of white noise, looped and filtered in different ways.
            noiseBuffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
            const data = noiseBuffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            const limiter = context.createDynamicsCompressor();
            limiter.threshold.value = -14;
            limiter.knee.value = 12;
            limiter.ratio.value = 8;
            limiter.attack.value = 0.004;
            limiter.release.value = 0.3;
            master = context.createGain();
            // Start silent and fade in, so the first click never starts with a roar.
            master.gain.value = 0;
            if (!muted) {
                master.gain.setTargetAtTime(MASTER_VOLUME, context.currentTime + 0.1, FADE_IN / 3);
            }
            master.connect(limiter).connect(context.destination);
            effectsBus = context.createBiquadFilter();
            effectsBus.type = 'lowpass';
            effectsBus.frequency.value = PLACES[place].effectsTone;
            effectsBus.connect(master);
            backgroundBus = gainNode(PLACES[place].background);
            backgroundBus.connect(effectsBus);
            startAmbience();
            startEngine();
        }
        if (context.state === 'suspended') {
            context.resume();
        }
    }
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // ---- Building blocks ---------------------------------------------------

    function filterNode(type, frequency, q = 0.7) {
        const filter = context.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = frequency;
        filter.Q.value = q;
        return filter;
    }

    function gainNode(value) {
        const gain = context.createGain();
        gain.gain.value = value;
        return gain;
    }

    /**
     * A burst of filtered noise that fades out.
     * options: at (seconds from now), duration, volume, type, from / to (filter sweep), q,
     *          out (where it plays: the effects filter unless told otherwise)
     */
    function noise({ at = 0, duration, volume, type, from, to, q = 0.7, out = effectsBus }) {
        const start = context.currentTime + at;
        const source = context.createBufferSource();
        source.buffer = noiseBuffer;
        const filter = filterNode(type, from, q);
        filter.frequency.setValueAtTime(from, start);
        filter.frequency.exponentialRampToValueAtTime(to, start + duration);
        const gain = gainNode(0);
        gain.gain.setValueAtTime(volume, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        source.connect(filter).connect(gain).connect(out);
        source.start(start, Math.random() * 2);
        source.stop(start + duration);
    }

    /** A low sine "thump" that drops in pitch. */
    function thump({ at = 0, duration, volume, from, to, out = effectsBus }) {
        const start = context.currentTime + at;
        const osc = context.createOscillator();
        osc.frequency.setValueAtTime(from, start);
        osc.frequency.exponentialRampToValueAtTime(to, start + duration);
        const gain = gainNode(0);
        gain.gain.setValueAtTime(volume, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        osc.connect(gain).connect(out);
        osc.start(start);
        osc.stop(start + duration);
    }

    /** Louder and brighter when close: 1 at the listener, about 0.4 across the battlefield. */
    function nearness(distance) {
        return Math.max(0.3, 1 / (1 + Math.pow(distance / 280, 2)));
    }

    const ready = () => context && context.state === 'running' && !muted;

    /** How loud something far away in the background battle is: 1 close by, 0.12 on the horizon. */
    function farness(distance) {
        return Math.max(0.12, 1 / (1 + Math.pow(distance / 450, 2)));
    }

    /** Sound is slower than light: a distant gun is heard after its flash (at most 3.5 s later). */
    const travel = distance => Math.min(distance / SPEED_OF_SOUND, 3.5);

    // ---- Plane engines ---------------------------------------------------------

    /**
     * One continuous drone for all the planes: a few low saw-tooth notes
     * through a low-pass filter, with a fast flutter (the propellers). It is
     * silent until setEngine() turns it up.
     */
    function startEngine() {
        const volume = gainNode(0);
        const tone = filterNode('lowpass', 300);
        const flutter = gainNode(1);
        const oscillators = ENGINE_NOTES.map((frequency, index) => {
            const osc = context.createOscillator();
            osc.type = index < 2 ? 'sawtooth' : 'triangle';
            osc.frequency.value = frequency;
            osc.connect(tone);
            osc.start();
            return osc;
        });
        const lfo = context.createOscillator();
        lfo.frequency.value = 23;
        lfo.connect(gainNode(0.22)).connect(flutter.gain);
        lfo.start();
        tone.connect(flutter).connect(volume).connect(backgroundBus);
        engine = { volume, tone, oscillators };
    }

    // ---- Recorded rain -----------------------------------------------------------

    /**
     * Plays the rain recording in an endless loop. The first and last 50 ms
     * are skipped, because MP3 files have a little silence at each end that
     * would be heard as a tick at every loop.
     */
    function rainLoop(buffer, rate, offset) {
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.loopStart = 0.05;
        source.loopEnd = buffer.duration - 0.05;
        source.playbackRate.value = rate;
        source.start(0, 0.05 + offset * (buffer.duration - 0.1));
        return source;
    }

    // ---- Storm ambience --------------------------------------------------------

    function startAmbience() {
        const settings = PLACES[place];
        const bus = gainNode(settings.ambience);
        const tone = filterNode('lowpass', settings.ambienceTone);
        bus.connect(tone).connect(master);

        // Rain: the recording, twice at once from different points, the second
        // one slightly slower and darker. Together they sound like a heavier,
        // wider downpour, and they never line up the same way twice.
        const rain = gainNode(0.9);
        rain.connect(bus);

        // Inside the bridge only: the rain drumming on the roof and windows
        // (the recording through a band of metal resonance), and the low hum
        // of the ship. They skip the muffling filter.
        const roof = gainNode(settings.roof);
        roof.connect(master);

        rainBytes
            .then(bytes => context.decodeAudioData(bytes))
            .then(buffer => {
                rainLoop(buffer, 1, 0).connect(filterNode('highpass', 90)).connect(rain);
                rainLoop(buffer, 0.9, 0.5).connect(filterNode('lowpass', 2200)).connect(gainNode(0.55)).connect(rain);
                rainLoop(buffer, 1.05, 0.25).connect(filterNode('bandpass', 1600, 0.8)).connect(roof);
            })
            .catch(error => console.warn('Rain sound unavailable:', error));
        thunderBytes
            .then(bytes => context.decodeAudioData(bytes))
            .then(buffer => { thunderBuffer = buffer; })
            .catch(error => console.warn('Thunder sound unavailable:', error));

        const hum = gainNode(settings.hum);
        for (const frequency of [55, 82.5]) {
            const osc = context.createOscillator();
            osc.frequency.value = frequency;
            osc.connect(hum);
            osc.start();
        }
        hum.connect(master);

        ambience = { bus, tone, rain, roof, hum };
    }

    /** Moves an audio parameter smoothly to a new value (a crossfade). */
    function glide(param, value, seconds) {
        param.setTargetAtTime(value, context.currentTime, seconds / 3);
    }

    return {
        /**
         * Where the listener is: 'lobby', 'aerial' or 'bridge'. The ambience
         * crossfades to the sound of that place.
         */
        setPlace(name) {
            place = name;
            if (!ambience) {
                return;
            }
            const settings = PLACES[name];
            glide(ambience.bus.gain, settings.ambience, 1.6);
            glide(ambience.tone.frequency, settings.ambienceTone, 1.6);
            glide(effectsBus.frequency, settings.effectsTone, 1.6);
            glide(ambience.roof.gain, settings.roof, 1.6);
            glide(ambience.hum.gain, settings.hum, 1.6);
            glide(backgroundBus.gain, settings.background, 1.6);
        },

        /** Called every frame with the strength of the wind (0..1), see weather.js. */
        setGust(gust) {
            if (!ambience || context.currentTime - lastGustUpdate < 0.2) {
                return;   // a few updates per second are plenty
            }
            lastGustUpdate = context.currentTime;
            glide(ambience.rain.gain, 0.75 + 0.3 * gust, 0.8);   // gusts drive the rain harder
        },

        /**
         * Thunder for a lightning strike `distance` world units away. Sound is
         * slower than light, so it arrives later (at most 4 s, to stay linked
         * to the flash). Close strikes crack; distant ones only roll.
         */
        thunder(distance) {
            if (!ready() || !thunderBuffer) return;
            const at = Math.min(distance / SPEED_OF_SOUND, 4);
            const close = Math.min(1, Math.max(0, 1 - (distance - 520) / 1000));   // 1 = very close
            const start = context.currentTime + at;

            // The recorded thunderclap. Close strikes play it from the start,
            // with the sharp crack, loud and bright. Distant ones skip the crack
            // and only roll: quieter, darker, shorter. A small random change of
            // speed makes every strike sound a little different.
            const source = context.createBufferSource();
            source.buffer = thunderBuffer;
            source.playbackRate.value = 0.88 + Math.random() * 0.2;
            const offset = close > 0.5 ? 0 : 0.6 + Math.random() * 0.8;
            const length = 12 + 12 * close;   // seconds of roll
            const filter = filterNode('lowpass', 700 + 9000 * close * close);
            const gain = gainNode(0);
            const volume = 0.35 + 0.65 * close;
            gain.gain.setValueAtTime(0, start);
            gain.gain.linearRampToValueAtTime(volume, start + 0.06);
            gain.gain.setValueAtTime(volume, start + length - 4);
            gain.gain.linearRampToValueAtTime(0, start + length);
            source.connect(filter).connect(gain).connect(effectsBus);
            source.start(start, offset);
            source.stop(start + length + 0.1);
        },

        /** A gun firing, `distance` world units from the listener. */
        cannon(distance = 0) {
            if (!ready()) return;
            const near = nearness(distance);
            noise({ duration: 0.12, volume: 0.5 * near, type: 'highpass', from: 1800, to: 900 });   // the crack
            noise({ duration: 0.7, volume: 0.6 * near, type: 'lowpass', from: 2200 * near + 300, to: 90 });
            thump({ duration: 0.55, volume: 0.8 * near, from: 130, to: 32 });
        },

        explosion(distance = 0) {
            if (!ready()) return;
            const near = nearness(distance);
            noise({ duration: 2.0, volume: 0.8 * near, type: 'lowpass', from: 1700 * near + 300, to: 45 });
            noise({ at: 0.05, duration: 0.9, volume: 0.25 * near, type: 'bandpass', from: 2600, to: 700 });   // debris
            thump({ duration: 1.3, volume: 0.9 * near, from: 80, to: 22 });
        },

        splash(distance = 0) {
            if (!ready()) return;
            const near = nearness(distance);
            noise({ duration: 1.4, volume: 0.45 * near, type: 'bandpass', from: 2400, to: 500 });
            noise({ at: 0.25, duration: 1.6, volume: 0.25 * near, type: 'highpass', from: 3000, to: 1800 });   // spray falling back
            thump({ duration: 0.4, volume: 0.45 * near, from: 95, to: 38 });
        },

        // ---- A ship going down (see scene/sinking.js) ----------------------------
        // Deliberately few, dark layers, quieter than a gun: they sit under the
        // storm instead of on top of it.

        /** The killing blow: a magazine going up. A sharp crack, then a deep, long roll. */
        deathBlow(distance = 0) {
            if (!ready()) return;
            const near = nearness(distance);
            noise({ duration: 0.09, volume: 0.4 * near, type: 'highpass', from: 2600, to: 1200 });
            thump({ duration: 2.4, volume: 0.85 * near, from: 58, to: 17 });
            noise({ duration: 3.4, volume: 0.65 * near, type: 'lowpass', from: 1100 * near + 250, to: 38 });
            for (let i = 0; i < 4; i++) {   // things breaking and falling back
                noise({ at: 0.2 + Math.random() * 1.1, duration: 0.2 + Math.random() * 0.3, volume: 0.08 * near,
                    type: 'bandpass', from: 1500, to: 400, q: 1.2 });
            }
        },

        /** A small blast inside a burning hull (ammunition, a fuel tank): muffled. */
        secondaryBlast(distance = 0) {
            if (!ready() || context.currentTime - lastSecondary < 0.3) return;
            lastSecondary = context.currentTime;
            const near = nearness(distance);
            thump({ duration: 0.9, volume: 0.35 * near, from: 72, to: 26 });
            noise({ duration: 1.2, volume: 0.28 * near, type: 'lowpass', from: 700 * near + 200, to: 50 });
        },

        /**
         * Steel giving way. A real creak is a fast train of tiny slips: here a
         * very low saw-tooth (each tooth = one slip), slowing down, heard
         * only through two resonances of the hull that slide down in pitch,
         * over a deep rumble. Quiet and dark on purpose.
         * @param strength 1 = a normal groan, more for the hull breaking in two
         */
        groan(distance = 0, strength = 1) {
            if (!ready() || context.currentTime - lastGroan < 1.2) return;
            lastGroan = context.currentTime;
            const near = nearness(distance);
            const start = context.currentTime;
            const seconds = 2.4 + Math.random() * 1.6;
            const slips = context.createOscillator();
            slips.type = 'sawtooth';
            slips.frequency.setValueAtTime(26 + Math.random() * 10, start);
            slips.frequency.linearRampToValueAtTime(13 + Math.random() * 5, start + seconds);
            const body = gainNode(0);
            const peak = Math.min(0.9, 0.45 * strength) * near;
            body.gain.setValueAtTime(0.0001, start);
            body.gain.exponentialRampToValueAtTime(peak, start + seconds * 0.4);
            body.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
            const pitch = 150 + Math.random() * 80;
            for (const [ratio, q, level] of [[1, 9, 1], [2.3, 12, 0.5]]) {
                const band = filterNode('bandpass', pitch * ratio * 1.2, q);
                band.frequency.setValueAtTime(pitch * ratio * 1.2, start);
                band.frequency.exponentialRampToValueAtTime(pitch * ratio * 0.75, start + seconds);
                slips.connect(band).connect(gainNode(level)).connect(body);
            }
            body.connect(filterNode('lowpass', 900)).connect(effectsBus);
            slips.start(start);
            slips.stop(start + seconds + 0.05);
            noise({ duration: seconds, volume: 0.22 * strength * near, type: 'lowpass', from: 220, to: 60 });
        },

        /** Hiss of steam: hot metal and boilers meeting the sea. Swells in, then fades. */
        steam(distance = 0, seconds = 3) {
            if (!ready() || context.currentTime - lastSteam < 1.5) return;
            lastSteam = context.currentTime;
            const near = nearness(distance);
            const start = context.currentTime;
            const source = context.createBufferSource();
            source.buffer = noiseBuffer;
            source.loop = true;
            const gain = gainNode(0);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.07 * near, start + 0.4);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
            source.connect(filterNode('highpass', 2200)).connect(filterNode('lowpass', 7000)).connect(gain).connect(effectsBus);
            source.start(start, Math.random() * 2);
            source.stop(start + seconds + 0.05);
        },

        /**
         * The hull slipping under: a deep rumble that bubbles (its volume
         * wobbles with two slow, unrelated beats, like air breaking the surface).
         */
        plunge(distance = 0) {
            if (!ready()) return;
            const near = nearness(distance);
            const start = context.currentTime;
            const seconds = 5.5;
            const source = context.createBufferSource();
            source.buffer = noiseBuffer;
            source.loop = true;
            const tone = filterNode('lowpass', 520);
            tone.frequency.setValueAtTime(520, start);
            tone.frequency.exponentialRampToValueAtTime(110, start + seconds);
            const gain = gainNode(0);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.32 * near, start + 1.2);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
            const bubbling = gainNode(1);
            for (const [rate, depth] of [[3.1, 0.35], [5.3, 0.25]]) {
                const lfo = context.createOscillator();
                lfo.frequency.value = rate * (0.85 + Math.random() * 0.3);
                lfo.connect(gainNode(depth)).connect(bubbling.gain);
                lfo.start(start);
                lfo.stop(start + seconds + 0.05);
            }
            source.connect(tone).connect(bubbling).connect(gain).connect(effectsBus);
            source.start(start, Math.random() * 2);
            source.stop(start + seconds + 0.05);
            thump({ at: 0.3, duration: 3.2, volume: 0.35 * near, from: 46, to: 20 });
        },

        // ---- The battle in the background (see scene/battlefield.js) -------------
        // All of these are quiet on purpose and start at most a few times per second.

        /** Guns of a distant ship: a soft thump and a rumble, heard after a delay. */
        distantGuns(distance) {
            if (!ready() || context.currentTime - lastDistant < 0.25) return;
            lastDistant = context.currentTime;
            const near = farness(distance);
            const at = travel(distance);
            thump({ at, duration: 0.8, volume: 0.3 * near, from: 75, to: 26, out: backgroundBus });
            noise({ at, duration: 1.8, volume: 0.2 * near, type: 'lowpass', from: 260 + 500 * near, to: 50, out: backgroundBus });
        },

        /** A distant hit or bomb: longer and deeper than the guns. */
        distantBlast(distance) {
            if (!ready() || context.currentTime - lastDistant < 0.25) return;
            lastDistant = context.currentTime;
            const near = farness(distance);
            const at = travel(distance);
            thump({ at, duration: 1.4, volume: 0.34 * near, from: 60, to: 20, out: backgroundBus });
            noise({ at, duration: 2.6, volume: 0.26 * near, type: 'lowpass', from: 380 + 600 * near, to: 40, out: backgroundBus });
        },

        /** An anti-aircraft shell bursting in the sky: a small dry pop. */
        flak(distance) {
            if (!ready() || context.currentTime - lastFlak < 0.14) return;
            lastFlak = context.currentTime;
            const near = farness(distance);
            const at = travel(distance);
            noise({ at, duration: 0.16, volume: 0.09 * near, type: 'bandpass', from: 700, to: 250, q: 1, out: backgroundBus });
            thump({ at, duration: 0.12, volume: 0.07 * near, from: 110, to: 60, out: backgroundBus });
        },

        /**
         * The drone of the closest plane, called every frame.
         * @param level 0 (no plane near) .. 1 (right overhead)
         * @param pitch 1 = normal; higher while the plane comes closer, lower while it leaves (Doppler)
         */
        setEngine(level, pitch) {
            if (!engine || context.currentTime - lastEngineUpdate < 0.1) {
                return;   // ten updates per second are plenty
            }
            lastEngineUpdate = context.currentTime;
            glide(engine.volume.gain, 0.2 * level, 0.35);
            glide(engine.tone.frequency, 220 + 520 * level, 0.35);
            engine.oscillators.forEach((osc, index) => glide(osc.frequency, ENGINE_NOTES[index] * pitch, 0.3));
        },

        /** Tiny blip played while the pirate's text is typed. */
        talk() {
            if (!ready()) return;
            const osc = context.createOscillator();
            osc.type = 'square';
            osc.frequency.value = 170 + Math.random() * 70;
            const gain = gainNode(0);
            const now = context.currentTime;
            gain.gain.setValueAtTime(0.035, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
            osc.connect(gain).connect(master);
            osc.start(now);
            osc.stop(now + 0.05);
        },

        /**
         * SOUND ON / OFF: silences everything, the ambience included.
         * @returns {boolean} the new muted state
         */
        toggleMute() {
            muted = !muted;
            if (master) {
                glide(master.gain, muted ? 0 : MASTER_VOLUME, 0.15);
            }
            return muted;
        }
    };
}
