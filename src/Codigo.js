/**
 * ============================================================================
 * SISTEMA DE AGENDA / RESERVAS — Backend (Code.gs)
 * Google Sheets como base de datos + Google Apps Script como backend/frontend.
 * Desplegado como Web App (doGet). 100% gratuito, sin dependencias externas.
 *
 * Estructura de hojas esperada en el Spreadsheet vinculado:
 *   Config | Especialistas | Servicios | Horarios | Bloqueos | Reservas
 *
 * Convención de nombres: las funciones que terminan en "_" son privadas
 * (uso interno). Ojo: en Apps Script eso es solo una convención — CUALQUIER
 * función de nivel superior es técnicamente invocable desde el cliente vía
 * google.script.run si alguien conoce su nombre. Por eso las funciones
 * administrativas (getReservasAdmin, confirmarReservaAdmin, etc.) validan un
 * token de sesión en su primera línea, no confían en que el cliente "no
 * debería" llamarlas.
 *
 * FIX zona horaria (aplicado): minutosDeFecha_ ahora SIEMPRE recibe y usa la
 * zona horaria explícita de Config (cfg.zona_horaria) en vez de depender de
 * .getHours()/.getMinutes() nativos de JS, que leen la zona horaria del
 * PROYECTO de Apps Script (Configuración del proyecto), no la del Sheet. Si
 * esas dos zonas no coincidían, cada hora leída desde Horarios/Reservas salía
 * corrida (por eso el desfase de "1h17m" en vez de un número de horas
 * redondo: las celdas de solo-hora se anclan al 30-dic-1899, y ahí los
 * husos horarios históricos no son múltiplos exactos de horas).
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// CONFIGURACIÓN GENERAL
// ----------------------------------------------------------------------------

var SHEET_NAMES = {
  CONFIG: 'Config',
  ESPECIALISTAS: 'Especialistas',
  SERVICIOS: 'Servicios',
  HORARIOS: 'Horarios',
  BLOQUEOS: 'Bloqueos',
  RESERVAS: 'Reservas',
  DIAS_ESPECIALES: 'DiasEspeciales',
  FIDELIDAD: 'Fidelidad',
  BENEFICIOS: 'Beneficios'
};

var HEADERS_DIAS_ESPECIALES = ['id', 'fecha', 'abierto', 'hora_inicio', 'hora_fin', 'especialista_id', 'notas', 'activo'];

// Estado por cliente (teléfono normalizado). Es una caché recalculable desde
// Reservas + Beneficios: si se desincroniza, `recalcularFidelidad_` la rehace.
var HEADERS_FIDELIDAD = [
  'telefono', 'nombre', 'visitas_totales', 'visitas_desde_premio',
  'premios_ganados', 'premios_canjeados', 'premio_disponible', 'ultima_visita'
];

// Un registro por premio generado. Es el ledger que impide duplicar premios.
var HEADERS_BENEFICIOS = [
  'id', 'telefono', 'tipo', 'servicio_id', 'descripcion', 'estado',
  'fecha_generado', 'fecha_canjeado', 'reserva_id'
];

/**
 * Estructura mínima que necesita la app. `setup()` la usa para crear las
 * hojas que falten y completar encabezados sin tocar los datos existentes.
 * Si agregás una columna nueva al backend, sumala acá.
 */
var HOJAS_REQUERIDAS = [
  { nombre: SHEET_NAMES.CONFIG, headers: ['clave', 'valor'] },
  { nombre: SHEET_NAMES.ESPECIALISTAS, headers: ['id', 'nombre', 'foto_url', 'color', 'activo', 'orden'] },
  { nombre: SHEET_NAMES.SERVICIOS, headers: ['id', 'nombre', 'duracion_minutos', 'precio', 'especialista_id', 'activo', 'descripcion'] },
  { nombre: SHEET_NAMES.HORARIOS, headers: ['especialista_id', 'dia_semana', 'hora_inicio', 'hora_fin', 'activo'] },
  { nombre: SHEET_NAMES.BLOQUEOS, headers: ['especialista_id', 'fecha_inicio', 'fecha_fin', 'hora_inicio', 'hora_fin'] },
  { nombre: SHEET_NAMES.RESERVAS, headers: ['id', 'codigo_reserva', 'fecha', 'hora_inicio', 'hora_fin', 'especialista_id', 'servicio_id', 'cliente_nombre', 'cliente_telefono', 'cliente_email', 'estado', 'notas', 'fecha_creacion', 'metodo_pago', 'beneficio_id', 'es_beneficio'] },
  { nombre: SHEET_NAMES.DIAS_ESPECIALES, headers: HEADERS_DIAS_ESPECIALES },
  { nombre: SHEET_NAMES.FIDELIDAD, headers: HEADERS_FIDELIDAD },
  { nombre: SHEET_NAMES.BENEFICIOS, headers: HEADERS_BENEFICIOS }
];

/**
 * Valores iniciales de Config. `setup()` solo agrega las claves que falten:
 * si una clave ya existe, no la pisa.
 */
var CONFIG_DEFAULT = {
  negocio_nombre: 'Studio Manicura',
  negocio_whatsapp: '70012345',
  negocio_direccion: 'Av. Las Palmas 456, entre 2do y 3er anillo · Santa Cruz de la Sierra',
  moneda: 'BOB',
  zona_horaria: 'America/La_Paz',
  intervalo_turnos_minutos: '30',
  anticipacion_minima_horas: '1',
  dias_max_anticipacion: '60',
  rubro_etiqueta_especialista: 'Manicurista',
  color_primario: '#4A1F3D',
  color_secundario: '#C9A227',
  color_acento: '#F4D6E4',
  color_texto: '#FFFFFF',
  mensaje_whatsapp_confirmacion: 'Hola {nombre}, tu turno de {servicio} con {especialista} quedó confirmado para el {fecha} a las {hora}. Te esperamos en {negocio}.',
  mensaje_whatsapp_cancelacion: 'Hola {nombre}, tu turno del {fecha} a las {hora} fue cancelado. Si querés reprogramarlo, escribinos.',
  pago_efectivo: 'TRUE',
  pago_qr: 'FALSE',
  pago_qr_imagen: '',
  pago_instrucciones: '',
  fidelidad_activa: 'FALSE',
  fidelidad_visitas_meta: '5',
  fidelidad_servicio_id: '',
  fidelidad_vigencia_dias: '0'
};

// Índice = Date.getDay() (0 = domingo ... 6 = sábado). Se usa en vez de
// Utilities.formatDate con locale para no depender del idioma configurado
// en el proyecto de Apps Script (por defecto suele quedar en inglés).
var DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
var MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

var CACHE_TTL_CONFIG = 60;      // 1 min
var CACHE_TTL_CATALOGO = 60;    // 1 min (Especialistas/Servicios/Horarios/Bloqueos)
var CACHE_TTL_DISPONIBILIDAD = 30; // 30 seg — corto porque cambia con cada reserva
var CACHE_TTL_TOKEN_ADMIN = 21600; // 6 horas de sesión de admin

// Freno de fuerza bruta para el login del panel. El contador es global al
// script: un atacante podría bloquear el acceso 5 minutos, pero sin IP real
// en Apps Script es preferible eso a permitir 10.000 intentos de PIN.
var MAX_INTENTOS_ADMIN = 6;
var BLOQUEO_ADMIN_SEGUNDOS = 300;

// ----------------------------------------------------------------------------
// PUNTO DE ENTRADA WEB APP
// ----------------------------------------------------------------------------

/**
 * Crea las hojas y la configuración por defecto si la planilla todavía no
 * fue inicializada. Devuelve `true` si preparó algo.
 *
 * Se llama desde `doGet`: así la primera visita (siempre de la cuenta dueña)
 * no falla por una hoja faltante. Solo estructura, nunca datos de demo.
 */
function asegurarEstructura_() {
  var ss = ss_();
  if (ss.getSheetByName(SHEET_NAMES.CONFIG)) return false;
  setup();
  return true;
}

function doGet(e) {
  var params = (e && e.parameter) || {};

  // Primera visita sobre una planilla recién creada: prepara la estructura
  // sola. No carga datos de demo (eso lo hace sembrarDemo()).
  asegurarEstructura_();

  // Ruta del manifest "PWA-lite" (ver README para limitaciones reales).
  if (params.manifest) {
    return construirManifest_();
  }

  var pagina = params.page === 'admin' ? 'admin' : 'reserva';
  var cfg = getConfig_();
  var scriptUrl = ScriptApp.getService().getUrl();
  var icono = obtenerIconoBase64_();

  var nombreTemplate = pagina === 'admin' ? 'Admin' : 'Index';
  var tmpl = HtmlService.createTemplateFromFile(nombreTemplate);
  tmpl.cfg = cfg;
  tmpl.scriptUrl = scriptUrl;
  tmpl.icono = icono;
  tmpl.adminAuthMode = pagina === 'admin' ? getAdminAuthMode_() : null;

  var titulo = cfg.negocio_nombre + (pagina === 'admin' ? ' · Admin' : '');

  // Sin maximum-scale: bloquear el zoom rompe la accesibilidad (WCAG 1.4.4).
  // Sin ALLOWALL: la app no necesita ser embebida en sitios de terceros y
  // habilitarlo expone el panel a clickjacking.
  var salida = tmpl.evaluate()
    .setTitle(titulo)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');

  return salida;
}

/** Incluye un archivo .html estático (sin scriptlets) dentro de otro template. */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function obtenerIconoBase64_() {
  try {
    return HtmlService.createHtmlOutputFromFile('IconoBase64').getContent().replace(/\s+/g, '');
  } catch (err) {
    return '';
  }
}

function construirManifest_() {
  var cfg = getConfig_();
  var icono = obtenerIconoBase64_();
  var scriptUrl = ScriptApp.getService().getUrl();
  var manifest = {
    name: cfg.negocio_nombre || 'Agenda de reservas',
    short_name: cfg.negocio_nombre || 'Agenda',
    start_url: scriptUrl,
    display: 'standalone',
    background_color: cfg.color_acento || '#E8DCC8',
    theme_color: cfg.color_primario || '#4A1F3D',
    icons: icono ? [
      { src: 'data:image/png;base64,' + icono, sizes: '512x512', type: 'image/png', purpose: 'any' }
    ] : []
  };
  return ContentService.createTextOutput(JSON.stringify(manifest))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------------------------------------------
// LECTURA GENÉRICA DE HOJAS
// ----------------------------------------------------------------------------

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(nombre) {
  var sh = ss_().getSheetByName(nombre);
  if (!sh) throw new Error('No existe la hoja "' + nombre + '". Revisa que el Sheet tenga todas las pestañas requeridas.');
  return sh;
}

/** Lee una hoja completa y la devuelve como array de objetos {encabezado: valor}. */
function readSheetAsObjects_(nombre) {
  var sh = sheet_(nombre);
  var valores = sh.getDataRange().getValues();
  if (valores.length < 2) return [];
  var headers = valores[0].map(function (h) { return String(h).trim(); });
  var out = [];
  for (var i = 1; i < valores.length; i++) {
    var fila = valores[i];
    var vacia = fila.every(function (c) { return c === '' || c === null; });
    if (vacia) continue;
    var obj = {};
    headers.forEach(function (h, idx) { obj[h] = fila[idx]; });
    obj.__row = i + 1; // fila real en la hoja (1-indexed, incluye encabezado)
    out.push(obj);
  }
  return out;
}

function parseBool_(v) {
  if (typeof v === 'boolean') return v;
  var s = String(v).trim().toUpperCase();
  return s === 'TRUE' || s === 'SI' || s === 'SÍ' || s === '1';
}

function indexarPorId_(arr) {
  var out = {};
  arr.forEach(function (item) { out[String(item.id)] = item; });
  return out;
}

/**
 * Escribe una fila nueva mapeando por NOMBRE de encabezado, no por posición.
 * Si alguien reordena las columnas del Sheet, esto sigue escribiendo bien.
 *
 * Además fuerza formato texto en las columnas que vienen del cliente: una
 * celda con "=HYPERLINK(...)" se evaluaría como fórmula (inyección de
 * fórmulas vía nombre, email o notas).
 */
function escribirFilaPorEncabezado_(nombreHoja, datos) {
  var sh = sheet_(nombreHoja);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  var fila = headers.map(function (h) {
    return Object.prototype.hasOwnProperty.call(datos, h) ? datos[h] : '';
  });

  var n = sh.getLastRow() + 1;
  // Formato texto: columnas de contacto conocidas (aunque vengan vacías) y
  // cualquier valor string (catálogos incluidos). Evita inyección de fórmulas.
  var colsContacto = ['cliente_nombre', 'cliente_telefono', 'cliente_email', 'notas'];
  headers.forEach(function (h, idx) {
    var valor = fila[idx];
    var esContacto = colsContacto.indexOf(h) > -1;
    var esTexto = typeof valor === 'string' && valor !== '';
    if (esContacto || esTexto) sh.getRange(n, idx + 1).setNumberFormat('@');
  });

  sh.getRange(n, 1, 1, headers.length).setValues([fila]);
  return n;
}

/** Valida que `row` sea una fila de datos real de Reservas (nunca el header). */
function validarFilaReserva_(row) {
  var n = Number(row);
  var ultima = sheet_(SHEET_NAMES.RESERVAS).getLastRow();
  if (!isFinite(n) || Math.floor(n) !== n || n < 2 || n > ultima) {
    throw new Error('Reserva inválida.');
  }
  return n;
}

/** Valida que `row` sea una fila de datos real de cualquier hoja. */
function validarFilaDeHoja_(nombreHoja, row) {
  var n = Number(row);
  var ultima = sheet_(nombreHoja).getLastRow();
  if (!isFinite(n) || Math.floor(n) !== n || n < 2 || n > ultima) {
    throw new Error('Fila inválida.');
  }
  return n;
}

/**
 * Actualiza una fila existente mapeando por NOMBRE de encabezado.
 * Fuerza formato texto en los valores string para evitar inyección de
 * fórmulas (=HYPERLINK(...), etc.) al editar desde el panel.
 */
function actualizarFilaPorEncabezado_(nombreHoja, row, datos) {
  var sh = sheet_(nombreHoja);
  row = validarFilaDeHoja_(nombreHoja, row);

  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });

  headers.forEach(function (h, idx) {
    if (!Object.prototype.hasOwnProperty.call(datos, h)) return;
    var valor = datos[h];
    if (typeof valor === 'string' && valor !== '') {
      sh.getRange(row, idx + 1).setNumberFormat('@');
    }
    sh.getRange(row, idx + 1).setValue(valor);
  });

  return row;
}

/**
 * Convierte una celda de fecha a "yyyy-MM-dd" sin depender de la zona del
 * proyecto. Acepta Date (celda numérica) o texto ISO (lo que escribe el panel).
 */
function fechaISODeCelda_(valor, zonaHoraria) {
  if (valor instanceof Date) return formatearFechaISO_(valor, zonaHoraria);
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(valor || '').trim());
  return m ? (m[1] + '-' + m[2] + '-' + m[3]) : '';
}

/**
 * Convierte una celda de fecha a Date SIN corrimiento de zona: un texto ISO se
 * interpreta como fecha de pared (mediodía local), no como medianoche UTC.
 * Necesario porque el seed y algunas cargas manuales dejan la celda como texto.
 */
