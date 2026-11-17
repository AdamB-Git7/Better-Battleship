// Guided missiles: the shots of the real game (and the one of the defeat cinematic).
//
// A missile is a small model built in code (body, ogive nose, fins, painted
// bands) that flies along a smooth curve:
//
//     launch point --> straight up out of the ship (or out of the fog)
//                 --> turns and cruises towards the target
//                 --> dives onto the target
//
// The path is two cubic Bezier curves joined end to end (7 points): the first
// one goes straight up and levels off at cruise height, the second one cruises
// and then bends down into a steep dive. The middle point is shared and both
// curves are level there, so the join is smooth. A small table of lengths
// along the path lets the missile move at the speed we want (slow out of the
// tube, then faster and faster) instead of the uneven speed the raw curve
// parameter would give.
//
// Everything visible besides the model is particles from the shared pool of
// effects.js: the exhaust flame (glowing sprites), the long smoke trail that
// stays a few seconds and drifts with the wind, the launch cloud. The glow of
// the motor borrows the single flash light of effects.js, so missiles add no
// light to the scene.
//
// Nothing is created while a missile flies: models, vectors and tables are
// made once and reused (a small pool of models).

import * as THREE from 'three';

const MODEL_SCALE = 1.35;   // a real missile would be a dot at the game's distances
const TAIL = -3.1;          // where the nozzle is, along the body (local z)
const SAMPLES = 48;         // points in the table of lengths along the path
const TRAIL_SPACING = 0.7;  // world units between two puffs of the smoke trail
const MAX_PUFFS = 20;       // per frame, so a very long jump never floods the pool

// Looks of the two sides: my missiles are light grey with a blue band, the
// enemy's are gunmetal with a red band (easy to tell apart, even from the bridge).
const STYLES = {
    mine: { body: 0xc9ced2, band: 0x2f7fd6 },
    enemy: { body: 0x5c6268, band: 0xc0281c }
};

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);

/** Glues several geometries into one (fewer draw calls). Only positions and normals are kept. */
function mergeParts(parts) {
    const flat = parts.map(part => (part.index ? part.toNonIndexed() : part));
    const count = flat.reduce((sum, part) => sum + part.attributes.position.count, 0);
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    let offset = 0;
    for (const part of flat) {
        positions.set(part.attributes.position.array, offset);
        normals.set(part.attributes.normal.array, offset);
        offset += part.attributes.position.array.length;
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    return merged;
}

/**
 * The shapes of the missile, along +z (nose at +z). Shared by every model.
 * Three geometries, one per material: painted metal, coloured bands, dark parts.
 */
function buildGeometries() {
    const radius = 0.32;
    // Lathe = a profile turned around the y axis; rotateX turns y into z.
    const along = geometry => geometry.rotateX(Math.PI / 2);

    // The body, with a slightly narrower "boat tail" at the back.
    const body = along(new THREE.CylinderGeometry(radius, radius, 4.4, 14, 1, true)).translate(0, 0, -0.1);
    const boatTail = along(new THREE.CylinderGeometry(radius, radius * 0.8, 0.5, 14, 1, true)).translate(0, 0, -2.55);
    // An ogive nose: rounded, not a plain cone.
    const noseProfile = [];
    for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        noseProfile.push(new THREE.Vector2(radius * Math.sqrt(1 - t * t * 0.98), t * 1.9));
    }
    const nose = along(new THREE.LatheGeometry(noseProfile, 14)).translate(0, 0, 2.1);

    // Four tail fins (a swept trapezoid) and four small strakes along the middle.
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.lineTo(0.95, -0.15);
    finShape.lineTo(0.95, 0.55);
    finShape.lineTo(0, 1.35);
    finShape.closePath();
    const strakeShape = new THREE.Shape();
    strakeShape.moveTo(0, 0);
    strakeShape.lineTo(0.28, 0.25);
    strakeShape.lineTo(0.28, 1.2);
    strakeShape.lineTo(0, 1.5);
    strakeShape.closePath();
    const fins = [];
    for (let i = 0; i < 4; i++) {
        const angle = Math.PI / 4 + i * Math.PI / 2;
        // The shape is drawn in (x = outwards, y = along the body); turn y into z.
        const fin = new THREE.ExtrudeGeometry(finShape, { depth: 0.06, bevelEnabled: false })
            .translate(radius * 0.9, 0, -0.03).rotateX(Math.PI / 2).rotateZ(angle).translate(0, 0, -1.55);
        const strake = new THREE.ExtrudeGeometry(strakeShape, { depth: 0.05, bevelEnabled: false })
            .translate(radius * 0.9, 0, -0.025).rotateX(Math.PI / 2).rotateZ(angle).translate(0, 0, 0.3);
        fins.push(fin, strake);
    }

    // Painted bands: a wide one behind the nose, a thin one near the tail.
    const band = (z, width) => along(new THREE.CylinderGeometry(radius * 1.02, radius * 1.02, width, 14, 1, true)).translate(0, 0, z);

    // The nozzle and the seeker window at the tip are dark.
    const nozzle = along(new THREE.CylinderGeometry(radius * 0.62, radius * 0.75, 0.35, 12, 1, true)).translate(0, 0, -2.95);
    const nozzleBack = along(new THREE.CircleGeometry(radius * 0.62, 12)).rotateY(Math.PI).translate(0, 0, -3.1);
    const seeker = along(new THREE.SphereGeometry(0.09, 8, 6)).translate(0, 0, 4.0);

    return {
        metal: mergeParts([body, boatTail, nose, ...fins]),
        band: mergeParts([band(1.55, 0.42), band(-1.9, 0.14)]),
        dark: mergeParts([nozzle, nozzleBack, seeker])
    };
}

