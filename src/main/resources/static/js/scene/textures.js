// Small procedural textures drawn on a canvas at start-up.
// Generating them in code keeps the project free of extra image files.

import * as THREE from 'three';

function canvas(width, height) {
    const element = document.createElement('canvas');
    element.width = width;
    element.height = height;
    return { element, ctx: element.getContext('2d') };
}

/** Soft white disc that fades to transparent: used for flames, sparks and spray. */
export function softDiscTexture() {
    const { element, ctx } = canvas(64, 64);
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.65)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(element);
}

/** Irregular cloud puff made of several overlapping soft discs: smoke and mist. */
export function puffTexture() {
    const { element, ctx } = canvas(128, 128);
    for (let i = 0; i < 22; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.random() * 30;
        const x = 64 + Math.cos(angle) * distance;
        const y = 64 + Math.sin(angle) * distance;
        const radius = 18 + Math.random() * 16;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(255,255,255,0.22)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 128, 128);
    }
    return new THREE.CanvasTexture(element);
}

/** Tileable streaks of foam, scrolled along the wake of a ship. */
export function foamTexture() {
    const { element, ctx } = canvas(256, 64);
    ctx.fillStyle = '#c3ced6';
    ctx.fillRect(0, 0, 256, 64);
    for (let i = 0; i < 90; i++) {
        const x = Math.random() * 256;
        const y = Math.random() * 64;
        const w = 10 + Math.random() * 40;
        const h = 1 + Math.random() * 3;
        ctx.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.6})`;
        // Draw twice so streaks crossing the right edge wrap around (tileable).
        ctx.fillRect(x, y, w, h);
        ctx.fillRect(x - 256, y, w, h);
    }
    const texture = new THREE.CanvasTexture(element);
    texture.wrapS = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

/**
 * Alpha mask of a wake, seen from above with the bow on the right:
 * two bow waves spreading out along the hull (a "V") and a churned trail
 * behind the stern. White = visible foam, black = no foam.
 */
export function wakeMaskTexture() {
    const { element, ctx } = canvas(256, 128);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 256, 128);
    // Everything fades out towards the left (far behind the ship).
    const fade = ctx.createLinearGradient(0, 0, 256, 0);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(0.4, 'rgba(255,255,255,0.85)');
    fade.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.filter = 'blur(5px)';
    ctx.lineCap = 'round';
    ctx.strokeStyle = fade;
    // Bow waves.
    ctx.lineWidth = 11;
    for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(244, 64);
        ctx.quadraticCurveTo(170, 64 + side * 30, 12, 64 + side * 52);
        ctx.stroke();
    }
    // Trail of the propellers, from the stern backwards.
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.moveTo(100, 64);
    ctx.lineTo(8, 64);
    ctx.stroke();
    return new THREE.CanvasTexture(element);
}

/**
 * Tileable grey blotches (soft blobs of every size): the uneven thickness of
 * an oil slick, read by the slick shader at two scales (see sinking.js).
 */
export function blotTexture() {
    const size = 256;
    const { element, ctx } = canvas(size, size);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 140; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const radius = 6 + Math.pow(Math.random(), 2) * 60;
        const alpha = 0.12 + Math.random() * 0.3;
        // Drawn nine times (shifted by the size) so blobs crossing an edge wrap around.
        for (const dx of [-size, 0, size]) {
            for (const dy of [-size, 0, size]) {
                const gradient = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, radius);
                gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
                gradient.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = gradient;
                ctx.fillRect(x + dx - radius, y + dy - radius, radius * 2, radius * 2);
            }
        }
    }
    const texture = new THREE.CanvasTexture(element);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    return texture;
}

/** A short text label (grid coordinates) as a texture. */
export function labelTexture(text, color = '#9fe8ff') {
    const { element, ctx } = canvas(64, 64);
    ctx.font = '600 40px Consolas, "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 32, 34);
    const texture = new THREE.CanvasTexture(element);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

// ---- Weathered surfaces for the ships and the bridge ------------------------------
// All of these are painted once on a canvas: flat colours first, then many
// small random marks (speckles, streaks, stains) so nothing looks brand new.

/** Finishes a canvas as a colour texture that can repeat. */
function surface(element, repeatX = true, repeatY = true) {
    const texture = new THREE.CanvasTexture(element);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = repeatX ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    texture.wrapT = repeatY ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    texture.anisotropy = 4;
    return texture;
}

/** Fine random speckles: breaks up flat paint. */
function speckle(ctx, width, height, count, light, dark, maxAlpha) {
    for (let i = 0; i < count; i++) {
        const shade = Math.random() < 0.5 ? light : dark;
        ctx.fillStyle = `rgba(${shade},${shade},${shade},${Math.random() * maxAlpha})`;
        ctx.fillRect(Math.random() * width, Math.random() * height, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
}

/** A streak running down from (x, y): rain-washed dirt or rust. Drawn twice so it tiles sideways. */
function streak(ctx, width, x, y, length, thickness, color) {
    const gradient = ctx.createLinearGradient(0, y, 0, y + length);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, thickness, length);
    ctx.fillRect(x - width, y, thickness, length);
}

/**
 * The side of a hull, from the keel (bottom of the image) to above the bow
 * (top): red anti-fouling paint under the water, a black line at the
 * waterline, grey paint above, with plate seams, dirt and rust.
 * It covers 4.2 world units of height, 1.5 of them under the water.
 */
export function hullTexture() {
    const width = 512;
    const height = 256;
    const { element, ctx } = canvas(width, height);
    const rowOf = y => (1 - (y + 1.5) / 4.2) * height;   // world height -> pixel row
    ctx.fillStyle = '#69727a';
    ctx.fillRect(0, 0, width, height);
    // Plate seams.
    ctx.fillStyle = 'rgba(20,24,28,0.22)';
    for (let y = 0.55; y < 2.7; y += 0.62) {
        ctx.fillRect(0, rowOf(y), width, 1);
    }
    for (let x = 0; x < width; x += 64) {
        ctx.fillRect(x + (x % 128 ? 20 : 0), 0, 1, rowOf(0.4));
    }
    speckle(ctx, width, height, 5000, 190, 30, 0.1);
    // Dirt washed down from the deck edge and the scuppers.
    for (let i = 0; i < 70; i++) {
        streak(ctx, width, Math.random() * width, rowOf(1.9) + Math.random() * 14, 20 + Math.random() * 60,
            1 + Math.random() * 4, `rgba(25,28,30,${0.12 + Math.random() * 0.25})`);
    }
    for (let i = 0; i < 26; i++) {
        streak(ctx, width, Math.random() * width, rowOf(0.5 + Math.random() * 1.2), 14 + Math.random() * 40,
            1 + Math.random() * 3, `rgba(120,62,30,${0.25 + Math.random() * 0.35})`);
    }
    // Under the waterline: dull red, stained green-brown near the surface.
    ctx.fillStyle = '#5e2620';
    ctx.fillRect(0, rowOf(0.2), width, height);
    const slime = ctx.createLinearGradient(0, rowOf(0.2), 0, rowOf(-0.7));
    slime.addColorStop(0, 'rgba(48,52,30,0.75)');
    slime.addColorStop(1, 'rgba(48,52,30,0)');
    ctx.fillStyle = slime;
    ctx.fillRect(0, rowOf(0.2), width, rowOf(-0.7) - rowOf(0.2));
    // Boot topping: the black band at the waterline.
    ctx.fillStyle = '#121416';
    ctx.fillRect(0, rowOf(0.42), width, rowOf(0.2) - rowOf(0.42));
    speckle(ctx, width, height, 2500, 160, 10, 0.12);
    return surface(element);
}

/** Painted steel plating for superstructures and turrets (tinted by the material colour). */
export function plateTexture() {
    const size = 256;
    const { element, ctx } = canvas(size, size);
    ctx.fillStyle = '#c4c7c9';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 40; i++) {   // large soft patches of uneven paint
        const x = Math.random() * size;
        const y = Math.random() * size;
        const radius = 20 + Math.random() * 50;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(${Math.random() < 0.5 ? '90,95,100' : '235,238,240'},0.16)`);
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
    }
    ctx.fillStyle = 'rgba(30,34,38,0.3)';
    ctx.fillRect(0, 127, size, 1);
    ctx.fillRect(127, 0, 1, size);
    for (let i = 0; i < 46; i++) {
        streak(ctx, size, Math.random() * size, Math.random() * size * 0.6, 20 + Math.random() * 90,
            1 + Math.random() * 3, `rgba(40,44,46,${0.1 + Math.random() * 0.2})`);
    }
    for (let i = 0; i < 9; i++) {
        streak(ctx, size, Math.random() * size, Math.random() * size * 0.7, 10 + Math.random() * 40,
            1 + Math.random() * 2, `rgba(125,66,32,${0.25 + Math.random() * 0.3})`);
    }
    speckle(ctx, size, size, 3000, 230, 40, 0.1);
    return surface(element);
}