function fechaDeCelda_(valor) {
  if (valor instanceof Date) return valor;
  var iso = fechaISODeCelda_(valor);
  return iso ? parsearFechaISO_(iso) : new Date(valor);
}

/** Normaliza una celda de hora (Date de solo-hora o texto) a "HH:mm". */
function horaHHMMDeCelda_(valor, zonaHoraria) {
  if (!valor) return '';
  var mins = minutosDeFecha_(valor, zonaHoraria);
  return mins == null ? '' : minutosAHHMM_(mins);
}

/** Crea la hoja DiasEspeciales si no existe (solo desde el panel admin). */
function asegurarHojaDiasEspeciales_() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET_NAMES.DIAS_ESPECIALES);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAMES.DIAS_ESPECIALES);
    sh.getRange(1, 1, 1, HEADERS_DIAS_ESPECIALES.length).setValues([HEADERS_DIAS_ESPECIALES]);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS_DIAS_ESPECIALES.length).setValues([HEADERS_DIAS_ESPECIALES]);
  }
  return sh;
}

// ----------------------------------------------------------------------------
// CONFIG / CATÁLOGOS (con caché corto para minimizar lecturas al Sheet)
// ----------------------------------------------------------------------------

function getConfig_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('cfg');
  if (cached) return JSON.parse(cached);

  var filas = readSheetAsObjects_(SHEET_NAMES.CONFIG);
  var cfg = {};
  filas.forEach(function (f) { cfg[f.clave] = f.valor; });

  cache.put('cfg', JSON.stringify(cfg), CACHE_TTL_CONFIG);
  return cfg;
}

function getEspecialistasActivos_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('especialistas');
  if (cached) return JSON.parse(cached);

  var filas = readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS)
    .filter(function (e) { return parseBool_(e.activo); })
    .sort(function (a, b) { return (Number(a.orden) || 0) - (Number(b.orden) || 0); })
    .map(function (e) {
      return { id: e.id, nombre: e.nombre, foto_url: e.foto_url || '', color: e.color || '' };
    });

  cache.put('especialistas', JSON.stringify(filas), CACHE_TTL_CATALOGO);
  return filas;
}

function getServiciosActivos_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('servicios');
  if (cached) return JSON.parse(cached);

  var filas = readSheetAsObjects_(SHEET_NAMES.SERVICIOS)
    .filter(function (s) { return parseBool_(s.activo); })
    .map(function (s) {
      return {
        id: s.id, nombre: s.nombre, duracion_minutos: Number(s.duracion_minutos),
        precio: Number(s.precio), especialista_id: String(s.especialista_id).trim(),
        descripcion: s.descripcion || ''
      };
    });

  cache.put('servicios', JSON.stringify(filas), CACHE_TTL_CATALOGO);
  return filas;
}

/**
 * Convierte de vuelta a Date un valor que salió de la caché (JSON.stringify
 * convierte los Date en texto ISO al guardarlos). Sin esto, las horas leídas
 * desde caché quedarían como string y romperían minutosDeFecha_().
 */
function reconstituirFecha_(valor) {
  if (typeof valor !== 'string') return valor;
  // La caché serializa los Date como ISO completo, pero las horas de la hoja
  // de Horarios ya son texto "HH:mm". `new Date('08:00')` es Invalid Date y
  // hacía que la capacidad de los reportes diera 0 al leer desde caché.
  if (/^\d{2}:\d{2}$/.test(valor)) return valor;
  return new Date(valor);
}

function getHorariosEspecialista_(especialistaId) {
  var cache = CacheService.getScriptCache();
  var claveCache = 'horarios_' + especialistaId;
  var cached = cache.get(claveCache);
  if (cached) {
    return JSON.parse(cached).map(function (h) {
      return { dia_semana: h.dia_semana, hora_inicio: reconstituirFecha_(h.hora_inicio), hora_fin: reconstituirFecha_(h.hora_fin) };
    });
  }

  var filas = readSheetAsObjects_(SHEET_NAMES.HORARIOS)
    .filter(function (h) { return String(h.especialista_id) === String(especialistaId) && parseBool_(h.activo); })
    .map(function (h) { return { dia_semana: h.dia_semana, hora_inicio: h.hora_inicio, hora_fin: h.hora_fin }; });

  cache.put(claveCache, JSON.stringify(filas), CACHE_TTL_CATALOGO);
  return filas;
}

function getBloqueosEspecialista_(especialistaId) {
  var cache = CacheService.getScriptCache();
  var claveCache = 'bloqueos_' + especialistaId;
  var cached = cache.get(claveCache);
  if (cached) return JSON.parse(cached);

  var cfg = getConfig_();
  var zona = cfg.zona_horaria || Session.getScriptTimeZone();

  // Fechas y horas se normalizan a texto igual que en DiasEspeciales. Así la
  // comparación no depende de si la celda vino como Date o como texto ISO
  // (new Date('2026-11-16') es medianoche UTC y en La Paz cae el día 15).
  var filas = readSheetAsObjects_(SHEET_NAMES.BLOQUEOS)
    .filter(function (b) {
      var esp = String(b.especialista_id).trim().toUpperCase();
      return esp === String(especialistaId).toUpperCase() || esp === 'TODOS';
    })
    .map(function (b) {
      return {
        especialista_id: b.especialista_id,
        fecha_inicio: fechaISODeCelda_(b.fecha_inicio, zona),
        fecha_fin: fechaISODeCelda_(b.fecha_fin, zona),
        hora_inicio: horaHHMMDeCelda_(b.hora_inicio, zona),
        hora_fin: horaHHMMDeCelda_(b.hora_fin, zona)
      };
    })
    .filter(function (b) { return !!b.fecha_inicio && !!b.fecha_fin; });

  cache.put(claveCache, JSON.stringify(filas), CACHE_TTL_CATALOGO);
  return filas;
}

/**
 * Reglas de días especiales activas, normalizadas. La hoja es opcional: si no
 * existe todavía (instalación nueva), devuelve [] y la disponibilidad usa el
 * horario semanal normal.
 */
function getDiasEspeciales_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('dias_especiales');
  if (cached) return JSON.parse(cached);

  var ss = ss_();
  if (!ss.getSheetByName(SHEET_NAMES.DIAS_ESPECIALES)) {
    cache.put('dias_especiales', '[]', CACHE_TTL_CATALOGO);
    return [];
  }

  var cfg = getConfig_();
  var zona = cfg.zona_horaria || Session.getScriptTimeZone();

  var filas = readSheetAsObjects_(SHEET_NAMES.DIAS_ESPECIALES)
    .filter(function (d) { return parseBool_(d.activo); })
    .map(function (d) {
      return {
        id: Number(d.id) || 0,
        __row: d.__row,
        fechaISO: fechaISODeCelda_(d.fecha, zona),
        abierto: parseBool_(d.abierto),
        hora_inicio: horaHHMMDeCelda_(d.hora_inicio, zona),
        hora_fin: horaHHMMDeCelda_(d.hora_fin, zona),
        especialista_id: String(d.especialista_id || 'TODOS').trim() || 'TODOS',
        notas: d.notas || ''
      };
    })
    .filter(function (d) { return !!d.fechaISO; })
    .sort(function (a, b) { return (a.id - b.id) || (a.__row - b.__row); });

  cache.put('dias_especiales', JSON.stringify(filas), CACHE_TTL_CATALOGO);
  return filas;
}

/** Reglas que aplican a un especialista: las suyas y las globales ("TODOS"). */
function getDiasEspecialesParaEspecialista_(especialistaId) {
  var id = String(especialistaId).toUpperCase();
  return getDiasEspeciales_().filter(function (r) {
    var esp = String(r.especialista_id || 'TODOS').toUpperCase();
    return esp === 'TODOS' || esp === id;
  });
}

/**
 * Devuelve la regla que gana para una fecha:
 * 1) la específica del especialista pisa a la global "TODOS";
 * 2) si hay varias del mismo alcance, gana la última creada.
 */
function reglaDiaEspecialPara_(reglas, fechaISO, especialistaId) {
  var delDia = (reglas || []).filter(function (r) { return r.fechaISO === fechaISO; });
  if (!delDia.length) return null;

  var propias = delDia.filter(function (r) {
    return String(r.especialista_id || 'TODOS').toUpperCase() !== 'TODOS' &&
      String(r.especialista_id) === String(especialistaId);
  });
  var elegidas = propias.length ? propias : delDia.filter(function (r) {
    return String(r.especialista_id || 'TODOS').toUpperCase() === 'TODOS';
  });
  if (!elegidas.length) return null;

  elegidas.sort(function (a, b) { return (a.id - b.id) || (a.__row - b.__row); });
  return elegidas[elegidas.length - 1];
}

function getDuracionServicio_(servicioId) {
  var servicio = getServiciosActivos_().filter(function (s) { return String(s.id) === String(servicioId); })[0];
  if (!servicio) throw new Error('El servicio seleccionado ya no está disponible.');
  return servicio.duracion_minutos;
}

/** Único punto de entrada para cargar la página pública: 1 sola llamada. */
function obtenerDatosIniciales() {
  var cfg = getConfig_();
  var especialistas = getEspecialistasActivos_();

  var idsActivos = {};
  especialistas.forEach(function (e) { idsActivos[String(e.id)] = true; });

  // Un servicio asignado a un especialista inactivo deja al cliente en un
  // paso 2 vacío, sin forma de continuar. Se oculta desde el origen.
  var servicios = getServiciosActivos_().filter(function (s) {
    var idEsp = String(s.especialista_id || 'TODOS').trim();
    return idEsp.toUpperCase() === 'TODOS' || idsActivos[idEsp];
  });

  return {
    cfg: cfg,
    especialistas: especialistas,
    servicios: servicios
  };
}

// ----------------------------------------------------------------------------
// DISPONIBILIDAD: horario - bloqueos - reservas
// ----------------------------------------------------------------------------

/**
 * FIX: ahora recibe zonaHoraria explícita y la usa vía Utilities.formatDate
 * en vez de .getHours()/.getMinutes() nativos (que dependen de la zona
 * horaria del PROYECTO de Apps Script, no de la del Sheet/Config).
 */
function minutosDeFecha_(valorHora, zonaHoraria) {
  if (!valorHora) return null;
  if (valorHora instanceof Date) {
    var zona = zonaHoraria || Session.getScriptTimeZone();
    var hhmm = Utilities.formatDate(valorHora, zona, 'HH:mm');
    var p = hhmm.split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }
  // Por si llega como texto "HH:MM"
  var partes = String(valorHora).split(':');
  return (Number(partes[0]) || 0) * 60 + (Number(partes[1]) || 0);
}

