import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SRC = path.resolve(import.meta.dirname, '../src/Codigo.js');
const CODIGO = fs.readFileSync(SRC, 'utf8');
const ZONA = 'America/Argentina/Buenos_Aires';

// ---------------------------------------------------------------------------
// Mocks mínimos de las APIs de Apps Script
// ---------------------------------------------------------------------------

function partesEnZona(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

function offsetMinutos(tz, date) {
  const p = partesEnZona(date, tz);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

function formatDate(date, tz, fmt) {
  const p = partesEnZona(date, tz);
  if (fmt === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
  if (fmt === 'HH:mm') return `${p.hour}:${p.minute}`;
  if (fmt === 'yyyy') return p.year;
  if (fmt === 'M') return String(Number(p.month));
  throw new Error('formatDate mock sin soporte para ' + fmt);
}

function parseDate(str, tz, fmt) {
  const conHora = fmt === 'yyyy-MM-dd' ? str + ' 00:00' : str;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(conHora);
  if (!m) throw new Error('parseDate mock sin soporte para ' + str + ' / ' + fmt);
  const utcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
  let offset = offsetMinutos(tz, new Date(utcGuess));
  offset = offsetMinutos(tz, new Date(utcGuess - offset * 60000));
  return new Date(utcGuess - offset * 60000);
}

function crearCache() {
  const store = new Map();
  return {
    get: (k) => (store.has(k) ? store.get(k) : null),
    put: (k, v) => store.set(k, String(v)),
    remove: (k) => store.delete(k),
    removeAll: (keys) => keys.forEach((k) => store.delete(k)),
    __store: store,
  };
}

function crearHoja(nombre, filas) {
  const data = filas.map((f) => f.slice());
  const formatos = [];

  const asegurar = (r, c) => {
    while (data.length < r) data.push([]);
    const fila = data[r - 1];
    while (fila.length < c) fila.push('');
    return fila;
  };

  const rango = (row, col, numRows, numCols) => {
    const nr = numRows == null ? 1 : numRows;
    const nc = numCols == null ? 1 : numCols;
    return {
      getValues() {
        const out = [];
        for (let r = 0; r < nr; r++) {
          const fila = [];
          for (let c = 0; c < nc; c++) {
            fila.push(asegurar(row + r, col + c)[col + c - 1]);
          }
          out.push(fila);
        }
        return out;
      },
      setValues(vals) {
        for (let r = 0; r < vals.length; r++) {
          for (let c = 0; c < vals[r].length; c++) {
            asegurar(row + r, col + c)[col + c - 1] = vals[r][c];
          }
        }
      },
      setValue(v) {
        asegurar(row, col)[col - 1] = v;
      },
      getValue() {
        return asegurar(row, col)[col - 1];
      },
      setNumberFormat(fmt) {
        formatos.push({ row, col, fmt });
      },
    };
  };

  return {
    getName: () => nombre,
    getLastRow: () => data.length,
    getLastColumn: () => data.reduce((max, f) => Math.max(max, f.length), 0),
    getDataRange: () => rango(1, 1, data.length, data.reduce((max, f) => Math.max(max, f.length), 0)),
    getRange: rango,
    deleteRow(row) {
      data.splice(row - 1, 1);
    },
    __data: data,
    __formatos: formatos,
    __col(header) {
      return data[0].map((h) => String(h).trim()).indexOf(header);
    },
  };
}

function cargarBackend(seed) {
  const hojas = new Map();
  for (const [nombre, filas] of Object.entries(seed.hojas || {})) {
    hojas.set(nombre, crearHoja(nombre, filas));
  }
  const cache = crearCache();
  const props = new Map(Object.entries(seed.props || {}));

  const ctx = {
    console,
    JSON,
    Date,
    Math,
    String,
    Number,
    Object,
    Array,
    RegExp,
    Error,
    isNaN,
    isFinite,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => hojas.get(n) || null,
        insertSheet: (n) => {
          const hoja = crearHoja(n, []);
          hojas.set(n, hoja);
          return hoja;
        },
        getSpreadsheetTimeZone: () => ZONA,
      }),
    },
    CacheService: { getScriptCache: () => cache },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, String(v)),
        deleteProperty: (k) => props.delete(k),
      }),
    },
    Utilities: {
      formatDate,
      parseDate,
      getUuid: () => 'uuid-' + Math.random().toString(16).slice(2),
    },
    Session: { getScriptTimeZone: () => ZONA },
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
    },
    Logger: { log() {} },
  };

  vm.createContext(ctx);
  vm.runInContext(CODIGO, ctx, { filename: 'Codigo.js' });
  return { ctx, hojas, cache, props };
}

// ---------------------------------------------------------------------------
// Datos base
// ---------------------------------------------------------------------------

const HEADERS_RESERVAS = [
  'id',
  'codigo_reserva',
  'fecha',
  'hora_inicio',
  'hora_fin',
  'especialista_id',
  'servicio_id',
  'cliente_nombre',
  'cliente_telefono',
  'cliente_email',
  'estado',
  'notas',
  'fecha_creacion',
  'metodo_pago',
  'beneficio_id',
  'es_beneficio',
];

function configBase(extra = {}) {
  const cfg = {
    zona_horaria: ZONA,
    intervalo_turnos_minutos: '30',
    anticipacion_minima_horas: '0',
    dias_max_anticipacion: '60',
    negocio_nombre: 'Bosque & Bronce',
    negocio_whatsapp: '5491123456789',
    negocio_direccion: 'Av. San Martín 123, Yacuiba',
    pago_efectivo: 'TRUE',
    pago_qr: 'TRUE',
    pago_qr_imagen: '',
    pago_instrucciones: 'Escanea el QR y envía el comprobante.',
    ...extra,
  };
  return [['clave', 'valor'], ...Object.entries(cfg).map(([k, v]) => [k, v])];
}

function fechaFutura(dias, ctx) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { iso, dia: ctx.DIAS_SEMANA[d.getDay()], date: d };
}

function seedCompleto(ctx, extra = {}) {
  const f = fechaFutura(3, ctx);
  return {
    hojas: {
      Config: configBase(extra.config),
      Especialistas: [
        ['id', 'nombre', 'foto_url', 'color', 'activo', 'orden'],
        [1, 'Rodrigo', '', '#1B4332', 'TRUE', 1],
        [2, 'Inactivo', '', '#B08947', 'FALSE', 2],
      ],
      Servicios: [
        ['id', 'nombre', 'duracion_minutos', 'precio', 'especialista_id', 'activo', 'descripcion'],
        [1, 'Corte clásico', 30, 5000, 'TODOS', 'TRUE', 'Corte a tijera'],
        [2, 'Solo Rodrigo', 30, 6000, '1', 'TRUE', ''],
        [3, 'De inactivo', 30, 7000, '2', 'TRUE', ''],
      ],
      Horarios: [
        ['especialista_id', 'dia_semana', 'hora_inicio', 'hora_fin', 'activo'],
        [1, f.dia, '09:00', '18:00', 'TRUE'],
      ],
      Bloqueos: [['especialista_id', 'fecha_inicio', 'fecha_fin', 'hora_inicio', 'hora_fin']],
      Reservas: [HEADERS_RESERVAS],
      ...(extra.hojas || {}),
    },
    props: extra.props || {},
    fecha: f,
  };
}

