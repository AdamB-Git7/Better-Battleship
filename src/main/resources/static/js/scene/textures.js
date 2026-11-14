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