function minutosAHHMM_(mins) {
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function formatearFechaISO_(fecha, zonaHoraria) {
  // Fallback a la zona del proyecto, no a una ciudad hardcodeada: si Config
  // no define zona_horaria, al menos usa la misma que el resto del runtime.
  return Utilities.formatDate(fecha, zonaHoraria || Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatearFechaBonita_(fecha, zonaHoraria) {
  // No usa getDay()/getDate() nativos: esos dependen de la zona del proyecto
  // de Apps Script, que puede no coincidir con la del negocio.
  var zona = zonaHoraria || Session.getScriptTimeZone();
  var ymd = Utilities.formatDate(fecha, zona, 'yyyy-MM-dd').split('-');
  var anio = Number(ymd[0]);
  var mes = Number(ymd[1]) - 1;
  var dia = Number(ymd[2]);
  var diaSemana = new Date(Date.UTC(anio, mes, dia)).getUTCDay();
  return DIAS_SEMANA[diaSemana].toLowerCase() + ' ' + dia + ' de ' + MESES_LARGOS[mes];
}

/**
 * Resta un intervalo [bi, bf] (minutos) de un bloque {inicio, fin}.
 * Devuelve un array con 0, 1 o 2 bloques resultantes.
 */
function restarIntervalo_(bloque, bi, bf) {
  if (bf <= bloque.inicio || bi >= bloque.fin) return [bloque]; // no se tocan
  var resultado = [];
  if (bi > bloque.inicio) resultado.push({ inicio: bloque.inicio, fin: Math.min(bi, bloque.fin) });
  if (bf < bloque.fin) resultado.push({ inicio: Math.max(bf, bloque.inicio), fin: bloque.fin });
  return resultado;
}

/**
 * Calcula los horarios de inicio disponibles ("HH:MM") para un especialista
 * en una fecha concreta, cruzando Horarios - Bloqueos - Reservas.
 *
 * FIX: recibe `zonaHoraria` y, opcionalmente, las reglas de días especiales
 * del especialista. Un día especial pisa por completo el horario semanal:
 * puede cerrar el día o abrirlo con un horario propio (ej. un domingo).
 */
function calcularSlotsDelDia_(fecha, horariosEsp, bloqueosEsp, reservasEsp, duracionMin, intervaloMin, ahora, minAnticipacionMs, zonaHoraria, reglasEspeciales, especialistaId) {
  var fechaISO = formatearFechaISO_(fecha, zonaHoraria);
  var regla = reglaDiaEspecialPara_(reglasEspeciales || [], fechaISO, especialistaId);
  var bloques;

  if (regla) {
    if (!regla.abierto) return []; // cierre puntual
    var ini = minutosDeFecha_(regla.hora_inicio, zonaHoraria);
    var fin = minutosDeFecha_(regla.hora_fin, zonaHoraria);
    if (ini == null || fin == null || fin <= ini) return [];
    bloques = [{ inicio: ini, fin: fin }];
  } else {
    var diaSemana = DIAS_SEMANA[fecha.getDay()];
    bloques = horariosEsp
      .filter(function (h) { return h.dia_semana === diaSemana; })
      .map(function (h) {
        return { inicio: minutosDeFecha_(h.hora_inicio, zonaHoraria), fin: minutosDeFecha_(h.hora_fin, zonaHoraria) };
      });

    if (bloques.length === 0) return [];
  }

  // Aplicar bloqueos que caen sobre esta fecha.
  bloqueosEsp.forEach(function (b) {
    if (fechaISO < b.fecha_inicio || fechaISO > b.fecha_fin) return; // no aplica a este día

    if (!b.hora_inicio || !b.hora_fin) {
      bloques = []; // bloqueo de día completo
      return;
    }
    var bi = minutosDeFecha_(b.hora_inicio, zonaHoraria);
    var bf = minutosDeFecha_(b.hora_fin, zonaHoraria);
    var nuevos = [];
    bloques.forEach(function (bl) { nuevos = nuevos.concat(restarIntervalo_(bl, bi, bf)); });
    bloques = nuevos;
  });

  if (bloques.length === 0) return [];

  // Generar candidatos cada `paso` minutos. Si el servicio dura más que el
  // intervalo configurado (ej. servicio de 45 min con intervalo de 30), el paso
  // debe ser la duración: de lo contrario se ofrecen dos turnos que se pisan
  // entre sí (10:00 y 10:30 para un servicio que termina 10:45).
  var paso = Math.max(Number(intervaloMin) || 0, Number(duracionMin) || 0);
  if (!paso) paso = 30;
  var candidatos = [];
  bloques.forEach(function (bl) {
    for (var t = bl.inicio; t + duracionMin <= bl.fin; t += paso) {
      candidatos.push(t);
    }
  });

  // Descartar los que chocan con reservas existentes (no canceladas).
  var ocupados = reservasEsp.map(function (r) {
    return { inicio: minutosDeFecha_(r.hora_inicio, zonaHoraria), fin: minutosDeFecha_(r.hora_fin, zonaHoraria) };
  });
  candidatos = candidatos.filter(function (t) {
    var finCandidato = t + duracionMin;
    return !ocupados.some(function (o) { return t < o.fin && finCandidato > o.inicio; });
  });

  // Descartar los que no cumplen la anticipación mínima (solo relevante si `fecha` es hoy/cercana).
  if (minAnticipacionMs > 0) {
    var zona = zonaHoraria || Session.getScriptTimeZone();
    var fechaISO = Utilities.formatDate(fecha, zona, 'yyyy-MM-dd');
    candidatos = candidatos.filter(function (t) {
      // parseDate interpreta la hora de pared en la zona del negocio y
      // devuelve el instante real. setHours() usaba la zona del proyecto.
      var momento = Utilities.parseDate(fechaISO + ' ' + minutosAHHMM_(t), zona, 'yyyy-MM-dd HH:mm');
      return momento.getTime() - ahora.getTime() >= minAnticipacionMs;
    });
  }

  return candidatos.sort(function (a, b) { return a - b; }).map(minutosAHHMM_);
}

/**
 * Devuelve, para todo un mes, un mapa { "yyyy-MM-dd": ["10:00","10:30",...] }.
 * UNA sola llamada desde el cliente cubre tanto pintar el calendario (días con
 * disponibilidad) como listar las horas de cualquier día que el usuario toque,
 * sin llamadas adicionales a google.script.run.
 */
function obtenerMesDisponibilidad(especialistaId, servicioId, anio, mes) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'disp_' + especialistaId + '_' + servicioId + '_' + anio + '_' + mes;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var cfg = getConfig_();
  var duracion = getDuracionServicio_(servicioId);
  var intervalo = Number(cfg.intervalo_turnos_minutos) || 30;
  var minAnticipacionMs = (Number(cfg.anticipacion_minima_horas) || 0) * 3600 * 1000;
  var maxDiasAnticipacion = Number(cfg.dias_max_anticipacion) || 60;

  var horariosEsp = getHorariosEspecialista_(especialistaId);
  var bloqueosEsp = getBloqueosEspecialista_(especialistaId);
  var reglasEsp = getDiasEspecialesParaEspecialista_(especialistaId);
  var reservasEsp = readSheetAsObjects_(SHEET_NAMES.RESERVAS)
    .filter(function (r) { return String(r.especialista_id) === String(especialistaId) && r.estado !== 'cancelada'; });

  var ahora = new Date();
  var hoyISO = formatearFechaISO_(ahora, cfg.zona_horaria);
  var maxFecha = new Date(ahora.getTime() + maxDiasAnticipacion * 86400000);

  // Se agrupan las reservas por fecha UNA sola vez (en vez de recorrer y
  // reformatear todas las reservas del especialista en cada uno de los ~30
  // días del mes, que es lo que hacía esto lento a medida que se acumulan
  // reservas).
  var reservasPorFecha = {};
  reservasEsp.forEach(function (r) {
    var k = fechaISODeCelda_(r.fecha, cfg.zona_horaria);
    (reservasPorFecha[k] = reservasPorFecha[k] || []).push(r);
  });

  var diasEnMes = new Date(anio, mes, 0).getDate();
  var resultado = {};

  for (var d = 1; d <= diasEnMes; d++) {
    var fecha = new Date(anio, mes - 1, d, 12, 0, 0); // mediodía para evitar líos de horario de verano
    var key = formatearFechaISO_(fecha, cfg.zona_horaria);

    if (key < hoyISO || fecha > maxFecha) {
      resultado[key] = [];
      continue;
    }

    resultado[key] = calcularSlotsDelDia_(
      fecha, horariosEsp, bloqueosEsp, reservasPorFecha[key] || [], duracion, intervalo, ahora, minAnticipacionMs, cfg.zona_horaria, reglasEsp, especialistaId
    );
  }

  cache.put(cacheKey, JSON.stringify(resultado), CACHE_TTL_DISPONIBILIDAD);
  return resultado;
}

function invalidarCacheDisponibilidad_(especialistaId, fecha, zonaHoraria) {
  var cache = CacheService.getScriptCache();
  // El año/mes de la clave se armó con la zona del negocio; usar
  // getFullYear()/getMonth() acá podía apuntar a otro mes en los bordes.
  var zona = zonaHoraria || Session.getScriptTimeZone();
  var anio = Number(Utilities.formatDate(fecha, zona, 'yyyy'));
  var mes = Number(Utilities.formatDate(fecha, zona, 'M'));
  // Servicios activos: invalidamos la combinación real usada + un comodín simple
  // recorriendo todos los servicios (son pocos, es barato).
  getServiciosActivos_().forEach(function (s) {
    cache.remove('disp_' + especialistaId + '_' + s.id + '_' + anio + '_' + mes);
  });
}

// ----------------------------------------------------------------------------
// CREAR RESERVA (flujo público)
// ----------------------------------------------------------------------------

function validarDatosReserva_(datos) {
  if (!datos) throw new Error('Faltan datos de la reserva.');
  if (!datos.especialistaId) throw new Error('Falta seleccionar especialista.');
  if (!datos.servicioId) throw new Error('Falta seleccionar servicio.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha || '')) throw new Error('Fecha inválida.');
  if (!/^\d{2}:\d{2}$/.test(datos.hora || '')) throw new Error('Hora inválida.');
  if (!datos.nombre || String(datos.nombre).trim().length < 2) throw new Error('Ingresa tu nombre.');
  var telefonoLimpio = String(datos.telefono || '').replace(/[^\d]/g, '');
  if (telefonoLimpio.length < 8) throw new Error('Ingresa un teléfono válido.');
  var metodoPago = String(datos.metodoPago || '').trim();
  if (metodoPago && ['efectivo', 'qr'].indexOf(metodoPago) === -1) {
    throw new Error('Forma de pago inválida.');
  }
}

function parsearFechaISO_(fechaStr) {
  var partes = fechaStr.split('-');
  return new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]), 12, 0, 0);
}

function generarCodigoReserva_(id) {
  var idStr = String(id);
  var relleno = idStr.length < 4 ? ('0000' + idStr).slice(-4) : idStr;
  return 'RES-' + relleno;
}

function obtenerSiguienteId_(sh) {
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var colId = headers.indexOf('id') + 1;
  if (colId === 0) colId = 1; // compatibilidad con hojas viejas sin encabezado "id"

  var ultima = sh.getLastRow();
  if (ultima < 2) return 1;

  var valores = sh.getRange(2, colId, ultima - 1, 1).getValues();
  var maxId = 0;
  valores.forEach(function (fila) {
    var n = Number(fila[0]);
    if (!isNaN(n) && n > maxId) maxId = n;
  });
  return maxId + 1;
}

/**
 * Crea una reserva. Se llama desde el flujo público (Index.html).
 * Vuelve a validar disponibilidad en el servidor (no confía en el caché que
 * ya tenía el cliente) y usa LockService para evitar reservas duplicadas si
 * dos personas confirman el mismo horario al mismo tiempo.
 */