function datosReserva(seed, over = {}) {
  return {
    especialistaId: 1,
    servicioId: 1,
    fecha: seed.fecha.iso,
    hora: '10:00',
    nombre: 'Juan Pérez',
    telefono: '+54 9 11 2345-6789',
    email: 'juan@example.com',
    notas: '=HYPERLINK("http://evil","x")',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('validarFilaReserva_ rechaza el encabezado y filas fuera de rango', () => {
  const { ctx, hojas } = cargarBackend({ hojas: { Reservas: [HEADERS_RESERVAS, [1], [2]] } });
  assert.equal(ctx.validarFilaReserva_(2), 2);
  assert.equal(ctx.validarFilaReserva_(3), 3);
  assert.throws(() => ctx.validarFilaReserva_(1), /Reserva inválida/);
  assert.throws(() => ctx.validarFilaReserva_(4), /Reserva inválida/);
  assert.throws(() => ctx.validarFilaReserva_(2.5), /Reserva inválida/);
  assert.throws(() => ctx.validarFilaReserva_('x'), /Reserva inválida/);
  assert.equal(hojas.get('Reservas').__data.length, 3);
});

test('escribirFilaPorEncabezado_ mapea por nombre y fuerza formato texto', () => {
  const headers = ['estado', 'cliente_nombre', 'id', 'notas', 'cliente_telefono', 'cliente_email'];
  const { ctx, hojas } = cargarBackend({ hojas: { Reservas: [headers] } });
  const fila = ctx.escribirFilaPorEncabezado_('Reservas', {
    id: 7,
    estado: 'pendiente',
    cliente_nombre: '=HYPERLINK("http://evil","x")',
    cliente_telefono: '5491123456789',
    cliente_email: 'a@b.com',
    notas: 'nota',
  });
  assert.equal(fila, 2);

  const hoja = hojas.get('Reservas');
  const escrita = hoja.__data[1];
  assert.equal(escrita[hoja.__col('estado')], 'pendiente');
  assert.equal(escrita[hoja.__col('cliente_nombre')], '=HYPERLINK("http://evil","x")');
  assert.equal(escrita[hoja.__col('id')], 7);

  const conFormatoTexto = hoja.__formatos.filter((f) => f.fmt === '@').map((f) => f.col);
  assert.ok(conFormatoTexto.includes(hoja.__col('cliente_nombre') + 1));
  assert.ok(conFormatoTexto.includes(hoja.__col('cliente_telefono') + 1));
  assert.ok(conFormatoTexto.includes(hoja.__col('cliente_email') + 1));
  assert.ok(conFormatoTexto.includes(hoja.__col('notas') + 1));
});

test('iniciarSesionAdmin bloquea tras MAX_INTENTOS y acepta el PIN correcto', () => {
  const { ctx } = cargarBackend({ props: { ADMIN_PIN: '1234' } });

  for (let i = 0; i < 6; i++) {
    const res = ctx.iniciarSesionAdmin({ pin: '0000' });
    assert.equal(res.ok, false);
    assert.match(res.error, /Credenciales incorrectas/);
  }
  const bloqueado = ctx.iniciarSesionAdmin({ pin: '1234' });
  assert.equal(bloqueado.ok, false);
  assert.match(bloqueado.error, /Demasiados intentos/);

  // Con el contador limpio, el PIN correcto emite token.
  const limpio = cargarBackend({ props: { ADMIN_PIN: '1234' } });
  const ok = limpio.ctx.iniciarSesionAdmin({ pin: '1234' });
  assert.equal(ok.ok, true);
  assert.ok(ok.token);
});

test('obtenerDatosIniciales oculta servicios de especialistas inactivos', () => {
  const ctx = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(ctx);
  const backend = cargarBackend({ hojas: seed.hojas });
  const datos = backend.ctx.obtenerDatosIniciales();
  const ids = datos.servicios.map((s) => String(s.id));
  assert.equal(ids.join(','), '1,2');
  assert.ok(!ids.includes('3'));
});

test('crearReserva rechaza especialista que no ofrece el servicio', () => {
  const { ctx } = cargarBackend({ hojas: {} });
  const seed = seedCompleto(ctx);
  const backend = cargarBackend({ hojas: seed.hojas });
  const res = backend.ctx.crearReserva(datosReserva(seed, { servicioId: 2, especialistaId: 9 }));
  assert.equal(res.ok, false);
  assert.match(res.error, /no ofrece ese servicio/);
});

test('crearReserva rechaza una fecha fuera del rango permitido', () => {
  const { ctx } = cargarBackend({ hojas: {} });
  const seed = seedCompleto(ctx);
  const backend = cargarBackend({ hojas: seed.hojas });
  const lejos = fechaFutura(90, backend.ctx);
  // 90 días suele ser sábado/domingo; el rango se rechaza antes de mirar horarios.
  const res = backend.ctx.crearReserva(datosReserva(seed, { fecha: lejos.iso }));
  assert.equal(res.ok, false);
  assert.match(res.error, /fuera del rango/);
});

test('crearReserva rechaza un horario ya ocupado', () => {
  const { ctx } = cargarBackend({ hojas: {} });
  const seed = seedCompleto(ctx);
  const fechaReserva = new Date(seed.fecha.date);
  fechaReserva.setHours(12, 0, 0, 0);
  const ocupada = [...HEADERS_RESERVAS];
  const fila = ocupada.map((h) => {
    if (h === 'id') return 1;
    if (h === 'fecha') return fechaReserva;
    if (h === 'hora_inicio') return '10:00';
    if (h === 'hora_fin') return '10:30';
    if (h === 'especialista_id') return 1;
    if (h === 'servicio_id') return 1;
    if (h === 'estado') return 'confirmada';
    return '';
  });
  seed.hojas.Reservas = [HEADERS_RESERVAS, fila];

  const backend = cargarBackend({ hojas: seed.hojas });
  const res = backend.ctx.crearReserva(datosReserva(seed, { hora: '10:00' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /ya no está disponible/);
});

test('crearReserva escribe por encabezado y devuelve el resumen', () => {
  const { ctx } = cargarBackend({ hojas: {} });
  const seed = seedCompleto(ctx);
  // Reordenamos las columnas para probar que no depende de la posición.
  const headersDesordenados = [...HEADERS_RESERVAS].reverse();
  seed.hojas.Reservas = [headersDesordenados];

  const backend = cargarBackend({ hojas: seed.hojas });
  const res = backend.ctx.crearReserva(datosReserva(seed));

  assert.equal(res.ok, true, res.error);
  assert.equal(res.resumen.servicio, 'Corte clásico');
  assert.equal(res.resumen.especialista, 'Rodrigo');
  assert.equal(res.resumen.hora, '10:00');
  assert.ok(res.codigoReserva);

  const hoja = backend.hojas.get('Reservas');
  const escrita = hoja.__data[1];
  const val = (h) => escrita[hoja.__col(h)];
  assert.equal(String(val('id')), '1');
  assert.equal(val('cliente_nombre'), 'Juan Pérez');
  assert.equal(val('cliente_telefono'), '5491123456789');
  assert.equal(val('estado'), 'pendiente');
  assert.equal(val('notas'), '=HYPERLINK("http://evil","x")');
  assert.equal(String(val('especialista_id')), '1');
  assert.equal(String(val('servicio_id')), '1');

  // La fecha y las horas quedan guardadas como instantes coherentes con la
  // zona del negocio, no con la zona del manifest.
  assert.equal(backend.ctx.formatearFechaISO_(val('fecha'), 'America/Santiago'), seed.fecha.iso);
  assert.equal(backend.ctx.minutosAHHMM_(backend.ctx.minutosDeFecha_(val('hora_inicio'), 'America/Santiago')), '10:00');
  assert.equal(backend.ctx.minutosAHHMM_(backend.ctx.minutosDeFecha_(val('hora_fin'), 'America/Santiago')), '10:30');
});

test('actualizarEstadoReserva_ valida fila y estado, y actualiza la celda', () => {
  const { ctx } = cargarBackend({ hojas: {} });
  const seed = seedCompleto(ctx);
  const f = new Date(seed.fecha.date);
  f.setHours(12, 0, 0, 0);
  const fila = HEADERS_RESERVAS.map((h) => {
    if (h === 'id') return 1;
    if (h === 'fecha') return f;
    if (h === 'hora_inicio') return '15:00';
    if (h === 'hora_fin') return '15:30';
    if (h === 'especialista_id') return 1;
    if (h === 'servicio_id') return 1;
    if (h === 'cliente_nombre') return 'Ana';
    if (h === 'cliente_telefono') return '5491100000000';
    if (h === 'estado') return 'pendiente';
    return '';
  });
  seed.hojas.Reservas = [HEADERS_RESERVAS, fila];

  const backend = cargarBackend({ hojas: seed.hojas });
  const { ctx: b, cache, hojas } = backend;
  cache.put('admin_token_tok', '1');
  const hoja = hojas.get('Reservas');
  const colEstado = hoja.__col('estado');

  const filaInvalida = b.actualizarEstadoReserva_('tok', 1, 'confirmada', null);
  assert.equal(filaInvalida.ok, false);
  assert.match(filaInvalida.error, /Reserva inválida/);

  const estadoInvalido = b.actualizarEstadoReserva_('tok', 2, 'hackeado', null);
  assert.equal(estadoInvalido.ok, false);
  assert.match(estadoInvalido.error, /Estado de reserva inválido/);

  const ok = b.actualizarEstadoReserva_('tok', 2, 'confirmada', null);
  assert.equal(ok.ok, true);
  assert.equal(hoja.__data[1][colEstado], 'confirmada');

  const sinToken = b.actualizarEstadoReserva_('no-existe', 2, 'confirmada', null);
  assert.equal(sinToken.ok, false);
  assert.match(sinToken.error, /Sesión inválida/);
});

test('generarLinkWhatsappReserva valida la fila antes de leer', () => {
  const { ctx } = cargarBackend({ hojas: {} });
  const seed = seedCompleto(ctx);
  const backend = cargarBackend({ hojas: seed.hojas });

  backend.cache.put('admin_token_tok', '1');
  const res = backend.ctx.generarLinkWhatsappReserva('tok', 1, 'confirmacion');
  assert.equal(res.ok, false);
  assert.match(res.error, /Reserva inválida/);
});

// ---------------------------------------------------------------------------
// Catálogos y días especiales (Etapa 3)
// ---------------------------------------------------------------------------

const HEADERS_DIAS = ['id', 'fecha', 'abierto', 'hora_inicio', 'hora_fin', 'especialista_id', 'notas', 'activo'];

function proximoDiaSemana(dia, ctx) {
  const hoy = new Date();
  let delta = (dia - hoy.getDay() + 7) % 7;
  if (delta === 0) delta = 7; // siempre futuro
  const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + delta, 12, 0, 0);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { iso, dia: ctx.DIAS_SEMANA[d.getDay()], date: d };
}

function backendAdmin(seed) {
  const backend = cargarBackend({ hojas: seed.hojas });
  backend.cache.put('admin_token_tok', '1');
  return backend;
}

test('getDiasEspeciales_ no crea la hoja en el flujo público', () => {
  const backend = cargarBackend({ hojas: { Config: configBase() } });
  assert.deepEqual([...backend.ctx.getDiasEspeciales_()], []);
  assert.equal(backend.hojas.has('DiasEspeciales'), false);
});

test('días especiales: abre un domingo sin horario semanal', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const domingo = proximoDiaSemana(0, base);

  const sinRegla = seedCompleto(base);
  // Horario fijo en lunes: si el seed usa "3 días desde hoy", cerca de la
  // medianoche puede caer justo en domingo y el test dejaría de probar el caso.
  sinRegla.hojas.Horarios = [
    ['especialista_id', 'dia_semana', 'hora_inicio', 'hora_fin', 'activo'],
    [1, 'Lunes', '09:00', '18:00', 'TRUE'],
  ];
  const backendSin = cargarBackend({ hojas: sinRegla.hojas });
  const falla = backendSin.ctx.crearReserva(datosReserva(sinRegla, { fecha: domingo.iso, hora: '10:00' }));
  assert.equal(falla.ok, false);
  assert.match(falla.error, /ya no está disponible/);

  const conRegla = seedCompleto(base);
  conRegla.hojas.DiasEspeciales = [
    HEADERS_DIAS,
    [1, domingo.iso, 'TRUE', '10:00', '13:00', 'TODOS', 'Domingo especial', 'TRUE'],
  ];
  const backend = cargarBackend({ hojas: conRegla.hojas });
  const ok = backend.ctx.crearReserva(datosReserva(conRegla, { fecha: domingo.iso, hora: '10:00' }));
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.resumen.hora, '10:00');
});

test('días especiales: cierra una fecha que normalmente tiene horario', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(base);
  seed.hojas.DiasEspeciales = [
    HEADERS_DIAS,
    [1, seed.fecha.iso, 'FALSE', '', '', 'TODOS', 'Feriado', 'TRUE'],
  ];
  const backend = cargarBackend({ hojas: seed.hojas });
  const res = backend.ctx.crearReserva(datosReserva(seed, { hora: '10:00' }));
  assert.equal(res.ok, false);
  assert.match(res.error, /ya no está disponible/);
});

