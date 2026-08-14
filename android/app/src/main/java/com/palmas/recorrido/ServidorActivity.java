package com.palmas.recorrido;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Pantalla para apuntar la APK a otro servidor (Django local, túnel, otro entorno).
 *
 * No está en el cajón de aplicaciones: se llega dejando pulsado el ícono de la app y
 * eligiendo "Servidor". Es a propósito — un auxiliar en el lote no debería toparse con
 * esto, y quien desarrolla lo tiene a un gesto.
 */
public class ServidorActivity extends Activity {

    private EditText campoUrl;
    private TextView aviso;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_servidor);

        campoUrl = findViewById(R.id.campo_url);
        aviso = findViewById(R.id.aviso);
        Button guardar = findViewById(R.id.btn_guardar);
        Button restaurar = findViewById(R.id.btn_restaurar);

        campoUrl.setText(ServidorConfig.url(this));
        mostrarAviso();

        guardar.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String url = ServidorConfig.normalizar(campoUrl.getText().toString());
                if (url == null) {
                    Toast.makeText(ServidorActivity.this,
                        "Esa dirección no sirve. Ejemplo: 192.168.1.50:8000",
                        Toast.LENGTH_LONG).show();
                    return;
                }
                ServidorConfig.guardar(ServidorActivity.this, url);
                reiniciarApp();
            }
        });

        restaurar.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ServidorConfig.restaurarPorDefecto(ServidorActivity.this);
                reiniciarApp();
            }
        });
    }

    private void mostrarAviso() {
        if (ServidorConfig.esPersonalizada(this)) {
            aviso.setText("⚠ Esta APK NO está apuntando a producción. " +
                          "Usa «Volver a producción» antes de entregarla a un auxiliar.");
            aviso.setVisibility(View.VISIBLE);
        } else {
            aviso.setVisibility(View.GONE);
        }
    }

    /**
     * El servidor se lee al construir el bridge, en onCreate: no basta con volver atrás,
     * hay que levantar el proceso de nuevo para que el WebView cargue la otra dirección.
     */
    private void reiniciarApp() {
        Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (i != null) {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            startActivity(i);
        }
        Runtime.getRuntime().exit(0);
    }
}