function crearReserva(datos) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return { ok: false, error: 'El sistema está ocupado, intenta de nuevo en unos segundos.' };
  }

  try {
    validarDatosReserva_(datos);

    var cfg = getConfig_();

    var servicio = getServiciosActivos_().filter(function (s) { return String(s.id) === String(datos.servicioId); })[0];
    if (!servicio) {
      return { ok: false, error: 'El servicio seleccionado ya no está disponible.' };
    }

    // El servicio puede estar atado a un especialista puntual ("TODOS" = cualquiera).
    var especialistaIdServicio = String(servicio.especialista_id || 'TODOS').trim();
    if (especialistaIdServicio.toUpperCase() !== 'TODOS' &&
        especialistaIdServicio !== String(datos.especialistaId).trim()) {
      return { ok: false, error: 'El especialista seleccionado no ofrece ese servicio.' };
    }

    var especialista = getEspecialistasActivos_().filter(function (e) { return String(e.id) === String(datos.especialistaId); })[0];
    if (!especialista) {
      return { ok: false, error: 'El especialista seleccionado ya no está disponible.' };
    }

    // Premio de fidelidad: se valida contra el teléfono que está reservando,
    // no contra el que mande el cliente en un campo aparte. Así un beneficio
    // ajeno no se puede aplicar cambiando solo el id.
    var fid = getFidelidadConfig_(cfg);
    var beneficio = null;
    var beneficioSolicitado = String(datos.beneficioId == null ? '' : datos.beneficioId).trim();
    if (beneficioSolicitado) {
      if (!fid.activa) return { ok: false, error: 'El programa de fidelidad no está activo.' };

      asegurarHojasFidelidad_();
      var telReserva = normalizarTelefono_(datos.telefono);
      beneficio = readSheetAsObjects_(SHEET_NAMES.BENEFICIOS).filter(function (b) {
        return String(b.id) === beneficioSolicitado &&
          normalizarTelefono_(b.telefono) === telReserva &&
          String(b.estado || '').trim().toLowerCase() === 'disponible';
      })[0];

      if (!beneficio) {
        return { ok: false, error: 'Ese premio ya no está disponible. Actualizá la página y volvé a intentar.' };
      }
      if (!beneficio.servicio_id || String(beneficio.servicio_id) !== String(datos.servicioId)) {
        return { ok: false, error: 'El premio solo se puede usar con el servicio configurado.' };
      }
    }

    // La anticipación máxima se validaba solo al pintar el calendario; un
    // request manual podía reservar fuera de rango.
    var maxDias = Number(cfg.dias_max_anticipacion) || 60;
    var hoyISO = formatearFechaISO_(new Date(), cfg.zona_horaria);
    var maxISO = formatearFechaISO_(new Date(Date.now() + maxDias * 86400000), cfg.zona_horaria);
    if (datos.fecha < hoyISO || datos.fecha > maxISO) {
      return { ok: false, error: 'La fecha está fuera del rango de reservas permitido.' };
    }

    var duracion = servicio.duracion_minutos;
    var fecha = parsearFechaISO_(datos.fecha);
    var intervalo = Number(cfg.intervalo_turnos_minutos) || 30;
    var minAnticipacionMs = (Number(cfg.anticipacion_minima_horas) || 0) * 3600 * 1000;

    var horariosEsp = getHorariosEspecialista_(datos.especialistaId);
    var bloqueosEsp = getBloqueosEspecialista_(datos.especialistaId);
    var reglasEsp = getDiasEspecialesParaEspecialista_(datos.especialistaId);
    var reservasEsp = readSheetAsObjects_(SHEET_NAMES.RESERVAS)
      .filter(function (r) {
        return String(r.especialista_id) === String(datos.especialistaId) &&
          r.estado !== 'cancelada' &&
          fechaISODeCelda_(r.fecha, cfg.zona_horaria) === datos.fecha;
      });

    var slotsLibres = calcularSlotsDelDia_(
      fecha, horariosEsp, bloqueosEsp, reservasEsp, duracion, intervalo, new Date(), minAnticipacionMs, cfg.zona_horaria, reglasEsp, datos.especialistaId
    );
    if (slotsLibres.indexOf(datos.hora) === -1) {
      return { ok: false, error: 'Ese horario ya no está disponible. Por favor elige otro.' };
    }

    // parseDate interpreta la hora de pared en la zona del negocio. Con
    // new Date(fecha).setHours() la hora se interpretaba en la zona del
    // proyecto (manifest), que puede no ser la misma.
    var horaInicioDate = Utilities.parseDate(datos.fecha + ' ' + datos.hora, cfg.zona_horaria, 'yyyy-MM-dd HH:mm');
    var horaFinDate = new Date(horaInicioDate.getTime() + duracion * 60000);
    var fechaReservaDate = Utilities.parseDate(datos.fecha, cfg.zona_horaria, 'yyyy-MM-dd');

    var sh = sheet_(SHEET_NAMES.RESERVAS);
    var nuevoId = obtenerSiguienteId_(sh);
    var codigo = generarCodigoReserva_(nuevoId);

    escribirFilaPorEncabezado_(SHEET_NAMES.RESERVAS, {
      id: nuevoId,
      codigo_reserva: codigo,
      fecha: fechaReservaDate,
      hora_inicio: horaInicioDate,
      hora_fin: horaFinDate,
      especialista_id: datos.especialistaId,
      servicio_id: datos.servicioId,
      cliente_nombre: String(datos.nombre).trim(),
      cliente_telefono: String(datos.telefono).replace(/[^\d]/g, ''),
      cliente_email: datos.email ? String(datos.email).trim() : '',
      estado: 'pendiente',
      notas: datos.notas ? String(datos.notas).trim() : '',
      metodo_pago: datos.metodoPago ? String(datos.metodoPago).trim() : '',
      fecha_creacion: new Date(),
      beneficio_id: beneficio ? beneficio.id : '',
      es_beneficio: beneficio ? 'TRUE' : 'FALSE'
    });

    if (beneficio) {
      actualizarFilaPorEncabezado_(SHEET_NAMES.BENEFICIOS, beneficio.__row, {
        estado: 'reservado',
        reserva_id: nuevoId
      });
    }

    invalidarCacheDisponibilidad_(datos.especialistaId, fechaReservaDate, cfg.zona_horaria);

    return {
      ok: true,
      codigoReserva: codigo,
      metodoPago: datos.metodoPago || '',
      resumen: {
        servicio: servicio.nombre,
        especialista: especialista.nombre,
        fecha: formatearFechaBonita_(fechaReservaDate, cfg.zona_horaria),
        hora: datos.hora,
        precio: beneficio ? 0 : servicio.precio,
        esBeneficio: !!beneficio
      },
      negocioWhatsapp: cfg.negocio_whatsapp || ''
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------------------
// FIDELIDAD: tarjeta de visitas y premios
// ----------------------------------------------------------------------------

function normalizarTelefono_(telefono) {
  return String(telefono == null ? '' : telefono).replace(/\D/g, '');
}

/** Lee y normaliza las reglas del programa. No decide si está activo. */
function getFidelidadConfig_(cfg) {
  cfg = cfg || getConfig_();
  var meta = Math.round(Number(cfg.fidelidad_visitas_meta) || 5);
  if (meta < 2) meta = 2;
  if (meta > 50) meta = 50;

  var vigencia = Math.round(Number(cfg.fidelidad_vigencia_dias) || 0);
  if (vigencia < 0) vigencia = 0;
  if (vigencia > 365) vigencia = 365;

  return {
    activa: parseBool_(cfg.fidelidad_activa),
    meta: meta,
    servicioId: String(cfg.fidelidad_servicio_id == null ? '' : cfg.fidelidad_servicio_id).trim(),
    vigenciaDias: vigencia
  };
}

function asegurarHojaConHeaders_(ss, nombre, headers) {
  var sh = ss.getSheetByName(nombre);
  if (!sh) {
    sh = ss.insertSheet(nombre);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sh;
}

/** Crea Fidelidad y Beneficios si faltan, sin depender de haber corrido setup(). */
function asegurarHojasFidelidad_() {
  var ss = ss_();
  asegurarHojaConHeaders_(ss, SHEET_NAMES.FIDELIDAD, HEADERS_FIDELIDAD);
  asegurarHojaConHeaders_(ss, SHEET_NAMES.BENEFICIOS, HEADERS_BENEFICIOS);

  // Instalaciones anteriores a la fidelidad no tienen estas dos columnas en
  // Reservas. Se agregan al final si faltan, sin tocar los datos existentes.
  var shReservas = ss.getSheetByName(SHEET_NAMES.RESERVAS);
  if (shReservas) asegurarHeaders_(shReservas, ['beneficio_id', 'es_beneficio']);
}

/**
 * Recalcula el estado de fidelidad desde las reservas completadas.
 *
 * Es idempotente a propósito: no incrementa contadores a ciegas. Si el admin
 * completa, descompleta y vuelve a completar la misma reserva, el número de
 * visitas no se infla. Además, cada premio generado queda registrado en
 * Beneficios, así que recalcular no duplica premios.
 *
 * - `telefono` vacío: recalcula a todos los clientes con actividad.
 * - `telefono` concreto: recalcula solo ese cliente (lo usa el panel y la web).
 *
 * Solo cuentan reservas `completada`. Las reservas de beneficio (`es_beneficio`)
 * no suman sellos: el servicio de premio es un regalo, no una visita comprada.
 */
function recalcularFidelidad_(telefono) {
  // La generación de premios se serializa: dos consultas simultáneas del mismo
  // teléfono no pueden ver "0 premios" y crear cada una el suyo.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    throw new Error('El sistema está ocupado, intenta de nuevo en unos segundos.');
  }

  try {
    return recalcularFidelidadSinLock_(telefono);
  } finally {
    lock.releaseLock();
  }
}

function recalcularFidelidadSinLock_(telefono) {
  var cfg = getConfig_();
  var fid = getFidelidadConfig_(cfg);
  if (!fid.activa) return null;

  var zona = cfg.zona_horaria || Session.getScriptTimeZone();
  var hoyISO = formatearFechaISO_(new Date(), zona);
  var telFiltro = telefono == null ? '' : normalizarTelefono_(telefono);
  if (telefono != null && !telFiltro) return null;

  asegurarHojasFidelidad_();

  var servicios = indexarPorId_(readSheetAsObjects_(SHEET_NAMES.SERVICIOS));
  var premioSrv = fid.servicioId ? (servicios[fid.servicioId] || {}) : {};
  var nombrePremio = String(premioSrv.nombre || '').trim() || 'Premio de fidelidad';

  // 1) Visitas completadas por teléfono (sin contar beneficios).
  var visitasPorTel = {};
  readSheetAsObjects_(SHEET_NAMES.RESERVAS).forEach(function (r) {
    if (String(r.estado || '').trim().toLowerCase() !== 'completada') return;
    if (parseBool_(r.es_beneficio)) return;

    var tel = normalizarTelefono_(r.cliente_telefono);
    if (!tel) return;
    if (telFiltro && tel !== telFiltro) return;

    if (!visitasPorTel[tel]) visitasPorTel[tel] = { visitas: 0, ultima: '', nombre: '' };
    var d = visitasPorTel[tel];
    d.visitas++;

    var iso = fechaISODeCelda_(r.fecha, zona);
    if (iso && iso > d.ultima) d.ultima = iso;
    var nombre = String(r.cliente_nombre || '').trim();
    if (nombre) d.nombre = nombre;
  });

  // Un teléfono consultado sin visitas igual necesita devolver un estado
  // (tarjeta en cero). No se persiste fila: la hoja solo guarda clientes con
  // historial real o premios generados.
  if (telFiltro && !visitasPorTel[telFiltro]) {
    visitasPorTel[telFiltro] = { visitas: 0, ultima: '', nombre: '' };
  }

  // 2) Premios ya generados por teléfono.
  var beneficiosPorTel = {};
  readSheetAsObjects_(SHEET_NAMES.BENEFICIOS).forEach(function (b) {
    var tel = normalizarTelefono_(b.telefono);
    if (!tel) return;
    if (telFiltro && tel !== telFiltro) return;
    if (!beneficiosPorTel[tel]) beneficiosPorTel[tel] = [];
    beneficiosPorTel[tel].push(b);
  });

  // 3) Estado actual de Fidelidad (para actualizar sin duplicar filas).
  var filasFid = {};
  readSheetAsObjects_(SHEET_NAMES.FIDELIDAD).forEach(function (f) {
    var tel = normalizarTelefono_(f.telefono);
    if (tel) filasFid[tel] = f;
  });

  var shBen = sheet_(SHEET_NAMES.BENEFICIOS);
  var siguienteId = obtenerSiguienteId_(shBen);
  var resultado = {};

  Object.keys(visitasPorTel).forEach(function (tel) {
    var datos = visitasPorTel[tel];
    var lista = beneficiosPorTel[tel] || [];

    // Vencimiento opcional: solo aplica a premios todavía disponibles.
    if (fid.vigenciaDias > 0) {
      var hoyMs = parsearFechaISO_(hoyISO).getTime();
      lista.forEach(function (b) {
        if (String(b.estado || '').trim().toLowerCase() !== 'disponible') return;
        var genISO = fechaISODeCelda_(b.fecha_generado, zona);
        if (!genISO) return;
        var limite = parsearFechaISO_(genISO).getTime() + fid.vigenciaDias * 86400000;
        if (hoyMs > limite) {
          actualizarFilaPorEncabezado_(SHEET_NAMES.BENEFICIOS, b.__row, { estado: 'vencido' });
          b.estado = 'vencido';
        }
      });
    }

    // 4) Generar los premios que correspondan a las visitas acumuladas.
    var deberiaTener = Math.floor(datos.visitas / fid.meta);
    while (lista.length < deberiaTener) {
      var nuevo = {
        id: siguienteId++,
        telefono: tel,
        tipo: 'servicio',
        servicio_id: fid.servicioId,
        descripcion: nombrePremio,
        estado: 'disponible',
        fecha_generado: new Date(),
        fecha_canjeado: '',
        reserva_id: ''
      };
      nuevo.__row = escribirFilaPorEncabezado_(SHEET_NAMES.BENEFICIOS, nuevo);
      lista.push(nuevo);
    }

    var premio = null;
    var canjeados = 0;
    lista.forEach(function (b) {
      var estadoBen = String(b.estado || '').trim().toLowerCase();
      if (estadoBen === 'canjeado') canjeados++;
      if (!premio && estadoBen === 'disponible') premio = b;
    });

    var visitasDesde = datos.visitas % fid.meta;
    var filaFid = filasFid[tel] || null;
    var valores = {
      telefono: tel,
      nombre: datos.nombre || (filaFid && filaFid.nombre) || '',
      visitas_totales: datos.visitas,
      visitas_desde_premio: visitasDesde,
      premios_ganados: lista.length,
      premios_canjeados: canjeados,
      premio_disponible: premio ? 'TRUE' : 'FALSE',
      ultima_visita: datos.ultima || ''
    };

    if (filaFid) {
      var cambio = false;
      Object.keys(valores).forEach(function (k) {
        if (String(filaFid[k] == null ? '' : filaFid[k]) !== String(valores[k])) cambio = true;
      });
      if (cambio) actualizarFilaPorEncabezado_(SHEET_NAMES.FIDELIDAD, filaFid.__row, valores);
    } else if (datos.visitas > 0 || lista.length > 0) {
      // No se persisten consultas de teléfonos sin historial: evita llenar la
      // hoja con números que solo miraron la agenda.
      escribirFilaPorEncabezado_(SHEET_NAMES.FIDELIDAD, valores);
    }

    resultado[tel] = {
      telefono: tel,
      nombre: valores.nombre,
      visitasTotales: datos.visitas,
      visitasDesdePremio: visitasDesde,
      meta: fid.meta,
      faltan: premio ? 0 : (fid.meta - visitasDesde),
      premioDisponible: !!premio,
      beneficioId: premio ? premio.id : '',
      premioServicioId: fid.servicioId,
      premioServicioNombre: String(premioSrv.nombre || '').trim(),
      premioDescripcion: premio ? String(premio.descripcion || nombrePremio) : nombrePremio,
      premiosGanados: lista.length,
      premiosCanjeados: canjeados,
      ultimaVisita: datos.ultima || ''
    };
  });

  return telFiltro ? (resultado[telFiltro] || null) : resultado;
}

/**
 * Consulta pública: la usa la agenda al ingresar el teléfono. Devuelve solo lo
 * necesario para mostrar el progreso y ofrecer el premio.
 */
function consultarFidelidad(telefono) {
  try {
    var tel = normalizarTelefono_(telefono);
    if (tel.length < 8) return { ok: false, error: 'Ingresá un WhatsApp válido.' };

    var fid = getFidelidadConfig_();
    if (!fid.activa) return { ok: true, activa: false };

    var estado = recalcularFidelidad_(tel);
    if (!estado) return { ok: true, activa: false };

    // La respuesta pública no expone el nombre del cliente: con solo conocer
    // un teléfono no se debe poder obtener el dato de otra persona.
    var publico = {};
    Object.keys(estado).forEach(function (k) {
      if (k !== 'nombre') publico[k] = estado[k];
    });
    publico.ok = true;
    publico.activa = true;
    return publico;
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Vista del programa para el panel: un estado por cliente. */
function getFidelidadAdmin(token) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    var fid = getFidelidadConfig_();
    if (!fid.activa) return { ok: true, activa: false, meta: fid.meta, estados: [] };

    var mapa = recalcularFidelidad_() || {};
    var estados = Object.keys(mapa).map(function (tel) { return mapa[tel]; });
    estados.sort(function (a, b) {
      return String(b.ultimaVisita || '').localeCompare(String(a.ultimaVisita || '')) ||
        String(a.nombre || '').localeCompare(String(b.nombre || ''));
    });

    return { ok: true, activa: true, meta: fid.meta, estados: estados };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Canje de mostrador: el cliente viene sin reservar y el admin entrega el
 * premio. Marca el beneficio disponible como canjeado y recalcula la tarjeta.
 */
function canjearBeneficioAdmin(token, telefono) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    var tel = normalizarTelefono_(telefono);
    if (!tel) throw new Error('El cliente no tiene un teléfono válido.');
    if (!getFidelidadConfig_().activa) throw new Error('El programa de fidelidad está desactivado.');

    var estado = recalcularFidelidad_(tel);
    if (!estado || !estado.premioDisponible) throw new Error('Este cliente no tiene un premio disponible.');

    var beneficio = readSheetAsObjects_(SHEET_NAMES.BENEFICIOS).filter(function (b) {
      return normalizarTelefono_(b.telefono) === tel &&
        String(b.estado || '').trim().toLowerCase() === 'disponible';
    })[0];
    if (!beneficio) throw new Error('Este cliente no tiene un premio disponible.');

    actualizarFilaPorEncabezado_(SHEET_NAMES.BENEFICIOS, beneficio.__row, {
      estado: 'canjeado',
      fecha_canjeado: new Date()
    });

    return { ok: true, fidelidad: recalcularFidelidad_(tel) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Función manual para el editor de Apps Script: recalcula la tarjeta de todos
 * los clientes. Útil después de activar el programa en una instalación que ya
 * tenía reservas completadas.
 */
function recalcularFidelidadAhora() {
  var resumen = recalcularFidelidad_() || {};
  Logger.log(JSON.stringify(resumen));
  return resumen;
}

// ----------------------------------------------------------------------------
// AUTENTICACIÓN ADMIN (PIN o usuario/clave — vive en Script Properties)
// ----------------------------------------------------------------------------

function getAdminAuthMode_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_PIN')) return 'pin';
  if (props.getProperty('ADMIN_USER') && props.getProperty('ADMIN_PASS')) return 'userpass';
  return 'sin_configurar';
}

function iniciarSesionAdmin(credenciales) {
  var props = PropertiesService.getScriptProperties();
  var cache = CacheService.getScriptCache();
  var modo = getAdminAuthMode_();

  if (modo === 'sin_configurar') {
    return { ok: false, error: 'El acceso de administrador no está configurado. Ve a Configuración del proyecto > Propiedades del script y agrega ADMIN_PIN (o ADMIN_USER + ADMIN_PASS).' };
  }

  var intentos = Number(cache.get('admin_intentos') || 0);
  if (intentos >= MAX_INTENTOS_ADMIN) {
    return { ok: false, error: 'Demasiados intentos fallidos. Espera unos minutos y volvé a probar.' };
  }

  var ok = false;
  if (modo === 'pin') {
    ok = !!(credenciales && String(credenciales.pin || '').trim() === String(props.getProperty('ADMIN_PIN')));
  } else if (modo === 'userpass') {
    ok = !!(credenciales &&
      credenciales.usuario === props.getProperty('ADMIN_USER') &&
      credenciales.clave === props.getProperty('ADMIN_PASS'));
  }

  if (!ok) {
    cache.put('admin_intentos', String(intentos + 1), BLOQUEO_ADMIN_SEGUNDOS);
    return { ok: false, error: 'Credenciales incorrectas.' };
  }

  cache.remove('admin_intentos');

  var token = Utilities.getUuid();
  cache.put('admin_token_' + token, '1', CACHE_TTL_TOKEN_ADMIN);
  return { ok: true, token: token };
}

function cerrarSesionAdmin(token) {
  if (token) CacheService.getScriptCache().remove('admin_token_' + token);
  return { ok: true };
}

function validarToken_(token) {
  return !!token && CacheService.getScriptCache().get('admin_token_' + token) === '1';
}

// ----------------------------------------------------------------------------
// PANEL ADMIN: listar y actualizar reservas
// ----------------------------------------------------------------------------

function getReservasAdmin(token) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada. Vuelve a iniciar sesión.' };

  var cfg = getConfig_();
  var especialistas = indexarPorId_(readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS));
  var servicios = indexarPorId_(readSheetAsObjects_(SHEET_NAMES.SERVICIOS));

  var reservas = readSheetAsObjects_(SHEET_NAMES.RESERVAS).map(function (r) {
    var esBeneficio = parseBool_(r.es_beneficio);
    return {
      row: r.__row,
      id: Number(r.id) || 0,
      codigo: r.codigo_reserva,
      fecha: fechaISODeCelda_(r.fecha, cfg.zona_horaria),
      fechaBonita: formatearFechaBonita_(fechaDeCelda_(r.fecha), cfg.zona_horaria),
      horaInicio: minutosAHHMM_(minutosDeFecha_(r.hora_inicio, cfg.zona_horaria)),
      horaFin: minutosAHHMM_(minutosDeFecha_(r.hora_fin, cfg.zona_horaria)),
      especialistaId: r.especialista_id,
      especialista: (especialistas[r.especialista_id] || {}).nombre || '—',
      servicioId: r.servicio_id,
      servicio: (servicios[r.servicio_id] || {}).nombre || '—',
      precio: esBeneficio ? 0 : (Number((servicios[r.servicio_id] || {}).precio) || 0),
      cliente: r.cliente_nombre,
      telefono: r.cliente_telefono,
      email: r.cliente_email,
      estado: r.estado,
      notas: r.notas,
      metodoPago: r.metodo_pago || '',
      esBeneficio: esBeneficio,
      beneficioId: r.beneficio_id || ''
    };
  });

  // Las reservas ingresadas/registradas más recientemente van primero. Se
  // ordena por "id" (siempre sube de a uno) y no por fecha_creacion: esa
  // fecha depende de la zona horaria configurada en el Sheet (un ajuste
  // aparte del proyecto de Apps Script) y datos de ejemplo cargados sin la
  // hora exacta pueden terminar "pareciendo" más recientes de lo que son.
  // El id nunca tiene ese problema.
  reservas.sort(function (a, b) { return b.id - a.id; });

  return { ok: true, reservas: reservas, etiquetaEspecialista: cfg.rubro_etiqueta_especialista || 'Especialista', moneda: cfg.moneda || '' };
}

// ----------------------------------------------------------------------------
// PANEL ADMIN: catálogos (servicios, especialistas, horarios, días especiales)
// ----------------------------------------------------------------------------

function getCatalogosAdmin(token) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada. Vuelve a iniciar sesión.' };

  var cfg = getConfig_();
  var zona = cfg.zona_horaria || Session.getScriptTimeZone();
  asegurarHojaDiasEspeciales_();

  var especialistas = readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS).map(function (e) {
    return {
      row: e.__row,
      id: Number(e.id) || 0,
      nombre: String(e.nombre || '').trim(),
      foto_url: e.foto_url || '',
      color: e.color || '',
      orden: Number(e.orden) || 0,
      activo: parseBool_(e.activo)
    };
  }).sort(function (a, b) {
    return (a.orden - b.orden) || a.nombre.localeCompare(b.nombre);
  });

  var espPorId = {};
  especialistas.forEach(function (e) { espPorId[String(e.id)] = e; });

  function nombreEspecialista_(id) {
    var s = String(id || 'TODOS').trim();
    if (!s || s.toUpperCase() === 'TODOS') return 'Todos';
    return (espPorId[s] || {}).nombre || '—';
  }

  var servicios = readSheetAsObjects_(SHEET_NAMES.SERVICIOS).map(function (s) {
    var espId = String(s.especialista_id || 'TODOS').trim() || 'TODOS';
    return {
      row: s.__row,
      id: Number(s.id) || 0,
      nombre: String(s.nombre || '').trim(),
      duracion_minutos: Number(s.duracion_minutos) || 0,
      precio: Number(s.precio) || 0,
      especialista_id: espId,
      especialista: nombreEspecialista_(espId),
      descripcion: s.descripcion || '',
      activo: parseBool_(s.activo)
    };
  }).sort(function (a, b) { return a.id - b.id; });

  var horarios = readSheetAsObjects_(SHEET_NAMES.HORARIOS).map(function (h) {
    var espId = String(h.especialista_id || '').trim();
    return {
      row: h.__row,
      especialista_id: espId,
      especialista: nombreEspecialista_(espId),
      dia_semana: String(h.dia_semana || '').trim(),
      hora_inicio: horaHHMMDeCelda_(h.hora_inicio, zona),
      hora_fin: horaHHMMDeCelda_(h.hora_fin, zona),
      activo: parseBool_(h.activo)
    };
  }).filter(function (h) {
    return h.especialista_id && h.hora_inicio && h.hora_fin;
  }).sort(function (a, b) {
    var oa = Number((espPorId[a.especialista_id] || {}).orden) || 0;
    var ob = Number((espPorId[b.especialista_id] || {}).orden) || 0;
    if (oa !== ob) return oa - ob;
    var da = DIAS_SEMANA.indexOf(a.dia_semana);
    var db = DIAS_SEMANA.indexOf(b.dia_semana);
    if (da !== db) return da - db;
    return String(a.hora_inicio).localeCompare(String(b.hora_inicio));
  });

  var dias = readSheetAsObjects_(SHEET_NAMES.DIAS_ESPECIALES).map(function (d) {
    var espId = String(d.especialista_id || 'TODOS').trim() || 'TODOS';
    var fechaISO = fechaISODeCelda_(d.fecha, zona);
    var bonita = '';
    if (fechaISO) {
      try {
        bonita = formatearFechaBonita_(Utilities.parseDate(fechaISO, zona, 'yyyy-MM-dd'), zona);
      } catch (e) { bonita = fechaISO; }
    }
    return {
      row: d.__row,
      id: Number(d.id) || 0,
      fechaISO: fechaISO,
      fechaBonita: bonita,
      abierto: parseBool_(d.abierto),
      hora_inicio: horaHHMMDeCelda_(d.hora_inicio, zona),
      hora_fin: horaHHMMDeCelda_(d.hora_fin, zona),
      especialista_id: espId,
      especialista: nombreEspecialista_(espId),
      notas: d.notas || '',
      activo: parseBool_(d.activo)
    };
  }).filter(function (d) { return !!d.fechaISO; })
    .sort(function (a, b) {
      if (a.fechaISO !== b.fechaISO) return a.fechaISO < b.fechaISO ? -1 : 1;
      return (a.id - b.id) || (a.row - b.row);
    });

  // Bloqueos: la hoja no tiene id ni activo; se crean, editan y eliminan.
  var bloqueos = [];
  if (ss_().getSheetByName(SHEET_NAMES.BLOQUEOS)) {
    bloqueos = readSheetAsObjects_(SHEET_NAMES.BLOQUEOS).map(function (b) {
      var espId = String(b.especialista_id || 'TODOS').trim() || 'TODOS';
      var inicioISO = fechaISODeCelda_(b.fecha_inicio, zona);
      var finISO = fechaISODeCelda_(b.fecha_fin, zona);
      var inicioBonita = '';
      var finBonita = '';
      try {
        if (inicioISO) inicioBonita = formatearFechaBonita_(Utilities.parseDate(inicioISO, zona, 'yyyy-MM-dd'), zona);
        if (finISO) finBonita = formatearFechaBonita_(Utilities.parseDate(finISO, zona, 'yyyy-MM-dd'), zona);
      } catch (e) {
        inicioBonita = inicioISO;
        finBonita = finISO;
      }
      return {
        row: b.__row,
        especialista_id: espId,
        especialista: nombreEspecialista_(espId),
        fecha_inicio: inicioISO,
        fecha_fin: finISO,
        fecha_inicioBonita: inicioBonita,
        fecha_finBonita: finBonita,
        todo_el_dia: !b.hora_inicio || !b.hora_fin,
        hora_inicio: horaHHMMDeCelda_(b.hora_inicio, zona),
        hora_fin: horaHHMMDeCelda_(b.hora_fin, zona)
      };
    }).filter(function (b) {
      return !!b.fecha_inicio && !!b.fecha_fin;
    }).sort(function (a, b) {
      if (a.fecha_inicio !== b.fecha_inicio) return a.fecha_inicio < b.fecha_inicio ? -1 : 1;
      return a.row - b.row;
    });
  }

  return {
    ok: true,
    zona: zona,
    moneda: cfg.moneda || '',
    especialistas: especialistas,
    servicios: servicios,
    horarios: horarios,
    dias: dias,
    bloqueos: bloqueos
  };
}