test('días especiales: la regla del especialista pisa la global (cierre global, apertura propia)', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const domingo = proximoDiaSemana(0, base);

  const seed = seedCompleto(base, {
    hojas: {
      Especialistas: [
        ['id', 'nombre', 'foto_url', 'color', 'activo', 'orden'],
        [1, 'Rodrigo', '', '#1B4332', 'TRUE', 1],
        [2, 'Camila', '', '#B08947', 'TRUE', 2],
      ],
      Horarios: [
        ['especialista_id', 'dia_semana', 'hora_inicio', 'hora_fin', 'activo'],
        [1, domingo.dia, '09:00', '13:00', 'TRUE'],
        [2, domingo.dia, '09:00', '13:00', 'TRUE'],
      ],
      DiasEspeciales: [
        HEADERS_DIAS,
        [1, domingo.iso, 'FALSE', '', '', 'TODOS', 'Feriado', 'TRUE'],
        [2, domingo.iso, 'TRUE', '10:00', '12:00', '2', 'Camila abre igual', 'TRUE'],
      ],
    },
  });
  const backend = cargarBackend({ hojas: seed.hojas });

  const rodrigo = backend.ctx.crearReserva(datosReserva(seed, {
    especialistaId: 1, fecha: domingo.iso, hora: '10:00',
  }));
  assert.equal(rodrigo.ok, false);
  assert.match(rodrigo.error, /ya no está disponible/);

  const camila = backend.ctx.crearReserva(datosReserva(seed, {
    especialistaId: 2, fecha: domingo.iso, hora: '10:00',
  }));
  assert.equal(camila.ok, true, camila.error);
  assert.equal(camila.resumen.hora, '10:00');
});

test('días especiales: la regla del especialista pisa la global (apertura global, cierre propio)', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const domingo = proximoDiaSemana(0, base);

  const seed = seedCompleto(base, {
    hojas: {
      Especialistas: [
        ['id', 'nombre', 'foto_url', 'color', 'activo', 'orden'],
        [1, 'Rodrigo', '', '#1B4332', 'TRUE', 1],
        [2, 'Camila', '', '#B08947', 'TRUE', 2],
      ],
      DiasEspeciales: [
        HEADERS_DIAS,
        [1, domingo.iso, 'TRUE', '10:00', '12:00', 'TODOS', 'Domingo abierto', 'TRUE'],
        [2, domingo.iso, 'FALSE', '', '', '2', 'Camila no atiende', 'TRUE'],
      ],
    },
  });
  const backend = cargarBackend({ hojas: seed.hojas });

  const rodrigo = backend.ctx.crearReserva(datosReserva(seed, {
    especialistaId: 1, fecha: domingo.iso, hora: '10:00',
  }));
  assert.equal(rodrigo.ok, true, rodrigo.error);

  const camila = backend.ctx.crearReserva(datosReserva(seed, {
    especialistaId: 2, fecha: domingo.iso, hora: '10:00',
  }));
  assert.equal(camila.ok, false);
  assert.match(camila.error, /ya no está disponible/);
});

test('getCatalogosAdmin exige token y crea DiasEspeciales', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const backend = backendAdmin(seedCompleto(base));

  const sinToken = backend.ctx.getCatalogosAdmin('no-existe');
  assert.equal(sinToken.ok, false);
  assert.match(sinToken.error, /Sesión inválida/);

  const res = backend.ctx.getCatalogosAdmin('tok');
  assert.equal(res.ok, true);
  assert.equal(backend.hojas.has('DiasEspeciales'), true);
  assert.equal(res.especialistas.length, 2);
  assert.equal(res.servicios.length, 3);
  assert.equal(res.horarios.length, 1);
  assert.equal(res.dias.length, 0);
  assert.equal(res.bloqueos.length, 0);
});

