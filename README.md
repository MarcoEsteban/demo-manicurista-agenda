# Demo Manicurista — Agenda de Reservas

Agenda de turnos para un studio de uñas con panel de administración sobre **Google Apps Script + Google Sheets**. Sin servidores, sin base de datos externa, sin costo de infraestructura.

- **Cliente** (`Index.html`): wizard de reserva en 6 pasos — servicio, manicurista, día, hora, datos y confirmación. Incluye selector de país para WhatsApp, elección de pago (efectivo o QR) y programa de fidelidad.
- **Admin** (`Admin.html`): login, filtros por estado, confirmación/cancelación por WhatsApp, sondeo de reservas nuevas, gestión de catálogos (servicios, manicuristas y horarios), historial por cliente, reportes, dashboard de ingresos y configuración del negocio.
- **Backend** (`Codigo.js`): disponibilidad calculada en servidor, `LockService` para evitar dobles reservas y validación de timezone.

## Demo con datos

`src/Codigo.js` incluye `sembrarDemo()`, que deja el negocio funcionando y poblado:

- 3 manicuristas: dos de martes a sábado y una de lunes a viernes.
- 6 servicios de uñas: clásica, semipermanente, pedicura spa, acrílicas, kapping y nail art.
- 12 reservas de ejemplo repartidas entre completadas, confirmadas, pendientes y canceladas.
- Fidelidad activa: cada 5 visitas completadas se regala una manicura clásica.

Es idempotente: solo completa las hojas vacías, así que se puede ejecutar más de una vez sin duplicar datos.

## Estructura

```
src/
  Codigo.js        Backend (server-side). Único archivo .js: Apps Script lo ejecuta en la nube.
  Index.html       Frontend público (HTML Service).
  Admin.html       Panel de administración.
  EstiloBase.html  Design system compartido (se incluye con include()).
  IconoBase64.html Ícono embebido como data URI.
  appsscript.json  Manifest del proyecto.
scripts/
  deploy.mjs       Push + deploy conservando la URL a partir del segundo deploy.
tests/             Tests de lógica pura con Node.
```

> **Regla de oro de Apps Script**: el JavaScript del cliente **no puede vivir en un `.js`**. Todo archivo `.js` se ejecuta en el servidor. El código de navegador va dentro de archivos `.html` incluidos con `include()`.

## Setup

```bash
npm install
npx clasp login          # una vez por máquina
npm run open             # abre el editor de Apps Script
```

La API de Apps Script tiene que estar habilitada en <https://script.google.com/home/usersettings>.

Con el proyecto abierto en el editor, ejecutá una vez:

```text
sembrarDemo()
```

Autorizá los permisos cuando lo pida. Eso crea las hojas, la configuración, el catálogo y las reservas de ejemplo. Si preferís una hoja limpia, ejecutá `setup()` en su lugar.

## Desarrollo

```bash
npm run watch            # sube cada cambio al editor (~2 s)
npm run logs             # logs del servidor en vivo
npm run push             # push manual
npm run pull             # baja cambios hechos en la web
```

`npm run watch` actualiza el **editor**, no la URL pública. Para publicar hay que crear una versión y actualizar el deployment (ver abajo).

## Deploy (importante)

```bash
npm run deploy -- "confirmar reservas por WhatsApp"
```

El script hace `clasp push` y después `clasp deploy -i <deploymentId>`. El `-i` es **obligatorio** después de la primera publicación: sin él, `clasp deploy` crea un deployment nuevo con **otra URL** y el QR impreso deja de funcionar.

La primera vez dejá `DEPLOYMENT_ID` vacío en `scripts/deploy.mjs`: el script crea el deployment, te muestra el ID y lo pegás ahí para conservar la URL.

## Hojas requeridas

| Hoja | Columnas |
|---|---|
| `Config` | `clave`, `valor` |
| `Especialistas` | `id`, `nombre`, `foto_url`, `color`, `activo`, `orden` |
| `Servicios` | `id`, `nombre`, `duracion_minutos`, `precio`, `especialista_id`, `activo`, `descripcion` |
| `Horarios` | `especialista_id`, `dia_semana`, `hora_inicio`, `hora_fin`, `activo` |
| `Bloqueos` | `especialista_id`, `fecha_inicio`, `fecha_fin`, `hora_inicio`, `hora_fin` |
| `DiasEspeciales` | `id`, `fecha`, `abierto`, `hora_inicio`, `hora_fin`, `especialista_id`, `notas`, `activo` |
| `Reservas` | `id`, `codigo_reserva`, `fecha`, `hora_inicio`, `hora_fin`, `especialista_id`, `servicio_id`, `cliente_nombre`, `cliente_telefono`, `cliente_email`, `estado`, `notas`, `fecha_creacion`, `metodo_pago`, `beneficio_id`, `es_beneficio` |
| `Fidelidad` | `telefono`, `nombre`, `visitas_totales`, `visitas_desde_premio`, `premios_ganados`, `premios_canjeados`, `premio_disponible`, `ultima_visita` |
| `Beneficios` | `id`, `telefono`, `tipo`, `servicio_id`, `descripcion`, `estado`, `fecha_generado`, `fecha_canjeado`, `reserva_id` |

