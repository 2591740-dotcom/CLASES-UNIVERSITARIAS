package com.claseclara.app;

import android.Manifest;
import android.os.Build;

import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Aviso fijo para que la preparación siga fuera de la aplicación. */
@CapacitorPlugin(
        name = "ClaseClaraPreparar",
        permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "avisos") }
)
public class PreparePlugin extends Plugin {
    @PluginMethod
    public void empezar(PluginCall call) {
        arrancar(call.getString("detalle", "Preparando la clase"));
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("avisos") != PermissionState.GRANTED) {
            requestPermissionForAlias("avisos", call, "permisoListo");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void aviso(PluginCall call) {
        String detalle = call.getString("detalle", "");
        if (getContext() != null && PrepareService.activo()) {
            try {
                PrepareService.actualizar(getContext(), detalle);
            } catch (RuntimeException ignored) {
                // La preparación sigue aunque el aviso no cambie.
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void terminar(PluginCall call) {
        if (getContext() != null) {
            try {
                PrepareService.dismiss(getContext());
            } catch (RuntimeException ignored) {
                // El aviso ya se había cerrado.
            }
        }
        call.resolve();
    }

    @PermissionCallback
    private void permisoListo(PluginCall call) {
        if (getContext() != null && PrepareService.activo()) {
            try {
                PrepareService.actualizar(getContext(), call.getString("detalle", "Preparando la clase"));
            } catch (RuntimeException ignored) {
                // La preparación sigue aunque el aviso no aparezca.
            }
        }
        call.resolve();
    }

    private void arrancar(String detalle) {
        if (getContext() == null) return;
        try {
            PrepareService.start(getContext(), detalle);
        } catch (RuntimeException ignored) {
            // La preparación sigue en primer plano si el aviso no puede abrirse.
        }
    }
}
