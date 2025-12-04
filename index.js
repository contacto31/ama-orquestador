require('dotenv').config();

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

const app = express();
app.use(express.json());

// ---------------------------
// Configuracion basica
// ---------------------------

const PORT = process.env.PORT || 3000;

const TRACCAR_URL = process.env.TRACCAR_URL; // ej. "http://31.97.135.112:8082"
const TRACCAR_USER = process.env.TRACCAR_USER;
const TRACCAR_PASSWORD = process.env.TRACCAR_PASSWORD;

// URL del orquestador para eventos de Zona Segura
const ORQ_EVENT_URL = process.env.ORQ_EVENT_URL || null;

// Intervalo de evaluacion de Zona Segura
const ZONA_SEGURA_INTERVALO_SEGUNDOS = parseInt(
  process.env.ZONA_SEGURA_INTERVALO_SEGUNDOS || '60',
  10
);
const ZONA_SEGURA_INTERVALO_MS =
  Number.isNaN(ZONA_SEGURA_INTERVALO_SEGUNDOS) || ZONA_SEGURA_INTERVALO_SEGUNDOS <= 0
    ? 0
    : ZONA_SEGURA_INTERVALO_SEGUNDOS * 1000;

if (!TRACCAR_URL || !TRACCAR_USER || !TRACCAR_PASSWORD) {
  console.warn(
    '⚠️ Falta configurar TRACCAR_URL / TRACCAR_USER / TRACCAR_PASSWORD en .env'
  );
}
if (!ORQ_EVENT_URL) {
  console.warn(
    'ℹ️ ORQ_EVENT_URL no configurada. Se omiten envios de eventos de Zona Segura.'
  );
}

