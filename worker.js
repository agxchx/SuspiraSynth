// worker.js - El motor de cálculo para la animación de partículas

// --- Clases y Lógica de Simulación (Ahora dentro del Worker) ---

// La clase Particle vivirá aquí, en el worker, lejos del hilo principal.
class Particle {
    constructor(isShadow = false) {
        this.x = Math.random() * 1000; // Inicia en una posición aleatoria
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

        // Si el objetivo no es válido (p.ej. al inicio), busca uno nuevo.
        if (!target) {
            this.targetIndex = Math.floor(Math.random() * eqBands.length);
            target = eqBands[this.targetIndex];
            if (!target) return; // Si aún no hay objetivo, salimos.
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
const particleCount = 20;

// --- Funciones de Cálculo Optimizadas ---

// Función para inicializar las partículas dentro del worker
function initParticleSystem() {
    particlesArray = [];
    shadowParticlesArray = [];
    for (let i = 0; i < particleCount; i++) {
        particlesArray.push(new Particle(false));
        shadowParticlesArray.push(new Particle(true));
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
    const cellSize = 120; // Radio de conexión. Se puede ajustar para cambiar la densidad de las líneas.

    // 1. Poblar la rejilla con las posiciones de las partículas
    for (const p of particleSystem) {
        const cellX = Math.floor(p.x / cellSize);
        const cellY = Math.floor(p.y / cellSize);
        const key = `${cellX},${cellY}`;
        if (!grid[key]) {
            grid[key] = [];
        }
        grid[key].push(p);
    }

    // 2. Comprobar conexiones solo en celdas adyacentes
    for (const p1 of particleSystem) {
        const cellX = Math.floor(p1.x / cellSize);
        const cellY = Math.floor(p1.y / cellSize);

        // Itera sobre la celda actual y las 8 vecinas
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const key = `${cellX + dx},${cellY + dy}`;
                if (grid[key]) {
                    for (const p2 of grid[key]) {
                        // Evita comparar una partícula consigo misma o duplicar líneas
                        if (p1 === p2) continue;

                        const distSq = (p1.x - p2.x)**2 + (p1.y - p2.y)**2;
                        
                        // Encuentra la banda de EQ más cercana al punto medio de la línea
                        const midX = (p1.x + p2.x) / 2;
                        const midY = (p1.y + p2.y) / 2;
                        let closestBand = allEqBands[0];
                        let minBandDistSq = Infinity;
                        for (const band of allEqBands) {
                            const bandDistSq = (midX - band.x)**2 + (midY - band.y)**2;
                            if (bandDistSq < minBandDistSq) {
                                minBandDistSq = bandDistSq;
                                closestBand = band;
                            }
                        }
                        
                        const level = isShadow ? closestBand.dryLevel : closestBand.wetLevel;
                        const maxDist = 10 + (level * 150);
                        
                        if (distSq < maxDist * maxDist) {
                            // Almacena x1, y1, x2, y2, y la opacidad de la línea
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

// El worker escucha mensajes del hilo principal.
self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'init') {
        // Inicializar las partículas cuando el hilo principal lo pida.
        initParticleSystem();
    } else if (type === 'update') {
        // Recibe los datos de las bandas de EQ del hilo principal.
        eqBandInstances = payload.eqBands;

        // Actualiza la posición de todas las partículas.
        particlesArray.forEach(p => p.update(eqBandInstances));
        shadowParticlesArray.forEach(p => p.update(eqBandInstances));

        // Calcula las conexiones de forma optimizada.
        const lines = calculateConnections(particlesArray, false, eqBandInstances);
        const shadowLines = calculateConnections(shadowParticlesArray, true, eqBandInstances);
        
        // Extrae las coordenadas de las partículas para enviar de vuelta.
        const particleCoords = new Float32Array(particlesArray.length * 2);
        for(let i = 0; i < particlesArray.length; i++) {
            particleCoords[i * 2] = particlesArray[i].x;
            particleCoords[i * 2 + 1] = particlesArray[i].y;
        }
        
        const shadowParticleCoords = new Float32Array(shadowParticlesArray.length * 2);
        for(let i = 0; i < shadowParticlesArray.length; i++) {
            shadowParticleCoords[i * 2] = shadowParticlesArray[i].x;
            shadowParticleCoords[i * 2 + 1] = shadowParticlesArray[i].y;
        }

        // Envía los datos listos para ser dibujados de vuelta al hilo principal.
        // Usamos "Transferable Objects" (los .buffer de los arrays) para que el envío sea
        // casi instantáneo, sin copiar datos.
        self.postMessage({
            particleCoords,
            shadowParticleCoords,
            lines,
            shadowLines
        }, [particleCoords.buffer, shadowParticleCoords.buffer, lines.buffer, shadowLines.buffer]);
    }
};