/** Non-slip deck coating: dark, rough and stained. */
export function deckTexture() {
    const size = 256;
    const { element, ctx } = canvas(size, size);
    ctx.fillStyle = '#b3b6b8';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, size, 9000, 240, 50, 0.16);
    for (let i = 0; i < 14; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const radius = 15 + Math.random() * 40;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, 'rgba(40,42,44,0.25)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
    }
    ctx.fillStyle = 'rgba(30,32,34,0.25)';
    for (let x = 0; x < size; x += 64) {
        ctx.fillRect(x, 0, 1, size);
    }
    return surface(element);
}

/**
 * The top of the carrier flight deck, seen from above: bow on the right,
 * port side at the top. It covers 48 x 14 world units (see shipModels.js).
 */
export function flightDeckTexture() {
    const width = 2048;
    const height = 512;
    const { element, ctx } = canvas(width, height);
    const X = x => ((x + 24) / 48) * width;
    const Y = z => ((z + 7) / 14) * height;
    ctx.fillStyle = '#2b2f33';
    ctx.fillRect(0, 0, width, height);
    speckle(ctx, width, height, 26000, 120, 0, 0.14);
    const line = (x1, z1, x2, z2, color, thickness, dash = []) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = thickness;
        ctx.setLineDash(dash);
        ctx.beginPath();
        ctx.moveTo(X(x1), Y(z1));
        ctx.lineTo(X(x2), Y(z2));
        ctx.stroke();
    };
    const white = 'rgba(214,218,220,0.85)';
    const yellow = 'rgba(214,176,60,0.85)';
    // Edges of the straight deck and its centre line.
    line(-23.4, 3.2, 17, 3.2, white, 5);
    line(-23.4, -3.2, 17, -3.2, white, 5);
    line(-4, 0, 22, 0, white, 4, [26, 22]);
    // The angled landing strip: runs from the stern towards the port side.
    line(-23, 2.2, 3, -4.9, white, 5);
    line(-23, -1.4, -5, -5.6, white, 5);
    line(-23, 0.4, 1, -5.3, yellow, 5, [34, 18]);
    // Catapult tracks at the bow, and the outlines of the two aircraft lifts.
    line(7, 1.0, 22.6, 1.0, 'rgba(10,11,12,0.9)', 7);
    line(7, -1.0, 22.6, -1.0, 'rgba(10,11,12,0.9)', 7);
    ctx.setLineDash([]);
    ctx.strokeStyle = yellow;
    ctx.lineWidth = 4;
    ctx.strokeRect(X(-10.5), Y(-0.2), X(-6.5) - X(-10.5), Y(2.9) - Y(-0.2));
    ctx.strokeRect(X(11), Y(-2.9), X(15) - X(11), Y(-0.6) - Y(-2.9));
    // Deck number at the bow, read from the stern.
    ctx.save();
    ctx.translate(X(19.3), Y(0));
    ctx.rotate(Math.PI / 2);
    ctx.font = '700 150px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = white;
    ctx.fillText('68', 0, 0);
    ctx.restore();
    // Rubber left by landing aircraft, and general grime.
    for (let i = 0; i < 90; i++) {
        const x = -20 + Math.random() * 16;
        const z = 1.6 - (x + 23) * 0.27 + (Math.random() - 0.5) * 2.2;
        line(x, z, x + 2 + Math.random() * 5, z - 0.6 - Math.random() * 1.2, `rgba(8,8,9,${0.1 + Math.random() * 0.25})`, 2 + Math.random() * 5);
    }
    for (let i = 0; i < 60; i++) {
        const x = Math.random() * width;
        const y = Math.random() * height;
        const radius = 20 + Math.random() * 80;
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
        gradient.addColorStop(0, `rgba(${Math.random() < 0.6 ? '10,11,12' : '90,94,98'},0.22)`);
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
    }
    return surface(element, false, false);
}

