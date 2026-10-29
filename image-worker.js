/* image-worker.js
 * Worker independiente (no usa worker.js ni audio-worker.js).
 *
 * Entrada  : { type:'analyze', reqId, width, height, pixels:ArrayBuffer(RGBA),
 *              sensitivity:0..1, cols:256, bands:25 }
 * Salida   : { type:'result', reqId, width, height, cols, bands,
 *              edges:Uint8Array(width*height)  -> intensidad de borde 0..255 (0 = no borde),
 *              matrix:Float32Array(cols*bands) -> intensidad máxima 0..1 por columna y banda,
 *              edgeCount }
 *
 * Proceso: gris -> gaussiano -> Sobel -> supresión de no-máximos -> umbral doble con histéresis.
 * La imagen resultante contiene SOLO bordes finos; todo lo demás queda en 0.
 *
 * Mapeo de bandas (idéntico al sintetizador espectral):
 *   banda 0 = grave (parte baja de la imagen), banda bands-1 = agudo (parte alta).
 *   banda = round((1 - yNormalizada) * (bands - 1))
 */

'use strict';

self.onmessage = function (e) {
    const m = e.data;
    if (!m || m.type !== 'analyze') return;
    try {
        const r = analyze(m);
        self.postMessage(
            {
                type: 'result',
                reqId: m.reqId,
                width: r.width,
                height: r.height,
                cols: r.cols,
                bands: r.bands,
                edges: r.edges,
                matrix: r.matrix,
                edgeCount: r.edgeCount
            },
            [r.edges.buffer, r.matrix.buffer]
        );
    } catch (err) {
        self.postMessage({ type: 'error', reqId: m.reqId, message: String(err && err.message ? err.message : err) });
    }
};

