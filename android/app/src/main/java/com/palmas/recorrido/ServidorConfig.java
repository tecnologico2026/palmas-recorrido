package com.palmas.recorrido;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Dónde vive la plataforma Palmas para esta instalación del APK.
 *
 * Por defecto apunta a producción: el auxiliar instala, abre y trabaja, sin configurar nada
 * ni escribir direcciones en el celular. La pantalla {@link ServidorActivity} permite
 * apuntarlo a un Django local mientras se desarrolla, sin recompilar ni reinstalar los
 * 12 celulares de campo.
 */
public final class ServidorConfig {

    /** Producción. Es lo que usan los celulares de campo mientras nadie toque nada. */
    public static final String URL_POR_DEFECTO =
        "https://palmas-34g66bccva-uc.a.run.app/labores/m/polinizacion/menu/";

    private static final String PREFS = "palmas_servidor";
    private static final String CLAVE_URL = "url";

    private ServidorConfig() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** La URL que debe cargar el WebView: la guardada, o producción si no hay ninguna. */
    public static String url(Context c) {
        String guardada = prefs(c).getString(CLAVE_URL, null);
        return (guardada == null || guardada.trim().isEmpty()) ? URL_POR_DEFECTO : guardada;
    }

    /** true si alguien cambió el servidor a mano (se avisa en pantalla para no confundirse). */
    public static boolean esPersonalizada(Context c) {
        return prefs(c).getString(CLAVE_URL, null) != null;
    }

    public static void guardar(Context c, String url) {
        prefs(c).edit().putString(CLAVE_URL, url).apply();
    }

    public static void restaurarPorDefecto(Context c) {
        prefs(c).edit().remove(CLAVE_URL).apply();
    }

    /**
     * Convierte lo que se escribió a mano en una URL cargable, o devuelve null si no sirve.
     *
     * Se escribe en el teclado de un celular, así que hay que perdonar lo típico: espacios
     * pegados por el autocompletado, falta de esquema, mayúsculas del teclado de Android.
     *
     * Se acepta http:// además de https:// a propósito: el Django de desarrollo corre en
     * la LAN sin certificado, y ese es justamente el caso de uso de esta pantalla. El
     * manifest ya declara usesCleartextTraffic para permitirlo.
     */
    public static String normalizar(String escrito) {
        if (escrito == null) return null;
        String u = escrito.trim();
        if (u.isEmpty()) return null;

        // El teclado de Android capitaliza la primera letra: "Https://..." no resuelve.
        if (u.regionMatches(true, 0, "http://", 0, 7) || u.regionMatches(true, 0, "https://", 0, 8)) {
            int i = u.indexOf("://");
            u = u.substring(0, i).toLowerCase() + u.substring(i);
        } else {
            u = "https://" + u;
        }

        // Tiene que quedar algo después del esquema (evita guardar "https://" pelado).
        String resto = u.substring(u.indexOf("://") + 3);
        if (resto.isEmpty() || resto.startsWith("/")) return null;

        return u;
    }
}
