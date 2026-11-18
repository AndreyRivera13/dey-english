# DevTalk

App web para practicar inglés hablado con escenarios del día a día de un desarrollador de software. Hablas por micrófono, la IA responde con voz y cada frase tuya vuelve revisada: qué cambia y por qué.

Demo: https://andreyrivera13.github.io/Dey-English-/

## Qué tiene

- Niveles A1, A2, B1 y B2, con seis escenarios cada uno (standup, code review, entrevistas, postmortem, entre otros) y un tema libre.
- Corrección de cada frase en formato diff, con la explicación en español.
- Lista de errores para repasar y marcar como dominados.
- Pistas cuando no sabes qué decir y traducción de lo que dice la IA.
- Progreso por nivel guardado en el navegador.

## Cómo funciona

El modelo de lenguaje corre en el navegador con WebGPU usando [WebLLM](https://github.com/mlc-ai/web-llm). No hay backend, cuentas ni claves de API. El modelo se descarga una sola vez y queda en caché.

| Modelo | Descarga aprox. | Memoria gráfica |
| --- | --- | --- |
| Ligero (Qwen2.5 1.5B) | 1 GB | 2 GB |
| Equilibrado (Llama 3.2 3B) | 1,8 GB | 3 GB |
| Máxima calidad (Llama 3.1 8B) | 4,5 GB | 6 GB |

La voz usa las funciones del navegador: `SpeechRecognition` para el dictado y `speechSynthesis` para leer las respuestas.

## Requisitos

- Chrome o Edge actualizados, en computador.
- Tarjeta gráfica con soporte de WebGPU.
- Micrófono. Si no hay, se puede escribir.

## Correr en local

```bash
python3 -m http.server 8000
# abrir http://localhost:8000
```

Con `?mock` en la URL se usa un motor simulado para probar la interfaz sin descargar el modelo.

## Pruebas

```bash
node --test tests/*.test.mjs
```

## Limitaciones

- Un modelo que cabe en el navegador corrige bien gramática y vocabulario, pero puede fallar en matices. La revisión es una ayuda, no una calificación oficial.
- En Chrome el dictado por voz pasa por el servicio de voz de Google.
- En celular el modelo puede no cargar por memoria.