const traccarClient = axios.create({
  baseURL: TRACCAR_URL,
  auth: {
    username: TRACCAR_USER,
    password: TRACCAR_PASSWORD
  },
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

// Umbral de seguridad para corte remoto
const CORTE_UMBRAL_KMH = 20;

// ---------------------------
// Persistencia simple en archivo
// ---------------------------

// Carpeta base donde se guardará vehiculos.json
// En el VPS apunta al volumen (ej: /app/data), y en local usa la carpeta del proyecto
const DATA_DIR = process.env.DATA_DIR || __dirname;
const VEHICULOS_FILE = path.join(DATA_DIR, 'vehiculos.json');
let VEHICULOS = {};
let ESTADO_CORTE = {}; // memoria en runtime
let ESTADO_ZONA = {}; // estado de zona segura por vehiculo: 'dentro' | 'fuera' | 'fuera_horario' | 'desconocido'

function cargarVehiculos() {
  try {
    if (fs.existsSync(VEHICULOS_FILE)) {
      const raw = fs.readFileSync(VEHICULOS_FILE, 'utf8');
      VEHICULOS = raw ? JSON.parse(raw) : {};
    } else {
      VEHICULOS = {};
    }
  } catch (err) {
    console.error('Error cargando vehiculos.json:', err.message);
    VEHICULOS = {};
  }
}

function guardarVehiculos() {
  try {
    fs.writeFileSync(VEHICULOS_FILE, JSON.stringify(VEHICULOS, null, 2), 'utf8');
  } catch (err) {
    console.error('Error guardando vehiculos.json:', err.message);
  }
}

cargarVehiculos();

// ---------------------------
// Helpers Traccar
// ---------------------------

async function getAllDevices() {
  const resp = await traccarClient.get('/api/devices');
  return resp.data || [];
}

async function getDeviceAndPositionByUniqueId(uniqueId) {
  const devices = await getAllDevices();
  const device = devices.find((d) => d.uniqueId === uniqueId);
  if (!device) {
    throw new Error('Device no encontrado para uniqueId ' + uniqueId);
  }

  let position = null;
  if (device.positionId) {
    const posResp = await traccarClient.get('/api/positions', {
      params: { id: device.positionId }
    });
    if (Array.isArray(posResp.data) && posResp.data.length > 0) {
      position = posResp.data[0];
    }
  }

  return { device, position };
}

async function crearOActualizarDeviceEnTraccar(uniqueId, name) {
  const devices = await getAllDevices();
  let device = devices.find((d) => d.uniqueId === uniqueId);

  if (device) {
    if (device.name !== name) {
      const resp = await traccarClient.put(`/api/devices/${device.id}`, {
        ...device,
        name
      });
      device = resp.data;
    }
  } else {
    const resp = await traccarClient.post('/api/devices', {
      name,
      uniqueId
    });
    device = resp.data;
  }

  return device;
}

async function sendCommandToDevice(uniqueId, type) {
  const { device } = await getDeviceAndPositionByUniqueId(uniqueId);

  const resp = await traccarClient.post('/api/commands/send', {
    deviceId: device.id,
    type
  });

  return {
    device,
    command: resp.data
  };
}

// ---------------------------
// Helpers varios
// ---------------------------

function utcToLocalMx(isoString) {
  if (!isoString) return null;
  return DateTime.fromISO(isoString, { zone: 'utc' })
    .setZone('America/Mexico_City')
    .toISO();
}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  function toRad(g) {
    return (g * Math.PI) / 180;
  }
  const R = 6371000; // metros
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function horaDentroDeVentana(horaInicio, horaFin, dtLocal) {
  if (!horaInicio || !horaFin) return true;
  const [hIni, mIni] = horaInicio.split(':').map(Number);
  const [hFin, mFin] = horaFin.split(':').map(Number);
  const minutosActual = dtLocal.hour * 60 + dtLocal.minute;
  const minutosIni = hIni * 60 + mIni;
  const minutosFin = hFin * 60 + mFin;

  if (Number.isNaN(minutosIni) || Number.isNaN(minutosFin)) return true;

  if (minutosIni <= minutosFin) {
    return minutosActual >= minutosIni && minutosActual <= minutosFin;
  }

  // Cruza medianoche
  return minutosActual >= minutosIni || minutosActual <= minutosFin;
}

function codigoDiaSemanaMx(dtLocal) {
  const dias = ['DO', 'LU', 'MA', 'MI', 'JU', 'VI', 'SA'];
  const idx = dtLocal.weekday % 7; // 1..7
  return dias[idx];
}

function knotsToKmh(knots) {
  if (typeof knots !== 'number') return null;
  return knots * 1.852;
}

// ---------------------------
// Eventos de Zona Segura
// ---------------------------

async function enviarEventoSalidaZonaSegura({
  vehiculoId,
  config,
  zona,
  position,
  distancia
}) {
  if (!ORQ_EVENT_URL) {
    // No hay URL configurada, solo registramos en logs
    console.warn(
      `Evento FUERA_DE_ZONA_SEGURA para ${vehiculoId} (no se envio, ORQ_EVENT_URL vacia)`
    );
    return;
  }

  try {
    const rawTime =
      position.serverTime || position.deviceTime || position.fixTime || null;
    const horaLocal = utcToLocalMx(rawTime);
    const lat = position.latitude;
    const lon = position.longitude;

    const googleMapsUrl =
      lat != null && lon != null
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
        : null;

    const bodyEvento = {
      tipoEvento: 'FUERA_DE_ZONA_SEGURA',
      vehiculoId,
      contratoId: config.contratoId,
      uniqueId: config.uniqueId || null,
      distancia_m: distancia,
      radio_cliente_m: zona.radio_cliente_m,
      radio_interno_m: zona.radio_interno_m,
      lat,
      lon,
      hora_evento_utc: rawTime,
      hora_evento_local: horaLocal,
      google_maps_url: googleMapsUrl,
      zonaSegura: {
        nombre: zona.nombre,
        diasSemana: zona.diasSemana,
        horaInicio: zona.horaInicio,
        horaFin: zona.horaFin
      }
    };

    await axios.post(ORQ_EVENT_URL, bodyEvento);
    console.log(
      `Evento FUERA_DE_ZONA_SEGURA enviado para vehiculo ${vehiculoId} -> ${ORQ_EVENT_URL}`
    );
  } catch (err) {
    console.error(
      `Error enviando evento FUERA_DE_ZONA_SEGURA para ${vehiculoId}:`,
      err.message
    );
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
  }
}

async function evaluarZonasSegurasYGenerarEventos() {
  try {
    const ahoraLocal = DateTime.now().setZone('America/Mexico_City');

    for (const [vehiculoId, config] of Object.entries(VEHICULOS)) {
      // Debe estar activo y tener zona activa y uniqueId
      if (config.activo === false) continue;
      if (!config.uniqueId) continue;
      const zona = config.zonaSegura;
      if (!zona || zona.activo !== true) continue;

      // Dia y hora
      const diaCodigo = codigoDiaSemanaMx(ahoraLocal);
      const aplicaDia = zona.diasSemana.includes(diaCodigo);
      const aplicaHora = horaDentroDeVentana(
        zona.horaInicio,
        zona.horaFin,
        ahoraLocal
      );
      const aplicaVentana = aplicaDia && aplicaHora;

      let nuevoEstado = 'desconocido';
      const prevEstado = ESTADO_ZONA[vehiculoId] || 'desconocido';

      if (!aplicaVentana) {
        nuevoEstado = 'fuera_horario';
        ESTADO_ZONA[vehiculoId] = nuevoEstado;
        continue; // no hay evaluacion de distancia ni eventos
      }

      // Obtener posicion actual
      let position;
      try {
        const res = await getDeviceAndPositionByUniqueId(config.uniqueId);
        position = res.position;
        if (!position) {
          console.warn(
            `Sin posicion reciente para evaluar Zona Segura en vehiculo ${vehiculoId}`
          );
          continue;
        }
      } catch (err) {
        console.error(
          `Error consultando posicion para Zona Segura en vehiculo ${vehiculoId}:`,
          err.message
        );
        continue;
      }

      const lat = position.latitude;
      const lon = position.longitude;

      const dist = distanciaMetros(zona.centro.lat, zona.centro.lon, lat, lon);

      if (dist > zona.radio_interno_m) {
        nuevoEstado = 'fuera';
      } else {
        nuevoEstado = 'dentro';
      }

      // Guardar nuevo estado
      ESTADO_ZONA[vehiculoId] = nuevoEstado;

      // Evento: cambio de dentro -> fuera (solo dentro de la ventana)
      if (nuevoEstado === 'fuera' && prevEstado === 'dentro') {
        await enviarEventoSalidaZonaSegura({
          vehiculoId,
          config,
          zona,
          position,
          distancia: dist
        });
      }
    }
  } catch (err) {
    console.error('Error general en evaluarZonasSegurasYGenerarEventos:', err.message);
  }
}

// ---------------------------
// Endpoints
// ---------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, mensaje: 'AMA Orquestador vivo' });
});

// ---------------------------
// 1) Alta de vehiculo
// ---------------------------