function validarHoraHHMM_(valor) {
  var s = String(valor || '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error('Hora inválida (usá HH:mm).');
  return s;
}

function validarFechaISO_(valor) {
  var s = String(valor || '').trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('Fecha inválida.');
  var y = Number(m[1]);
  var mo = Number(m[2]);
  var d = Number(m[3]);
  var prueba = new Date(Date.UTC(y, mo - 1, d));
  if (prueba.getUTCFullYear() !== y || prueba.getUTCMonth() !== mo - 1 || prueba.getUTCDate() !== d) {
    throw new Error('Fecha inválida.');
  }
  return s;
}

function especialistaExiste_(especialistaId) {
  var id = String(especialistaId || '').trim();
  if (!id || id.toUpperCase() === 'TODOS') return true;
  return readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS).some(function (e) {
    return String(e.id) === id;
  });
}

function guardarServicioAdmin(token, datos) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    datos = datos || {};
    var nombre = String(datos.nombre || '').trim();
    if (nombre.length < 2) throw new Error('El nombre del servicio es obligatorio.');

    var duracion = Math.round(Number(datos.duracion_minutos));
    if (!isFinite(duracion) || duracion < 5 || duracion > 480) {
      throw new Error('La duración debe estar entre 5 y 480 minutos.');
    }

    var precio = Number(datos.precio);
    if (!isFinite(precio) || precio < 0) throw new Error('El precio no puede ser negativo.');
    precio = Math.round(precio * 100) / 100;

    var espId = String(datos.especialista_id || 'TODOS').trim() || 'TODOS';
    if (espId.toUpperCase() !== 'TODOS' && !especialistaExiste_(espId)) {
      throw new Error('El especialista seleccionado no existe.');
    }

    var payload = {
      nombre: nombre,
      duracion_minutos: duracion,
      precio: precio,
      especialista_id: espId,
      descripcion: String(datos.descripcion || '').trim(),
      activo: datos.activo ? 'TRUE' : 'FALSE'
    };

    var sh = sheet_(SHEET_NAMES.SERVICIOS);
    var row = datos.row ? validarFilaDeHoja_(SHEET_NAMES.SERVICIOS, datos.row) : 0;
    var id = Number(datos.id) || 0;

    if (row) {
      actualizarFilaPorEncabezado_(SHEET_NAMES.SERVICIOS, row, payload);
      if (!id) {
        var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
          .map(function (h) { return String(h).trim(); });
        id = Number(sh.getRange(row, headers.indexOf('id') + 1).getValue()) || 0;
      }
    } else {
      id = obtenerSiguienteId_(sh);
      payload.id = id;
      escribirFilaPorEncabezado_(SHEET_NAMES.SERVICIOS, payload);
    }

    limpiarCacheTotal();
    return { ok: true, id: id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function guardarEspecialistaAdmin(token, datos) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    datos = datos || {};
    var nombre = String(datos.nombre || '').trim();
    if (nombre.length < 2) throw new Error('El nombre del especialista es obligatorio.');

    var orden = Math.round(Number(datos.orden));
    if (!isFinite(orden) || orden < 0) orden = 0;

    var color = String(datos.color || '').trim();
    if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) throw new Error('Color inválido (usá #RRGGBB).');

    var foto = String(datos.foto_url || '').trim();
    if (foto && !/^(https?:\/\/|data:image\/)/i.test(foto)) {
      throw new Error('La foto debe ser una URL http(s) o data:image.');
    }

    var payload = {
      nombre: nombre,
      foto_url: foto,
      color: color,
      orden: orden,
      activo: datos.activo ? 'TRUE' : 'FALSE'
    };

    var sh = sheet_(SHEET_NAMES.ESPECIALISTAS);
    var row = datos.row ? validarFilaDeHoja_(SHEET_NAMES.ESPECIALISTAS, datos.row) : 0;
    var id = Number(datos.id) || 0;

    if (row) {
      actualizarFilaPorEncabezado_(SHEET_NAMES.ESPECIALISTAS, row, payload);
      if (!id) {
        var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
          .map(function (h) { return String(h).trim(); });
        id = Number(sh.getRange(row, headers.indexOf('id') + 1).getValue()) || 0;
      }
    } else {
      id = obtenerSiguienteId_(sh);
      payload.id = id;
      escribirFilaPorEncabezado_(SHEET_NAMES.ESPECIALISTAS, payload);
    }

    limpiarCacheTotal();
    return { ok: true, id: id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function guardarHorarioAdmin(token, datos) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    datos = datos || {};
    var espId = String(datos.especialista_id || '').trim();
    if (!espId || espId.toUpperCase() === 'TODOS' || !especialistaExiste_(espId)) {
      throw new Error('Elegí un especialista válido.');
    }

    var dia = String(datos.dia_semana || '').trim();
    if (DIAS_SEMANA.indexOf(dia) === -1) throw new Error('Día de la semana inválido.');

    var inicio = validarHoraHHMM_(datos.hora_inicio);
    var fin = validarHoraHHMM_(datos.hora_fin);
    if (fin <= inicio) throw new Error('La hora de fin debe ser posterior a la de inicio.');

    var payload = {
      especialista_id: espId,
      dia_semana: dia,
      hora_inicio: inicio,
      hora_fin: fin,
      activo: datos.activo ? 'TRUE' : 'FALSE'
    };

    var row = datos.row ? validarFilaDeHoja_(SHEET_NAMES.HORARIOS, datos.row) : 0;
    if (row) actualizarFilaPorEncabezado_(SHEET_NAMES.HORARIOS, row, payload);
    else escribirFilaPorEncabezado_(SHEET_NAMES.HORARIOS, payload);

    limpiarCacheTotal();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function guardarDiaEspecialAdmin(token, datos) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    datos = datos || {};
    var fecha = validarFechaISO_(datos.fecha);
    var abierto = !!datos.abierto;
    var inicio = '';
    var fin = '';

    if (abierto) {
      inicio = validarHoraHHMM_(datos.hora_inicio);
      fin = validarHoraHHMM_(datos.hora_fin);
      if (fin <= inicio) throw new Error('La hora de fin debe ser posterior a la de inicio.');
    }

    var espId = String(datos.especialista_id || 'TODOS').trim() || 'TODOS';
    if (espId.toUpperCase() !== 'TODOS' && !especialistaExiste_(espId)) {
      throw new Error('El especialista seleccionado no existe.');
    }

    var sh = asegurarHojaDiasEspeciales_();
    var row = datos.row ? validarFilaDeHoja_(SHEET_NAMES.DIAS_ESPECIALES, datos.row) : 0;
    var zona = getConfig_().zona_horaria || Session.getScriptTimeZone();

    var duplicado = readSheetAsObjects_(SHEET_NAMES.DIAS_ESPECIALES).some(function (d) {
      if (row && Number(d.__row) === row) return false;
      return fechaISODeCelda_(d.fecha, zona) === fecha &&
        String(d.especialista_id || 'TODOS').trim().toUpperCase() === espId.toUpperCase();
    });
    if (duplicado) throw new Error('Ya existe una regla para esa fecha y especialista.');

    var payload = {
      fecha: fecha,
      abierto: abierto ? 'TRUE' : 'FALSE',
      hora_inicio: inicio,
      hora_fin: fin,
      especialista_id: espId,
      notas: String(datos.notas || '').trim(),
      activo: datos.activo === false ? 'FALSE' : 'TRUE'
    };

    if (row) {
      actualizarFilaPorEncabezado_(SHEET_NAMES.DIAS_ESPECIALES, row, payload);
    } else {
      payload.id = obtenerSiguienteId_(sh);
      escribirFilaPorEncabezado_(SHEET_NAMES.DIAS_ESPECIALES, payload);
    }

    limpiarCacheTotal();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function guardarBloqueoAdmin(token, datos) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    datos = datos || {};

    var espId = String(datos.especialista_id || 'TODOS').trim() || 'TODOS';
    if (espId.toUpperCase() !== 'TODOS' && !especialistaExiste_(espId)) {
      throw new Error('El especialista seleccionado no existe.');
    }

    var fechaInicio = validarFechaISO_(datos.fecha_inicio);
    var fechaFin = validarFechaISO_(datos.fecha_fin || datos.fecha_inicio);
    if (fechaFin < fechaInicio) {
      throw new Error('La fecha final no puede ser anterior a la inicial.');
    }

    var todoElDia = datos.todo_el_dia === true ||
      (!String(datos.hora_inicio || '').trim() && !String(datos.hora_fin || '').trim());
    var horaInicio = '';
    var horaFin = '';

    if (!todoElDia) {
      horaInicio = validarHoraHHMM_(datos.hora_inicio);
      horaFin = validarHoraHHMM_(datos.hora_fin);
      if (horaFin <= horaInicio) throw new Error('La hora de fin debe ser posterior a la de inicio.');
    }

    var payload = {
      especialista_id: espId,
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      hora_inicio: horaInicio,
      hora_fin: horaFin
    };

    var row = datos.row ? validarFilaDeHoja_(SHEET_NAMES.BLOQUEOS, datos.row) : 0;
    if (row) actualizarFilaPorEncabezado_(SHEET_NAMES.BLOQUEOS, row, payload);
    else escribirFilaPorEncabezado_(SHEET_NAMES.BLOQUEOS, payload);

    limpiarCacheTotal();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function cambiarActivoCatalogoAdmin(token, tipo, row, activo) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    var mapa = {
      servicio: SHEET_NAMES.SERVICIOS,
      especialista: SHEET_NAMES.ESPECIALISTAS,
      horario: SHEET_NAMES.HORARIOS,
      dia: SHEET_NAMES.DIAS_ESPECIALES
    };
    var nombreHoja = mapa[String(tipo || '')];
    if (!nombreHoja) throw new Error('Tipo de catálogo inválido.');

    row = validarFilaDeHoja_(nombreHoja, row);
    var sh = sheet_(nombreHoja);
    var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).trim(); });
    var colActivo = headers.indexOf('activo') + 1;
    if (colActivo === 0) throw new Error('La hoja no tiene columna "activo".');

    sh.getRange(row, colActivo).setValue(activo ? 'TRUE' : 'FALSE');
    limpiarCacheTotal();
    return { ok: true, activo: !!activo };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function eliminarCatalogoAdmin(token, tipo, row) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    if (tipo !== 'horario' && tipo !== 'dia' && tipo !== 'bloqueo') {
      throw new Error('Este catálogo no se elimina: desactivalo en su lugar.');
    }
    var nombreHoja = tipo === 'horario' ? SHEET_NAMES.HORARIOS
      : tipo === 'dia' ? SHEET_NAMES.DIAS_ESPECIALES
      : SHEET_NAMES.BLOQUEOS;
    row = validarFilaDeHoja_(nombreHoja, row);
    sheet_(nombreHoja).deleteRow(row);
    limpiarCacheTotal();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ----------------------------------------------------------------------------