test('guardarServicioAdmin crea, edita y valida', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const backend = backendAdmin(seedCompleto(base));

  const sinToken = backend.ctx.guardarServicioAdmin('no', { nombre: 'X' });
  assert.equal(sinToken.ok, false);
  assert.match(sinToken.error, /Sesión inválida/);

  const nuevo = backend.ctx.guardarServicioAdmin('tok', {
    nombre: 'Barba', duracion_minutos: 20, precio: 2500, especialista_id: 'TODOS', descripcion: '', activo: true,
  });
  assert.equal(nuevo.ok, true, nuevo.error);
  assert.equal(nuevo.id, 4);
  const hoja = backend.hojas.get('Servicios');
  const filaNueva = hoja.__data[hoja.__data.length - 1];
  assert.equal(filaNueva[hoja.__col('nombre')], 'Barba');
  assert.equal(Number(filaNueva[hoja.__col('id')]), 4);

  const editado = backend.ctx.guardarServicioAdmin('tok', {
    row: 2, id: 1, nombre: 'Corte premium', duracion_minutos: 45, precio: 9000, especialista_id: '1', activo: true,
  });
  assert.equal(editado.ok, true, editado.error);
  const filaEditada = hoja.__data[1];
  assert.equal(filaEditada[hoja.__col('nombre')], 'Corte premium');
  assert.equal(Number(filaEditada[hoja.__col('duracion_minutos')]), 45);
  assert.equal(String(filaEditada[hoja.__col('especialista_id')]), '1');

  const invalido = backend.ctx.guardarServicioAdmin('tok', {
    nombre: 'Corto', duracion_minutos: 2, precio: 100, especialista_id: 'TODOS', activo: true,
  });
  assert.equal(invalido.ok, false);
  assert.match(invalido.error, /duración/);
});

test('guardarEspecialistaAdmin crea y valida color/foto', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const backend = backendAdmin(seedCompleto(base));

  const nuevo = backend.ctx.guardarEspecialistaAdmin('tok', {
    nombre: 'Nuevo', foto_url: 'https://example.com/foto.jpg', color: '#123456', orden: 3, activo: true,
  });
  assert.equal(nuevo.ok, true, nuevo.error);
  assert.equal(nuevo.id, 3);

  const colorMalo = backend.ctx.guardarEspecialistaAdmin('tok', {
    nombre: 'Otro', color: 'rojo', orden: 4, activo: true,
  });
  assert.equal(colorMalo.ok, false);
  assert.match(colorMalo.error, /Color inválido/);

  const fotoMala = backend.ctx.guardarEspecialistaAdmin('tok', {
    nombre: 'Otro', foto_url: 'javascript:alert(1)', orden: 4, activo: true,
  });
  assert.equal(fotoMala.ok, false);
  assert.match(fotoMala.error, /foto/);
});

test('guardarHorarioAdmin valida día y rango, y escribe la fila', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const backend = backendAdmin(seedCompleto(base));
  const hoja = backend.hojas.get('Horarios');

  const ok = backend.ctx.guardarHorarioAdmin('tok', {
    especialista_id: '1', dia_semana: 'Lunes', hora_inicio: '09:00', hora_fin: '13:00', activo: true,
  });
  assert.equal(ok.ok, true, ok.error);
  const nueva = hoja.__data[hoja.__data.length - 1];
  assert.equal(nueva[hoja.__col('dia_semana')], 'Lunes');
  assert.equal(nueva[hoja.__col('hora_inicio')], '09:00');

  const diaMalo = backend.ctx.guardarHorarioAdmin('tok', {
    especialista_id: '1', dia_semana: 'Funday', hora_inicio: '09:00', hora_fin: '13:00', activo: true,
  });
  assert.equal(diaMalo.ok, false);
  assert.match(diaMalo.error, /Día de la semana/);

  const rangoMalo = backend.ctx.guardarHorarioAdmin('tok', {
    especialista_id: '1', dia_semana: 'Lunes', hora_inicio: '13:00', hora_fin: '09:00', activo: true,
  });
  assert.equal(rangoMalo.ok, false);
  assert.match(rangoMalo.error, /posterior/);

  const todos = backend.ctx.guardarHorarioAdmin('tok', {
    especialista_id: 'TODOS', dia_semana: 'Lunes', hora_inicio: '09:00', hora_fin: '13:00', activo: true,
  });
  assert.equal(todos.ok, false);
  assert.match(todos.error, /especialista válido/);
});

test('guardarDiaEspecialAdmin crea, evita duplicados y valida fecha', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const domingo = proximoDiaSemana(0, base);
  const backend = backendAdmin(seedCompleto(base));

  const ok = backend.ctx.guardarDiaEspecialAdmin('tok', {
    fecha: domingo.iso, abierto: true, hora_inicio: '10:00', hora_fin: '13:00',
    especialista_id: 'TODOS', notas: 'Domingo especial', activo: true,
  });
  assert.equal(ok.ok, true, ok.error);
  const hoja = backend.hojas.get('DiasEspeciales');
  assert.ok(hoja);
  assert.equal(hoja.__data.length, 2);

  const duplicado = backend.ctx.guardarDiaEspecialAdmin('tok', {
    fecha: domingo.iso, abierto: true, hora_inicio: '11:00', hora_fin: '12:00',
    especialista_id: 'TODOS', activo: true,
  });
  assert.equal(duplicado.ok, false);
  assert.match(duplicado.error, /Ya existe/);

  const porEspecialista = backend.ctx.guardarDiaEspecialAdmin('tok', {
    fecha: domingo.iso, abierto: true, hora_inicio: '14:00', hora_fin: '16:00',
    especialista_id: '1', activo: true,
  });
  assert.equal(porEspecialista.ok, true, porEspecialista.error);

  const cerrado = backend.ctx.guardarDiaEspecialAdmin('tok', {
    fecha: domingo.iso, abierto: false, especialista_id: '2', activo: true,
  });
  assert.equal(cerrado.ok, true, cerrado.error);

  const fechaMala = backend.ctx.guardarDiaEspecialAdmin('tok', {
    fecha: '2026-02-30', abierto: false, especialista_id: 'TODOS', activo: true,
  });
  assert.equal(fechaMala.ok, false);
  assert.match(fechaMala.error, /Fecha inválida/);
});

test('cambiarActivo y eliminar respetan las reglas de cada catálogo', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const backend = backendAdmin(seedCompleto(base));

  const ok = backend.ctx.cambiarActivoCatalogoAdmin('tok', 'servicio', 2, false);
  assert.equal(ok.ok, true, ok.error);
  const hojaServicios = backend.hojas.get('Servicios');
  assert.equal(hojaServicios.__data[1][hojaServicios.__col('activo')], 'FALSE');

  const tipoMalo = backend.ctx.cambiarActivoCatalogoAdmin('tok', 'otro', 2, true);
  assert.equal(tipoMalo.ok, false);
  assert.match(tipoMalo.error, /Tipo de catálogo/);

  const noSeBorra = backend.ctx.eliminarCatalogoAdmin('tok', 'servicio', 2);
  assert.equal(noSeBorra.ok, false);
  assert.match(noSeBorra.error, /desactivalo/);

  const hojaHorarios = backend.hojas.get('Horarios');
  const antes = hojaHorarios.__data.length;
  const borrado = backend.ctx.eliminarCatalogoAdmin('tok', 'horario', 2);
  assert.equal(borrado.ok, true, borrado.error);
  assert.equal(hojaHorarios.__data.length, antes - 1);
});

