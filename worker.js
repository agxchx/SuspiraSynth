// worker-optimized.js - Motor de cálculo de partículas (versión ligera y adaptativa)

// ================== CONFIGURACIÓN (ajustable) ==================
const MAX_PARTICLES = 50;     // densidad máxima (igual que antes)
const MIN_PARTICLES = 20;     // densidad mínima si el equipo va lento
const MAX_LINK_DIST = 220;    // alcance máximo de una línea (px). Más alto = más denso/pesado
const MAX_LINES = 700;        // tope de líneas por sistema (limita el coste de dibujo)
const ALPHA_BOOST = 3;        // antes cada línea se emitía 2 veces (x1.5); ahora una vez con x3
const TARGET_MS = 5;          // si el cálculo pasa de esto, baja la calidad
const FAST_MS = 2;            // si el cálculo está por debajo, la sube

const MAX_SPEED = 2.5, FRICTION = 0.97, SWITCH_DIST_SQ = 30 * 30;
const MAX_SPEED_SQ = MAX_SPEED * MAX_SPEED;

// ================== SISTEMA DE PARTÍCULAS (typed arrays) ==================
class ParticleSystem {
    constructor(isShadow) {
        this.isShadow = isShadow;
        this.x = new Float32Array(MAX_PARTICLES);
        this.y = new Float32Array(MAX_PARTICLES);
        this.vx = new Float32Array(MAX_PARTICLES);
        this.vy = new Float32Array(MAX_PARTICLES);
        this.target = new Uint16Array(MAX_PARTICLES);
        this.lines = new Float32Array(MAX_LINES * 5); // buffer reutilizado
        for (let i = 0; i < MAX_PARTICLES; i++) {
            this.x[i] = Math.random() * 1000;
            this.y[i] = Math.random() * 500;
            this.vx[i] = (Math.random() - 0.5) * 2;
            this.vy[i] = (Math.random() - 0.5) * 2;
        }
    }

    spawnOnBands(bx, by, nb) {
        for (let i = 0; i < MAX_PARTICLES; i++) {
            const b = (Math.random() * nb) | 0;
            this.x[i] = bx[b] + (Math.random() - 0.5) * 10;
            this.y[i] = by[b] + (Math.random() - 0.5) * 10;
        }
    }

    update(count, bx, by, levels, nb) {
        const { x, y, vx, vy, target } = this;
        for (let i = 0; i < count; i++) {
            let t = target[i];
            if (t >= nb) { t = target[i] = (Math.random() * nb) | 0; }

            const pull = 0.001 + levels[t] * 0.01;
            const dx = bx[t] - x[i];
            const dy = by[t] - y[i];

            if (dx * dx + dy * dy < SWITCH_DIST_SQ && nb > 1) {
                let n = (Math.random() * (nb - 1)) | 0;
                if (n >= t) n++;
                target[i] = n;
            }

            let sx = (vx[i] + dx * pull) * FRICTION;
            let sy = (vy[i] + dy * pull) * FRICTION;
            const s2 = sx * sx + sy * sy;
            if (s2 > MAX_SPEED_SQ) {
                const k = MAX_SPEED / Math.sqrt(s2);
                sx *= k; sy *= k;
            }
            vx[i] = sx; vy[i] = sy;
            x[i] += sx; y[i] += sy;
        }
    }

