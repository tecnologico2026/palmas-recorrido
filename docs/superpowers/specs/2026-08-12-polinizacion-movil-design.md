# Polinización en APK nativa — diseño

**Fecha:** 2026-08-12 · **Estado:** aprobado en brainstorming, pendiente de plan
**Objetivo de campo:** prueba hoy (miércoles 12) · operación real el martes 18 de agosto

## Problema

Las labores de polinización se hacen en campo sin internet. La plataforma web ya funciona
offline, pero el **recorrido GPS se corta cuando el auxiliar apaga la pantalla y guarda el
celular en el bolsillo**: `gps-tracker.js` usa `watchPosition` + Wake Lock, y Android congela
el WebView de Chrome cuando la pantalla se apaga.

La APK `palmas-recorrido` ya resolvió eso con un foreground service nativo, pero vive aparte:
graba recorridos y exporta GPX, sin ninguna relación con polinización.

## Alcance

**Solo polinización.** Cosecha, poda y riego siguen como están. Si la prueba sale bien, se
evalúa extender.

Las labores que deben funcionar en campo sin señal:

| Labor | Ruta | ¿Offline hoy? |
|---|---|---|
| Evaluación | `/labores/m/polinizacion/seguimiento/EVALUACION/` | Sí |
| Hora a hora | `/labores/m/polinizacion/seguimiento/HORA_HORA/` | Sí |
| Tumba de flor | `/labores/m/polinizacion/seguimiento/TUMBA/` | Sí |
| Acompañamiento | `/labores/m/polinizacion/seguimiento/ACOMPANAMIENTO/` | Sí |
| Programar | `/labores/m/polinizacion/programar/` | Sí |
| Ejecución | `/labores/polinizacion/ejecucion/` | **No** — pantalla de escritorio |

Las cinco primeras ya las cachea el Service Worker (`core/static/core/sw.js:171`).

## Lo que ya existe y NO se vuelve a construir

- Service Worker con precache y estrategia network-first por pantalla.
- Colas offline en IndexedDB: `polinizacion-offline.js`, `eval-offline.js`.
- `EvaluacionPolinizacion` con los 4 tipos y `client_uuid` para idempotencia.
- `SesionGPS` / `TrackPoint` y el endpoint `POST /labores/m/gps/sync/`, idempotente y
  capaz de recibir varios días acumulados (agrupa por fecha local del punto).
- Cloud Run Jobs (`palmas-migrate`, `palmas-sync-pesajes`) como patrón para tareas programadas.

## Arquitectura

Una APK Capacitor que es un **cascarón**: no contiene ninguna pantalla de polinización.

```
┌──────────────── APK "Palmas Campo" ─────────────────┐
│  WebView → https://palmas-34g66bccva-uc.a.run.app   │
│            /labores/m/polinizacion/                 │
│            · Service Worker existente = offline     │
│            · Cookie de sesión Django = identidad    │
│  ⇅ bridge de Capacitor (inyectado en la remota)     │
│  Foreground Service GPS (nativo)                    │
│            · vivo con la pantalla apagada           │
└─────────────────────────────────────────────────────┘
```

Razón de la decisión: con 12 teléfonos, empaquetar los formularios dentro del APK obligaría a
recorrer 12 celulares en cada ajuste. Con el cascarón, los cambios de Django llegan solos.

`server.url` está documentado como "no para producción" — la advertencia apunta a rechazos de
Google Play y a exponer APIs nativas a un dominio ajeno. Aquí la distribución es **sideload
interno desde GitHub Releases** y el dominio es propio, con `allowNavigation` restringido.

## Componentes

### 1. APK (repo `palmas-recorrido`)
- `capacitor.config.json`: `server.url` + `allowNavigation` al dominio de Palmas.
- Pantalla de primer arranque para escribir el servidor; queda guardado.
- Se elimina `www/app.js` y `www/index.html`: la lógica de recorrido pasa al servidor.
- Verificar que el permiso de ubicación sea "Permitir todo el tiempo"; bloquear con mensaje
  claro si está en "solo mientras se usa" (ahí el recorrido se corta en silencio).

### 2. `gps-tracker.js` — un archivo, dos motores (repo `palmas`)

