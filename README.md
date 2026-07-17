# Palmas Recorrido — app de prueba

App **Android aparte** para probar en campo la grabación de recorridos GPS **en segundo plano**
(pantalla apagada, celular en el bolsillo), al estilo CyberTracker. **No toca** la plataforma de
cosecha: los puntos se guardan **solo en el celular**.

## Qué hace

- Campo **Código** (quién lleva el celular) + lista **cada cuánto toma un punto** (5/10/15/20 s).
- Botones **Iniciar mi día** / **Terminar mi día**.
- Graba el recorrido con el servicio de fondo de Android y lo dibuja sobre el mapa satélite,
  **sin rayas falsas** (bota fixes de mala precisión y corta la línea en los huecos).
- **Compartir recorrido**: exporta el día como archivo GPX etiquetado con el código.

## Instalar (una sola vez, en el celular)

1. Abre en el celular el link de descarga del APK (Releases → el último).
2. Android dirá que no se pueden instalar apps de esta fuente → **Permitir/Configurar** → activa
   "Permitir de esta fuente".
3. Instala y abre **Palmas Recorrido**.
4. La primera vez pedirá el **permiso de ubicación** → elige **"Permitir todo el tiempo"**
   (imprescindible para que grabe con la pantalla apagada).

## Usar

1. Escribe el **código** del auxiliar.
2. Elige **cada cuánto** guarda un punto.
3. **Iniciar mi día** → guarda el celular y trabaja normal.
4. Al terminar → **Terminar mi día** → **Compartir recorrido** para enviar el GPX.

## Cómo está hecho

- [Capacitor 6](https://capacitorjs.com) envuelve una web local (`www/`) — mismas pantallas, app nativa.
- GPS de fondo: [`@capacitor-community/background-geolocation`](https://github.com/capacitor-community/background-geolocation)
  (servicio en primer plano con notificación fija).
- Mapa: Leaflet + imágenes satélite de Esri.
- El **APK se compila solo en la nube** (GitHub Actions) y queda en *Releases*.

## Compilar el APK

Se compila automáticamente al hacer push a `main` (ver `.github/workflows/build.yml`). El instalable
queda en la última *Release* como `palmas-recorrido.apk`.
