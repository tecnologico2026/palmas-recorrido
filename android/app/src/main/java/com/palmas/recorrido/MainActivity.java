package com.palmas.recorrido;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.Logger;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Carga la plataforma Palmas en el WebView, con el servidor que diga {@link ServidorConfig}.
 *
 * Por qué se hace en Java y no navegando desde una página local: en Android, server.url
 * recibe trato especial en el bridge nativo. Si en su lugar se carga una página local y se
 * salta al servidor con window.location, los plugins nativos dejan de responder
 * ("not implemented on android") y Capacitor.isNativePlatform() devuelve false — se perdería
 * el GPS de fondo, que es la razón de existir de esta APK.
 * Ver ionic-team/capacitor#4164 y #7454.
 */
public class MainActivity extends BridgeActivity {

    /** Código propio para la respuesta del permiso de notificaciones (no lo usa nadie más). */
    private static final int PERMISO_NOTIFICACIONES = 9101;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pedirPermisoDeNotificaciones();
    }

    /**
     * Pide POST_NOTIFICATIONS en Android 13+.
     *
     * El plugin de GPS de fondo NO lo pide —solo declara el alias "location"— y el manifest
     * por sí solo no basta: desde Android 13 es un permiso de runtime. Sin él, la
     * notificación fija de "grabando tu recorrido" no se muestra.
     *
     * Importa por dos motivos: es la única señal que tiene el auxiliar (y el supervisor)
     * de que el recorrido se está grabando —"mira que salga la notificación" es el
     * protocolo de verificación en campo—, y es lo que le dice al operario que su
     * ubicación se está usando, que es la razón de que Android la exija.
     *
     * Afecta a los teléfonos NUEVOS: los Moto G05 traen Android 15. Los E30/E40 con
     * Android 11 no pasan por aquí y muestran la notificación sin pedir nada.
     */
    private void pedirPermisoDeNotificaciones() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;   // Android 12 o menor: la notificación sale sin permiso de runtime
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        // Si el operario lo niega, la app sigue funcionando y el recorrido se graba igual:
        // solo se queda sin el aviso visible. No se insiste ni se bloquea la pantalla.
        requestPermissions(
            new String[] { Manifest.permission.POST_NOTIFICATIONS }, PERMISO_NOTIFICACIONES);
    }

    @Override
    protected void load() {
        // BridgeActivity.load() hace bridgeBuilder.setConfig(config): si config queda en null,
        // el bridge cae al capacitor.config.json tal cual, que es el comportamiento normal.
        config = configConServidor(ServidorConfig.url(this));
        super.load();
    }

    /**
     * Toma el capacitor.config.json real y le cambia solamente server.url.
     *
     * Se hace así, y no con CapConfig.Builder, porque el Builder arranca en valores por
     * defecto: no hereda nada del archivo. Construirla desde cero perdería allowMixedContent
     * y toda la configuración de plugins, y volvería a perderla cada vez que alguien agregue
     * algo al JSON sin acordarse de replicarlo aquí.
     */
    @SuppressWarnings("deprecation") // el constructor con JSONObject es el único que respeta el archivo
    private CapConfig configConServidor(String url) {
        try {
            JSONObject json = leerConfigDeAssets();
            JSONObject server = json.optJSONObject("server");
            if (server == null) {
                server = new JSONObject();
                json.put("server", server);
            }
            server.put("url", url);
            return new CapConfig(getAssets(), json);
        } catch (Exception e) {
            // Sin config propia la app abre igual, contra lo que diga el archivo: es mejor
            // que quedarse en pantalla negra por un JSON mal formado.
            Logger.error("No se pudo aplicar el servidor " + url + "; se usa capacitor.config.json", e);
            return null;
        }
    }

    private JSONObject leerConfigDeAssets() throws Exception {
        try (InputStream in = getAssets().open("capacitor.config.json")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            return new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
        }
    }
}
