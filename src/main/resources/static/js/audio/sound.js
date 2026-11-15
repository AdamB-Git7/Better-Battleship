// All the sound of the game, synthesised with the Web Audio API (no audio files).
//
// Signal path:
//
//   one-shot effects (cannon, explosion, splash, thunder) --> effects filter --+
//   storm ambience (rain, wind, waves) --> ambience filter -------------------+--> master --> limiter --> speakers
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
// Everything is made from two ingredients: filtered white noise and sine "thumps".

const MASTER_VOLUME = 0.85;
const SPEED_OF_SOUND = 340;   // world units per second, for the thunder delay

// How each place sounds: ambience volume and brightness, effects brightness,
// and the two layers that only exist inside the bridge.
const PLACES = {
    lobby: { ambience: 0.32, ambienceTone: 6000, effectsTone: 16000, roof: 0, hum: 0, background: 0.45 },
    aerial: { ambience: 0.8, ambienceTone: 15000, effectsTone: 18000, roof: 0, hum: 0, background: 1 },
    bridge: { ambience: 0.6, ambienceTone: 650, effectsTone: 2600, roof: 0.11, hum: 0.035, background: 0.85 }
};

const ENGINE_NOTES = [86, 92.5, 43];   // two slightly detuned engines and their octave below

export function createSound() {
    let context = null;
    let noiseBuffer = null;
    let master = null;
    let effectsBus = null;
    let backgroundBus = null;   // everything that belongs to the battle in the background
    let engine = null;          // the drone of the planes, once started
    let lastDistant = 0;        // when the last distant boom / flak pop was started
    let lastFlak = 0;
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
            master.gain.value = muted ? 0 : MASTER_VOLUME;
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

    /** An endless noise source. Different speeds make the loops sound unrelated. */
    function noiseLoop(rate) {
        const source = context.createBufferSource();
        source.buffer = noiseBuffer;
        source.loop = true;
        source.playbackRate.value = rate;
        source.start(0, Math.random() * 3);
        return source;
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

    // ---- Storm ambience --------------------------------------------------------

    function startAmbience() {
        const settings = PLACES[place];
        const bus = gainNode(settings.ambience);
        const tone = filterNode('lowpass', settings.ambienceTone);
        bus.connect(tone).connect(master);

        // Rain: a steady hiss.
        const rain = gainNode(0.2);
        noiseLoop(1).connect(filterNode('highpass', 1100)).connect(filterNode('lowpass', 7500)).connect(rain).connect(bus);

        // Wind: a band of low noise that swells with the gusts, and a thin
        // whistle on top that only appears when it blows hard.
        const windBand = filterNode('bandpass', 420, 0.9);
        const wind = gainNode(0.2);
        noiseLoop(0.63).connect(windBand).connect(wind).connect(bus);
        const whistleBand = filterNode('bandpass', 1300, 7);
        const whistle = gainNode(0);
        noiseLoop(0.81).connect(whistleBand).connect(whistle).connect(bus);

        // Waves: deep noise whose volume rises and falls every few seconds
        // (two slow oscillators of different speeds, so it never repeats exactly).
        const waves = gainNode(0.3);
        noiseLoop(0.41).connect(filterNode('lowpass', 380)).connect(waves).connect(bus);
        for (const [speed, depth] of [[0.13, 0.14], [0.19, 0.09]]) {
            const lfo = context.createOscillator();
            lfo.frequency.value = speed;
            lfo.connect(gainNode(depth)).connect(waves.gain);
            lfo.start();
        }

        // Inside the bridge only: rain drumming on the roof and the windows,
        // and the low hum of the ship. They skip the muffling filter.
        const roof = gainNode(settings.roof);
        noiseLoop(1.27).connect(filterNode('bandpass', 1700, 0.6)).connect(roof).connect(master);
        const hum = gainNode(settings.hum);
        for (const frequency of [55, 82.5]) {
            const osc = context.createOscillator();
            osc.frequency.value = frequency;
            osc.connect(hum);
            osc.start();
        }
        hum.connect(master);

        ambience = { bus, tone, rain, wind, windBand, whistle, whistleBand, roof, hum };
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
            glide(ambience.wind.gain, 0.1 + 0.5 * gust * gust, 0.6);
            glide(ambience.windBand.frequency, 300 + 420 * gust, 0.6);
            glide(ambience.whistle.gain, 0.07 * gust * gust * gust, 0.6);
            glide(ambience.whistleBand.frequency, 1100 + 500 * gust, 0.6);
            glide(ambience.rain.gain, 0.15 + 0.12 * gust, 0.6);
        },

        /**
         * Thunder for a lightning strike `distance` world units away. Sound is
         * slower than light, so it arrives later (at most 4 s, to stay linked
         * to the flash). Close strikes crack; distant ones only roll.
         */
        thunder(distance) {
            if (!ready()) return;
            const at = Math.min(distance / SPEED_OF_SOUND, 4);
            const close = Math.min(1, Math.max(0, 1 - (distance - 520) / 1000));   // 1 = very close
            const start = context.currentTime + at;

            // The long roll: low noise whose volume wobbles at random while it dies away.
            const duration = 3.2 + 2.6 * (1 - close) + Math.random();
            const source = context.createBufferSource();
            source.buffer = noiseBuffer;
            source.loop = true;
            const filter = filterNode('lowpass', 140 + 420 * close);
            filter.frequency.setValueAtTime(140 + 420 * close, start);
            filter.frequency.exponentialRampToValueAtTime(55, start + duration);
            const gain = gainNode(0);
            const steps = 28;
            const curve = new Float32Array(steps);
            const volume = 0.55 + 0.45 * close;
            for (let i = 0; i < steps; i++) {
                const t = i / (steps - 1);
                const body = Math.min(1, t * 9) * Math.pow(1 - t, 1.6);
                curve[i] = volume * body * (0.5 + 0.5 * Math.random());
            }
            curve[steps - 1] = 0;
            gain.gain.setValueCurveAtTime(curve, start, duration);
            source.connect(filter).connect(gain).connect(effectsBus);
            source.start(start, Math.random() * 2);
            source.stop(start + duration + 0.1);
            thump({ at, duration: 1.6, volume: 0.3 + 0.4 * close, from: 62, to: 24 });

            // The crack: only when the bolt is close enough.
            if (close > 0.4) {
                for (const [delay, level] of [[0, 1], [0.07, 0.5], [0.17, 0.7]]) {
                    noise({ at: at + delay, duration: 0.28, volume: 0.55 * close * level,
                        type: 'bandpass', from: 3200, to: 500, q: 0.6 });
                }
            }
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