`DiasEspeciales` es opcional: si no existe, la disponibilidad usa el horario semanal normal. La hoja se crea automáticamente la primera vez que se guarda una regla desde el panel admin. Cada fila pisa el horario semanal para esa fecha (`abierto = FALSE` cierra el día; `abierto = TRUE` usa `hora_inicio`–`hora_fin`). Con `especialista_id = TODOS` aplica a todo el negocio; una regla de un especialista tiene prioridad sobre la global de la misma fecha.

`Bloqueos` se administra desde el panel (Configuración → Bloqueos): admite rangos de fechas, día completo o una franja horaria, y `TODOS` como alcance. Se restan de la disponibilidad después de aplicar el horario semanal o el día especial.

### Reportes, Dashboard y Configuración

La página **Reportes** calcula, para el período elegido: ingresos (solo reservas confirmadas y completadas), ticket promedio, ocupación estimada por especialista, servicios más pedidos y actividad diaria. La ocupación se estima como turnos no cancelados sobre la capacidad teórica del horario, usando la duración del servicio activo más corto; no descuenta la anticipación mínima porque también analiza fechas pasadas.

La página **Dashboard** muestra ingresos y turnos cobrados de **hoy**, de la **semana en curso** (lunes a hoy) y del **mes en curso** (día 1 a hoy), más el ranking de ingresos por especialista y los servicios más realizados del mes. Solo cuenta reservas `confirmada` o `completada`.

La página **Configuración** edita el nombre del negocio, la ubicación y las formas de pago del sitio público:

- **Efectivo en el local**: el cliente paga al llegar.
- **Pago por QR**: se sube una imagen del QR desde el panel. La imagen se redimensiona y comprime en el navegador (PNG/JPEG/WebP, menos de ~47.000 caracteres) y se guarda como data URL en `Config`. En la confirmación, el cliente ve el QR y las instrucciones, y envía el comprobante por WhatsApp al negocio. No hay pasarela de pago ni subida de archivos desde la webapp.

Si una instalación existente no tiene la columna `metodo_pago` en `Reservas`, agregala al final de la hoja. Las claves nuevas de `Config` se crean solas al guardar la configuración desde el panel.

Un servicio cuya duración supera el intervalo configurado (por ejemplo, 45 min con `intervalo_turnos_minutos = 30`) genera turnos cada 45 min, no cada 30: el paso es `max(intervalo, duración)` para que los turnos no se pisen.

Claves de `Config` usadas por el código: `negocio_nombre`, `negocio_whatsapp`, `negocio_direccion`, `moneda`, `zona_horaria`, `intervalo_turnos_minutos`, `anticipacion_minima_horas`, `dias_max_anticipacion`, `rubro_etiqueta_especialista`, `color_primario`, `color_secundario`, `color_acento`, `color_texto`, `mensaje_whatsapp_confirmacion`, `mensaje_whatsapp_cancelacion`, `pago_efectivo`, `pago_qr`, `pago_qr_imagen`, `pago_instrucciones`, `fidelidad_activa`, `fidelidad_visitas_meta`, `fidelidad_servicio_id`, `fidelidad_vigencia_dias`.

## Autenticación del admin

Las credenciales viven en **Propiedades del script** (Configuración del proyecto → Propiedades del script), nunca en el repo.

- `ADMIN_PIN` → login por PIN.
- `ADMIN_USER` + `ADMIN_PASS` → login usuario/clave.

Si no hay ninguna configurada, el panel muestra las instrucciones.

## Tests

```bash
npm test                 # lógica pura con mocks de las APIs de Apps Script
npm run check            # sintaxis del backend
```

## Gotchas conocidos

- **Timezone**: `Config.zona_horaria` manda: el código formatea fechas, horas y mensajes con esa zona. El manifest (`appsscript.json`) y la zona del Sheet idealmente deben coincidir; si no, las fechas que ve el usuario siguen siendo correctas, pero el editor y los logs usan la zona del manifest.
- **Caché**: Config y catálogos se cachean 60 s; disponibilidad 30 s. Las mutaciones desde el panel admin invalidan la caché automáticamente (`limpiarCacheTotal()`). Si editás el Sheet a mano, ejecutá `limpiarCacheTotal()` desde el editor.
- **Deploy viejo**: la URL pública sirve la última versión desplegada, no el código del editor. Si un cambio "no aparece", falta `npm run deploy`.