test('guardarBloqueoAdmin crea, edita, valida y elimina', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const backend = backendAdmin(seedCompleto(base));
  const hoja = backend.hojas.get('Bloqueos');

  const todoElDia = backend.ctx.guardarBloqueoAdmin('tok', {
    especialista_id: '1',
    fecha_inicio: '2026-11-20',
    fecha_fin: '2026-11-22',
    todo_el_dia: true,
  });
  assert.equal(todoElDia.ok, true, todoElDia.error);
  const fila = hoja.__data[hoja.__data.length - 1];
  assert.equal(fila[hoja.__col('especialista_id')], '1');
  assert.equal(fila[hoja.__col('fecha_inicio')], '2026-11-20');
  assert.equal(fila[hoja.__col('fecha_fin')], '2026-11-22');
  assert.equal(fila[hoja.__col('hora_inicio')], '');

  const catalogo = backend.ctx.getCatalogosAdmin('tok');
  assert.equal(catalogo.ok, true);
  assert.equal(catalogo.bloqueos.length, 1);
  assert.equal(catalogo.bloqueos[0].todo_el_dia, true);
  assert.equal(catalogo.bloqueos[0].especialista, 'Rodrigo');

  const conHoras = backend.ctx.guardarBloqueoAdmin('tok', {
    row: 2,
    especialista_id: 'TODOS',
    fecha_inicio: '2026-11-20',
    fecha_fin: '2026-11-20',
    todo_el_dia: false,
    hora_inicio: '12:00',
    hora_fin: '13:00',
  });
  assert.equal(conHoras.ok, true, conHoras.error);
  const editada = hoja.__data[1];
  assert.equal(editada[hoja.__col('especialista_id')], 'TODOS');
  assert.equal(editada[hoja.__col('hora_inicio')], '12:00');
  assert.equal(editada[hoja.__col('hora_fin')], '13:00');

  const rangoMalo = backend.ctx.guardarBloqueoAdmin('tok', {
    especialista_id: 'TODOS', fecha_inicio: '2026-11-22', fecha_fin: '2026-11-20', todo_el_dia: true,
  });
  assert.equal(rangoMalo.ok, false);
  assert.match(rangoMalo.error, /anterior/);

  const horasMalas = backend.ctx.guardarBloqueoAdmin('tok', {
    especialista_id: 'TODOS', fecha_inicio: '2026-11-20', fecha_fin: '2026-11-20',
    todo_el_dia: false, hora_inicio: '13:00', hora_fin: '12:00',
  });
  assert.equal(horasMalas.ok, false);
  assert.match(horasMalas.error, /posterior/);

  const espMalo = backend.ctx.guardarBloqueoAdmin('tok', {
    especialista_id: '99', fecha_inicio: '2026-11-20', fecha_fin: '2026-11-20', todo_el_dia: true,
  });
  assert.equal(espMalo.ok, false);
  assert.match(espMalo.error, /no existe/);

  const antes = hoja.__data.length;
  const borrado = backend.ctx.eliminarCatalogoAdmin('tok', 'bloqueo', 2);
  assert.equal(borrado.ok, true, borrado.error);
  assert.equal(hoja.__data.length, antes - 1);
});

test('un bloqueo de día completo quita la fecha de la disponibilidad pública', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(base);
  const f = seed.fecha;

  // Las celdas se escriben como texto (formato '@'), así que la hoja devuelve
  // strings: el caso que antes se corría un día por el parseo UTC de new Date().
  seed.hojas.Bloqueos = [
    ['especialista_id', 'fecha_inicio', 'fecha_fin', 'hora_inicio', 'hora_fin'],
    ['TODOS', f.iso, f.iso, '', ''],
  ];

  const backend = cargarBackend({ hojas: seed.hojas });
  const [anio, mes] = f.iso.split('-').map(Number);
  const disp = backend.ctx.obtenerMesDisponibilidad('1', '1', anio, mes);
  assert.equal(disp[f.iso].length, 0);
});

test('un bloqueo por franja horaria descuenta solo esos turnos', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(base);
  const f = seed.fecha;

  seed.hojas.Bloqueos = [
    ['especialista_id', 'fecha_inicio', 'fecha_fin', 'hora_inicio', 'hora_fin'],
    ['1', f.iso, f.iso, '10:00', '11:00'],
  ];

  const backend = cargarBackend({ hojas: seed.hojas });
  const [anio, mes] = f.iso.split('-').map(Number);
  const slots = backend.ctx.obtenerMesDisponibilidad('1', '1', anio, mes)[f.iso];

  assert.ok(slots.length > 0);
  assert.equal(slots.indexOf('09:00'), 0);
  assert.equal(slots.indexOf('10:00'), -1);
  assert.equal(slots.indexOf('10:30'), -1);
  assert.ok(slots.indexOf('11:00') > -1);
});

test('getReportesAdmin suma ingresos, excluye canceladas y calcula ocupación', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(base);

  const fila = (id, servicio, estado, fecha) => {
    const f = [...HEADERS_RESERVAS].map((h) => {
      if (h === 'id') return id;
      if (h === 'fecha') return fecha;
      if (h === 'hora_inicio') return '10:00';
      if (h === 'hora_fin') return '10:30';
      if (h === 'especialista_id') return 1;
      if (h === 'servicio_id') return servicio;
      if (h === 'estado') return estado;
      if (h === 'cliente_nombre') return 'Cliente ' + id;
      return '';
    });
    return f;
  };

  seed.hojas.Reservas = [
    HEADERS_RESERVAS,
    fila(1, 1, 'confirmada', '2026-11-05'),
    fila(2, 2, 'completada', '2026-11-06'),
    fila(3, 1, 'cancelada', '2026-11-07'),
    fila(4, 1, 'pendiente', '2026-11-08'),
  ];

  const backend = backendAdmin(seed);
  const res = backend.ctx.getReportesAdmin('tok', '2026-11-01', '2026-11-30');
  assert.equal(res.ok, true, res.error);

  assert.equal(res.resumen.total, 4);
  assert.equal(res.resumen.pendientes, 1);
  assert.equal(res.resumen.confirmadas, 1);
  assert.equal(res.resumen.completadas, 1);
  assert.equal(res.resumen.canceladas, 1);
  assert.equal(res.resumen.turnosAtendidos, 2);
  assert.equal(res.resumen.ingresos, 11000);
  assert.equal(res.resumen.ticketPromedio, 5500);

  assert.equal(res.porServicio.length, 2);
  const corte = res.porServicio.find((s) => s.nombre === 'Corte clásico');
  assert.equal(corte.turnos, 1);
  assert.equal(corte.ingresos, 5000);

  assert.equal(res.porEspecialista.length, 1);
  assert.equal(res.porEspecialista[0].nombre, 'Rodrigo');
  assert.equal(res.porEspecialista[0].turnos, 2);
  assert.equal(res.porEspecialista[0].ocupados, 3);
  assert.equal(res.porEspecialista[0].ingresos, 11000);
  assert.ok(res.porEspecialista[0].capacidad > 0);
  assert.ok(res.porEspecialista[0].ocupacion >= 0);

  // Segunda llamada: los horarios vienen de la caché (texto "HH:mm"). No debe
  // romper la capacidad ni cambiar la ocupación.
  const res2 = backend.ctx.getReportesAdmin('tok', '2026-11-01', '2026-11-30');
  assert.equal(res2.ok, true, res2.error);
  assert.ok(res2.porEspecialista[0].capacidad > 0);
  assert.equal(res2.resumen.ocupacion, res.resumen.ocupacion);

  assert.equal(res.porDia.length, 30);
  assert.equal(res.porDia[4].fechaISO, '2026-11-05');
  assert.equal(res.porDia[4].turnos, 1);
  assert.equal(res.porDia[6].turnos, 0); // la cancelada no ocupa
});

test('getReportesAdmin valida token, fechas y rango máximo', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const backend = backendAdmin(seedCompleto(base));

  assert.equal(backend.ctx.getReportesAdmin('no', '2026-11-01', '2026-11-30').ok, false);
  assert.match(
    backend.ctx.getReportesAdmin('tok', '2026-11-30', '2026-11-01').error,
    /anterior/
  );
  assert.match(
    backend.ctx.getReportesAdmin('tok', '2024-01-01', '2026-11-30').error,
    /366/
  );
});

