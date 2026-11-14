// Sound effects, synthesised with the Web Audio API so no audio files are needed.
// To use real recordings later, replace the body of cannon / explosion / splash
// with code that plays an AudioBuffer: the rest of the game only calls these three.

export function createSound() {
    let context = null;
    let noiseBuffer = null;
    let muted = false;

    // Browsers only allow audio after a user gesture, so we create the
    // context lazily on the first click or key press.
    function unlock() {
        if (!context) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) {
                return;
            }
            context = new AudioCtx();
            noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
            const data = noiseBuffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                data[i] = Math.random() * 2 - 1;
            }
        }
        if (context.state === 'suspended') {
            context.resume();
        }
    }
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    /** Filtered white noise with a volume envelope: the base of all three sounds. */
    function noise({ duration, volume, type, from, to }) {
        const source = context.createBufferSource();
        source.buffer = noiseBuffer;
        const filter = context.createBiquadFilter();
        filter.type = type;
        const now = context.currentTime;
        filter.frequency.setValueAtTime(from, now);
        filter.frequency.exponentialRampToValueAtTime(to, now + duration);
        const gain = context.createGain();
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
        source.connect(filter).connect(gain).connect(context.destination);
        source.start(now, Math.random());
        source.stop(now + duration);
    }

    /** A short low "thump". */
    function thump({ duration, volume, from, to }) {
        const osc = context.createOscillator();
        const now = context.currentTime;
        osc.frequency.setValueAtTime(from, now);
        osc.frequency.exponentialRampToValueAtTime(to, now + duration);
        const gain = context.createGain();
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
        osc.connect(gain).connect(context.destination);
        osc.start(now);
        osc.stop(now + duration);
    }

    const ready = () => context && context.state === 'running' && !muted;

    return {
        cannon() {
            if (!ready()) return;
            noise({ duration: 0.35, volume: 0.5, type: 'lowpass', from: 2400, to: 200 });
            thump({ duration: 0.3, volume: 0.6, from: 150, to: 40 });
        },
        explosion() {
            if (!ready()) return;
            noise({ duration: 1.3, volume: 0.7, type: 'lowpass', from: 1800, to: 60 });
            thump({ duration: 0.8, volume: 0.8, from: 90, to: 28 });
        },
        splash() {
            if (!ready()) return;
            noise({ duration: 0.9, volume: 0.35, type: 'bandpass', from: 2600, to: 700 });
        },
        /** @returns {boolean} the new muted state */
        toggleMute() {
            muted = !muted;
            return muted;
        }
    };
}