    // Cada par se evalúa UNA sola vez (j > i) y se descartan pronto los pares lejanos.
    connections(count, bx, by, levels, nb) {
        const { x, y, lines } = this;

        let maxLevel = 0;
        for (let b = 0; b < nb; b++) if (levels[b] > maxLevel) maxLevel = levels[b];
        const reach = Math.min(MAX_LINK_DIST, 10 + maxLevel * 1000);
        const reachSq = reach * reach;

        let n = 0;
        for (let i = 0; i < count && n < MAX_LINES; i++) {
            const x1 = x[i], y1 = y[i];
            for (let j = i + 1; j < count; j++) {
                const dx = x1 - x[j], dy = y1 - y[j];
                const d2 = dx * dx + dy * dy;
                if (d2 >= reachSq) continue; // rechazo barato antes de buscar banda

                // banda más cercana al punto medio (solo para pares que sobreviven)
                const mx = (x1 + x[j]) * 0.5, my = (y1 + y[j]) * 0.5;
                let best = 0, bestD = Infinity;
                for (let b = 0; b < nb; b++) {
                    const ex = mx - bx[b], ey = my - by[b];
                    const d = ex * ex + ey * ey;
                    if (d < bestD) { bestD = d; best = b; }
                }

                const level = levels[best];
                const maxDist = Math.min(MAX_LINK_DIST, 10 + level * 1000);
                if (d2 >= maxDist * maxDist) continue;

                let alpha = (1 - Math.sqrt(d2) / maxDist) * level * ALPHA_BOOST;
                if (alpha > 1) alpha = 1;
                if (alpha <= 0.01) continue; // invisible: no vale la pena dibujarla

                const o = n * 5;
                lines[o] = x1; lines[o + 1] = y1;
                lines[o + 2] = x[j]; lines[o + 3] = y[j];
                lines[o + 4] = alpha;
                if (++n >= MAX_LINES) break;
            }
        }
        // copia compacta del tamaño justo (se transfiere sin copiar al hilo principal)
        return lines.slice(0, n * 5);
    }

    coords(count) {
        const out = new Float32Array(count * 2);
        for (let i = 0; i < count; i++) {
            out[i * 2] = this.x[i];
            out[i * 2 + 1] = this.y[i];
        }
        return out;
    }
}

// ================== ESTADO ==================
const normal = new ParticleSystem(false);
const shadow = new ParticleSystem(true);

let particlesInitialized = false;
let activeCount = MAX_PARTICLES;
let avgMs = 0;
let frames = 0;

// Datos de bandas en arrays planos (se reutilizan)
const MAX_BANDS = 256;
const bandX = new Float32Array(MAX_BANDS);
const bandY = new Float32Array(MAX_BANDS);
const wetLv = new Float32Array(MAX_BANDS);
const dryLv = new Float32Array(MAX_BANDS);

const EMPTY = () => new Float32Array(0);

// Ajuste automático de calidad según lo que tarda el equipo
function adaptQuality(ms) {
    avgMs = avgMs === 0 ? ms : avgMs * 0.9 + ms * 0.1;
    if (++frames % 20 !== 0) return;
    if (avgMs > TARGET_MS && activeCount > MIN_PARTICLES) {
        activeCount = Math.max(MIN_PARTICLES, activeCount - 5);
    } else if (avgMs < FAST_MS && activeCount < MAX_PARTICLES) {
        activeCount = Math.min(MAX_PARTICLES, activeCount + 5);
    }
}

// ================== MENSAJES ==================
self.onmessage = function (e) {
    const { type, payload } = e.data;

    if (type !== 'update') return; // 'init' ya no hace falta: todo se crea al cargar

    const bands = payload && payload.eqBands;
    const nb = bands ? Math.min(bands.length, MAX_BANDS) : 0;

    if (nb === 0) {
        self.postMessage({
            particleCoords: EMPTY(), shadowParticleCoords: EMPTY(),
            lines: EMPTY(), shadowLines: EMPTY()
        });
        return;
    }

    const t0 = performance.now();

    for (let i = 0; i < nb; i++) {
        const b = bands[i];
        bandX[i] = b.x; bandY[i] = b.y;
        wetLv[i] = b.wetLevel || 0;
        dryLv[i] = b.dryLevel || 0;
    }

    if (!particlesInitialized) {
        normal.spawnOnBands(bandX, bandY, nb);
        shadow.spawnOnBands(bandX, bandY, nb);
        particlesInitialized = true;
    }

    normal.update(activeCount, bandX, bandY, wetLv, nb);
    shadow.update(activeCount, bandX, bandY, dryLv, nb);

    const lines = normal.connections(activeCount, bandX, bandY, wetLv, nb);
    const shadowLines = shadow.connections(activeCount, bandX, bandY, dryLv, nb);
    const particleCoords = normal.coords(activeCount);
    const shadowParticleCoords = shadow.coords(activeCount);

    adaptQuality(performance.now() - t0);

    self.postMessage(
        { particleCoords, shadowParticleCoords, lines, shadowLines },
        [particleCoords.buffer, shadowParticleCoords.buffer, lines.buffer, shadowLines.buffer]
    );
};
