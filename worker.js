// worker.js - El motor de cálculo para la animación de partículas

// --- Clases y Lógica de Simulación ---

class Particle {
    constructor(isShadow = false) {
        this.x = Math.random() * 1000;
        this.y = Math.random() * 500;
        this.speedX = (Math.random() - 0.5) * 2;
        this.speedY = (Math.random() - 0.5) * 2;
        this.targetIndex = 0;
        this.isShadow = isShadow;
    }

    update(eqBands) {
        if (!eqBands || eqBands.length === 0) return;
        
        const maxSpeed = 2.5, friction = 0.97, switchDistance = 30;
        let target = eqBands[this.targetIndex];

        if (!target) {
            this.targetIndex = Math.floor(Math.random() * eqBands.length);
            target = eqBands[this.targetIndex];
            if (!target) return;
        }

        const level = this.isShadow ? target.dryLevel : target.wetLevel;
        const pullFactor = 0.001 + (level * 0.01); 

        let dx = target.x - this.x;
        let dy = target.y - this.y;
        
        if (Math.sqrt(dx*dx + dy*dy) < switchDistance) {
            let newIndex;
            do { newIndex = Math.floor(Math.random() * eqBands.length);
            } while (newIndex === this.targetIndex && eqBands.length > 1);
            this.targetIndex = newIndex;
        }
        
        this.speedX += dx * pullFactor; 
        this.speedY += dy * pullFactor;
        this.speedX *= friction; 
        this.speedY *= friction;
        
        const speed = Math.sqrt(this.speedX*this.speedX + this.speedY*this.speedY);
        if (speed > maxSpeed) {
            this.speedX = (this.speedX / speed) * maxSpeed;
            this.speedY = (this.speedY / speed) * maxSpeed;
        }
        this.x += this.speedX; 
        this.y += this.speedY;
    }
}

// --- Variables del Estado del Worker ---
let particlesArray = [];
let shadowParticlesArray = [];
let eqBandInstances = [];
const particleCount = 100;
let particlesInitialized = false; // Bandera para controlar si ya nacieron en el EQ

// --- Funciones de Cálculo Optimizadas ---

// Función para inicializar las partículas (ahora acepta las bandas de EQ opcionalmente)
function initParticleSystem(eqBands = []) {
    particlesArray = [];
    shadowParticlesArray = [];
    for (let i = 0; i < particleCount; i++) {
        const p = new Particle(false);
        const sp = new Particle(true);

        // Si existen bandas de EQ, hacemos que nazcan directamente sobre ellas
        if (eqBands && eqBands.length > 0) {
            const randomBand = eqBands[Math.floor(Math.random() * eqBands.length)];
            p.x = randomBand.x + (Math.random() - 0.5) * 10;
            p.y = randomBand.y + (Math.random() - 0.5) * 10;
            
            const randomBandShadow = eqBands[Math.floor(Math.random() * eqBands.length)];
            sp.x = randomBandShadow.x + (Math.random() - 0.5) * 10;
            sp.y = randomBandShadow.y + (Math.random() - 0.5) * 10;
        }

        particlesArray.push(p);
        shadowParticlesArray.push(sp);
    }
}

/**
 * ¡LA OPTIMIZACIÓN CLAVE!
 * Esta función calcula las conexiones usando una rejilla espacial para evitar el bucle O(n^2).
 * Devuelve un array de coordenadas de líneas listas para dibujar.
 */
function calculateConnections(particleSystem, isShadow, allEqBands) {
    const lines = [];
    if (allEqBands.length === 0) return new Float32Array(0);

    const grid = {};
    const cellSize = 200;

    for (const p of particleSystem) {
        const cellX = Math.floor(p.x / cellSize);
        const cellY = Math.floor(p.y / cellSize);
        const key = `${cellX},${cellY}`;
        if (!grid[key]) {
            grid[key] = [];
        }
        grid[key].push(p);
    }

    for (const p1 of particleSystem) {
        const cellX = Math.floor(p1.x / cellSize);
        const cellY = Math.floor(p1.y / cellSize);

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const key = `${cellX + dx},${cellY + dy}`;
                if (grid[key]) {
                    for (const p2 of grid[key]) {
                        if (p1 === p2) continue;

                        const distSq = (p1.x - p2.x)**2 + (p1.y - p2.y)**2;
                        
                        let midX = (p1.x + p2.x) / 2;
                        let midY = (p1.y + p2.y) / 2;
                        let closestBand = allEqBands[0];
                        let minBandDistSq = Infinity;
                        for (const band of allEqBands) {
                            let bandDistSq = (midX - band.x)**2 + (midY - band.y)**2;
                            if (bandDistSq < minBandDistSq) {
                                minBandDistSq = bandDistSq;
                                closestBand = band;
                            }
                        }
                        
                        let level = isShadow ? closestBand.dryLevel : closestBand.wetLevel;
                        let maxDist = 10 + (level * 2000);
                        
                        if (distSq < maxDist * maxDist) {
                            lines.push(p1.x, p1.y, p2.x, p2.y, (1 - Math.sqrt(distSq) / maxDist) * level * 1.5);
                        }
                    }
                }
            }
        }
    }
    return new Float32Array(lines);
}

// --- Manejador de Mensajes del Worker ---

self.onmessage = function(e) {
    let { type, payload } = e.data;

    if (type === 'init') {
        initParticleSystem();
    } else if (type === 'update') {
        eqBandInstances = payload.eqBands;

        // Si todavía no se inicializaron y ya llegaron las bandas, nacen ahí
        if (!particlesInitialized && eqBandInstances.length > 0) {
            initParticleSystem(eqBandInstances);
            particlesInitialized = true;
        }

        particlesArray.forEach(p => p.update(eqBandInstances));
        shadowParticlesArray.forEach(p => p.update(eqBandInstances));

        let lines = calculateConnections(particlesArray, false, eqBandInstances);
        let shadowLines = calculateConnections(shadowParticlesArray, true, eqBandInstances);
        
        let particleCoords = new Float32Array(particlesArray.length * 2);
        for(let i = 0; i < particlesArray.length; i++) {
            particleCoords[i * 2] = particlesArray[i].x;
            particleCoords[i * 2 + 1] = particlesArray[i].y;
        }
        
        let shadowParticleCoords = new Float32Array(shadowParticlesArray.length * 2);
        for(let i = 0; i < shadowParticlesArray.length; i++) {
            shadowParticleCoords[i * 2] = shadowParticlesArray[i].x;
            shadowParticleCoords[i * 2 + 1] = shadowParticlesArray[i].y;
        }

        self.postMessage({
            particleCoords,
            shadowParticleCoords,
            lines,
            shadowLines
        }, [particleCoords.buffer, shadowParticleCoords.buffer, lines.buffer, shadowLines.buffer]);
    }
};
