# Voz Lab

Página web que hace que una voz (A) se parezca a otra (B) usando Fourier, STFT/ISTFT, phase vocoder y cepstrum.
Conversión no paralela, sobre grabaciones, con fidelidad didáctica. Todo el audio se procesa en el navegador.

## Ejecutar
Sirve la carpeta con cualquier servidor estático (el micrófono exige HTTPS o localhost):

    python3 -m http.server 8000      # y abre http://localhost:8000

Si abres `index.html` con doble clic, el Worker no carga y el procesamiento corre en el hilo principal.

## Archivos
| Archivo | Contenido |
|---|---|
| `index.html` | Estructura de la página |
| `styles.css` | Estilos |
| `app.js` | Interfaz: grabación, carga, perfil (IndexedDB), visualizaciones |
| `dsp.js` | FFT, STFT/ISTFT, cepstrum, F0 (YIN), phase vocoder, conversión con phase vocoder |
| `world.js` | Vocoder fuente-filtro tipo WORLD: análisis (F0, CheapTrick, aperiodicidad), conversión y síntesis |
| `worker.js` | Ejecuta `dsp.js` y `world.js` en un Web Worker |
| `tests/dsp.test.js` | Pruebas del DSP con señales sintéticas |

## Pruebas
    node tests/dsp.test.js

## Uso
1. Marca la casilla de consentimiento.
2. Voz B: graba o sube 30-60 s y pulsa "Crear perfil de B" (queda guardado en el dispositivo).
3. Voz A: graba o sube hasta 3 minutos.
4. Ajusta parámetros y pulsa "Convertir". Compara A, B y C en la sección final.

## Imitación (Nivel 1) y estimación de F0
- **F0:** YIN sobre una copia diezmada a ~8 kHz, con varios candidatos por cuadro y Viterbi (al estilo pYIN) para elegir la ruta más continua y evitar saltos de octava.
- **Entonación:** modo "imitar B" lleva la media y la desviación de log F0 a las de B; "conservar A" solo desplaza; "aplanar" fija todo en el tono de B.
- **Timbre:** VTLN (factor de deformación de frecuencias entre 0.6 y 1.6 que mejor acerca la envolvente de A a la de B) y ajuste por cuadro hacia la media y la dispersión de la envolvente de B.
- **Soplo:** compara la relación armónico/ruido (medida con la periodicidad de YIN); si B es más soplada se añade ruido con la forma del espectro, si es más limpia se hunden los valles entre armónicos.
- **Ritmo:** sílabas por segundo estimadas con los picos de la envolvente de energía; opcionalmente se aplica un time-stretch para igualar la de B.
- Los perfiles creados con la versión anterior siguen funcionando, pero conviene recrearlos para tener variación, soplo y ritmo de B.

## Motores de síntesis
La sección "Convertir" permite elegir el motor:
- **Phase vocoder (STFT):** el motor original. Cambia el tono estirando y remuestreando, y corrige el timbre con la envolvente cepstral.
- **Vocoder fuente-filtro (tipo WORLD):** separa la voz cada 5 ms en F0, envolvente (CheapTrick: ventana de 3 periodos, suavizado de 2/3 de F0 y liftering sinc con compensación) y aperiodicidad en bandas de 500, 1500, 3000, 5000 y 7500 Hz (versión simplificada de D4C: 1 menos la autocorrelación normalizada de la banda en el periodo). Resintetiza con un pulso de fase mínima por periodo más ruido filtrado. Tono, envolvente, aperiodicidad y duración se modifican por separado; el bloqueo de fase y la opción de consonantes sordas no aplican (los cuadros sordos nunca reciben tono).

Los perfiles de B (versión 3) guardan las estadísticas de ambos motores. Un perfil anterior sirve para el phase vocoder, pero hay que recrearlo para el motor fuente-filtro.

### Medir el parecido de timbre
La tabla de comparación muestra dos distancias de envolvente. La **cepstral** es la que el phase vocoder corrige directamente, así que tiende a favorecerlo. La **CheapTrick** sigue las amplitudes reales de los armónicos y es la medida más fiel; en las pruebas con voces sintéticas el motor fuente-filtro queda más cerca de B con ella.

## Cobertura del SRS
RF1-RF17, RF19, RF20, RF22 y RF23 implementados, más el Nivel 1 de imitación, YIN y el vocoder fuente-filtro. RF18 y RF21 se eliminaron del alcance.
Limitaciones conocidas: el tamaño de FFT es igual al de la ventana (sin relleno de ceros); el resultado solo se reproduce
dentro de la página (sin exportación, por RF21); la calidad con voces reales debe ajustarse con los parámetros de `f0Track` (umbral 0.5 de YIN, costo sordo 0.35,
penalización de saltos 4) y el orden de liftering. La vista de cuadro de la sección de análisis sigue mostrando el
cepstrum con fines didácticos (umbral 0.06), aunque la conversión usa YIN.