```js
if (window.Capacitor?.Plugins?.BackgroundGeolocation) {
    // APK: watcher nativo, sobrevive pantalla apagada
} else {
    // Chrome: watchPosition + wakeLock (lo actual, intacto)
}
```

La web sigue igual para quien entre por navegador. Se comparte cola, endpoint, filtro de
precisión y cálculo de distancia: no se bifurca el producto.

### 3. Pantalla de campo de polinización (repo `palmas`)

`recorrido_app.html` pasa de ser solo recorrido a ser **la pantalla de campo de polinización**:
acceso a las cuatro labores + Programar, con el recorrido grabando por debajo. Estilo y patrones
de `cosecha_movil.html` (mobile-first, controles táctiles, `font-size: 16px` en inputs para que
Android no haga zoom, cabecera sticky).

### 4. Ventana de captura

**6:00 AM – 3:00 PM**, configurable **desde el servidor** (no quemada en el APK; si cambia la
jornada no se recompilan 12 celulares).

A las 3 PM se apaga la **captura**, no la **sincronización**: el auxiliar recupera señal al
volver a la oficina y la cola debe poder vaciarse esa misma tarde.

### 5. Volumen y retención

A 1 punto/10 s: 2.880 puntos por teléfono al día, 34.560 con 12 teléfonos, ~10,4 millones al año.

| Palanca | Efecto |
|---|---|
| `distanceFilter: 10` (hoy en 0) | ~1.400 pts/día |
| Douglas-Peucker, tolerancia 5 m, al cerrar el día | ~350 pts/día |

**Orden obligatorio: primero resumir, después adelgazar.** `SesionGPS.distancia_total_m`,
`lotes_detectados` y `ResultadoCruce.porcentaje_tiempo_en_lote` se calculan de los timestamps
punto a punto; si se simplifica antes, el "% de tiempo en lote" queda mal para siempre.

Job semanal (Cloud Run Job, patrón `sync_pesajes`):

```
1. calcula resúmenes de la semana
2. exporta cada recorrido a GeoJSON y lo empaqueta
3. sube el ZIP a Google Cloud Storage        ← respaldo automático
4. borra TrackPoint > 14 días, SOLO si su ZIP ya existe en GCS
```

El supervisor junior descarga desde una pantalla de descargas. **La purga mira edad y respaldo,
nunca "si alguien descargó"** — si la descarga falla o el archivo se pierde en un PC, el dato
no debe desaparecer. **`SesionGPS` no se borra jamás**, solo los `TrackPoint` crudos.

Formato: **GeoJSON** (ya existe `gps_export_geojson`, QGIS lo abre nativo). Shapefile quedaría
para después, con `pyshp`, si el flujo del supervisor lo exige.

### 5.b Mapa diario de polinización

Pedido explícito: el supervisor debe poder ver los recorridos del día de polinización, como ya
se hace con cosecha.

La pantalla **ya existe y no es de cosecha**: `/labores/mapa-dia/` (`views.mapa_dia`,
`views.mapa_dia_imagen`, render en `labores/mapa_dia.py`). `recorridos_del_dia(fecha)` toma
**todas** las `SesionGPS` de la fecha, las agrupa por empleado y les da un color por auxiliar.
Los recorridos de polinización aparecerían ahí solos en cuanto empiecen a sincronizar.

**El bloqueador es el dato, no la pantalla.** `gps_sync` crea la sesión con
`SesionGPS.objects.get_or_create(empleado=empleado, fecha=fecha)` — sin `ejecucion`. Ese FK
(nullable) es lo único que ataría un recorrido a una labor, así que hoy **toda sesión que llega
del móvil queda sin labor** y cosecha y polinización se dibujarían mezcladas en el mismo PNG.

Decisión pendiente — cómo se marca la labor de un recorrido:

| Opción | A favor | En contra |
|---|---|---|
| Mandarla desde el móvil en el sync | explícito, sin adivinar | hay que tocar el payload y la cola offline |
| Inferirla de la programación del día | cero cambios en el móvil | falla con el trabajo no programado |
| Campo propio en `SesionGPS` | independiente de `Ejecucion` | un campo más que mantener al día |

Hasta resolverlo, filtrar por labor en el mapa no tiene de dónde filtrar.