// PANEL ADMIN: reportes de operación
// ----------------------------------------------------------------------------

var ESTADOS_CON_INGRESO = ['confirmada', 'completada'];

/** Días ISO entre dos fechas inclusive, sin depender de la zona del proyecto. */
function diasISOEnRango_(desdeISO, hastaISO) {
  var p1 = desdeISO.split('-');
  var p2 = hastaISO.split('-');
  var cursor = Date.UTC(Number(p1[0]), Number(p1[1]) - 1, Number(p1[2]));
  var fin = Date.UTC(Number(p2[0]), Number(p2[1]) - 1, Number(p2[2]));
  var out = [];
  while (cursor <= fin) {
    var d = new Date(cursor);
    var y = d.getUTCFullYear();
    var m = ('0' + (d.getUTCMonth() + 1)).slice(-2);
    var dia = ('0' + d.getUTCDate()).slice(-2);
    out.push({ iso: y + '-' + m + '-' + dia, anio: y, mes: Number(m), dia: Number(d.getUTCDate()) });
    cursor += 86400000;
  }
  return out;
}

/**
 * Reportes del período: ingresos, turnos, ticket promedio, ocupación por
 * especialista y ranking de servicios. La ocupación es una estimación:
 * turnos no cancelados sobre la capacidad teórica del horario (con el
 * servicio más corto activo), sin descontar la anticipación mínima porque
 * el reporte también mira fechas pasadas.
 */