app.post('/api/vehiculos', async (req, res) => {
  try {
    const { contratoId, tipoCliente, nombreTitular, uniqueId, aliasUnidad } =
      req.body || {};

    if (!contratoId || !tipoCliente || !nombreTitular || !uniqueId) {
      return res.status(400).json({
        error:
          'Faltan campos. Se requiere contratoId, tipoCliente, nombreTitular y uniqueId.'
      });
    }

    if (!['individual', 'empresa'].includes(tipoCliente)) {
      return res
        .status(400)
        .json({ error: 'tipoCliente debe ser "individual" o "empresa".' });
    }

    const existenteConUniqueId = Object.entries(VEHICULOS).find(
      ([, v]) => v.uniqueId === uniqueId
    );
    if (existenteConUniqueId) {
      return res.status(409).json({
        error:
          'Ese uniqueId ya esta asignado a otro vehiculo (' +
          existenteConUniqueId[0] +
          ').'
      });
    }

    const vehiculosContrato = Object.entries(VEHICULOS).filter(
      ([, v]) => v.contratoId === contratoId
    );

    let vehiculoId;
    let numeroUnidad;

    if (vehiculosContrato.length === 0) {
      if (tipoCliente === 'individual') {
        vehiculoId = contratoId;
      } else {
        vehiculoId = contratoId + '-001';
      }
      numeroUnidad = 1;
    } else {
      const maxNum = vehiculosContrato.reduce(
        (max, [, v]) =>
          typeof v.numeroUnidad === 'number' && v.numeroUnidad > max
            ? v.numeroUnidad
            : max,
        1
      );
      numeroUnidad = maxNum + 1;
      const sufijo = String(numeroUnidad).padStart(3, '0');
      vehiculoId = contratoId + '-' + sufijo;
    }

    if (VEHICULOS[vehiculoId]) {
      return res
        .status(409)
        .json({ error: 'Ya existe un vehiculo con id ' + vehiculoId });
    }

    const nombreDevice =
      contratoId +
      ' - ' +
      (aliasUnidad || `Unidad ${numeroUnidad}`) +
      ' (' +
      nombreTitular +
      ')';

    const device = await crearOActualizarDeviceEnTraccar(uniqueId, nombreDevice);

    const ahora = new Date().toISOString();

    VEHICULOS[vehiculoId] = {
      contratoId,
      tipoCliente,
      numeroUnidad,
      nombreTitular,
      aliasUnidad: aliasUnidad || `Unidad ${numeroUnidad}`,
      uniqueId,
      activo: true,
      motivoInactivacion: null,
      fechaAlta: ahora,
      fechaInactivacion: null,
      fechaReactivacion: null,
      fechaCambioUniqueId: null,
      fechaLiberacionUniqueId: null,
      zonaSegura: null,
      modoSiniestro: false,
      siniestro: null
    };

    ESTADO_CORTE[vehiculoId] = 'normal';
    ESTADO_ZONA[vehiculoId] = 'desconocido';

    guardarVehiculos();

    return res.json({
      ok: true,
      vehiculoId,
      contratoId,
      tipoCliente,
      numeroUnidad,
      nombreTitular,
      aliasUnidad: VEHICULOS[vehiculoId].aliasUnidad,
      uniqueId,
      activo: true,
      traccarDeviceId: device.id,
      mensaje: 'Vehiculo registrado en el Orquestador y en Traccar.'
    });
  } catch (err) {
    console.error('Error en POST /api/vehiculos:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    return res.status(500).json({
      error: 'No se pudo registrar el vehiculo',
      detalle: err.response ? `${err.response.status}` : err.message
    });
  }
});

// ---------------------------
// 2) Inactivar vehiculo
// ---------------------------