/**
 * @param root the group the models are added to
 * @param fx what the missiles need from effects.js:
 *        { spawn, glow(position, intensity), sound, distanceTo(position) }
 */
export function createMissiles(root, fx) {
    const { spawn, glow, sound, distanceTo } = fx;
    const geometries = buildGeometries();
    const materials = {};
    for (const [name, colors] of Object.entries(STYLES)) {
        materials[name] = {
            // Metal that still reads at night: the storm sky is baked into the
            // environment map (storm.js), and a faint emissive keeps it from going black.
            metal: new THREE.MeshStandardMaterial({ color: colors.body, metalness: 0.6, roughness: 0.32, emissive: 0x15181b }),
            band: new THREE.MeshStandardMaterial({ color: colors.band, metalness: 0.2, roughness: 0.5, emissive: colors.band, emissiveIntensity: 0.12 }),
            dark: new THREE.MeshStandardMaterial({ color: 0x111316, metalness: 0.4, roughness: 0.6 })
        };
    }

    // Reusable vectors (no allocation while flying).
    const velocity = new THREE.Vector3();
    const point = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const side = new THREE.Vector3();
    const lift = new THREE.Vector3();
    const tail = new THREE.Vector3();
    const jitter = new THREE.Vector3();

    const pool = [];   // every missile ever built, flying or not

    function buildMissile(style) {
        const group = new THREE.Group();
        for (const part of ['metal', 'band', 'dark']) {
            group.add(new THREE.Mesh(geometries[part], materials[style][part]));
        }
        group.scale.setScalar(MODEL_SCALE);
        group.visible = false;
        root.add(group);
        return {
            style, group, active: false,
            points: Array.from({ length: 7 }, () => new THREE.Vector3()),   // two curves sharing points[3]
            lengths: new Float32Array(SAMPLES + 1),   // length of the curve from the start to each sample
            lastPuff: new THREE.Vector3(),            // where the smoke trail stopped last frame
            time: 0, duration: 1, s: 0, kind: 'outgoing', phase: 0,
            onImpact: null, onCancel: null
        };
    }

    /** A free model of the right side, built the first time it is needed. */
    function take(style) {
        let missile = pool.find(m => !m.active && m.style === style);
        if (!missile) {
            missile = buildMissile(style);
            pool.push(missile);
        }
        return missile;
    }

    // ---- The curve -------------------------------------------------------------

    /**
     * Which of the two curves a path parameter t (0..1) falls on: the first
     * half of t is the climb, the second half the cruise and dive.
     * Returns the index of the curve's first point; `local` gets t on that curve.
     */
    const local = { t: 0 };
    function segment(t) {
        if (t < 0.5) {
            local.t = t * 2;
            return 0;
        }
        local.t = Math.min(1, t * 2 - 1);
        return 3;
    }

    /** Point of the path at parameter t (0..1). */
    function bezier(points, t, target) {
        const i = segment(t);
        const p0 = points[i], p1 = points[i + 1], p2 = points[i + 2], p3 = points[i + 3];
        const v = local.t;
        const u = 1 - v;
        const a = u * u * u;
        const b = 3 * u * u * v;
        const c = 3 * u * v * v;
        const d = v * v * v;
        return target.set(
            a * p0.x + b * p1.x + c * p2.x + d * p3.x,
            a * p0.y + b * p1.y + c * p2.y + d * p3.y,
            a * p0.z + b * p1.z + c * p2.z + d * p3.z
        );
    }

    /** Direction of the path at parameter t (the derivative, not normalised). */
    function bezierTangent(points, t, target) {
        const i = segment(t);
        const p0 = points[i], p1 = points[i + 1], p2 = points[i + 2], p3 = points[i + 3];
        const v = local.t;
        const u = 1 - v;
        const a = 3 * u * u;
        const b = 6 * u * v;
        const c = 3 * v * v;
        return target.set(
            a * (p1.x - p0.x) + b * (p2.x - p1.x) + c * (p3.x - p2.x),
            a * (p1.y - p0.y) + b * (p2.y - p1.y) + c * (p3.y - p2.y),
            a * (p1.z - p0.z) + b * (p2.z - p1.z) + c * (p3.z - p2.z)
        );
    }

    /**
     * Lays out the 7 points of the path from `from` to `to`.
     *   points[0..3]: the climb. Straight up, then bending over to level flight.
     *   points[3..6]: the cruise, then the dive onto the target.
     * `top` is the cruise height above the higher of the two ends; `split` is
     * how far along (0..1) the missile levels off.
     */
    function layOut(points, from, to, top, split, diveSteepness) {
        const [p0, p1, p2, p3, p4, p5, p6] = points;
        const cruise = Math.max(from.y, to.y) + top;
        // Horizontal direction and distance from the launcher to the target.
        side.set(to.x - from.x, 0, to.z - from.z);
        const reach = side.length();
        side.normalize();
        p0.copy(from);
        p6.copy(to);
        // The level-off point, and the two handles that keep the path level there.
        p3.copy(from).addScaledVector(side, reach * split).setY(cruise);
        p1.copy(from).setY(from.y + (cruise - from.y) * 0.75);   // straight up out of the tube
        p2.copy(p3).addScaledVector(side, -reach * split * 0.45);
        p4.copy(p3).addScaledVector(side, reach * (1 - split) * 0.45);
        // Above the target: the higher this handle, the steeper the final dive.
        p5.copy(to).addScaledVector(side, -reach * 0.08).setY(to.y + (cruise - to.y) * diveSteepness);
    }

    /** Fills the table of lengths, so we can move a fixed distance along the curve. */
    function measure(missile) {
        let total = 0;
        bezier(missile.points, 0, point);
        missile.lengths[0] = 0;
        for (let i = 1; i <= SAMPLES; i++) {
            bezier(missile.points, i / SAMPLES, tangent);   // tangent is only a spare vector here
            total += tangent.distanceTo(point);
            missile.lengths[i] = total;
            point.copy(tangent);
        }
    }

    /** Curve parameter t at a fraction s (0..1) of the curve's length. */
    function parameterAt(missile, s) {
        const target = s * missile.lengths[SAMPLES];
        let i = 1;
        while (i < SAMPLES && missile.lengths[i] < target) {
            i++;
        }
        const before = missile.lengths[i - 1];
        const span = missile.lengths[i] - before || 1;
        return (i - 1 + (target - before) / span) / SAMPLES;
    }

    // ---- Launch ----------------------------------------------------------------

    /**
     * Fires a missile from `from` to `to`.
     * @param onImpact called once, when it reaches the target (main.js reveals the result then)
     * @param options
     *   style: 'mine' (light grey, blue band) or 'enemy' (gunmetal, red band)
     *   kind: 'outgoing' (my shot), 'incoming' (the enemy's shot), 'cinematic' (the defeat)
     *   duration: seconds of flight (default: from the distance, 1.6 to 2.3 s)
     *   onCancel: called instead of onImpact if the missile is removed early (leaving the game)
     * @returns the flight duration in seconds
     */
    function launch(from, to, onImpact, options = {}) {
        const kind = options.kind ?? 'outgoing';
        const missile = take(options.style ?? (kind === 'outgoing' ? 'mine' : 'enemy'));
        const distance = from.distanceTo(to);
        if (kind === 'cinematic') {
            // Out of the fog, a short climb, then nearly flat and straight at
            // the bridge windows: seen head-on, it grows and grows.
            layOut(missile.points, from, to, 10, 0.3, 0.1);
        } else {
            // Vertical launch, a cruise above the battlefield, a steep dive.
            // Kept low enough to stay in the bridge windows.
            layOut(missile.points, from, to, 16 + distance * 0.1, 0.3, 1);
        }
        measure(missile);
        missile.kind = kind;
        missile.duration = options.duration ?? THREE.MathUtils.clamp(1.3 + distance / 260, 1.6, 2.3);
        missile.time = 0;
        missile.s = 0;
        missile.phase = Math.random() * 10;
        missile.onImpact = onImpact;
        missile.onCancel = options.onCancel ?? null;
        missile.lastPuff.copy(from);
        missile.active = true;
        missile.group.visible = true;
        place(missile, 0);

        launchCloud(from, kind);
        const near = distanceTo(from);
        if (kind === 'outgoing') {
            sound.missileLaunch(near);
            sound.missileHiss(missile.duration, near);
        } else if (kind === 'incoming') {
            sound.missileLaunch(near);   // far away in the fog: quiet and dull
            sound.missileIncoming(missile.duration);
        } else {
            sound.missileScream(missile.duration);
        }
        return missile.duration;
    }

    /** The burst of flame and the cloud of white smoke where the missile leaves its tube. */
    function launchCloud(position, kind) {
        const size = kind === 'cinematic' ? 1.4 : 1;
        for (let i = 0; i < 12; i++) {   // flame out of the tube
            spawn({ position, velocity: velocity.set((Math.random() - 0.5) * 8, 4 + Math.random() * 12, (Math.random() - 0.5) * 8),
                life: 0.25 + Math.random() * 0.15, size: [3.5 * size, 7 * size], color: i % 3 === 0 ? 0xfff2c8 : 0xff9a3a,
                colorEnd: 0xc0400e, additive: true, drag: 3 });
        }
        for (let i = 0; i < 26; i++) {   // exhaust smoke rolling over the deck, then carried away
            const angle = Math.random() * Math.PI * 2;
            const speed = 5 + Math.random() * 12;
            spawn({ position, velocity: velocity.set(Math.cos(angle) * speed, 1 + Math.random() * 7, Math.sin(angle) * speed),
                life: 2.6 + Math.random() * 1.6, size: [3 * size, 15 * size], color: 0xe9e9e4, colorEnd: 0x858a8f,
                opacity: 0.6, smoke: true, drag: 1.1, wind: 0.45, fadeIn: 5 });
        }
        glow(position, 520);
    }

    // ---- Flight ----------------------------------------------------------------

    /**
     * Puts the model at a fraction s of the way and points it along the path.
     * A slight wobble (two slow sines across the path) makes it look guided,
     * correcting its course; it fades out at both ends so the missile leaves
     * the launcher and hits the target exactly.
     */
    function place(missile, s) {
        const t = parameterAt(missile, s);
        bezier(missile.points, t, point);
        bezierTangent(missile.points, t, tangent).normalize();
        const wobble = Math.sin(Math.PI * s) * (missile.kind === 'cinematic' ? 0.25 : 0.7);
        side.crossVectors(tangent, UP);
        if (side.lengthSq() < 1e-4) {
            side.set(1, 0, 0);   // flying straight up: any side will do
        }
        side.normalize();
        lift.crossVectors(side, tangent);
        const time = missile.time + missile.phase;
        point.addScaledVector(side, Math.sin(time * 6.3) * wobble)
            .addScaledVector(lift, Math.sin(time * 4.1 + 1.3) * wobble * 0.6);
        missile.group.position.copy(point);
        missile.group.quaternion.setFromUnitVectors(Z_AXIS, tangent);
    }

    /**
     * Fraction of the length covered after a fraction u of the flight time.
     * The speed changes steadily: for a real shot it grows (slow out of the
     * tube, fastest in the dive). The cinematic missile does the opposite, a
     * touch of slow motion: fast over the sea, slower in the last metres, so
     * the player has time to see it grow in the window.
     */
    function distanceFraction(kind, u) {
        const [start, growth] = kind === 'cinematic' ? [1.4, -1.1] : [0.3, 1.5];
        return (start * u + growth * u * u / 2) / (start + growth / 2);
    }

    function update(dt, time) {
        for (const missile of pool) {
            if (!missile.active) {
                continue;
            }
            missile.time += dt;
            const u = Math.min(missile.time / missile.duration, 1);
            missile.s = distanceFraction(missile.kind, u);
            place(missile, missile.s);
            exhaust(missile, u, time);
            if (u >= 1) {
                missile.active = false;
                missile.group.visible = false;
                const onImpact = missile.onImpact;
                missile.onImpact = missile.onCancel = null;
                onImpact();
            }
        }
    }

    /** The flame at the nozzle, its glow, and the smoke trail since last frame. */
    function exhaust(missile, u, time) {
        tangent.set(0, 0, 1).applyQuaternion(missile.group.quaternion);   // where the nose points
        tail.copy(missile.group.position).addScaledVector(tangent, TAIL * MODEL_SCALE);
        const boost = u < 0.15 ? 1.5 : 1;   // the booster burns bigger at launch
        const big = missile.kind === 'cinematic' ? 0.8 : 1;
        // Hot white core and an orange flame, thrown backwards out of the nozzle.
        spawn({ position: tail, velocity: velocity.copy(tangent).multiplyScalar(-14), life: 0.06,
            size: [2.4 * boost * big, 1 * big], color: 0xfff6e0, additive: true });
        for (let i = 0; i < 2; i++) {
            spawn({ position: tail, velocity: velocity.copy(tangent).multiplyScalar(-28 - Math.random() * 14)
                .add(jitter.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(5)),
            life: 0.12 + Math.random() * 0.06, size: [3.4 * boost * big, 1.2 * big], color: 0xffb04a, colorEnd: 0xff4a12, additive: true });
        }
        // The motor lights the missile, the smoke and whatever is below it.
        glow(tail, (240 + 60 * Math.sin(time * 41)) * boost);

        // The smoke trail: one puff every TRAIL_SPACING units since the last one,
        // so it stays a continuous ribbon even when the missile is fast.
        const gap = missile.lastPuff.distanceTo(tail);
        const puffs = Math.min(MAX_PUFFS, Math.floor(gap / TRAIL_SPACING));
        for (let i = 1; i <= puffs; i++) {
            point.copy(missile.lastPuff).lerp(tail, i / puffs);
            spawn({ position: point, velocity: velocity.set((Math.random() - 0.5) * 1.5, 0.6 + Math.random(), (Math.random() - 0.5) * 1.5),
                life: 3.2 + Math.random() * 1.4, size: [2.2 * big, 10 + Math.random() * 4], color: 0xe6e6e0, colorEnd: 0x80858a,
                opacity: 0.55, smoke: true, drag: 0.8, wind: 0.3, fadeIn: 7 });
        }
        if (puffs > 0) {
            missile.lastPuff.copy(tail);
        }
    }

    /** Removes every missile at once (leaving the game). Their onCancel is called. */
    function clear() {
        for (const missile of pool) {
            if (missile.active) {
                missile.active = false;
                missile.group.visible = false;
                const onCancel = missile.onCancel;
                missile.onImpact = missile.onCancel = null;
                onCancel?.();
            }
        }
    }

    const flying = () => pool.some(missile => missile.active);

    return { launch, update, clear, flying };
}
