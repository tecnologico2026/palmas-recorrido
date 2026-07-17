/*
 * Palmas Recorrido — app de prueba (standalone).
 *
 * Graba el recorrido GPS del auxiliar en SEGUNDO PLANO (pantalla apagada) usando el
 * servicio nativo de Android (plugin background-geolocation). Guarda los puntos SOLO en
 * el celular (IndexedDB) y los dibuja sobre el mapa sin rayas falsas: bota los fixes de
 * mala precisión y parte el recorrido en tramos donde hay un salto imposible (hueco).
 */
(function () {
  'use strict';

  // ---- Parámetros de calidad (mismos criterios del mapa del día de la plataforma) ----
  var MAX_PRECISION_M = 50;   // botar fixes peores que esto (bajo palma la señal se degrada)
  var MAX_SALTO_M = 120;      // salto >120 m entre dos puntos seguidos = hueco → cortar la línea

  var ESRI_SAT = 'https://server.arcgisonline.com/ArcGIS/rest/services/' +
                 'World_Imagery/MapServer/tile/{z}/{y}/{x}';

  // ---- Estado en memoria ----
  var db = null;
  var map = null, capaSat = null, marcador = null;
  var segmentos = [];          // array de L.polyline (un tramo continuo cada uno)
  var ultimoDibujado = null;   // {lat, lon} del último punto dibujado
  var distanciaTotal = 0;      // metros
  var totalPuntos = 0;
  var watcherId = null;
  var ultimoGuardadoMs = 0;    // para el muestreo por intervalo
  var grabando = false;
  var siguiendo = true;        // el mapa sigue al auxiliar hasta que él lo mueva

  var BG = null, Share = null, Filesystem = null;
  var esNativo = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // ============================ Utilidades ============================
  function hoyISO() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function $(id) { return document.getElementById(id); }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.classList.remove('oculto');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('oculto'); }, ms || 3200);
  }

  function distanciaM(a, b) {
    var R = 6371000;
    var p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180;
    var dphi = (b.lat - a.lat) * Math.PI / 180, dl = (b.lon - a.lon) * Math.PI / 180;
    var h = Math.sin(dphi / 2) * Math.sin(dphi / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ============================ IndexedDB ============================
  function abrirDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('palmas-recorrido', 1);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains('puntos')) {
          var st = d.createObjectStore('puntos', { keyPath: 'id', autoIncrement: true });
          st.createIndex('dia', 'dia', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function guardarPunto(p) {
    return new Promise(function (resolve) {
      var tx = db.transaction('puntos', 'readwrite');
      tx.objectStore('puntos').add(p);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  function puntosDelDia(dia) {
    return new Promise(function (resolve) {
      var tx = db.transaction('puntos', 'readonly');
      var idx = tx.objectStore('puntos').index('dia');
      var req = idx.getAll(IDBKeyRange.only(dia));
      req.onsuccess = function () { resolve((req.result || []).sort(function (a, b) { return a.time - b.time; })); };
      req.onerror = function () { resolve([]); };
    });
  }

  // ============================ Mapa ============================
  function iniciarMapa() {
    map = L.map('map', { zoomControl: true, attributionControl: false }).setView([4.0, -73.0], 5);
    capaSat = L.tileLayer(ESRI_SAT, { maxZoom: 19 }).addTo(map);
    map.on('dragstart', function () { siguiendo = false; });
  }

  function nuevoSegmento(color) {
    var pl = L.polyline([], { color: color || '#38bdf8', weight: 5, opacity: .95 }).addTo(map);
    segmentos.push(pl);
    return pl;
  }

  function pintarPunto(pt) {
    // pt: {lat, lon, accuracy}. Filtra precisión mala.
    if (pt.accuracy != null && pt.accuracy > MAX_PRECISION_M) return;   // fix malo → no ensucia
    var latlon = [pt.lat, pt.lon];
    // Punticos estilo CyberTracker: cada lectura del GPS = un punto (así lo ve la gerente).
    L.circleMarker(latlon, {
      radius: 5, color: '#1a1a1a', weight: 1.5, fillColor: '#ffe119', fillOpacity: 1,
    }).addTo(map);
    if (ultimoDibujado) {
      var salto = distanciaM(ultimoDibujado, pt);
      if (salto <= MAX_SALTO_M) distanciaTotal += salto;   // no contar los huecos
    }
    ultimoDibujado = { lat: pt.lat, lon: pt.lon };

    // Marcador del auxiliar (posición actual, encima de los punticos)
    if (!marcador) marcador = L.circleMarker(latlon, { radius: 8, color: '#fff', weight: 2, fillColor: '#ef4444', fillOpacity: 1 }).addTo(map);
    else marcador.setLatLng(latlon);
    if (siguiendo) map.setView(latlon, Math.max(map.getZoom(), 17));
  }

  function actualizarEstado() {
    $('estado-datos').textContent = totalPuntos + ' pts · ' + (distanciaTotal / 1000).toFixed(2) + ' km';
  }

  // ============================ Captura GPS ============================
  function onUbicacion(loc) {
    // loc del plugin: {latitude, longitude, accuracy, speed, time}
    if (!loc || loc.latitude == null) return;
    var ahora = Date.now();
    var intervaloMs = (parseInt($('intervalo').value, 10) || 10) * 1000;
    // Muestreo por TIEMPO (lo maneja el callback nativo, no un timer JS que el sistema congela):
    // guardamos un punto cada X s. El primero entra siempre.
    if (ultimoGuardadoMs && (ahora - ultimoGuardadoMs) < intervaloMs) {
      // Aun así movemos el marcador para que se vea vivo
      if (marcador) marcador.setLatLng([loc.latitude, loc.longitude]);
      return;
    }
    ultimoGuardadoMs = ahora;
    var pt = {
      dia: hoyISO(),
      codigo: ($('codigo').value || '').trim(),
      lat: loc.latitude, lon: loc.longitude,
      accuracy: loc.accuracy != null ? loc.accuracy : null,
      speed: loc.speed != null ? loc.speed : null,
      time: loc.time || ahora,
    };
    guardarPunto(pt);
    totalPuntos++;
    pintarPunto(pt);
    actualizarEstado();
  }

  function iniciarWatcherNativo() {
    return BG.addWatcher({
      backgroundMessage: 'Grabando tu recorrido. Toca para volver a la app.',
      backgroundTitle: 'Palmas Recorrido — grabando',
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,   // todos los fixes nativos; el intervalo lo aplicamos por tiempo
    }, function (location, error) {
      if (error) {
        if (error.code === 'NOT_AUTHORIZED') {
          toast('Falta el permiso de ubicación. Actívalo en Ajustes → Permisos → Ubicación → Permitir siempre.', 6000);
        }
        return;
      }
      onUbicacion(location);
    }).then(function (id) { watcherId = id; });
  }

  // ============================ Iniciar / Terminar ============================
  function iniciarDia() {
    var codigo = ($('codigo').value || '').trim();
    if (!codigo) { toast('Escribe el código de quien lleva el celular.'); $('codigo').focus(); return; }
    if (!esNativo) {
      toast('Esta app graba en segundo plano solo instalada en el celular (APK). En navegador es solo vista previa.', 5000);
    }
    grabando = true;
    ultimoGuardadoMs = 0;
    localStorage.setItem('pr-grabando', '1');
    localStorage.setItem('pr-codigo', codigo);
    localStorage.setItem('pr-intervalo', $('intervalo').value);
    localStorage.setItem('pr-dia', hoyISO());

    $('panel-top').classList.add('bloqueado');
    $('btn-iniciar').classList.add('oculto');
    $('btn-terminar').classList.remove('oculto');
    $('btn-compartir').classList.add('oculto');
    $('estado').classList.remove('oculto');
    siguiendo = true;

    if (esNativo && BG) {
      iniciarWatcherNativo().catch(function (e) { toast('No se pudo iniciar el GPS: ' + e); });
    } else {
      // Vista previa en navegador (no graba en segundo plano)
      watcherId = navigator.geolocation.watchPosition(function (pos) {
        onUbicacion({ latitude: pos.coords.latitude, longitude: pos.coords.longitude,
                      accuracy: pos.coords.accuracy, speed: pos.coords.speed, time: pos.timestamp });
      }, function () {}, { enableHighAccuracy: true, maximumAge: 0 });
    }
    toast('Grabando el día de ' + codigo + ' (cada ' + $('intervalo').value + ' s).');
  }

  function terminarDia() {
    grabando = false;
    localStorage.removeItem('pr-grabando');
    if (esNativo && BG && watcherId) { BG.removeWatcher({ id: watcherId }).catch(function () {}); }
    else if (watcherId != null) { navigator.geolocation.clearWatch(watcherId); }
    watcherId = null;

    $('panel-top').classList.remove('bloqueado');
    $('btn-terminar').classList.add('oculto');
    $('btn-iniciar').classList.remove('oculto');
    $('estado').classList.add('oculto');
    if (totalPuntos > 0) $('btn-compartir').classList.remove('oculto');
    toast('Recorrido terminado. ' + totalPuntos + ' puntos guardados.');
  }

  // ============================ Exportar / Compartir (GPX) ============================
  function gpxDelDia(puntos, codigo, dia) {
    var trkpts = puntos.map(function (p) {
      var t = new Date(p.time).toISOString();
      return '   <trkpt lat="' + p.lat + '" lon="' + p.lon + '"><time>' + t + '</time></trkpt>';
    }).join('\n');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Palmas Recorrido" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      '  <trk><name>' + (codigo || 'sin-codigo') + ' ' + dia + '</name><trkseg>\n' +
      trkpts + '\n  </trkseg></trk>\n</gpx>\n';
  }

  function compartir() {
    var dia = localStorage.getItem('pr-dia') || hoyISO();
    var codigo = localStorage.getItem('pr-codigo') || '';
    puntosDelDia(dia).then(function (pts) {
      if (!pts.length) { toast('No hay puntos para compartir.'); return; }
      var gpx = gpxDelDia(pts, codigo, dia);
      var nombre = 'recorrido_' + (codigo || 'sc') + '_' + dia + '.gpx';
      if (esNativo && Filesystem && Share) {
        Filesystem.writeFile({ path: nombre, data: gpx, directory: 'CACHE', encoding: 'utf8' })
          .then(function () { return Filesystem.getUri({ path: nombre, directory: 'CACHE' }); })
          .then(function (r) { return Share.share({ title: nombre, text: 'Recorrido ' + codigo + ' ' + dia, url: r.uri }); })
          .catch(function (e) { toast('No se pudo compartir: ' + e); });
      } else {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
        a.download = nombre; a.click();
      }
    });
  }

  // ============================ Arranque ============================
  function restaurarRecorridoDibujado() {
    var dia = hoyISO();
    return puntosDelDia(dia).then(function (pts) {
      totalPuntos = pts.length;
      pts.forEach(pintarPunto);
      actualizarEstado();
      if (pts.length && $('btn-terminar').classList.contains('oculto') && !grabando) {
        $('btn-compartir').classList.remove('oculto');
      }
    });
  }

  function arrancar() {
    // Plugins nativos
    if (esNativo && window.Capacitor && window.Capacitor.registerPlugin) {
      BG = window.Capacitor.registerPlugin('BackgroundGeolocation');
      Share = window.Capacitor.Plugins ? window.Capacitor.Plugins.Share : window.Capacitor.registerPlugin('Share');
      Filesystem = window.Capacitor.Plugins ? window.Capacitor.Plugins.Filesystem : window.Capacitor.registerPlugin('Filesystem');
    }
    iniciarMapa();

    // Restaurar código/intervalo previos
    var cod = localStorage.getItem('pr-codigo'); if (cod) $('codigo').value = cod;
    var iv = localStorage.getItem('pr-intervalo'); if (iv) $('intervalo').value = iv;

    // Botones
    $('btn-iniciar').addEventListener('click', iniciarDia);
    $('btn-terminar').addEventListener('click', terminarDia);
    $('btn-compartir').addEventListener('click', compartir);

    abrirDB().then(function (d) {
      db = d;
      return restaurarRecorridoDibujado();
    }).then(function () {
      // Si quedó grabando (la app se reabrió), reanuda
      if (localStorage.getItem('pr-grabando') === '1' && localStorage.getItem('pr-dia') === hoyISO()) {
        iniciarDia();
      }
    }).catch(function (e) { toast('Error iniciando: ' + e); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
  else arrancar();
})();