app.post('/api/vehiculos/:vehiculoId/inactivar', (req, res) => {
  const vehiculoId = req.params.vehiculoId;
  const config = VEHICULOS[vehiculoId];

  if (!config) {
    return res
      .status(404)
      .json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  const { motivo } = req.body || {};

  if (!['impago', 'cancelacion'].includes(motivo)) {
    return res
      .status(400)
      .json({ error: 'motivo debe ser "impago" o "cancelacion".' });
  }

  const yaEstabaInactivo = config.activo === false;
  config.activo = false;
  config.motivoInactivacion = motivo;
  config.fechaInactivacion = new Date().toISOString();

  guardarVehiculos();

  return res.json({
    ok: true,
    vehiculoId,
    contratoId: config.contratoId,
    activo: false,
    motivoInactivacion: motivo,
    yaEstabaInactivo,
    mensaje:
      'Vehiculo inactivado por motivo "' +
      motivo +
      '". No se realizaran mas operaciones hasta reactivacion.'
  });
});

// ---------------------------
// 3) Reactivar vehiculo
// ---------------------------

app.post('/api/vehiculos/:vehiculoId/reactivar', (req, res) => {
  const vehiculoId = req.params.vehiculoId;
  const config = VEHICULOS[vehiculoId];

  if (!config) {
    return res
      .status(404)
      .json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  if (!config.uniqueId) {
    return res.status(409).json({
      error:
        'El vehiculo no tiene un dispositivo (uniqueId) asignado. Asigna un dispositivo antes de reactivar.'
    });
  }

  if (config.activo !== false) {
    return res.json({
      ok: false,
      vehiculoId,
      contratoId: config.contratoId,
      activo: true,
      mensaje: 'El vehiculo ya se encontraba activo.'
    });
  }

  config.activo = true;
  config.motivoInactivacion = null;
  config.fechaReactivacion = new Date().toISOString();

  guardarVehiculos();

  return res.json({
    ok: true,
    vehiculoId,
    contratoId: config.contratoId,
    activo: true,
    mensaje:
      'Vehiculo reactivado. Se reanuda el monitoreo y el uso de funciones de seguridad.'
  });
});

// ---------------------------
// 4) Cambiar equipo (modificar uniqueId)
// ---------------------------

app.post('/api/vehiculos/:vehiculoId/modificar-uniqueId', async (req, res) => {
  try {
    const vehiculoId = req.params.vehiculoId;
    const config = VEHICULOS[vehiculoId];

    if (!config) {
      return res
        .status(404)
        .json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    const { nuevoUniqueId } = req.body || {};
    if (!nuevoUniqueId || typeof nuevoUniqueId !== 'string') {
      return res
        .status(400)
        .json({ error: 'nuevoUniqueId es obligatorio y debe ser un string.' });
    }

    if (!config.uniqueId) {
      return res.status(409).json({
        error:
          'El vehiculo no tiene uniqueId actual asignado. Revisa el estado o usa el flujo de alta.'
      });
    }

    const otro = Object.entries(VEHICULOS).find(
      ([id, v]) => v.uniqueId === nuevoUniqueId && id !== vehiculoId
    );
    if (otro) {
      return res.status(409).json({
        error:
          'El nuevo uniqueId ya esta asignado al vehiculo ' +
          otro[0] +
          '.'
      });
    }

    const nombreDevice =
      config.contratoId +
      ' - ' +
      (config.aliasUnidad || `Unidad ${config.numeroUnidad}`) +
      ' (' +
      config.nombreTitular +
      ')';

    const device = await crearOActualizarDeviceEnTraccar(
      nuevoUniqueId,
      nombreDevice
    );

    const uniqueIdAnterior = config.uniqueId;
    config.uniqueId = nuevoUniqueId;
    config.fechaCambioUniqueId = new Date().toISOString();

    guardarVehiculos();

    return res.json({
      ok: true,
      vehiculoId,
      contratoId: config.contratoId,
      uniqueIdAnterior,
      nuevoUniqueId,
      traccarDeviceId: device.id,
      mensaje:
        'uniqueId actualizado correctamente. El nuevo dispositivo queda asociado a este vehiculo.'
    });
  } catch (err) {
    console.error(
      'Error en POST /api/vehiculos/:vehiculoId/modificar-uniqueId:',
      err.message
    );
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    return res.status(500).json({
      error: 'No se pudo modificar el uniqueId del vehiculo',
      detalle: err.response ? `${err.response.status}` : err.message
    });
  }
});

// ---------------------------
// 5) Reutilizar equipo (liberar uniqueId)
// ---------------------------

app.post('/api/vehiculos/:vehiculoId/liberar-dispositivo', (req, res) => {
  const vehiculoId = req.params.vehiculoId;
  const config = VEHICULOS[vehiculoId];

  if (!config) {
    return res
      .status(404)
      .json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  if (config.activo !== false) {
    return res.status(409).json({
      error:
        'Solo puedes liberar el dispositivo de un vehiculo inactivo. Inactivalo primero.'
    });
  }

  if (!config.uniqueId) {
    return res.status(409).json({
      error:
        'El vehiculo no tiene uniqueId asignado actualmente. No hay dispositivo que liberar.'
    });
  }

  const uniqueIdLiberado = config.uniqueId;
  config.uniqueId = null;
  config.fechaLiberacionUniqueId = new Date().toISOString();

  guardarVehiculos();

  return res.json({
    ok: true,
    vehiculoId,
    contratoId: config.contratoId,
    activo: false,
    uniqueIdLiberado,
    mensaje:
      'Dispositivo liberado. El uniqueId puede asignarse a otro cliente mediante el proceso de alta de vehiculo.'
  });
});

// ---------------------------
// 6) Consultar estatus del vehiculo
// ---------------------------

app.get('/api/vehiculos/:vehiculoId/estatus', async (req, res) => {
  try {
    const vehiculoId = req.params.vehiculoId;
    const config = VEHICULOS[vehiculoId];

    if (!config) {
      return res
        .status(404)
        .json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    const base = {
      vehiculoId,
      contratoId: config.contratoId,
      tipoCliente: config.tipoCliente,
      nombreTitular: config.nombreTitular,
      aliasUnidad: config.aliasUnidad || null,
      activo_orq: config.activo !== false,
      motivoInactivacion: config.motivoInactivacion || null,
      estado_corte: ESTADO_CORTE[vehiculoId] || 'desconocido',
      tiene_zona_segura: !!config.zonaSegura,
      zona_segura_activa: config.zonaSegura?.activo === true,
      modo_siniestro: config.modoSiniestro === true,
      hora_inicio_siniestro: config.siniestro?.horaInicio || null,
      hora_cierre_siniestro: config.siniestro?.horaCierre || null,
      resultado_siniestro: config.siniestro?.resultado || null
    };

    if (!config.uniqueId) {
      return res.json({
        ...base,
        tiene_uniqueId: false,
        uniqueId: null,
        existe_en_traccar: false,
        status_traccar: null,
        activo_traccar: null,
        ultima_comunicacion_utc: null,
        ultima_comunicacion_local: null
      });
    }

    const devices = await getAllDevices();
    const device = devices.find((d) => d.uniqueId === config.uniqueId);

    if (!device) {
      return res.json({
        ...base,
        tiene_uniqueId: true,
        uniqueId: config.uniqueId,
        existe_en_traccar: false,
        status_traccar: null,
        activo_traccar: null,
        ultima_comunicacion_utc: null,
        ultima_comunicacion_local: null
      });
    }

    const statusTraccar = device.status || 'desconocido';
    const activoTraccar = statusTraccar === 'online';
    const lastUpdateUtc = device.lastUpdate || null;
    const lastUpdateLocal = utcToLocalMx(lastUpdateUtc);

    return res.json({
      ...base,
      tiene_uniqueId: true,
      uniqueId: config.uniqueId,
      existe_en_traccar: true,
      status_traccar: statusTraccar,
      activo_traccar: activoTraccar,
      ultima_comunicacion_utc: lastUpdateUtc,
      ultima_comunicacion_local: lastUpdateLocal
    });
  } catch (err) {
    console.error('Error en GET /api/vehiculos/:vehiculoId/estatus:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    return res.status(500).json({
      error: 'Error consultando estatus en Traccar',
      detalle: err.response ? `${err.response.status}` : err.message
    });
  }
});

// ---------------------------
// 7) Ubicacion del vehiculo
// ---------------------------

app.get('/api/vehiculos/:vehiculoId/ubicacion', async (req, res) => {
  try {
    const vehiculoId = req.params.vehiculoId;
    const config = VEHICULOS[vehiculoId];

    if (!config) {
      return res
        .status(404)
        .json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (config.activo === false) {
      return res.status(409).json({
        error: 'Vehiculo inactivo; no se puede consultar ubicacion.',
        motivo_inactivacion: config.motivoInactivacion || null
      });
    }

    if (!config.uniqueId) {
      return res.status(409).json({
        error:
          'El vehiculo no tiene uniqueId asignado. No se puede consultar ubicacion.'
      });
    }

    const { device, position } = await getDeviceAndPositionByUniqueId(
      config.uniqueId
    );

    const estado = device.status || 'desconocido';

    const rawTime =
      (position && (position.serverTime || position.deviceTime || position.fixTime)) ||
      null;

    const horaLocal = utcToLocalMx(rawTime);

    const lat = position ? position.latitude : null;
    const lon = position ? position.longitude : null;

    const googleMapsUrl =
      lat != null && lon != null
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
        : null;

    const fuentePosicion =
      (position && position.attributes && position.attributes.source) || null;
    const precision =
      position && typeof position.accuracy === 'number'
        ? position.accuracy
        : null;
    const satelites =
      position && position.attributes && typeof position.attributes.sat === 'number'
        ? position.attributes.sat
        : null;

    const velocidadKmh =
      position && typeof position.speed === 'number'
        ? knotsToKmh(position.speed)
        : null;

    return res.json({
      vehiculoId,
      contratoId: config.contratoId,
      nombre_mostrado: config.aliasUnidad || config.nombreTitular,
      estado,
      lat,
      lon,
      hora_ultima_posicion_utc: rawTime,
      hora_ultima_posicion_local: horaLocal,
      google_maps_url: googleMapsUrl,
      fuente_posicion: fuentePosicion,
      precision_aprox_m: precision,
      satelites,
      velocidad_kmh: velocidadKmh
    });
  } catch (err) {
    console.error('Error en GET /api/vehiculos/:vehiculoId/ubicacion:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    return res.status(500).json({
      error: 'Error consultando Traccar',
      detalle: err.response ? `${err.response.status}` : err.message
    });
  }
});

// ---------------------------
// 8) Estado de corte
// ---------------------------

app.get('/api/vehiculos/:vehiculoId/estado-corte', (req, res) => {
  const vehiculoId = req.params.vehiculoId;
  const config = VEHICULOS[vehiculoId];

  if (!config) {
    return res
      .status(404)
      .json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  const estadoCorte = ESTADO_CORTE[vehiculoId] || 'normal';

  return res.json({
    vehiculoId,
    contratoId: config.contratoId,
    estado_corte: estadoCorte
  });
});

// ---------------------------
// 9) Corte y reanudacion de motor
// ---------------------------

app.post('/api/vehiculos/:vehiculoId/corte', async (req, res) => {
  try {
    const vehiculoId = req.params.vehiculoId;
    const config = VEHICULOS[vehiculoId];

    if (!config) {
      return res
        .status(404)
        .json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (config.activo === false) {
      return res.status(409).json({
        error: 'Vehiculo inactivo; no se puede enviar comando de corte.',
        motivo_inactivacion: config.motivoInactivacion || null
      });
    }

    if (!config.uniqueId) {
      return res.status(409).json({
        error:
          'El vehiculo no tiene uniqueId asignado. No se puede enviar comando de corte.'
      });
    }

    // 1) Intentar obtener velocidad actual
    let velocidadKmh = null;
    try {
      const { position } = await getDeviceAndPositionByUniqueId(config.uniqueId);
      if (position && typeof position.speed === 'number') {
        velocidadKmh = knotsToKmh(position.speed);
      }
    } catch (e) {
      console.error('Error obteniendo velocidad antes de corte:', e.message);
      // No rompemos el flujo; seguimos mandando el comando sin velocidad
    }

    // 2) Enviar comando de corte
    const { command } = await sendCommandToDevice(config.uniqueId, 'engineStop');
    ESTADO_CORTE[vehiculoId] = 'cortado';

    const superaUmbral =
      velocidadKmh != null && velocidadKmh > CORTE_UMBRAL_KMH;

    const mensaje = superaUmbral
      ? `Comando de corte enviado. El dispositivo ejecutara el paro cuando la velocidad sea menor o igual a ${CORTE_UMBRAL_KMH} km/h.`
      : 'Comando de corte enviado y aceptado por el servidor. El dispositivo debe ejecutar el paro en segundos.';

    return res.json({
      vehiculoId,
      contratoId: config.contratoId,
      resultado: 'confirmado',
      comandoId: command.id,
      estado_corte: 'cortado',
      velocidad_kmh: velocidadKmh,
      corte_puede_demorar: superaUmbral,
      mensaje
    });
  } catch (err) {
    console.error('Error en POST /api/vehiculos/:vehiculoId/corte:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    return res.status(500).json({
      error: 'No se pudo enviar el comando de corte',
      detalle: err.response ? `${err.response.status}` : err.message
    });
  }
});

app.post('/api/vehiculos/:vehiculoId/reanudar', async (req, res) => {
  try {
    const vehiculoId = req.params.vehiculoId;
    const config = VEHICULOS[vehiculoId];

    if (!config) {
      return res
        .status(404)
        .json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (config.activo === false) {
      return res.status(409).json({
        error: 'Vehiculo inactivo; no se puede enviar comando de reanudacion.',
        motivo_inactivacion: config.motivoInactivacion || null
      });
    }

    if (!config.uniqueId) {
      return res.status(409).json({
        error:
          'El vehiculo no tiene uniqueId asignado. No se puede enviar comando de reanudacion.'
      });
    }

    const { command } = await sendCommandToDevice(
      config.uniqueId,
      'engineResume'
    );
    ESTADO_CORTE[vehiculoId] = 'normal';

    return res.json({
      vehiculoId,
      contratoId: config.contratoId,
      resultado: 'confirmado',
      comandoId: command.id,
      estado_corte: 'normal',
      mensaje:
        'Comando de reanudacion enviado y aceptado por el servidor. El dispositivo debe restablecer la marcha en segundos.'
    });
  } catch (err) {
    console.error(
      'Error en POST /api/vehiculos/:vehiculoId/reanudar:',
      err.message
    );
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    return res.status(500).json({
      error: 'No se pudo enviar el comando de reanudacion',
      detalle: err.response ? `${err.response.status}` : err.message
    });
  }
});

// ---------------------------
// 10) Zona Segura
// ---------------------------

// Configurar / activar Zona Segura (Z1 / Z3)
app.post('/api/vehiculos/:vehiculoId/zona-segura', async (req, res) => {
  try {
    const vehiculoId = req.params.vehiculoId;
    const config = VEHICULOS[vehiculoId];

    if (!config) {
      return res
        .status(404)
        .json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (config.activo === false) {
      return res.status(409).json({
        error: 'Vehiculo inactivo; no se puede configurar Zona Segura.',
        motivo_inactivacion: config.motivoInactivacion || null
      });
    }

    if (!config.uniqueId) {
      return res.status(409).json({
        error:
          'El vehiculo no tiene uniqueId asignado. No se puede configurar Zona Segura.'
      });
    }

    const {
      nombre,
      limite_m,
      diasAccion,
      horaInicio,
      horaFin,
      activo,
      forzarSobreEscritura
    } = req.body || {};

    if (!nombre || typeof nombre !== 'string') {
      return res
        .status(400)
        .json({ error: 'nombre es obligatorio y debe ser string.' });
    }

    if (typeof limite_m !== 'number') {
      return res
        .status(400)
        .json({ error: 'limite_m es obligatorio y debe ser numero.' });
    }

    if (limite_m < 20 || limite_m > 40) {
      return res.status(400).json({
        error: 'limite_m debe estar entre 20 y 40 metros.'
      });
    }

    if (!Array.isArray(diasAccion) || diasAccion.length === 0) {
      return res.status(400).json({
        error:
          'diasAccion debe ser un arreglo no vacio con codigos tipo "LU","MA","MI","JU","VI","SA","DO".'
      });
    }

    const diasValidos = new Set(['LU', 'MA', 'MI', 'JU', 'VI', 'SA', 'DO']);
    const diasInvalidos = diasAccion.filter((d) => !diasValidos.has(d));
    if (diasInvalidos.length > 0) {
      return res.status(400).json({
        error:
          'diasAccion contiene valores invalidos: ' + diasInvalidos.join(', ')
      });
    }

    if (!horaInicio || typeof horaInicio !== 'string') {
      return res
        .status(400)
        .json({ error: 'horaInicio es obligatoria y debe ser string HH:mm.' });
    }

    if (!horaFin || typeof horaFin !== 'string') {
      return res
        .status(400)
        .json({ error: 'horaFin es obligatoria y debe ser string HH:mm.' });
    }

    if (typeof activo !== 'boolean') {
      return res
        .status(400)
        .json({ error: 'activo es obligatorio y debe ser boolean.' });
    }

    const zonaActual = config.zonaSegura;
    const zonaActivaYa = zonaActual && zonaActual.activo === true;

    if (zonaActivaYa && !forzarSobreEscritura) {
      return res.json({
        ok: false,
        vehiculoId,
        contratoId: config.contratoId,
        yaExistiaActiva: true,
        requiere_confirmacion: true,
        zona_actual: {
          nombre: zonaActual.nombre,
          radio_cliente_m: zonaActual.radio_cliente_m,
          diasSemana: zonaActual.diasSemana,
          horaInicio: zonaActual.horaInicio,
          horaFin: zonaActual.horaFin,
          activo: zonaActual.activo
        },
        mensaje:
          'Ya existe una Zona Segura activa. El usuario debe decidir si la mantiene o la reemplaza.'
      });
    }

    // Obtener posicion actual del vehiculo
    let latCentro = null;
    let lonCentro = null;

    try {
      const { position } = await getDeviceAndPositionByUniqueId(config.uniqueId);
      if (!position) {
        return res.status(500).json({
          error:
            'No se encontro posicion reciente del vehiculo para configurar Zona Segura. Intenta de nuevo cuando el equipo tenga señal.'
        });
      }
      latCentro = position.latitude;
      lonCentro = position.longitude;
    } catch (e) {
      console.error('Error obteniendo posicion para Zona Segura:', e.message);
      return res.status(500).json({
        error:
          'Error consultando posicion actual del vehiculo para configurar Zona Segura.',
        detalle: e.message
      });
    }

    const radioCliente = limite_m;
    const radioInterno = radioCliente + 10;

    const nuevaZona = {
      nombre,
      centro: { lat: latCentro, lon: lonCentro },
      radio_cliente_m: radioCliente,
      radio_interno_m: radioInterno,
      diasSemana: diasAccion,
      horaInicio,
      horaFin,
      activo: !!activo
    };

    config.zonaSegura = nuevaZona;
    guardarVehiculos();

    // Reiniciar estado de zona en memoria
    ESTADO_ZONA[vehiculoId] = 'desconocido';

    return res.json({
      ok: true,
      vehiculoId,
      contratoId: config.contratoId,
      zonaSegura: nuevaZona,
      yaExistiaActiva: zonaActivaYa,
      lejos_de_zona: false,
      distancia_m: 0,
      mensaje: nuevaZona.activo
        ? 'Zona Segura configurada y activada correctamente.'
        : 'Zona Segura configurada pero inactiva.'
    });
  } catch (err) {
    console.error(
      'Error en POST /api/vehiculos/:vehiculoId/zona-segura:',
      err.message
    );
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    return res.status(500).json({
      error: 'Error configurando Zona Segura',
      detalle: err.response ? `${err.response.status}` : err.message
    });
  }
});

// Desactivar Zona Segura (Z2)
app.post('/api/vehiculos/:vehiculoId/zona-segura/desactivar', (req, res) => {
  const vehiculoId = req.params.vehiculoId;
  const config = VEHICULOS[vehiculoId];

  if (!config) {
    return res
      .status(404)
      .json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  const zona = config.zonaSegura;

  if (!zona) {
    return res.json({
      ok: false,
      vehiculoId,
      contratoId: config.contratoId,
      mensaje: 'El vehiculo no tiene Zona Segura configurada.'
    });
  }

  if (zona.activo === false) {
    return res.json({
      ok: false,
      vehiculoId,
      contratoId: config.contratoId,
      zonaSegura: {
        nombre: zona.nombre,
        activo: zona.activo
      },
      mensaje: 'La Zona Segura ya se encontraba desactivada.'
    });
  }

  zona.activo = false;
  guardarVehiculos();

  // Estado en memoria deja de importar, pero lo reseteamos por claridad
  ESTADO_ZONA[vehiculoId] = 'desconocido';

  return res.json({
    ok: true,
    vehiculoId,
    contratoId: config.contratoId,
    zonaSegura: {
      nombre: zona.nombre,
      activo: zona.activo
    },
    mensaje:
      'Zona Segura desactivada. La configuracion se mantiene pero no generara alertas.'
  });
});

// Obtener configuracion de Zona Segura
app.get('/api/vehiculos/:vehiculoId/zona-segura', (req, res) => {
  const vehiculoId = req.params.vehiculoId;
  const config = VEHICULOS[vehiculoId];

  if (!config) {
    return res
      .status(404)
      .json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  if (!config.zonaSegura) {
    return res.json({
      vehiculoId,
      contratoId: config.contratoId,
      tiene_zona_segura: false,
      zonaSegura: null
    });
  }

  return res.json({
    vehiculoId,
    contratoId: config.contratoId,
    tiene_zona_segura: true,
    zonaSegura: config.zonaSegura
  });
});

// Evaluar si el vehiculo esta dentro/fuera de la Zona Segura (consulta puntual)
app.get('/api/vehiculos/:vehiculoId/check-zona-segura', async (req, res) => {
  try {
    const vehiculoId = req.params.vehiculoId;
    const config = VEHICULOS[vehiculoId];

    if (!config) {
      return res
        .status(404)
        .json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (config.activo === false) {
      return res.status(409).json({
        error: 'Vehiculo inactivo; no se evalua Zona Segura.',
        motivo_inactivacion: config.motivoInactivacion || null
      });
    }

    if (!config.uniqueId) {
      return res.status(409).json({
        error:
          'El vehiculo no tiene uniqueId asignado. No se puede evaluar Zona Segura.'
      });
    }

    if (!config.zonaSegura) {
      return res.json({
        vehiculoId,
        contratoId: config.contratoId,
        tiene_zona_segura: false,
        activa: false,
        aplica_ventana: false,
        fuera_de_zona: false,
        motivo: 'SIN_CONFIG'
      });
    }

    const {
      centro,
      radio_cliente_m,
      radio_interno_m,
      diasSemana,
      horaInicio,
      horaFin,
      activo: zonaActiva
    } = config.zonaSegura;

    if (!zonaActiva) {
      return res.json({
        vehiculoId,
        contratoId: config.contratoId,
        tiene_zona_segura: true,
        activa: false,
        aplica_ventana: false,
        fuera_de_zona: false,
        motivo: 'ZONA_INACTIVA'
      });
    }

    const ahoraLocal = DateTime.now().setZone('America/Mexico_City');
    const diaCodigo = codigoDiaSemanaMx(ahoraLocal);

    const aplicaDia = diasSemana.includes(diaCodigo);
    const aplicaHora = horaDentroDeVentana(horaInicio, horaFin, ahoraLocal);
    const aplicaVentana = aplicaDia && aplicaHora;

    if (!aplicaVentana) {
      return res.json({
        vehiculoId,
        contratoId: config.contratoId,
        tiene_zona_segura: true,
        activa: true,
        aplica_ventana: false,
        fuera_de_zona: false,
        motivo: 'FUERA_HORARIO_O_DIA'
      });
    }

    const { position } = await getDeviceAndPositionByUniqueId(config.uniqueId);
    if (!position) {
      return res.status(500).json({
        error:
          'No se encontro posicion reciente para evaluar Zona Segura.'
      });
    }

    const lat = position.latitude;
    const lon = position.longitude;

    const dist = distanciaMetros(centro.lat, centro.lon, lat, lon);
    const radioEval = radio_interno_m;
    const fuera = dist > radioEval;

    const rawTime =
      position.serverTime || position.deviceTime || position.fixTime || null;
    const horaLocalStr = utcToLocalMx(rawTime);

    return res.json({
      vehiculoId,
      contratoId: config.contratoId,
      tiene_zona_segura: true,
      activa: true,
      aplica_ventana: true,
      fuera_de_zona: fuera,
      distancia_m: dist,
      radio_cliente_m,
      radio_interno_m,
      lat,
      lon,
      hora_ultima_posicion_utc: rawTime,
      hora_ultima_posicion_local: horaLocalStr,
      evento_sugerido: fuera ? 'FUERA_DE_ZONA_SEGURA' : null
    });
  } catch (err) {
    console.error(
      'Error en GET /api/vehiculos/:vehiculoId/check-zona-segura:',
      err.message
    );
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    return res.status(500).json({
      error: 'Error evaluando Zona Segura',
      detalle: err.response ? `${err.response.status}` : err.message
    });
  }
});

// ---------------------------
// 11) Siniestros: iniciar y cerrar
// ---------------------------

// S1 - Iniciar protocolo de siniestro
app.post('/api/vehiculos/:vehiculoId/siniestro/iniciar', (req, res) => {
  const vehiculoId = req.params.vehiculoId;
  const config = VEHICULOS[vehiculoId];

  if (!config) {
    return res
      .status(404)
      .json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  if (config.activo === false) {
    return res.status(409).json({
      error: 'Vehiculo inactivo; no se puede iniciar siniestro.',
      motivo_inactivacion: config.motivoInactivacion || null
    });
  }

  const { causa, canal } = req.body || {};
  const yaEnSiniestro = config.modoSiniestro === true;

  const ahoraIso = new Date().toISOString();

  config.modoSiniestro = true;
  config.siniestro = {
    activo: true,
    causa: causa || null,
    canal: canal || null,
    horaInicio: ahoraIso,
    horaCierre: null,
    resultado: null,
    ultimaUbicacionCierre: null
  };

  guardarVehiculos();

  return res.json({
    ok: true,
    vehiculoId,
    contratoId: config.contratoId,
    modoSiniestro: true,
    yaEnSiniestro,
    causa: config.siniestro.causa,
    canal: config.siniestro.canal,
    horaInicio: ahoraIso,
    mensaje: `Siniestro iniciado para el vehiculo ${vehiculoId}.`
  });
});

// S4 - Cerrar siniestro (con reanudacion si corresponde)
app.post('/api/vehiculos/:vehiculoId/siniestro/cerrar', async (req, res) => {
  try {
    const vehiculoId = req.params.vehiculoId;
    const config = VEHICULOS[vehiculoId];

    if (!config) {
      return res
        .status(404)
        .json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    const { resultado } = req.body || {};
    if (!['recuperado', 'no_recuperado'].includes(resultado)) {
      return res.status(400).json({
        error: 'resultado debe ser "recuperado" o "no_recuperado".'
      });
    }

    if (!config.uniqueId) {
      return res.status(409).json({
        error:
          'El vehiculo no tiene uniqueId asignado. No se puede cerrar siniestro con reanudacion.'
      });
    }

    let reanudoMotor = false;
    let comandoId = null;

    if (ESTADO_CORTE[vehiculoId] === 'cortado') {
      try {
        const { command } = await sendCommandToDevice(
          config.uniqueId,
          'engineResume'
        );
        ESTADO_CORTE[vehiculoId] = 'normal';
        reanudoMotor = true;
        comandoId = command.id;
      } catch (err) {
        console.error(
          'Error reanudando motor al cerrar siniestro:',
          err.message
        );
        if (err.response) {
          console.error('Status:', err.response.status);
          console.error('Data:', err.response.data);
        }
        return res.status(500).json({
          error: 'No se pudo reanudar el motor al cerrar el siniestro',
          detalle: err.response ? `${err.response.status}` : err.message
        });
      }
    }

    let ultimaUbicacion = null;
    try {
      const { position } = await getDeviceAndPositionByUniqueId(
        config.uniqueId
      );
      if (position) {
        const rawTime =
          position.serverTime ||
          position.deviceTime ||
          position.fixTime ||
          null;

        const horaLocal = utcToLocalMx(rawTime);

        ultimaUbicacion = {
          lat: position.latitude,
          lon: position.longitude,
          hora_utc: rawTime,
          hora_local: horaLocal
        };
      }
    } catch (err) {
      console.error(
        'Error obteniendo posicion al cerrar siniestro:',
        err.message
      );
      if (err.response) {
        console.error('Status:', err.response.status);
        console.error('Data:', err.response.data);
      }
    }

    const ahoraIso = new Date().toISOString();

    config.modoSiniestro = false;
    config.siniestro = {
      ...(config.siniestro || {}),
      activo: false,
      resultado,
      horaInicio: (config.siniestro && config.siniestro.horaInicio) || null,
      horaCierre: ahoraIso,
      ultimaUbicacionCierre: ultimaUbicacion
    };

    guardarVehiculos();

    return res.json({
      ok: true,
      vehiculoId,
      contratoId: config.contratoId,
      resultado,
      modoSiniestro: false,
      reanudo_motor: reanudoMotor,
      comandoId,
      horaInicio: config.siniestro.horaInicio,
      horaCierre: ahoraIso,
      ultima_ubicacion_cierre: ultimaUbicacion,
      mensaje:
        resultado === 'recuperado'
          ? 'Siniestro cerrado. Vehiculo marcado como recuperado.'
          : 'Siniestro cerrado. Vehiculo marcado como no recuperado.'
    });
  } catch (err) {
    console.error(
      'Error en POST /api/vehiculos/:vehiculoId/siniestro/cerrar:',
      err.message
    );
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', err.response.data);
    }
    return res.status(500).json({
      error: 'No se pudo cerrar el siniestro',
      detalle: err.response ? `${err.response.status}` : err.message
    });
  }
});

// ---------------------------
// Inicio del servidor y motor de Zona Segura
// ---------------------------

app.listen(PORT, () => {
  console.log(`AMA Orquestador escuchando en puerto ${PORT}`);

  if (ZONA_SEGURA_INTERVALO_MS > 0) {
    setInterval(() => {
      evaluarZonasSegurasYGenerarEventos().catch((err) =>
        console.error('Error en ciclo de Zona Segura:', err.message)
      );
    }, ZONA_SEGURA_INTERVALO_MS);
    console.log(
      `Motor de Zona Segura activo. Intervalo: ${ZONA_SEGURA_INTERVALO_SEGUNDOS} segundos.`
    );
  } else {
    console.log('Motor de Zona Segura desactivado (intervalo <= 0).');
  }
});