test('getReservasAdmin incluye el precio del servicio', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(base);
  seed.hojas.Reservas = [
    HEADERS_RESERVAS,
    [...HEADERS_RESERVAS].map((h) => {
      if (h === 'id') return 1;
      if (h === 'fecha') return '2026-11-05';
      if (h === 'hora_inicio') return '10:00';
      if (h === 'hora_fin') return '10:30';
      if (h === 'especialista_id') return 1;
      if (h === 'servicio_id') return 1;
      if (h === 'estado') return 'confirmada';
      return '';
    }),
  ];

  const backend = backendAdmin(seed);
  const res = backend.ctx.getReservasAdmin('tok');
  assert.equal(res.ok, true);
  assert.equal(res.reservas[0].precio, 5000);
  // La fecha puede venir como texto ISO (seed/carga manual): debe conservar el
  // día de pared y no correrse por interpretarse como medianoche UTC.
  assert.equal(res.reservas[0].fecha, '2026-11-05');
  assert.equal(res.reservas[0].fechaBonita, 'jueves 5 de noviembre');
});

test('calcularSlotsDelDia_ separa turnos según la duración del servicio', () => {
  const { ctx } = cargarBackend({ hojas: {} });
  const fecha = new Date(2026, 10, 16, 12, 0, 0); // lunes 16/11/2026
  const horarios = [
    { especialista_id: 1, dia_semana: 'Lunes', hora_inicio: '09:00', hora_fin: '12:00', activo: 'TRUE' },
  ];

  const slots45 = ctx.calcularSlotsDelDia_(fecha, horarios, [], [], 45, 30, new Date(), 0, ZONA, [], 1);
  assert.deepEqual(Array.from(slots45), ['09:00', '09:45', '10:30', '11:15']);

  // Un servicio de 30 min sí conserva el intervalo configurado.
  const slots30 = ctx.calcularSlotsDelDia_(fecha, horarios, [], [], 30, 30, new Date(), 0, ZONA, [], 1);
  assert.equal(slots30[0], '09:00');
  assert.equal(slots30[1], '09:30');
});

test('crearReserva guarda metodo_pago y rechaza uno inválido', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(base);
  const backend = cargarBackend({ hojas: seed.hojas });

  const res = backend.ctx.crearReserva(datosReserva(seed, { metodoPago: 'qr' }));
  assert.equal(res.ok, true, res.error);
  assert.equal(res.metodoPago, 'qr');

  const hoja = backend.hojas.get('Reservas');
  assert.equal(hoja.__data[1][hoja.__col('metodo_pago')], 'qr');

  const malo = backend.ctx.crearReserva(datosReserva(seed, { hora: '11:00', metodoPago: 'cripto' }));
  assert.equal(malo.ok, false);
  assert.match(malo.error, /Forma de pago/i);
});

test('guardarConfigAdmin hace upsert y getConfigAdmin expone las claves', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const backend = backendAdmin(seedCompleto(base));
  const qr = 'data:image/png;base64,' + 'A'.repeat(80);

  const res = backend.ctx.guardarConfigAdmin('tok', {
    negocio_nombre: 'Bosque Nuevo',
    negocio_direccion: 'Calle 1 #234, Yacuiba',
    pago_efectivo: true,
    pago_qr: true,
    pago_qr_imagen: qr,
    pago_instrucciones: 'Pagá el monto exacto y mandá el comprobante.',
  });
  assert.equal(res.ok, true, res.error);

  const hoja = backend.hojas.get('Config');
  const cfg = Object.fromEntries(hoja.__data.slice(1).map((f) => [String(f[0]).trim(), f[1]]));
  assert.equal(cfg.negocio_nombre, 'Bosque Nuevo');
  assert.equal(cfg.negocio_direccion, 'Calle 1 #234, Yacuiba');
  assert.equal(cfg.pago_efectivo, 'TRUE');
  assert.equal(cfg.pago_qr, 'TRUE');
  assert.equal(cfg.pago_qr_imagen, qr);

  // No debe duplicar la clave: sigue habiendo una sola fila de negocio_nombre.
  assert.equal(hoja.__data.filter((f) => f[0] === 'negocio_nombre').length, 1);

  const lectura = backend.ctx.getConfigAdmin('tok');
  assert.equal(lectura.ok, true);
  assert.equal(lectura.config.pago_qr_imagen, qr);
  assert.equal(lectura.config.pago_efectivo, 'TRUE');

  const sinPagos = backend.ctx.guardarConfigAdmin('tok', {
    negocio_nombre: 'Bosque Nuevo',
    pago_efectivo: false,
    pago_qr: false,
  });
  assert.equal(sinPagos.ok, false);
  assert.match(sinPagos.error, /al menos una forma de pago/i);
});

test('getDashboardAdmin calcula hoy, semana, mes y rankings', () => {
  const base = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(base);

  const hoy = new Date();
  const futura = new Date();
  futura.setDate(futura.getDate() + 3);

  const fila = (id, fecha, servicioId, estado) => HEADERS_RESERVAS.map((h) => {
    if (h === 'id') return id;
    if (h === 'fecha') return fecha;
    if (h === 'hora_inicio') return '10:00';
    if (h === 'hora_fin') return '10:30';
    if (h === 'especialista_id') return 1;
    if (h === 'servicio_id') return servicioId;
    if (h === 'cliente_nombre') return 'Cliente';
    if (h === 'estado') return estado;
    return '';
  });

  seed.hojas.Reservas = [
    HEADERS_RESERVAS,
    fila(1, hoy, 1, 'confirmada'),
    fila(2, hoy, 2, 'completada'),
    fila(3, hoy, 1, 'pendiente'),
    fila(4, hoy, 1, 'cancelada'),
    fila(5, futura, 1, 'confirmada'),
  ];

  const backend = backendAdmin(seed);
  const res = backend.ctx.getDashboardAdmin('tok');
  assert.equal(res.ok, true, res.error);

  // Solo confirmadas/completadas de hoy: 5000 + 6000.
  assert.equal(res.hoy.ingresos, 11000);
  assert.equal(res.hoy.turnos, 2);
  assert.equal(res.semana.ingresos, 11000);
  assert.equal(res.mes.ingresos, 11000);

  assert.equal(res.especialistas.length, 1);
  assert.equal(res.especialistas[0].nombre, 'Rodrigo');
  assert.equal(res.especialistas[0].ingresos, 11000);
  assert.equal(res.especialistas[0].turnos, 2);

  assert.deepEqual(Array.from(res.servicios.map((s) => s.nombre)), ['Solo Rodrigo', 'Corte clásico']);
  assert.equal(res.servicios[0].turnos, 1);
  assert.equal(res.servicios[0].ingresos, 6000);

  assert.equal(backend.ctx.getDashboardAdmin('no').ok, false);
});

// ---------------------------------------------------------------------------
// setup() — instalación idempotente
// ---------------------------------------------------------------------------

test('setup crea todas las hojas requeridas con sus encabezados', () => {
  const backend = cargarBackend({ hojas: {} });
  const res = backend.ctx.setup();

  assert.equal(res.ok, true);
  const nombres = ['Config', 'Especialistas', 'Servicios', 'Horarios', 'Bloqueos', 'Reservas', 'DiasEspeciales', 'Fidelidad', 'Beneficios'];
  for (const nombre of nombres) {
    const hoja = backend.hojas.get(nombre);
    assert.ok(hoja, `falta la hoja ${nombre}`);
    assert.ok(hoja.__data.length >= 1, `${nombre} quedó sin encabezado`);
  }

  assert.deepEqual(backend.hojas.get('Config').__data[0], ['clave', 'valor']);
  assert.deepEqual(backend.hojas.get('Reservas').__data[0], HEADERS_RESERVAS);
  assert.equal(res.hojasCreadas.length, nombres.length);
});

test('setup es idempotente: no duplica hojas, encabezados ni claves', () => {
  const backend = cargarBackend({ hojas: {} });
  backend.ctx.setup();
  const filasConfig = backend.hojas.get('Config').__data.length;

  const segunda = backend.ctx.setup();

  assert.deepEqual(Array.from(segunda.hojasCreadas), []);
  assert.deepEqual(Object.keys(segunda.headersAgregados), []);
  assert.deepEqual(Array.from(segunda.configAgregada), []);
  assert.equal(backend.hojas.get('Config').__data.length, filasConfig);
});