function getReportesAdmin(token, desde, hasta) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    var cfg = getConfig_();
    var zona = cfg.zona_horaria || Session.getScriptTimeZone();
    var hoyISO = formatearFechaISO_(new Date(), zona);

    if (!desde) desde = hoyISO.slice(0, 7) + '-01';
    if (!hasta) hasta = hoyISO;

    desde = validarFechaISO_(desde);
    hasta = validarFechaISO_(hasta);
    if (hasta < desde) throw new Error('La fecha final no puede ser anterior a la inicial.');

    var dias = diasISOEnRango_(desde, hasta);
    if (dias.length > 366) throw new Error('El período no puede superar los 366 días.');

    var especialistas = readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS);
    var nombresEsp = {};
    especialistas.forEach(function (e) { nombresEsp[String(e.id)] = String(e.nombre || '').trim(); });

    var servicios = readSheetAsObjects_(SHEET_NAMES.SERVICIOS);
    var srvPorId = indexarPorId_(servicios);

    var reservas = readSheetAsObjects_(SHEET_NAMES.RESERVAS).map(function (r) {
      var srv = srvPorId[String(r.servicio_id)] || {};
      return {
        fechaISO: fechaISODeCelda_(r.fecha, zona),
        especialistaId: String(r.especialista_id || '').trim(),
        estado: String(r.estado || '').trim().toLowerCase(),
        precio: Number(srv.precio) || 0,
        nombreServicio: String(srv.nombre || 'Servicio eliminado').trim(),
        esBeneficio: parseBool_(r.es_beneficio)
      };
    }).filter(function (r) {
      return r.fechaISO && r.fechaISO >= desde && r.fechaISO <= hasta;
    });

    var resumen = {
      total: reservas.length,
      pendientes: 0,
      confirmadas: 0,
      completadas: 0,
      canceladas: 0,
      beneficios: 0,
      ingresos: 0,
      turnosAtendidos: 0,
      ticketPromedio: 0
    };

    var porEspecialista = {};
    var porServicio = {};
    var porDia = {};

    dias.forEach(function (d) {
      porDia[d.iso] = { fechaISO: d.iso, turnos: 0, ingresos: 0 };
    });

    reservas.forEach(function (r) {
      if (r.estado === 'pendiente') resumen.pendientes++;
      else if (r.estado === 'confirmada') resumen.confirmadas++;
      else if (r.estado === 'completada') resumen.completadas++;
      else if (r.estado === 'cancelada') resumen.canceladas++;

      var dia = porDia[r.fechaISO];
      if (dia && r.estado !== 'cancelada') dia.turnos++;

      var kEsp = r.especialistaId || '—';
      if (!porEspecialista[kEsp]) {
        porEspecialista[kEsp] = {
          id: kEsp,
          nombre: nombresEsp[kEsp] || 'Especialista eliminado',
          turnos: 0,
          ocupados: 0,
          ingresos: 0
        };
      }
      if (r.estado !== 'cancelada') porEspecialista[kEsp].ocupados++;

      // Un beneficio ocupa turno (por eso cuenta en ocupación), pero no genera
      // ingresos ni entra en el ticket promedio.
      if (r.esBeneficio) {
        if (r.estado === 'completada') resumen.beneficios++;
        return;
      }

      if (ESTADOS_CON_INGRESO.indexOf(r.estado) === -1) return;

      resumen.ingresos += r.precio;
      resumen.turnosAtendidos++;

      porEspecialista[kEsp].turnos++;
      porEspecialista[kEsp].ingresos += r.precio;

      if (!porServicio[r.nombreServicio]) {
        porServicio[r.nombreServicio] = { nombre: r.nombreServicio, turnos: 0, ingresos: 0 };
      }
      porServicio[r.nombreServicio].turnos++;
      porServicio[r.nombreServicio].ingresos += r.precio;

      if (dia) dia.ingresos += r.precio;
    });

    resumen.ingresos = Math.round(resumen.ingresos * 100) / 100;
    resumen.ticketPromedio = resumen.turnosAtendidos
      ? Math.round(resumen.ingresos / resumen.turnosAtendidos * 100) / 100
      : 0;

    // Capacidad teórica del período por especialista.
    var duracionBase = 0;
    servicios.forEach(function (s) {
      if (!parseBool_(s.activo)) return;
      var d = Number(s.duracion_minutos) || 0;
      if (d > 0 && (!duracionBase || d < duracionBase)) duracionBase = d;
    });
    var intervalo = Number(cfg.intervalo_turnos_minutos) || 30;
    if (!duracionBase) duracionBase = intervalo;

    var ids = especialistas.map(function (e) { return String(e.id); });
    Object.keys(porEspecialista).forEach(function (id) {
      if (ids.indexOf(id) === -1) ids.push(id);
    });

    var ahora = new Date();
    var totalCapacidad = 0;
    var totalOcupados = 0;

    var filasEsp = ids.map(function (id) {
      var horarios = getHorariosEspecialista_(id);
      var bloqueos = getBloqueosEspecialista_(id);
      var reglas = getDiasEspecialesParaEspecialista_(id);
      var capacidad = 0;

      dias.forEach(function (d) {
        var fecha = new Date(d.anio, d.mes - 1, d.dia, 12, 0, 0);
        capacidad += calcularSlotsDelDia_(
          fecha, horarios, bloqueos, [], duracionBase, intervalo,
          ahora, 0, zona, reglas, id
        ).length;
      });

      var datos = porEspecialista[id] || { turnos: 0, ocupados: 0, ingresos: 0 };
      totalCapacidad += capacidad;
      totalOcupados += datos.ocupados;

      return {
        id: id,
        nombre: nombresEsp[id] || 'Especialista eliminado',
        turnos: datos.turnos,
        ocupados: datos.ocupados,
        capacidad: capacidad,
        ocupacion: capacidad > 0 ? Math.round(datos.ocupados / capacidad * 100) : 0,
        ingresos: Math.round(datos.ingresos * 100) / 100
      };
    }).filter(function (e) {
      return e.capacidad > 0 || e.ocupados > 0;
    }).sort(function (a, b) {
      return (b.ingresos - a.ingresos) || (b.turnos - a.turnos);
    });

    var filasServicio = Object.keys(porServicio).map(function (k) {
      var s = porServicio[k];
      return { nombre: s.nombre, turnos: s.turnos, ingresos: Math.round(s.ingresos * 100) / 100 };
    }).sort(function (a, b) {
      return (b.turnos - a.turnos) || (b.ingresos - a.ingresos);
    });

    return {
      ok: true,
      desde: desde,
      hasta: hasta,
      moneda: cfg.moneda || '',
      duracionBase: duracionBase,
      resumen: Object.assign({}, resumen, {
        ocupacion: totalCapacidad > 0 ? Math.round(totalOcupados / totalCapacidad * 100) : 0
      }),
      porEspecialista: filasEsp,
      porServicio: filasServicio,
      porDia: dias.map(function (d) { return porDia[d.iso]; })
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ----------------------------------------------------------------------------
// PANEL ADMIN: configuración del negocio y pagos
// ----------------------------------------------------------------------------

/** Claves de Config expuestas en la página Configuración del panel. */
var CLAVES_CONFIG_NEGOCIO = [
  'negocio_nombre',
  'negocio_direccion',
  'pago_efectivo',
  'pago_qr',
  'pago_qr_imagen',
  'pago_instrucciones',
  'fidelidad_activa',
  'fidelidad_visitas_meta',
  'fidelidad_servicio_id',
  'fidelidad_vigencia_dias'
];

function getConfigAdmin(token) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    var cfg = getConfig_();
    var config = {};
    CLAVES_CONFIG_NEGOCIO.forEach(function (clave) {
      config[clave] = cfg[clave] == null ? '' : String(cfg[clave]);
    });

    // El panel necesita los servicios para elegir cuál se regala.
    var servicios = readSheetAsObjects_(SHEET_NAMES.SERVICIOS).map(function (s) {
      return {
        id: Number(s.id) || 0,
        nombre: String(s.nombre || '').trim(),
        activo: parseBool_(s.activo)
      };
    }).filter(function (s) { return s.id && s.nombre; });

    return { ok: true, config: config, servicios: servicios };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Upsert por nombre de clave en la hoja Config. Fuerza formato texto: una
 * celda con "=..." se evaluaría como fórmula, y acá guardamos data URLs.
 */
function guardarClavesConfig_(valores) {
  var sh = sheet_(SHEET_NAMES.CONFIG);
  var filas = sh.getDataRange().getValues();
  if (!filas.length) throw new Error('La hoja Config está vacía.');

  var headers = filas[0].map(function (h) { return String(h).trim(); });
  var colClave = headers.indexOf('clave');
  var colValor = headers.indexOf('valor');
  if (colClave === -1 || colValor === -1) {
    throw new Error('La hoja Config debe tener las columnas "clave" y "valor".');
  }

  var filaPorClave = {};
  for (var i = 1; i < filas.length; i++) {
    var claveFila = String(filas[i][colClave]).trim();
    if (claveFila) filaPorClave[claveFila] = i + 1;
  }

  Object.keys(valores).forEach(function (clave) {
    var fila = filaPorClave[clave];
    if (!fila) {
      fila = sh.getLastRow() + 1;
      filaPorClave[clave] = fila;
      var rangoClave = sh.getRange(fila, colClave + 1);
      rangoClave.setNumberFormat('@');
      rangoClave.setValue(clave);
    }
    var rangoValor = sh.getRange(fila, colValor + 1);
    rangoValor.setNumberFormat('@');
    rangoValor.setValue(String(valores[clave]));
  });
}

function guardarConfigAdmin(token, datos) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    datos = datos || {};

    var nombre = String(datos.negocio_nombre || '').trim();
    if (nombre.length < 2) throw new Error('El nombre del negocio es obligatorio.');

    var direccion = String(datos.negocio_direccion || '').trim();
    if (direccion.length > 200) throw new Error('La dirección no puede superar los 200 caracteres.');

    var instrucciones = String(datos.pago_instrucciones || '').trim();
    if (instrucciones.length > 600) throw new Error('Las instrucciones de pago no pueden superar los 600 caracteres.');

    var qrImagen = String(datos.pago_qr_imagen || '').trim();
    if (qrImagen) {
      if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(qrImagen)) {
        throw new Error('La imagen del QR no es válida. Subí un archivo PNG, JPG o WebP.');
      }
      // Límite de celda de Sheets: 50.000 caracteres. Dejamos margen.
      if (qrImagen.length > 47000) {
        throw new Error('La imagen del QR es demasiado grande. Probá con una más chica.');
      }
    }

    var pagoEfectivo = !!datos.pago_efectivo;
    var pagoQr = !!datos.pago_qr;
    if (!pagoEfectivo && !pagoQr) {
      throw new Error('Habilitá al menos una forma de pago.');
    }
    if (pagoQr && !qrImagen && !getConfig_().pago_qr_imagen) {
      throw new Error('Subí la imagen del QR para habilitar el pago por QR.');
    }

    var fidelidadActiva = !!datos.fidelidad_activa;
    var fidelidadMeta = Math.round(Number(datos.fidelidad_visitas_meta) || 5);
    if (fidelidadMeta < 2 || fidelidadMeta > 50) {
      throw new Error('La meta de visitas debe estar entre 2 y 50.');
    }

    var fidelidadServicio = String(datos.fidelidad_servicio_id || '').trim();
    if (fidelidadActiva && !fidelidadServicio) {
      throw new Error('Elegí el servicio que se regala para activar la fidelidad.');
    }
    if (fidelidadActiva && fidelidadServicio) {
      var servicioPremio = getServiciosActivos_().filter(function (s) {
        return String(s.id) === fidelidadServicio;
      })[0];
      if (!servicioPremio) throw new Error('El servicio del premio no existe o está inactivo.');
    }

    var fidelidadVigencia = Math.round(Number(datos.fidelidad_vigencia_dias) || 0);
    if (fidelidadVigencia < 0 || fidelidadVigencia > 365) {
      throw new Error('La vigencia del premio debe estar entre 0 y 365 días (0 = sin vencimiento).');
    }

    var valores = {
      negocio_nombre: nombre,
      negocio_direccion: direccion,
      pago_efectivo: pagoEfectivo ? 'TRUE' : 'FALSE',
      pago_qr: pagoQr ? 'TRUE' : 'FALSE',
      pago_instrucciones: instrucciones,
      fidelidad_activa: fidelidadActiva ? 'TRUE' : 'FALSE',
      fidelidad_visitas_meta: String(fidelidadMeta),
      fidelidad_servicio_id: fidelidadServicio,
      fidelidad_vigencia_dias: String(fidelidadVigencia)
    };
    // Si no se subió una imagen nueva, se conserva la que ya estaba.
    if (qrImagen) valores.pago_qr_imagen = qrImagen;

    guardarClavesConfig_(valores);
    limpiarCacheTotal();

    // Al activar el programa con historial previo, genera los premios que ya
    // correspondían sin esperar a la próxima reserva completada.
    if (fidelidadActiva) {
      try {
        recalcularFidelidad_();
      } catch (errFid) {
        Logger.log('Fidelidad: ' + errFid.message);
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ----------------------------------------------------------------------------
// PANEL ADMIN: dashboard (hoy, semana y mes)
// ----------------------------------------------------------------------------

/** Lunes de la semana ISO (lunes a domingo) a la que pertenece la fecha. */
function lunesDeSemanaISO_(fechaIso) {
  var p = fechaIso.split('-');
  var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  var dia = d.getUTCDay(); // 0 = domingo
  d.setUTCDate(d.getUTCDate() - (dia === 0 ? 6 : dia - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Resumen para el Dashboard: ingresos y turnos cobrados de hoy, de la semana
 * en curso (lunes a hoy) y del mes en curso (día 1 a hoy). Una sola lectura
 * de Reservas; ingresos solo en estados confirmada/completada.
 * El ranking de especialistas y servicios corresponde al mes en curso.
 */
function getDashboardAdmin(token) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try {
    var cfg = getConfig_();
    var zona = cfg.zona_horaria || Session.getScriptTimeZone();
    var hoyISO = formatearFechaISO_(new Date(), zona);
    var mesDesde = hoyISO.slice(0, 7) + '-01';
    var semanaDesde = lunesDeSemanaISO_(hoyISO);

    var especialistas = readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS);
    var nombresEsp = {};
    especialistas.forEach(function (e) {
      nombresEsp[String(e.id)] = String(e.nombre || '').trim();
    });

    var srvPorId = indexarPorId_(readSheetAsObjects_(SHEET_NAMES.SERVICIOS));

    var acumulado = {
      hoy: { desde: hoyISO, hasta: hoyISO, ingresos: 0, turnos: 0 },
      semana: { desde: semanaDesde, hasta: hoyISO, ingresos: 0, turnos: 0 },
      mes: { desde: mesDesde, hasta: hoyISO, ingresos: 0, turnos: 0 }
    };
    var porEspecialista = {};
    var porServicio = {};

    readSheetAsObjects_(SHEET_NAMES.RESERVAS).forEach(function (r) {
      var fechaISO = fechaISODeCelda_(r.fecha, zona);
      if (!fechaISO || fechaISO > hoyISO) return;

      var estado = String(r.estado || '').trim().toLowerCase();
      if (ESTADOS_CON_INGRESO.indexOf(estado) === -1) return;

      // Los beneficios de fidelidad no son ingresos: se excluyen del dashboard
      // para no inflar la facturación ni el ticket promedio.
      if (parseBool_(r.es_beneficio)) return;

      var srv = srvPorId[String(r.servicio_id)] || {};
      var precio = Number(srv.precio) || 0;
      var nombreServicio = String(srv.nombre || 'Servicio eliminado').trim();
      var espId = String(r.especialista_id || '').trim() || '—';

      if (fechaISO >= mesDesde) {
        acumulado.mes.ingresos += precio;
        acumulado.mes.turnos++;

        if (!porEspecialista[espId]) {
          porEspecialista[espId] = {
            id: espId,
            nombre: nombresEsp[espId] || 'Especialista eliminado',
            ingresos: 0,
            turnos: 0
          };
        }
        porEspecialista[espId].ingresos += precio;
        porEspecialista[espId].turnos++;

        if (!porServicio[nombreServicio]) {
          porServicio[nombreServicio] = { nombre: nombreServicio, ingresos: 0, turnos: 0 };
        }
        porServicio[nombreServicio].ingresos += precio;
        porServicio[nombreServicio].turnos++;
      }

      if (fechaISO >= semanaDesde) {
        acumulado.semana.ingresos += precio;
        acumulado.semana.turnos++;
      }

      if (fechaISO === hoyISO) {
        acumulado.hoy.ingresos += precio;
        acumulado.hoy.turnos++;
      }
    });

    var redondear = function (n) { return Math.round(n * 100) / 100; };
    ['hoy', 'semana', 'mes'].forEach(function (clave) {
      acumulado[clave].ingresos = redondear(acumulado[clave].ingresos);
    });

    var filasEspecialista = Object.keys(porEspecialista).map(function (id) {
      var e = porEspecialista[id];
      return { id: e.id, nombre: e.nombre, ingresos: redondear(e.ingresos), turnos: e.turnos };
    }).sort(function (a, b) {
      return (b.ingresos - a.ingresos) || (b.turnos - a.turnos);
    });

    var filasServicio = Object.keys(porServicio).map(function (nombre) {
      var s = porServicio[nombre];
      return { nombre: s.nombre, ingresos: redondear(s.ingresos), turnos: s.turnos };
    }).sort(function (a, b) {
      return (b.turnos - a.turnos) || (b.ingresos - a.ingresos);
    });

    return {
      ok: true,
      hoyISO: hoyISO,
      moneda: cfg.moneda || '',
      hoy: acumulado.hoy,
      semana: acumulado.semana,
      mes: acumulado.mes,
      especialistas: filasEspecialista,
      servicios: filasServicio
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function construirMensajeWhatsapp_(plantilla, filaReserva, cfg, especialistas, servicios) {
  var esp = especialistas[filaReserva.especialista_id] || {};
  var srv = servicios[filaReserva.servicio_id] || {};
  var fecha = fechaDeCelda_(filaReserva.fecha);
  return String(plantilla || '')
    .replace(/{nombre}/g, filaReserva.cliente_nombre || '')
    .replace(/{servicio}/g, srv.nombre || '')
    .replace(/{especialista}/g, esp.nombre || '')
    .replace(/{fecha}/g, formatearFechaBonita_(fecha, cfg.zona_horaria))
    .replace(/{hora}/g, minutosAHHMM_(minutosDeFecha_(filaReserva.hora_inicio, cfg.zona_horaria)))
    .replace(/{negocio}/g, cfg.negocio_nombre || '');
}

function construirLinkWhatsapp_(telefono, mensaje) {
  var limpio = String(telefono || '').replace(/[^\d]/g, '');
  return 'https://wa.me/' + limpio + '?text=' + encodeURIComponent(mensaje);
}

var ESTADOS_RESERVA_VALIDOS = ['pendiente', 'confirmada', 'cancelada', 'completada'];

function actualizarEstadoReserva_(token, row, nuevoEstado, plantillaMensajeKey, motivo) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  if (ESTADOS_RESERVA_VALIDOS.indexOf(String(nuevoEstado)) === -1) {
    return { ok: false, error: 'Estado de reserva inválido.' };
  }

  // Sin esta validación, row=1 pisaba el encabezado de la hoja y dejaba la
  // planilla inutilizable hasta restaurarla a mano.
  try { row = validarFilaReserva_(row); }
  catch (e) { return { ok: false, error: e.message }; }

  var sh = sheet_(SHEET_NAMES.RESERVAS);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var colEstado = headers.indexOf('estado') + 1;
  if (colEstado === 0) return { ok: false, error: 'No se encontró la columna "estado" en Reservas.' };

  var valoresFila = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];
  var filaReserva = {};
  headers.forEach(function (h, idx) { filaReserva[h] = valoresFila[idx]; });

  var cfg = getConfig_();

  sh.getRange(row, colEstado).setValue(nuevoEstado);
  invalidarCacheDisponibilidad_(filaReserva.especialista_id, fechaDeCelda_(filaReserva.fecha), cfg.zona_horaria);

  var notasFinal = filaReserva.notas || '';
  if (motivo && String(motivo).trim()) {
    var colNotas = headers.indexOf('notas') + 1;
    var motivoTexto = 'Motivo cancelación: ' + String(motivo).trim();
    notasFinal = notasFinal ? (notasFinal + ' | ' + motivoTexto) : motivoTexto;
    if (colNotas > 0) sh.getRange(row, colNotas).setValue(notasFinal);
    filaReserva.notas = notasFinal;
  }

  var respuesta = { ok: true, estado: nuevoEstado, notas: notasFinal };

  // Efectos de fidelidad: el premio se consume al completar la reserva y se
  // libera si la reserva se cancela. Después se recalcula la tarjeta desde las
  // reservas, que es lo que evita contar dos veces la misma visita.
  var fid = getFidelidadConfig_(cfg);
  if (fid.activa) {
    asegurarHojasFidelidad_();
    var beneficioId = String(filaReserva.beneficio_id == null ? '' : filaReserva.beneficio_id).trim();
    if (beneficioId) {
      var beneficio = readSheetAsObjects_(SHEET_NAMES.BENEFICIOS).filter(function (b) {
        return String(b.id) === beneficioId;
      })[0];
      var estadoBen = beneficio ? String(beneficio.estado || '').trim().toLowerCase() : '';
      if (beneficio && nuevoEstado === 'completada' && estadoBen !== 'canjeado') {
        actualizarFilaPorEncabezado_(SHEET_NAMES.BENEFICIOS, beneficio.__row, {
          estado: 'canjeado',
          fecha_canjeado: new Date(),
          reserva_id: filaReserva.id
        });
      } else if (beneficio && nuevoEstado === 'cancelada' && estadoBen === 'reservado') {
        actualizarFilaPorEncabezado_(SHEET_NAMES.BENEFICIOS, beneficio.__row, {
          estado: 'disponible',
          reserva_id: ''
        });
      }
    }

    var telCliente = normalizarTelefono_(filaReserva.cliente_telefono);
    if (telCliente) {
      try {
        respuesta.fidelidad = recalcularFidelidad_(telCliente);
      } catch (e) {
        // La reserva ya cambió de estado: no se revierte por un fallo al
        // recalcular la tarjeta. Se registra para diagnosticar.
        Logger.log('Fidelidad: ' + e.message);
      }
    }
  }

  if (plantillaMensajeKey) {
    var especialistas = indexarPorId_(readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS));
    var servicios = indexarPorId_(readSheetAsObjects_(SHEET_NAMES.SERVICIOS));
    var mensaje = construirMensajeWhatsapp_(cfg[plantillaMensajeKey], filaReserva, cfg, especialistas, servicios);
    respuesta.waUrl = construirLinkWhatsapp_(filaReserva.cliente_telefono, mensaje);
  }

  return respuesta;
}

function confirmarReservaAdmin(token, row) {
  return actualizarEstadoReserva_(token, row, 'confirmada', 'mensaje_whatsapp_confirmacion');
}

function cancelarReservaAdmin(token, row, motivo) {
  return actualizarEstadoReserva_(token, row, 'cancelada', 'mensaje_whatsapp_cancelacion', motivo);
}

function completarReservaAdmin(token, row) {
  return actualizarEstadoReserva_(token, row, 'completada', null);
}

/**
 * Regenera el enlace de WhatsApp de una reserva ya confirmada/cancelada sin
 * repetir la acción — útil si el admin recargó la página y quiere reenviar
 * el mensaje, o si la primera vez no llegó a abrirlo.
 */
function generarLinkWhatsappReserva(token, row, tipo) {
  if (!validarToken_(token)) return { ok: false, error: 'Sesión inválida o expirada.' };

  try { row = validarFilaReserva_(row); }
  catch (e) { return { ok: false, error: e.message }; }

  var sh = sheet_(SHEET_NAMES.RESERVAS);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var valoresFila = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];
  var filaReserva = {};
  headers.forEach(function (h, idx) { filaReserva[h] = valoresFila[idx]; });

  var cfg = getConfig_();
  var especialistas = indexarPorId_(readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS));
  var servicios = indexarPorId_(readSheetAsObjects_(SHEET_NAMES.SERVICIOS));
  var plantillaKey = tipo === 'cancelacion' ? 'mensaje_whatsapp_cancelacion' : 'mensaje_whatsapp_confirmacion';
  var mensaje = construirMensajeWhatsapp_(cfg[plantillaKey], filaReserva, cfg, especialistas, servicios);

  return { ok: true, waUrl: construirLinkWhatsapp_(filaReserva.cliente_telefono, mensaje) };
}

// ----------------------------------------------------------------------------
// SETUP DE INSTALACIONES
// ----------------------------------------------------------------------------

/**
 * Deja el Sheet listo para usar. Es idempotente: se puede ejecutar las veces
 * que haga falta y solo crea lo que falta, sin borrar ni pisar datos.
 *
 * Qué hace:
 *   1. Crea las hojas requeridas que no existan.
 *   2. Escribe el encabezado de las hojas vacías y agrega al final las
 *      columnas faltantes (por ejemplo, `metodo_pago` en instalaciones viejas).
 *   3. Agrega a Config las claves que falten, con valores iniciales.
 *   4. Limpia el caché para que el panel vea los cambios al instante.
 *
 * Se ejecuta manualmente desde el editor de Apps Script: elegir `setup` en el
 * dropdown de funciones y pulsar ▶ Ejecutar.
 */
function setup() {
  var ss = ss_();
  var hojasCreadas = [];
  var headersAgregados = {};
  var configAgregada = [];

  HOJAS_REQUERIDAS.forEach(function (def) {
    var sh = ss.getSheetByName(def.nombre);
    if (!sh) {
      sh = ss.insertSheet(def.nombre);
      hojasCreadas.push(def.nombre);
    }
    var faltantes = asegurarHeaders_(sh, def.headers);
    if (faltantes.length) headersAgregados[def.nombre] = faltantes;
  });

  var shConfig = ss.getSheetByName(SHEET_NAMES.CONFIG);
  var valores = shConfig.getDataRange().getValues();
  var claves = {};
  for (var i = 1; i < valores.length; i++) {
    var clave = String(valores[i][0] == null ? '' : valores[i][0]).trim();
    if (clave) claves[clave] = true;
  }

  var fila = Math.max(shConfig.getLastRow(), 1) + 1;
  Object.keys(CONFIG_DEFAULT).forEach(function (clave) {
    if (claves[clave]) return;
    shConfig.getRange(fila, 1, 1, 2).setValues([[clave, CONFIG_DEFAULT[clave]]]);
    fila++;
    configAgregada.push(clave);
  });

  limpiarCacheTotal();

  var resumen = {
    ok: true,
    hojasCreadas: hojasCreadas,
    headersAgregados: headersAgregados,
    configAgregada: configAgregada
  };
  Logger.log(JSON.stringify(resumen));
  return resumen;
}

// ----------------------------------------------------------------------------
// DATOS DE DEMO
// ----------------------------------------------------------------------------

/**
 * Carga un negocio de ejemplo completo: manicuristas, servicios de uñas,
 * horarios y reservas en distintos estados (completadas, confirmadas y
 * pendientes), más el programa de fidelidad activo.
 *
 * Es idempotente: cada bloque se completa solo si su hoja está vacía, así que
 * se puede ejecutar varias veces sin duplicar datos ni pisar los existentes.
 * Ejecutala una vez desde el editor de Apps Script:
 *
 *   sembrarDemo() → Ejecutar → Revisar permisos → Permitir
 */
function sembrarDemo() {
  var resumenSetup = setup();
  var cfg = getConfig_();
  var catalogo = sembrarCatalogoDemo_();
  var horarios = sembrarHorariosDemo_(catalogo);
  var reservas = sembrarReservasDemo_(cfg, catalogo);

  var servicioPremio = catalogo.servicios['Manicura clásica'];
  guardarClavesConfig_({
    fidelidad_activa: servicioPremio ? 'TRUE' : 'FALSE',
    fidelidad_visitas_meta: '5',
    fidelidad_servicio_id: servicioPremio ? String(servicioPremio.id) : '',
    fidelidad_vigencia_dias: '180'
  });
  limpiarCacheTotal();

  try {
    recalcularFidelidad_();
  } catch (errFid) {
    Logger.log('Fidelidad demo: ' + errFid.message);
  }

  var resumen = {
    ok: true,
    setup: resumenSetup,
    especialistasCreados: catalogo.especialistasCreados,
    serviciosCreados: catalogo.serviciosCreados,
    horariosCreados: horarios,
    reservasCreadas: reservas
  };
  Logger.log(JSON.stringify(resumen));
  return resumen;
}

/**
 * Crea las manicuristas y los servicios de uñas si las hojas están vacías.
 * Devuelve mapas por nombre para que el resto del seed no dependa de IDs fijos.
 */
function sembrarCatalogoDemo_() {
  var out = {
    especialistas: {},
    servicios: {},
    especialistasCreados: 0,
    serviciosCreados: 0
  };

  var shEsp = sheet_(SHEET_NAMES.ESPECIALISTAS);
  if (shEsp.getLastRow() < 2) {
    [
      ['Camila Rojas', '#C2185B', 1],
      ['Valentina Cruz', '#7B1FA2', 2],
      ['Lucía Méndez', '#00897B', 3]
    ].forEach(function (e) {
      var id = obtenerSiguienteId_(shEsp);
      escribirFilaPorEncabezado_(SHEET_NAMES.ESPECIALISTAS, {
        id: id,
        nombre: e[0],
        foto_url: '',
        color: e[1],
        activo: 'TRUE',
        orden: e[2]
      });
      out.especialistas[e[0]] = id;
      out.especialistasCreados++;
    });
  } else {
    readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS).forEach(function (e) {
      if (String(e.activo).toUpperCase() === 'TRUE') {
        out.especialistas[String(e.nombre)] = Number(e.id);
      }
    });
  }

  var shServ = sheet_(SHEET_NAMES.SERVICIOS);
  if (shServ.getLastRow() < 2) {
    [
      ['Manicura clásica', 45, 80, 'Limpieza, forma y esmalte tradicional.'],
      ['Manicura semipermanente', 60, 120, 'Esmalte en gel de larga duración.'],
      ['Pedicura spa', 60, 140, 'Exfoliación, hidratación y esmalte.'],
      ['Uñas acrílicas', 90, 200, 'Extensión con acrílico y forma a elección.'],
      ['Kapping gel', 75, 160, 'Refuerzo de gel sobre uña natural.'],
      ['Diseño y nail art', 30, 50, 'Detalles pintados o pedrería.']
    ].forEach(function (s) {
      var id = obtenerSiguienteId_(shServ);
      escribirFilaPorEncabezado_(SHEET_NAMES.SERVICIOS, {
        id: id,
        nombre: s[0],
        duracion_minutos: s[1],
        precio: s[2],
        especialista_id: 'TODOS',
        activo: 'TRUE',
        descripcion: s[3]
      });
      out.servicios[s[0]] = { id: id, duracion: s[1], precio: s[2] };
      out.serviciosCreados++;
    });
  } else {
    readSheetAsObjects_(SHEET_NAMES.SERVICIOS).forEach(function (s) {
      if (String(s.activo).toUpperCase() === 'TRUE') {
        out.servicios[String(s.nombre)] = {
          id: Number(s.id),
          duracion: Number(s.duracion_minutos),
          precio: Number(s.precio)
        };
      }
    });
  }

  return out;
}