function analyze(m) {
    const w = m.width | 0;
    const h = m.height | 0;
    const cols = m.cols | 0;
    const bands = m.bands | 0;
    const sens = Math.min(1, Math.max(0, Number(m.sensitivity)));
    const rgba = new Uint8ClampedArray(m.pixels);

    if (w < 8 || h < 8 || rgba.length < w * h * 4) throw new Error('Imagen demasiado pequeña o datos inválidos.');

    // 1) Escala de grises
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
        gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    }

    // 2) Desenfoque gaussiano separable (sigma 1.4, radio 3)
    const blurred = gaussianBlur(gray, w, h, 1.4, 3);

    // 3) Sobel
    const mag = new Float32Array(w * h);
    const dir = new Uint8Array(w * h); // 0: horizontal, 1: diag /, 2: vertical, 3: diag \
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const a = blurred[i - w - 1], b = blurred[i - w], c = blurred[i - w + 1];
            const d = blurred[i - 1], f = blurred[i + 1];
            const g = blurred[i + w - 1], hh = blurred[i + w], k = blurred[i + w + 1];
            const gx = (c + 2 * f + k) - (a + 2 * d + g);
            const gy = (g + 2 * hh + k) - (a + 2 * b + c);
            mag[i] = Math.sqrt(gx * gx + gy * gy);
            // Dirección del gradiente cuantizada en 4 sectores
            let ang = Math.atan2(gy, gx) * 180 / Math.PI;
            if (ang < 0) ang += 180;
            if (ang < 22.5 || ang >= 157.5) dir[i] = 0;
            else if (ang < 67.5) dir[i] = 1;
            else if (ang < 112.5) dir[i] = 2;
            else dir[i] = 3;
        }
    }

    // 4) Supresión de no-máximos (bordes de 1 px)
    const nms = new Float32Array(w * h);
    let maxMag = 0;
    for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
            const i = y * w + x;
            const v = mag[i];
            if (v <= 0) continue;
            let n1, n2;
            switch (dir[i]) {
                case 0: n1 = mag[i - 1]; n2 = mag[i + 1]; break;
                case 1: n1 = mag[i + w - 1]; n2 = mag[i - w + 1]; break;
                case 2: n1 = mag[i - w]; n2 = mag[i + w]; break;
                default: n1 = mag[i - w - 1]; n2 = mag[i + w + 1]; break;
            }
            if (v >= n1 && v > n2) {
                nms[i] = v;
                if (v > maxMag) maxMag = v;
            }
        }
    }

    const edges = new Uint8Array(w * h);
    let edgeCount = 0;

    if (maxMag > 0) {
        // Referencia de normalización: percentil 99 de los máximos locales (evita que un
        // solo borde extremo apague al resto). Piso mínimo para que el ruido de una
        // imagen plana no se convierta en bordes.
        const BINS = 1024;
        const hist = new Uint32Array(BINS);
        let total = 0;
        for (let i = 0; i < nms.length; i++) {
            if (nms[i] > 0) {
                hist[Math.min(BINS - 1, Math.floor((nms[i] / maxMag) * (BINS - 1)))]++;
                total++;
            }
        }
        let acc = 0, p99 = maxMag;
        const target = total * 0.99;
        for (let b = 0; b < BINS; b++) {
            acc += hist[b];
            if (acc >= target) { p99 = ((b + 1) / BINS) * maxMag; break; }
        }
        const ref = Math.max(p99, 80);

        // 5) Umbral doble con histéresis. Más sensibilidad = umbrales más bajos.
        const high = 0.60 - 0.52 * sens;
        const low = high * 0.45;

        const norm = new Float32Array(w * h);
        const state = new Uint8Array(w * h); // 0 nada, 1 débil, 2 fuerte/aceptado
        const stack = new Int32Array(w * h);
        let sp = 0;
        for (let i = 0; i < nms.length; i++) {
            if (nms[i] <= 0) continue;
            const n = Math.min(1, nms[i] / ref);
            norm[i] = n;
            if (n >= high) { state[i] = 2; stack[sp++] = i; }
            else if (n >= low) state[i] = 1;
        }
        while (sp > 0) {
            const i = stack[--sp];
            const x = i % w;
            const y = (i - x) / w;
            for (let dy = -1; dy <= 1; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= h) continue;
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const xx = x + dx;
                    if (xx < 0 || xx >= w) continue;
                    const j = yy * w + xx;
                    if (state[j] === 1) { state[j] = 2; stack[sp++] = j; }
                }
            }
        }
        for (let i = 0; i < state.length; i++) {
            if (state[i] === 2) {
                edges[i] = Math.max(1, Math.round(norm[i] * 255));
                edgeCount++;
            }
        }
    }

    // 6) Matriz columnas x bandas con la intensidad máxima de borde
    const matrix = new Float32Array(cols * bands);
    const bandOfRow = new Int32Array(h);
    for (let y = 0; y < h; y++) {
        const yn = (y + 0.5) / h;
        bandOfRow[y] = Math.max(0, Math.min(bands - 1, Math.round((1 - yn) * (bands - 1))));
    }
    for (let y = 0; y < h; y++) {
        const band = bandOfRow[y];
        const rowOff = y * w;
        for (let x = 0; x < w; x++) {
            const v = edges[rowOff + x];
            if (v === 0) continue;
            const col = Math.min(cols - 1, Math.floor((x * cols) / w));
            const k = col * bands + band;
            const f = v / 255;
            if (f > matrix[k]) matrix[k] = f;
        }
    }

    return { width: w, height: h, cols, bands, edges, matrix, edgeCount };
}

function gaussianBlur(src, w, h, sigma, radius) {
    const size = radius * 2 + 1;
    const kernel = new Float32Array(size);
    let sum = 0;
    for (let i = 0; i < size; i++) {
        const x = i - radius;
        kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
        sum += kernel[i];
    }
    for (let i = 0; i < size; i++) kernel[i] /= sum;

    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);

    // Horizontal
    for (let y = 0; y < h; y++) {
        const off = y * w;
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                let xx = x + k;
                if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
                acc += src[off + xx] * kernel[k + radius];
            }
            tmp[off + x] = acc;
        }
    }
    // Vertical
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                let yy = y + k;
                if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
                acc += tmp[yy * w + x] * kernel[k + radius];
            }
            out[y * w + x] = acc;
        }
    }
    return out;
}