test('setup agrega columnas faltantes sin tocar los datos existentes', () => {
  const faltantes = ['metodo_pago', 'beneficio_id', 'es_beneficio'];
  const headersViejos = HEADERS_RESERVAS.filter((h) => faltantes.indexOf(h) === -1);
  const backend = cargarBackend({
    hojas: {
      Reservas: [
        headersViejos,
        [1, 'ABC123', '2026-11-20', '10:00', '10:30', 1, 1, 'Ana', '123', '', 'confirmada', '', '2026-11-19'],
      ],
    },
  });

  const res = backend.ctx.setup();
  const hoja = backend.hojas.get('Reservas');

  assert.deepEqual(Array.from(res.headersAgregados.Reservas), faltantes);
  assert.equal(hoja.__data[0].length, HEADERS_RESERVAS.length);
  assert.equal(hoja.__data[0][HEADERS_RESERVAS.length - 1], 'es_beneficio');
  assert.equal(hoja.__data[1][0], 1);
  assert.equal(hoja.__data[1][7], 'Ana');
});

test('setup respeta los valores de Config ya cargados', () => {
  const backend = cargarBackend({
    hojas: {
      Config: [
        ['clave', 'valor'],
        ['negocio_nombre', 'Barbería El Roble'],
        ['zona_horaria', 'America/La_Paz'],
      ],
    },
  });

  const res = backend.ctx.setup();
  const filas = backend.hojas.get('Config').__data;

  assert.ok(!res.configAgregada.includes('negocio_nombre'));
  assert.ok(res.configAgregada.includes('moneda'));
  assert.equal(filas.filter((f) => f[0] === 'negocio_nombre').length, 1);
  assert.equal(filas.find((f) => f[0] === 'negocio_nombre')[1], 'Barbería El Roble');
});

// ---------------------------------------------------------------------------
// Fidelidad
// ---------------------------------------------------------------------------

function filaReserva(over = {}) {
  const base = {
    id: 1,
    codigo_reserva: 'RES-0001',
    fecha: '2026-01-01',
    hora_inicio: '10:00',
    hora_fin: '10:30',
    especialista_id: 1,
    servicio_id: 1,
    cliente_nombre: 'Cliente',
    cliente_telefono: '5491123456789',
    cliente_email: '',
    estado: 'completada',
    notas: '',
    fecha_creacion: '',
    metodo_pago: '',
    beneficio_id: '',
    es_beneficio: 'FALSE',
    ...over,
  };
  return HEADERS_RESERVAS.map((h) => (base[h] === undefined ? '' : base[h]));
}

function configFidelidad(extra = {}) {
  return {
    fidelidad_activa: 'TRUE',
    fidelidad_visitas_meta: '3',
    fidelidad_servicio_id: '1',
    fidelidad_vigencia_dias: '0',
    ...extra,
  };
}

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('consultarFidelidad devuelve inactiva cuando el programa está apagado', () => {
  const ctx = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(ctx);
  const backend = cargarBackend(seed);

  const res = backend.ctx.consultarFidelidad('+54 9 11 2345-6789');

  assert.equal(res.ok, true);
  assert.equal(res.activa, false);
  assert.equal(backend.hojas.has('Fidelidad'), false);
});

test('consultarFidelidad muestra el progreso sin adelantar premios', () => {
  const ctx = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(ctx, {
    config: configFidelidad(),
    hojas: {
      Reservas: [
        HEADERS_RESERVAS,
        filaReserva({ id: 1 }),
        filaReserva({ id: 2 }),
      ],
    },
  });
  const backend = cargarBackend(seed);

  const res = backend.ctx.consultarFidelidad('+54 9 11 2345-6789');

  assert.equal(res.ok, true);
  assert.equal(res.activa, true);
  assert.equal(res.visitasTotales, 2);
  assert.equal(res.visitasDesdePremio, 2);
  assert.equal(res.faltan, 1);
  assert.equal(res.premioDisponible, false);
  assert.equal(res.nombre, undefined); // la respuesta pública no expone el nombre
  assert.equal(backend.hojas.get('Beneficios').__data.length, 1); // solo encabezado
});

test('al completar la meta genera un premio y recalcular no lo duplica', () => {
  const ctx = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(ctx, {
    config: configFidelidad(),
    hojas: {
      Reservas: [
        HEADERS_RESERVAS,
        filaReserva({ id: 1 }),
        filaReserva({ id: 2 }),
        filaReserva({ id: 3 }),
      ],
    },
  });
  const backend = cargarBackend(seed);

  const primera = backend.ctx.recalcularFidelidad_('5491123456789');
  const segunda = backend.ctx.recalcularFidelidad_('5491123456789');

  assert.equal(primera.premioDisponible, true);
  assert.equal(segunda.premioDisponible, true);
  assert.equal(backend.hojas.get('Beneficios').__data.length, 2); // encabezado + 1 premio

  const fid = backend.hojas.get('Fidelidad');
  const fila = fid.__data[1];
  assert.equal(Number(fila[fid.__col('visitas_totales')]), 3);
  assert.equal(Number(fila[fid.__col('premios_ganados')]), 1);
  assert.equal(fila[fid.__col('premio_disponible')], 'TRUE');
});

test('crearReserva con premio cobra 0 y completar la reserva lo canjea', () => {
  const ctx = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(ctx, {
    config: configFidelidad(),
    props: { ADMIN_PIN: '1234' },
    hojas: {
      Reservas: [
        HEADERS_RESERVAS,
        filaReserva({ id: 1 }),
        filaReserva({ id: 2 }),
        filaReserva({ id: 3 }),
      ],
    },
  });
  const backend = cargarBackend(seed);
  const premio = backend.ctx.recalcularFidelidad_('5491123456789');

  const res = backend.ctx.crearReserva(datosReserva(seed, { beneficioId: premio.beneficioId }));

  assert.equal(res.ok, true);
  assert.equal(res.resumen.precio, 0);
  assert.equal(res.resumen.esBeneficio, true);

  const hojaReservas = backend.hojas.get('Reservas');
  const filaNueva = hojaReservas.__data[hojaReservas.__data.length - 1];
  assert.equal(filaNueva[hojaReservas.__col('es_beneficio')], 'TRUE');
  assert.equal(String(filaNueva[hojaReservas.__col('beneficio_id')]), String(premio.beneficioId));

  const hojaBeneficios = backend.hojas.get('Beneficios');
  assert.equal(hojaBeneficios.__data[1][hojaBeneficios.__col('estado')], 'reservado');

  const token = backend.ctx.iniciarSesionAdmin({ pin: '1234' }).token;
  const completada = backend.ctx.completarReservaAdmin(token, hojaReservas.__data.length);

  assert.equal(completada.ok, true);
  assert.equal(hojaBeneficios.__data[1][hojaBeneficios.__col('estado')], 'canjeado');

  const estado = backend.ctx.consultarFidelidad('5491123456789');
  assert.equal(estado.visitasTotales, 3); // el corte gratis no suma sello
  assert.equal(estado.premioDisponible, false);
  assert.equal(estado.premiosCanjeados, 1);
});

test('un premio no se puede usar desde otro teléfono', () => {
  const ctx = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(ctx, {
    config: configFidelidad(),
    hojas: {
      Reservas: [
        HEADERS_RESERVAS,
        filaReserva({ id: 1 }),
        filaReserva({ id: 2 }),
        filaReserva({ id: 3 }),
      ],
    },
  });
  const backend = cargarBackend(seed);
  const premio = backend.ctx.recalcularFidelidad_('5491123456789');

  const res = backend.ctx.crearReserva(datosReserva(seed, {
    beneficioId: premio.beneficioId,
    telefono: '+54 9 11 0000-0000',
  }));

  assert.equal(res.ok, false);
  assert.match(res.error, /premio/i);

  const hojaBen = backend.hojas.get('Beneficios');
  assert.equal(hojaBen.__data[1][hojaBen.__col('estado')], 'disponible');
});

