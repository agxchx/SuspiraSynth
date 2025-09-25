// Carga la librería SoundTouch. Asegúrate de que el archivo 'soundtouch-compiled.js'
// esté accesible en la misma ruta que este worker.
try {
    importScripts('soundtouch-compiled.js');
} catch (e) {
    console.error("Error al importar soundtouch-compiled.js en el worker:", e);
    // Enviar un mensaje de error de vuelta podría ser útil
    self.postMessage({ error: "No se pudo cargar la librería de audio." });
}

/**
 * Procesa un AudioBuffer utilizando SoundTouch para cambiar su tempo/velocidad
 * sin alterar el pitch. Esta función es intensiva en CPU y está diseñada
 * para ejecutarse exclusivamente dentro de un Web Worker.
 *
 * @param {object} audioBufferData - Un objeto que contiene los datos del buffer.
 * @param {Float32Array[]} audioBufferData.channels - Array de Float32Array, uno por cada canal.
 * @param {number} audioBufferData.sampleRate - La tasa de muestreo del audio.
 * @param {number} rateFactor - El factor de velocidad. > 1 acelera, < 1 ralentiza.
 * @returns {object|null} - Un objeto con los canales procesados y la nueva tasa de muestreo, o null si falla.
 */
function processAudioWithSoundTouch(audioBufferData, rateFactor) {
    if (typeof SoundTouch === 'undefined' || typeof SimpleFilter === 'undefined') {
        console.error("SoundTouch no está cargado en el worker.");
        return null;
    }

    const soundTouchInstance = new SoundTouch();
    soundTouchInstance.sampleRate = audioBufferData.sampleRate;
    soundTouchInstance.tempo = rateFactor;

    const numChannels = audioBufferData.channels.length;
    const inputFrames = audioBufferData.channels[0].length;
    
    // Intercalar los canales en un solo array, como lo requiere SoundTouch
    const interleavedInputSamples = new Float32Array(inputFrames * numChannels);
    for (let f = 0; f < inputFrames; f++) {
        for (let ch = 0; ch < numChannels; ch++) {
            interleavedInputSamples[f * numChannels + ch] = audioBufferData.channels[ch][f];
        }
    }

    const soundTouchSource = {
        extract: (target, numFramesToExtract, positionFrames) => {
            const requestedSamples = numFramesToExtract * numChannels;
            const startSampleInBuffer = positionFrames * numChannels;
            if (startSampleInBuffer >= interleavedInputSamples.length) {
                return 0; // No hay más datos que leer
            }
            const availableSamples = interleavedInputSamples.length - startSampleInBuffer;
            const samplesToCopy = Math.min(requestedSamples, availableSamples);
            
            target.set(interleavedInputSamples.subarray(startSampleInBuffer, startSampleInBuffer + samplesToCopy));
            
            return Math.floor(samplesToCopy / numChannels);
        }
    };

    const soundTouchFilter = new SimpleFilter(soundTouchSource, soundTouchInstance);

    const processedSamplesContainer = [];
    const bufferSizeSamples = 4096 * numChannels;
    const tempProcessingBuffer = new Float32Array(bufferSizeSamples);
    let framesExtracted;

    do {
        framesExtracted = soundTouchFilter.extract(tempProcessingBuffer, 4096);
        if (framesExtracted > 0) {
            processedSamplesContainer.push(tempProcessingBuffer.slice(0, framesExtracted * numChannels));
        }
    } while (framesExtracted > 0);

    if (processedSamplesContainer.length === 0) {
        return null;
    }

    // Unir todos los trozos procesados
    const totalProcessedSamples = processedSamplesContainer.reduce((sum, chunk) => sum + chunk.length, 0);
    const finalOutputSamplesInterleaved = new Float32Array(totalProcessedSamples);
    let currentOffset = 0;
    processedSamplesContainer.forEach(chunk => {
        finalOutputSamplesInterleaved.set(chunk, currentOffset);
        currentOffset += chunk.length;
    });
    
    const newTotalFrames = Math.floor(totalProcessedSamples / numChannels);
    if (newTotalFrames === 0) return null;

    // Des-intercalar el resultado de vuelta a canales separados
    const processedChannels = [];
    for (let ch = 0; ch < numChannels; ch++) {
        const channelData = new Float32Array(newTotalFrames);
        for (let f = 0; f < newTotalFrames; f++) {
            channelData[f] = finalOutputSamplesInterleaved[f * numChannels + ch];
        }
        processedChannels.push(channelData);
    }

    return {
        channels: processedChannels,
        sampleRate: audioBufferData.sampleRate,
    };
}


// El worker escucha mensajes del hilo principal
self.onmessage = function(event) {
    const { audioBufferChannels, sampleRate, rateFactor, cacheKey } = event.data;

    // Reconstruimos un objeto simple con los datos necesarios para procesar
    const audioData = {
        channels: audioBufferChannels,
        sampleRate: sampleRate,
    };

    const processedResult = processAudioWithSoundTouch(audioData, rateFactor);

    if (processedResult) {
        // Devolvemos el resultado al hilo principal.
        // El segundo argumento es una lista de objetos "Transferibles" para evitar
        // clonar los datos, lo que hace la comunicación mucho más rápida.
        const transferableObjects = processedResult.channels.map(channel => channel.buffer);
        self.postMessage({
            processedBufferChannels: processedResult.channels,
            sampleRate: processedResult.sampleRate,
            cacheKey: cacheKey
        }, transferableObjects);
    } else {
        // En caso de error, enviar una respuesta vacía
        self.postMessage({
            processedBufferChannels: null,
            cacheKey: cacheKey
        });
    }
};