/** A hull number in worn white paint on a transparent background. */
export function numberTexture(text) {
    const { element, ctx } = canvas(64 * text.length, 96);
    ctx.font = '700 86px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0d0f10';
    ctx.fillText(text, element.width / 2 + 3, 54);       // dark shadow edge, as painted on real hulls
    ctx.fillStyle = '#c9cdd0';
    ctx.fillText(text, element.width / 2, 51);
    // Worn paint: punch small holes in it.
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 260; i++) {
        ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.6})`;
        ctx.fillRect(Math.random() * element.width, Math.random() * 96, 1 + Math.random() * 3, 1 + Math.random() * 5);
    }
    return surface(element, false, false);
}

/** Steel wall panels with seams and rivets, for the inside of the bridge. */
export function panelTexture() {
    const size = 512;
    const { element, ctx } = canvas(size, size);
    ctx.fillStyle = '#9aa1a6';
    ctx.fillRect(0, 0, size, size);
    speckle(ctx, size, size, 9000, 220, 40, 0.08);
    const step = size / 2;
    for (let i = 0; i < 2; i++) {
        // A seam is a dark groove with a thin highlight beside it.
        ctx.fillStyle = 'rgba(10,12,14,0.7)';
        ctx.fillRect(i * step, 0, 3, size);
        ctx.fillRect(0, i * step, size, 3);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(i * step + 3, 0, 1, size);
        ctx.fillRect(0, i * step + 3, size, 1);
        for (let r = 16; r < size; r += 32) {   // rivets along the seams
            for (const [x, y] of [[i * step + 12, r], [r, i * step + 12]]) {
                ctx.fillStyle = 'rgba(15,17,19,0.55)';
                ctx.beginPath();
                ctx.arc(x + 1, y + 1, 3.2, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = 'rgba(215,220,224,0.55)';
                ctx.beginPath();
                ctx.arc(x, y, 2.4, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
    for (let i = 0; i < 40; i++) {
        streak(ctx, size, Math.random() * size, Math.random() * size, 30 + Math.random() * 120,
            1 + Math.random() * 3, `rgba(20,22,24,${0.08 + Math.random() * 0.15})`);
    }
    return surface(element);
}

/**
 * Rain on a window: drops and the trails they leave, white on transparent.
 * It repeats in both directions, so it can slide down the glass for ever.
 */
export function rainGlassTexture() {
    const size = 512;
    const { element, ctx } = canvas(size, size);
    // Draw everything nine times (shifted by one tile) so that it wraps cleanly.
    const tiled = draw => {
        for (const dx of [-size, 0, size]) {
            for (const dy of [-size, 0, size]) {
                ctx.save();
                ctx.translate(dx, dy);
                draw();
                ctx.restore();
            }
        }
    };
    for (let i = 0; i < 46; i++) {   // trails with a fat drop at the bottom
        const x = Math.random() * size;
        const y = Math.random() * size;
        const length = 40 + Math.random() * 150;
        const alpha = 0.12 + Math.random() * 0.25;
        const lean = (Math.random() - 0.3) * 14;
        const thickness = 1 + Math.random() * 1.6;
        tiled(() => {
            const gradient = ctx.createLinearGradient(0, y - length, 0, y);
            gradient.addColorStop(0, 'rgba(255,255,255,0)');
            gradient.addColorStop(1, `rgba(255,255,255,${alpha})`);
            ctx.strokeStyle = gradient;
            ctx.lineWidth = thickness;
            ctx.beginPath();
            ctx.moveTo(x - lean, y - length);
            ctx.quadraticCurveTo(x - lean * 0.3, y - length * 0.4, x, y);
            ctx.stroke();
            ctx.fillStyle = `rgba(255,255,255,${alpha + 0.3})`;
            ctx.beginPath();
            ctx.ellipse(x, y, 2.2, 3.4, 0, 0, Math.PI * 2);
            ctx.fill();
        });
    }
    for (let i = 0; i < 420; i++) {   // small drops sitting on the glass
        const x = Math.random() * size;
        const y = Math.random() * size;
        const radius = 0.8 + Math.random() * 2.6;
        const alpha = 0.15 + Math.random() * 0.45;
        tiled(() => {
            const gradient = ctx.createRadialGradient(x - radius * 0.3, y - radius * 0.3, 0, x, y, radius);
            gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
            gradient.addColorStop(0.7, `rgba(255,255,255,${alpha * 0.25})`);
            gradient.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
        });
    }
    const texture = new THREE.CanvasTexture(element);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    return texture;
}