test('cancelar una reserva con premio lo devuelve a disponible', () => {
  const ctx = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(ctx, {
    config: configFidelidad(),
    props: { ADMIN_PIN: '1234' },
    hojas: {
      Reservas: [
        HEADERS_RESERVAS,
        filaReserva({ id: 1 }),
        filaReserva({ id: 2 }),
        filaReserva({ id: 3 }),
      ],
    },
  });
  const backend = cargarBackend(seed);
  const premio = backend.ctx.recalcularFidelidad_('5491123456789');
  const reserva = backend.ctx.crearReserva(datosReserva(seed, { beneficioId: premio.beneficioId }));
  assert.equal(reserva.ok, true);

  const token = backend.ctx.iniciarSesionAdmin({ pin: '1234' }).token;
  const row = backend.hojas.get('Reservas').__data.length;
  const cancelada = backend.ctx.cancelarReservaAdmin(token, row, 'Cliente no pudo venir');

  assert.equal(cancelada.ok, true);
  const hojaBeneficios = backend.hojas.get('Beneficios');
  assert.equal(hojaBeneficios.__data[1][hojaBeneficios.__col('estado')], 'disponible');

  const estado = backend.ctx.consultarFidelidad('5491123456789');
  assert.equal(estado.premioDisponible, true);
});

test('reportes y dashboard no cuentan los beneficios como ingresos', () => {
  const ctx = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(ctx, {
    props: { ADMIN_PIN: '1234' },
    hojas: {
      Reservas: [
        HEADERS_RESERVAS,
        filaReserva({ id: 1, fecha: hoyISO(), estado: 'completada' }),
        filaReserva({ id: 2, fecha: hoyISO(), estado: 'completada', es_beneficio: 'TRUE', beneficio_id: 1 }),
        filaReserva({ id: 3, fecha: hoyISO(), estado: 'cancelada' }),
      ],
    },
  });
  const backend = cargarBackend(seed);
  const token = backend.ctx.iniciarSesionAdmin({ pin: '1234' }).token;
  const hoy = hoyISO();

  const reporte = backend.ctx.getReportesAdmin(token, hoy, hoy);
  assert.equal(reporte.ok, true);
  assert.equal(reporte.resumen.ingresos, 5000);
  assert.equal(reporte.resumen.turnosAtendidos, 1);
  assert.equal(reporte.resumen.completadas, 2);
  assert.equal(reporte.resumen.beneficios, 1);

  const dashboard = backend.ctx.getDashboardAdmin(token);
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.mes.ingresos, 5000);
  assert.equal(dashboard.mes.turnos, 1);
});

test('guardarConfigAdmin valida la meta y exige servicio al activar fidelidad', () => {
  const ctx = cargarBackend({ hojas: {} }).ctx;
  const seed = seedCompleto(ctx, { props: { ADMIN_PIN: '1234' } });
  const backend = cargarBackend(seed);
  const token = backend.ctx.iniciarSesionAdmin({ pin: '1234' }).token;

  const base = {
    negocio_nombre: 'Bosque & Bronce',
    negocio_direccion: '',
    pago_efectivo: true,
    pago_qr: false,
    pago_instrucciones: '',
    fidelidad_activa: true,
    fidelidad_visitas_meta: 5,
    fidelidad_servicio_id: '1',
    fidelidad_vigencia_dias: 0,
  };

  const sinServicio = backend.ctx.guardarConfigAdmin(token, { ...base, fidelidad_servicio_id: '' });
  assert.equal(sinServicio.ok, false);
  assert.match(sinServicio.error, /Elegí el servicio/);

  const metaInvalida = backend.ctx.guardarConfigAdmin(token, { ...base, fidelidad_visitas_meta: 1 });
  assert.equal(metaInvalida.ok, false);
  assert.match(metaInvalida.error, /entre 2 y 50/);

  const ok = backend.ctx.guardarConfigAdmin(token, base);
  assert.equal(ok.ok, true);

  const cfg = backend.ctx.getConfigAdmin(token);
  assert.equal(cfg.config.fidelidad_activa, 'TRUE');
  assert.equal(cfg.config.fidelidad_visitas_meta, '5');
  assert.equal(cfg.config.fidelidad_servicio_id, '1');
});

// ---------------------------------------------------------------------------
// Datos de demo
// ---------------------------------------------------------------------------

test('sembrarDemo crea el negocio de ejemplo completo y es idempotente', () => {
  const backend = cargarBackend({ hojas: {} });

  const res = backend.ctx.sembrarDemo();
  assert.equal(res.ok, true);
  assert.equal(res.especialistasCreados, 3);
  assert.equal(res.serviciosCreados, 6);
  assert.equal(res.horariosCreados, 15);
  assert.equal(res.reservasCreadas, 12);

  assert.equal(backend.hojas.get('Especialistas').__data.length, 4);
  assert.equal(backend.hojas.get('Servicios').__data.length, 7);
  assert.equal(backend.hojas.get('Horarios').__data.length, 16);
  assert.equal(backend.hojas.get('Reservas').__data.length, 13);

  const datos = backend.ctx.obtenerDatosIniciales();
  assert.equal(datos.especialistas.length, 3);
  assert.equal(datos.servicios.length, 6);
  assert.equal(datos.cfg.negocio_nombre, 'Studio Manicura');
  assert.equal(datos.cfg.rubro_etiqueta_especialista, 'Manicurista');

  const cfg = backend.ctx.getConfig_();
  assert.equal(cfg.fidelidad_activa, 'TRUE');
  assert.equal(cfg.fidelidad_visitas_meta, '5');
  assert.equal(cfg.fidelidad_servicio_id, '1');
  // El WhatsApp necesita el código de país para que wa.me/ funcione.
  assert.equal(String(cfg.negocio_whatsapp), '59170012345');

  // La clienta con 5 visitas completadas ya tiene un premio disponible.
  const fidelidad = backend.hojas.get('Fidelidad').__data;
  const maria = fidelidad.find((f) => String(f[0]).includes('71234567'));
  assert.ok(maria);
  assert.equal(Number(maria[2]), 5);
  assert.equal(String(maria[6]), 'TRUE');
  assert.equal(backend.hojas.get('Beneficios').__data.length, 2); // header + 1 premio

  // Todas las reservas caen en día hábil (martes a sábado).
  const reservas = backend.hojas.get('Reservas').__data.slice(1);
  for (const fila of reservas) {
    const fecha = fila[2];
    const dow = fecha instanceof Date ? fecha.getUTCDay() : null;
    if (dow != null) assert.ok(dow >= 2 && dow <= 6, 'reserva fuera de martes-sábado: ' + fecha);
  }

  // Una segunda ejecución no duplica nada.
  const res2 = backend.ctx.sembrarDemo();
  assert.equal(res2.especialistasCreados, 0);
  assert.equal(res2.serviciosCreados, 0);
  assert.equal(res2.horariosCreados, 0);
  assert.equal(res2.reservasCreadas, 0);
  assert.equal(backend.hojas.get('Especialistas').__data.length, 4);
  assert.equal(backend.hojas.get('Servicios').__data.length, 7);
  assert.equal(backend.hojas.get('Horarios').__data.length, 16);
  assert.equal(backend.hojas.get('Reservas').__data.length, 13);
});

test('asegurarEstructura_ prepara la planilla recién creada', () => {
  const backend = cargarBackend({ hojas: {} });

  assert.equal(backend.ctx.asegurarEstructura_(), true);
  for (const nombre of ['Config', 'Especialistas', 'Servicios', 'Horarios', 'Bloqueos', 'Reservas', 'DiasEspeciales', 'Fidelidad', 'Beneficios']) {
    assert.ok(backend.hojas.get(nombre), 'falta la hoja ' + nombre);
  }
  assert.equal(backend.ctx.asegurarEstructura_(), false);
});

test('sembrarDemo no pisa un WhatsApp que ya tiene número propio', () => {
  const hojas = { Config: configBase({ negocio_whatsapp: '59177777777' }) };
  const backend = cargarBackend({ hojas });

  backend.ctx.sembrarDemo();

  const cfg = backend.ctx.getConfig_();
  assert.equal(String(cfg.negocio_whatsapp), '59177777777');
});