### 6. Modelo

| Cambio | Por qué |
|---|---|
| `TrackPoint.id`: UUID → `BigAutoField` | UUIDv4 aleatorio fragmenta el índice B-tree; a 10M filas los inserts se degradan justo cuando 12 teléfonos sincronizan a la vez |
| `SesionGPS.respaldada_en` (nuevo) | ruta del ZIP en GCS; sin esto la purga no borra |
| `SesionGPS.simplificada` (nuevo) | evita re-simplificar |

### 7. Permisos (repo `palmas`)

`can_evaluar_polinizacion` hoy solo lo tienen `labores_admin` y `labores_auxiliar`
(`labores/groups.py:40,117`). Los auditores llevan `can_evaluar_poda` con el precedente
*"los auditores también evalúan; Jorge 14-jul"* — falta el equivalente para polinización.

No existe rol de auxiliar CTC (`labores_auxiliar_ayt` es Alce y Transporte).

**Supuesto pendiente de confirmar:** los auditores llenan los mismos cuatro formularios que el
CTC. Si auditan con otro criterio, es un modelo nuevo y un spec aparte.

## Manejo de errores

| Riesgo | Mitigación |
|---|---|
| Sesión vencida en campo sin señal → no puede entrar | `SESSION_COOKIE_AGE` no está configurado (default 2 semanas). Subir a 60 días y avisar en pantalla al faltar 7 |
| Primera vez sin wifi → no hay caché, pantalla vacía | Protocolo: preparar el celular con wifi antes de salir (`/m/polinizacion/preparar/` ya existe) |
| Ubicación en "solo mientras se usa" → recorrido cortado en silencio | La APK verifica y bloquea con mensaje |
| Graba fuera de jornada | Ventana 6 AM–3 PM. Con `distanceFilter`, estar quieto casi no genera puntos |

## Testing

- Django, al HTTP boundary: permisos por rol, purga que no borra sin respaldo, simplificación
  que preserva la distancia total, `gps_sync` idempotente.
- Campo: un teléfono, jornada completa, pantalla apagada en el bolsillo.

## Fases

| Fase | Qué | Cuándo |
|---|---|---|
| **0 — hoy** | APK con `server.url` contra producción. Prueba de campo: evaluaciones y recepción de datos **sin internet**. No requiere ningún cambio ni deploy en Django | miércoles 12 |

**En la Fase 0 el GPS todavía NO es nativo.** El WebView carga la web tal cual está, así que el
recorrido sigue usando `watchPosition` + Wake Lock y necesita la pantalla encendida. Lo que la
Fase 0 prueba es el WebView y el offline de los formularios, no el GPS de fondo — ese llega en
la Fase 1. Decirlo antes evita que en campo se lea como una falla.

### Criterio de éxito de la Fase 0

La prueba de hoy sale bien si, con el celular en **modo avión** dentro del lote:

1. La APK abre y muestra las pantallas de polinización (vienen del Service Worker).
2. Se puede llenar y guardar una **Evaluación** y una **Tumba de flor**; la pantalla confirma
   que quedó encolada.
3. Al recuperar señal, los registros aparecen en la plataforma con el operario y el lote
   correctos, **sin duplicarse** si se reintenta.
4. El auxiliar entiende qué está pasando sin que nadie le explique al oído.

Si 1 y 2 fallan, el problema es de caché (el celular no se preparó con wifi). Si falla 3, el
problema es la cola offline y hay que revisarla antes del martes.
| **1 — antes del martes** | `gps-tracker.js` de dos motores, pantalla de campo de polinización estilo cosecha móvil, ventana horaria, `distanceFilter` | jueves–lunes |
| **2 — cuando haya volumen** | `BigAutoField`, simplificación, job de respaldo y purga | tras la primera semana |
| **3 — pendiente de respuesta** | Permisos de auditoría y rol CTC | por definir |

La Fase 0 es deliberadamente mínima: prueba el supuesto más caro de revertir (¿sirve el WebView
en campo sin señal?) sin tocar producción.

## Supuestos

1. Distribución por sideload desde GitHub Releases, no Google Play.
2. Los auditores usan los mismos cuatro formularios que el CTC.
3. La prueba de hoy va contra producción, con datos reales.