/** Carga horarios semanales de las tres manicuristas si la hoja está vacía. */
function sembrarHorariosDemo_(catalogo) {
  var sh = sheet_(SHEET_NAMES.HORARIOS);
  if (sh.getLastRow() >= 2) return 0;

  var planes = [
    ['Camila Rojas', ['Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'], '09:00', '19:00'],
    ['Valentina Cruz', ['Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'], '10:00', '20:00'],
    ['Lucía Méndez', ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'], '09:00', '18:00']
  ];

  var creados = 0;
  planes.forEach(function (plan) {
    var espId = catalogo.especialistas[plan[0]];
    if (!espId) return;
    plan[1].forEach(function (dia) {
      escribirFilaPorEncabezado_(SHEET_NAMES.HORARIOS, {
        especialista_id: espId,
        dia_semana: dia,
        hora_inicio: plan[2],
        hora_fin: plan[3],
        activo: 'TRUE'
      });
      creados++;
    });
  });
  return creados;
}

/**
 * Carga reservas de ejemplo si la hoja está vacía. Las fechas se calculan
 * relativas a hoy y caen siempre en día hábil (martes a sábado), así el demo
 * se ve poblado sin importar cuándo se siembre.
 */
function sembrarReservasDemo_(cfg, catalogo) {
  var sh = sheet_(SHEET_NAMES.RESERVAS);
  if (sh.getLastRow() >= 2) return 0;

  var filas = [
    // Historial de una clienta fiel: 5 visitas completadas → premio.
    { offset: -24, hora: '10:00', cliente: 'María Fernanda López', tel: '71234567', servicio: 'Manicura clásica', esp: 'Camila Rojas', estado: 'completada', pago: 'efectivo' },
    { offset: -17, hora: '11:00', cliente: 'María Fernanda López', tel: '71234567', servicio: 'Manicura semipermanente', esp: 'Valentina Cruz', estado: 'completada', pago: 'efectivo' },
    { offset: -10, hora: '15:00', cliente: 'María Fernanda López', tel: '71234567', servicio: 'Pedicura spa', esp: 'Lucía Méndez', estado: 'completada', pago: 'qr' },
    { offset: -5, hora: '10:30', cliente: 'María Fernanda López', tel: '71234567', servicio: 'Kapping gel', esp: 'Camila Rojas', estado: 'completada', pago: 'efectivo' },
    { offset: -2, hora: '16:00', cliente: 'María Fernanda López', tel: '71234567', servicio: 'Manicura clásica', esp: 'Valentina Cruz', estado: 'completada', pago: 'efectivo' },
    { offset: -1, hora: '14:00', cliente: 'Carla Villarroel', tel: '76543210', servicio: 'Uñas acrílicas', esp: 'Camila Rojas', estado: 'completada', pago: 'qr' },
    // Agenda próxima.
    { offset: 1, hora: '10:00', cliente: 'Sofía Aguilera', tel: '70112233', servicio: 'Manicura semipermanente', esp: 'Valentina Cruz', estado: 'confirmada', pago: 'efectivo' },
    { offset: 2, hora: '15:00', cliente: 'Andrea Suárez', tel: '71445566', servicio: 'Uñas acrílicas', esp: 'Camila Rojas', estado: 'confirmada', pago: 'qr' },
    { offset: 3, hora: '11:00', cliente: 'Daniela Ferrufino', tel: '72334455', servicio: 'Pedicura spa', esp: 'Lucía Méndez', estado: 'pendiente', pago: 'efectivo' },
    { offset: 4, hora: '09:30', cliente: 'Gabriela Pinto', tel: '73667788', servicio: 'Manicura clásica', esp: 'Camila Rojas', estado: 'confirmada', pago: 'efectivo' },
    { offset: 5, hora: '17:00', cliente: 'Rocío Salazar', tel: '74998877', servicio: 'Diseño y nail art', esp: 'Valentina Cruz', estado: 'pendiente', pago: 'qr' },
    { offset: 2, hora: '12:00', cliente: 'Carla Villarroel', tel: '76543210', servicio: 'Diseño y nail art', esp: 'Lucía Méndez', estado: 'cancelada', pago: '' }
  ];

  var creadas = 0;
  filas.forEach(function (f) {
    var servicio = catalogo.servicios[f.servicio];
    var espId = catalogo.especialistas[f.esp];
    if (!servicio || !espId) return;

    var fechaISO = diaHabilDemoISO_(cfg, f.offset);
    var inicio = Utilities.parseDate(fechaISO + ' ' + f.hora, cfg.zona_horaria, 'yyyy-MM-dd HH:mm');
    var fin = new Date(inicio.getTime() + servicio.duracion * 60000);
    var id = obtenerSiguienteId_(sh);

    escribirFilaPorEncabezado_(SHEET_NAMES.RESERVAS, {
      id: id,
      codigo_reserva: generarCodigoReserva_(id),
      fecha: Utilities.parseDate(fechaISO, cfg.zona_horaria, 'yyyy-MM-dd'),
      hora_inicio: inicio,
      hora_fin: fin,
      especialista_id: espId,
      servicio_id: servicio.id,
      cliente_nombre: f.cliente,
      cliente_telefono: f.tel,
      cliente_email: '',
      estado: f.estado,
      notas: '',
      fecha_creacion: new Date(inicio.getTime() - 2 * 86400000),
      metodo_pago: f.pago,
      beneficio_id: '',
      es_beneficio: 'FALSE'
    });
    creadas++;
  });

  return creadas;
}

/**
 * Fecha ISO (en la zona del negocio) del próximo día hábil a partir de
 * `offsetDias` respecto de hoy. Martes a sábado se consideran hábiles.
 */
function diaHabilDemoISO_(cfg, offsetDias) {
  var d = new Date(Date.now() + offsetDias * 86400000);
  var zona = cfg.zona_horaria || Session.getScriptTimeZone();

  for (var i = 0; i < 7; i++) {
    var iso = formatearFechaISO_(d, zona);
    var partes = iso.split('-');
    var dow = new Date(Date.UTC(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]))).getUTCDay();
    if (dow >= 2 && dow <= 6) return iso;
    d = new Date(d.getTime() + 86400000);
  }
  return formatearFechaISO_(d, zona);
}

/**
 * Asegura que una hoja tenga todos los encabezados pedidos, en orden.
 * - Hoja vacía: escribe la fila completa.
 * - Hoja con datos: agrega al final solo las columnas que falten.
 * No reordena ni borra columnas existentes.
 * Devuelve la lista de encabezados agregados.
 */
function asegurarHeaders_(sh, headers) {
  var ultimaCol = sh.getLastColumn();
  if (ultimaCol === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    return headers.slice();
  }

  var actuales = sh.getRange(1, 1, 1, ultimaCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var faltantes = headers.filter(function (h) {
    return actuales.indexOf(h) === -1;
  });

  if (faltantes.length) {
    sh.getRange(1, ultimaCol + 1, 1, faltantes.length).setValues([faltantes]);
  }
  return faltantes;
}

/**
 * Borra TODO el caché de golpe. Ejecútala manualmente desde el editor de
 * Apps Script (seleccionándola en el dropdown de funciones y dándole ▶ Ejecutar)
 * cada vez que cambies datos en el Sheet y quieras verlos reflejados al
 * instante, sin esperar el TTL normal.
 */
/**
 * Limpia el caché de horarios/bloqueos/disponibilidad de UN especialista
 * específico. Úsala después de editar la hoja Horarios o Bloqueos para ver
 * el cambio reflejado al instante, sin esperar los 3 min de caché normal.
 * Cambia el "1" por el id del especialista que editaste.
 */
/**
 * Limpia TODO el caché relevante de una sola vez: config, catálogos, y
 * horarios/bloqueos/disponibilidad de CADA especialista (los lee directo
 * de la hoja, no hace falta escribir IDs a mano). Úsala después de
 * cualquier cambio en el Sheet — nombre del negocio, horarios, servicios,
 * lo que sea — para ver el resultado al instante sin esperar el TTL.
 */
function limpiarCacheTotal() {
  var cache = CacheService.getScriptCache();
  cache.removeAll(['cfg', 'especialistas', 'servicios', 'dias_especiales']);

  var cfg = getConfig_();
  var zona = cfg.zona_horaria || Session.getScriptTimeZone();
  var especialistas = readSheetAsObjects_(SHEET_NAMES.ESPECIALISTAS);
  var servicios = getServiciosActivos_();
  var hoy = new Date();

  var anioBase = Number(Utilities.formatDate(hoy, zona, 'yyyy'));
  var mesBase = Number(Utilities.formatDate(hoy, zona, 'M'));

  especialistas.forEach(function (e) {
    cache.remove('horarios_' + e.id);
    cache.remove('bloqueos_' + e.id);
    for (var m = -1; m <= 2; m++) {
      // Aritmética de meses en vez de new Date(y, m, 1): esa forma usa la
      // zona del proyecto, que puede no ser la del negocio.
      var idx = (mesBase - 1) + m;
      var anio = anioBase + Math.floor(idx / 12);
      var mes = ((idx % 12) + 12) % 12 + 1;
      servicios.forEach(function (s) {
        cache.remove('disp_' + e.id + '_' + s.id + '_' + anio + '_' + mes);
      });
    }
  });

  Logger.log('Caché limpiado por completo. Todos los cambios del Sheet ya son visibles.');
}

function debugZonaHoraria() {
  var cfg = getConfig_();
  Logger.log('cfg.zona_horaria = "' + cfg.zona_horaria + '"');
  Logger.log('Session.getScriptTimeZone() = "' + Session.getScriptTimeZone() + '"');
  Logger.log('Spreadsheet.getSpreadsheetTimeZone() = "' + SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() + '"');

  var filas = readSheetAsObjects_(SHEET_NAMES.HORARIOS);
  var prueba = filas[0].hora_inicio;
  Logger.log('Valor crudo hora_inicio fila 1: ' + prueba);
  Logger.log('Formateado con cfg.zona_horaria: ' + Utilities.formatDate(prueba, cfg.zona_horaria || Session.getScriptTimeZone(), 'HH:mm'));
  Logger.log('Formateado con timezone REAL del Sheet: ' + Utilities.formatDate(prueba, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'HH:mm'));
}
