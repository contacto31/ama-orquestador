// index.js
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'America/Mexico_City';

const DATA_DIR = process.env.DATA_DIR || __dirname;
const VEHICULOS_FILE = path.join(DATA_DIR, 'vehiculos.json');

console.log('DATA_DIR en runtime:', DATA_DIR);
console.log('Usando archivo de vehículos en:', VEHICULOS_FILE);

// ---------- Utilidades de almacenamiento local ----------

function cargarVehiculos() {
  try {
    if (!fs.existsSync(VEHICULOS_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(VEHICULOS_FILE, 'utf8');
    if (!raw.trim()) {
      return {};
    }
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error cargando vehiculos.json:', err);
    return {};
  }
}

function guardarVehiculos(vehiculos) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VEHICULOS_FILE, JSON.stringify(vehiculos, null, 2), 'utf8');
  } catch (err) {
    console.error('Error guardando vehiculos.json:', err);
  }
}

// ---------- Cliente Traccar ----------

const traccar = axios.create({
  baseURL: process.env.TRACCAR_URL,
  auth: {
    username: process.env.TRACCAR_USER,
    password: process.env.TRACCAR_PASSWORD
  },
  timeout: 10000
});

// Obtener / crear device en Traccar según uniqueId
async function asegurarDeviceTraccar(uniqueId, nombre) {
  const devResp = await traccar.get('/devices', { params: { uniqueId } });
  const devices = devResp.data;
  if (Array.isArray(devices) && devices.length > 0) {
    return devices[0];
  }

  const newResp = await traccar.post('/devices', {
    name: nombre,
    uniqueId
  });
  return newResp.data;
}

// Obtener última posición a partir del deviceId de Traccar
async function obtenerUltimaPosicionTraccar(deviceId) {
  const devResp = await traccar.get('/devices', { params: { id: deviceId } });
  const devices = devResp.data;
  if (!Array.isArray(devices) || devices.length === 0) {
    throw new Error('Dispositivo no encontrado en Traccar');
  }
  const device = devices[0];
  if (!device.positionId) {
    throw new Error('El dispositivo aún no tiene posición en Traccar');
  }

  const posResp = await traccar.get('/positions', { params: { id: device.positionId } });
  const positions = posResp.data;
  if (!Array.isArray(positions) || positions.length === 0) {
    throw new Error('Posición no encontrada en Traccar');
  }
  const pos = positions[0];

  const lat = pos.latitude;
  const lon = pos.longitude;
  const velocidadKmh = typeof pos.speed === 'number' ? pos.speed * 1.852 : null;
  const deviceTime = pos.deviceTime || pos.fixTime || pos.serverTime;

  const dtUtc = deviceTime
    ? DateTime.fromISO(deviceTime, { zone: 'utc' })
    : DateTime.utc();

  const dtLocal = dtUtc.setZone(TIMEZONE);

  return {
    lat,
    lon,
    velocidadKmh,
    utc: dtUtc.toISO(),
    local: dtLocal.toISO(),
    raw: pos
  };
}

// Enviar comando a Traccar (ej. corte / reanudar)
async function enviarComandoTraccar(deviceId, tipo, data) {
  const resp = await traccar.post('/commands/send', {
    deviceId,
    type: tipo,
    attributes: data || {}
  });
  return resp.data;
}

// ---------- Utilidades varias ----------

function generarVehiculoId(vehiculos, contratoId, tipoCliente) {
  if (tipoCliente === 'individual') {
    return contratoId;
  }
  const prefijo = contratoId + '-';
  let max = 0;
  for (const id of Object.keys(vehiculos)) {
    if (id.startsWith(prefijo)) {
      const suf = id.slice(prefijo.length);
      const n = parseInt(suf, 10);
      if (!isNaN(n) && n > max) {
        max = n;
      }
    }
  }
  const siguiente = String(max + 1).padStart(3, '0');
  return prefijo + siguiente;
}

function googleMapsUrl(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

function distanciaMetros(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (v) => (v * Math.PI) / 180;
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

const MAP_DIA = {
  LU: 1,
  MA: 2,
  MI: 3,
  JU: 4,
  VI: 5,
  SA: 6,
  DO: 7
};

function horaEnMinutos(hhmm) {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function estaEnVentanaHorario(zona, dtLocal) {
  if (!zona || !zona.diasSemana || !zona.horaInicio || !zona.horaFin) {
    return false;
  }
  const diaLuxon = dtLocal.weekday;
  const dias = zona.diasSemana;
  const codigosDia = dias.map((d) => MAP_DIA[d]).filter(Boolean);
  if (!codigosDia.includes(diaLuxon)) {
    return false;
  }
  const hm = dtLocal.hour * 60 + dtLocal.minute;
  const inicio = horaEnMinutos(zona.horaInicio);
  const fin = horaEnMinutos(zona.horaFin);
  if (inicio == null || fin == null) return false;

  if (inicio <= fin) {
    return hm >= inicio && hm <= fin;
  } else {
    return hm >= inicio || hm <= fin;
  }
}

// ---------- Endpoints básicos ----------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mensaje: 'AMA Orquestador vivo'
  });
});

// ---------- Gestión de vehículos / contratos ----------

app.post('/api/vehiculos', async (req, res) => {
  try {
    const { contratoId, tipoCliente, nombreTitular, uniqueId, aliasUnidad } = req.body;

    if (!contratoId || !tipoCliente || !nombreTitular || !uniqueId) {
      return res.status(400).json({
        error: 'Datos incompletos para alta de vehículo'
      });
    }

    const vehiculos = cargarVehiculos();
    const vehiculoId = generarVehiculoId(vehiculos, contratoId, tipoCliente);

    const nombreDevice = aliasUnidad || `Vehículo ${vehiculoId}`;
    const device = await asegurarDeviceTraccar(uniqueId, nombreDevice);

    const ahoraIso = new Date().toISOString();

    vehiculos[vehiculoId] = {
      vehiculoId,
      contratoId,
      tipoCliente,
      nombreTitular,
      aliasUnidad: aliasUnidad || '',
      nombre_mostrado: aliasUnidad || vehiculoId,
      uniqueId,
      traccarDeviceId: device.id,
      activo: true,
      motivo_baja: null,
      zonaSegura: null,
      siniestro: null,
      creadoEn: ahoraIso,
      actualizadoEn: ahoraIso
    };

    guardarVehiculos(vehiculos);

    return res.json({
      ok: true,
      vehiculoId,
      contratoId,
      tipoCliente,
      nombreTitular,
      aliasUnidad: vehiculos[vehiculoId].aliasUnidad,
      nombre_mostrado: vehiculos[vehiculoId].nombre_mostrado,
      uniqueId,
      traccarDeviceId: device.id
    });
  } catch (err) {
    console.error('Error en alta de vehiculo:', err);
    return res.status(500).json({
      error: 'No se pudo registrar el vehiculo',
      detalle: err.response?.status || err.message
    });
  }
});

app.post('/api/vehiculos/:vehiculoId/inactivar', (req, res) => {
  const { vehiculoId } = req.params;
  const { motivo } = req.body;
  const vehiculos = cargarVehiculos();
  const vehiculo = vehiculos[vehiculoId];

  if (!vehiculo) {
    return res.status(404).json({ error: 'Vehiculo no encontrado en el Orquestador' });
  }

  vehiculo.activo = false;
  vehiculo.motivo_baja = motivo || 'sin_especificar';
  vehiculo.actualizadoEn = new Date().toISOString();

  guardarVehiculos(vehiculos);

  return res.json({
    ok: true,
    vehiculoId,
    activo: vehiculo.activo,
    motivo_baja: vehiculo.motivo_baja
  });
});

app.post('/api/vehiculos/:vehiculoId/reactivar', (req, res) => {
  const { vehiculoId } = req.params;
  const vehiculos = cargarVehiculos();
  const vehiculo = vehiculos[vehiculoId];

  if (!vehiculo) {
    return res.status(404).json({ error: 'Vehiculo no encontrado en el Orquestador' });
  }

  vehiculo.activo = true;
  vehiculo.motivo_baja = null;
  vehiculo.actualizadoEn = new Date().toISOString();

  guardarVehiculos(vehiculos);

  return res.json({
    ok: true,
    vehiculoId,
    activo: vehiculo.activo
  });
});

app.post('/api/vehiculos/:vehiculoId/modificar-uniqueId', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const { nuevoUniqueId } = req.body;

    if (!nuevoUniqueId) {
      return res.status(400).json({ error: 'nuevoUniqueId es obligatorio' });
    }

    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no encontrado en el Orquestador' });
    }

    const deviceId = vehiculo.traccarDeviceId;
    if (!deviceId) {
      return res.status(409).json({ error: 'Vehiculo sin traccarDeviceId' });
    }

    await traccar.put(`/devices/${deviceId}`, {
      id: deviceId,
      name: vehiculo.nombre_mostrado,
      uniqueId: nuevoUniqueId
    });

    vehiculo.uniqueId = nuevoUniqueId;
    vehiculo.actualizadoEn = new Date().toISOString();

    guardarVehiculos(vehiculos);

    return res.json({
      ok: true,
      vehiculoId,
      uniqueId: vehiculo.uniqueId
    });
  } catch (err) {
    console.error('Error modificando uniqueId:', err);
    return res.status(500).json({
      error: 'No se pudo modificar el uniqueId',
      detalle: err.response?.status || err.message
    });
  }
});

app.post('/api/vehiculos/:vehiculoId/liberar-dispositivo', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no encontrado en el Orquestador' });
    }

    vehiculo.activo = false;
    vehiculo.motivo_baja = 'liberado_para_reutilizar';
    vehiculo.actualizadoEn = new Date().toISOString();

    guardarVehiculos(vehiculos);

    return res.json({
      ok: true,
      vehiculoId,
      mensaje: 'Vehiculo marcado como liberado; el dispositivo puede reutilizarse'
    });
  } catch (err) {
    console.error('Error liberando dispositivo:', err);
    return res.status(500).json({
      error: 'No se pudo liberar el dispositivo',
      detalle: err.message
    });
  }
});

app.get('/api/vehiculos/:vehiculoId/estatus', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    let existeEnTraccar = false;
    let statusTraccar = 'desconocido';

    if (vehiculo.traccarDeviceId) {
      try {
        const devResp = await traccar.get('/devices', { params: { id: vehiculo.traccarDeviceId } });
        const devices = devResp.data;
        if (Array.isArray(devices) && devices.length > 0) {
          existeEnTraccar = true;
          const dev = devices[0];
          statusTraccar = dev.status || 'desconocido';
        }
      } catch (innerErr) {
        console.error('Error consultando estatus en Traccar:', innerErr.message);
      }
    }

    return res.json({
      vehiculoId,
      contratoId: vehiculo.contratoId,
      nombre_mostrado: vehiculo.nombre_mostrado,
      activo_orq: vehiculo.activo,
      motivo_baja: vehiculo.motivo_baja,
      existe_en_traccar: existeEnTraccar,
      status_traccar: statusTraccar
    });
  } catch (err) {
    console.error('Error en estatus de vehiculo:', err);
    return res.status(500).json({
      error: 'Error consultando estatus',
      detalle: err.message
    });
  }
});

// ---------- Ubicación y corte remoto ----------

app.get('/api/vehiculos/:vehiculoId/ubicacion', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (!vehiculo.activo) {
      return res.status(409).json({ error: 'Vehiculo inactivo en el Orquestador' });
    }

    if (!vehiculo.traccarDeviceId) {
      return res.status(409).json({ error: 'Vehiculo sin traccarDeviceId' });
    }

    const pos = await obtenerUltimaPosicionTraccar(vehiculo.traccarDeviceId);

    return res.json({
      vehiculoId,
      contratoId: vehiculo.contratoId,
      nombre_mostrado: vehiculo.nombre_mostrado,
      estado: 'online',
      lat: pos.lat,
      lon: pos.lon,
      hora_ultima_posicion_utc: pos.utc,
      hora_ultima_posicion_local: pos.local,
      google_maps_url: googleMapsUrl(pos.lat, pos.lon),
      fuente_posicion: null,
      precision_aprox_m: 0,
      satelites: null,
      velocidad_kmh: pos.velocidadKmh
    });
  } catch (err) {
    console.error('Error obteniendo ubicacion:', err);
    return res.status(500).json({
      error: 'Error consultando ubicacion',
      detalle: err.message
    });
  }
});

app.get('/api/vehiculos/:vehiculoId/estado-corte', (req, res) => {
  const { vehiculoId } = req.params;
  const vehiculos = cargarVehiculos();
  const vehiculo = vehiculos[vehiculoId];

  if (!vehiculo) {
    return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  const estado = vehiculo.estado_corte || 'normal';

  return res.json({
    vehiculoId,
    contratoId: vehiculo.contratoId,
    estado_corte: estado
  });
});

app.post('/api/vehiculos/:vehiculoId/corte', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (!vehiculo.activo) {
      return res.status(409).json({ error: 'Vehiculo inactivo en el Orquestador' });
    }

    if (!vehiculo.traccarDeviceId) {
      return res.status(409).json({ error: 'Vehiculo sin traccarDeviceId' });
    }

    const pos = await obtenerUltimaPosicionTraccar(vehiculo.traccarDeviceId);
    const velocidad = pos.velocidadKmh || 0;
    const cortePuedeDemorar = velocidad > 20;

    await enviarComandoTraccar(vehiculo.traccarDeviceId, 'engineStop', {});

    vehiculo.estado_corte = 'cortado';
    vehiculo.actualizadoEn = new Date().toISOString();
    guardarVehiculos(vehiculos);

    return res.json({
      ok: true,
      vehiculoId,
      contratoId: vehiculo.contratoId,
      resultado: 'comando_enviado',
      estado_corte: vehiculo.estado_corte,
      velocidad_kmh: velocidad,
      corte_puede_demorar: cortePuedeDemorar
    });
  } catch (err) {
    console.error('Error enviando corte:', err);
    return res.status(500).json({
      error: 'No se pudo enviar el comando de corte',
      detalle: err.message
    });
  }
});

app.post('/api/vehiculos/:vehiculoId/reanudar', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (!vehiculo.traccarDeviceId) {
      return res.status(409).json({ error: 'Vehiculo sin traccarDeviceId' });
    }

    await enviarComandoTraccar(vehiculo.traccarDeviceId, 'engineResume', {});

    vehiculo.estado_corte = 'normal';
    vehiculo.actualizadoEn = new Date().toISOString();
    guardarVehiculos(vehiculos);

    return res.json({
      ok: true,
      vehiculoId,
      contratoId: vehiculo.contratoId,
      estado_corte: vehiculo.estado_corte
    });
  } catch (err) {
    console.error('Error enviando reanudacion:', err);
    return res.status(500).json({
      error: 'No se pudo enviar el comando de reanudación',
      detalle: err.message
    });
  }
});

// ---------- Protocolo de siniestro ----------

app.post('/api/vehiculos/:vehiculoId/siniestro/iniciar', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const { causa, canal, detalle } = req.body;
    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (!vehiculo.activo) {
      return res.status(409).json({ error: 'Vehiculo inactivo en el Orquestador' });
    }

    vehiculo.siniestro = {
      activo: true,
      causa: causa || null,
      canal: canal || null,
      detalle: detalle || null,
      iniciadoEn: new Date().toISOString(),
      cerradoEn: null,
      resultado: null
    };
    vehiculo.actualizadoEn = new Date().toISOString();

    guardarVehiculos(vehiculos);

    let ubicacion = null;
    if (vehiculo.traccarDeviceId) {
      try {
        const pos = await obtenerUltimaPosicionTraccar(vehiculo.traccarDeviceId);
        ubicacion = {
          lat: pos.lat,
          lon: pos.lon,
          hora_ultima_posicion_local: pos.local,
          google_maps_url: googleMapsUrl(pos.lat, pos.lon),
          velocidad_kmh: pos.velocidadKmh
        };
      } catch (inner) {
        console.error('Error obteniendo ubicacion al iniciar siniestro:', inner.message);
      }
    }

    return res.json({
      ok: true,
      vehiculoId,
      contratoId: vehiculo.contratoId,
      siniestro: vehiculo.siniestro,
      ubicacion
    });
  } catch (err) {
    console.error('Error iniciando siniestro:', err);
    return res.status(500).json({
      error: 'Error iniciando siniestro',
      detalle: err.message
    });
  }
});

app.post('/api/vehiculos/:vehiculoId/siniestro/cerrar', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const { resultado, reanudarMotor } = req.body;
    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    if (!vehiculo.siniestro || !vehiculo.siniestro.activo) {
      return res.status(409).json({ error: 'No hay siniestro activo para este vehículo' });
    }

    vehiculo.siniestro.activo = false;
    vehiculo.siniestro.resultado = resultado || null;
    vehiculo.siniestro.cerradoEn = new Date().toISOString();

    let ubicacion = null;
    if (vehiculo.traccarDeviceId) {
      try {
        const pos = await obtenerUltimaPosicionTraccar(vehiculo.traccarDeviceId);
        ubicacion = {
          lat: pos.lat,
          lon: pos.lon,
          hora_ultima_posicion_local: pos.local,
          google_maps_url: googleMapsUrl(pos.lat, pos.lon),
          velocidad_kmh: pos.velocidadKmh
        };
      } catch (inner) {
        console.error('Error obteniendo ubicacion al cerrar siniestro:', inner.message);
      }
    }

    if (reanudarMotor && vehiculo.traccarDeviceId) {
      try {
        await enviarComandoTraccar(vehiculo.traccarDeviceId, 'engineResume', {});
        vehiculo.estado_corte = 'normal';
      } catch (inner) {
        console.error('Error reanudando motor al cerrar siniestro:', inner.message);
      }
    }

    vehiculo.actualizadoEn = new Date().toISOString();
    guardarVehiculos(vehiculos);

    return res.json({
      ok: true,
      vehiculoId,
      contratoId: vehiculo.contratoId,
      siniestro: vehiculo.siniestro,
      ubicacion
    });
  } catch (err) {
    console.error('Error cerrando siniestro:', err);
    return res.status(500).json({
      error: 'Error cerrando siniestro',
      detalle: err.message
    });
  }
});

// ---------- Zona Segura ----------

app.post('/api/vehiculos/:vehiculoId/zona-segura', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const {
      nombre,
      limite_m,
      diasAccion,
      horaInicio,
      horaFin,
      activo,
      forzarSobreEscritura
    } = req.body;

    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    const limite = parseInt(limite_m, 10);
    if (isNaN(limite) || limite < 20 || limite > 40) {
      return res.status(400).json({
        error: 'limite_m inválido; debe estar entre 20 y 40 metros'
      });
    }

    if (!Array.isArray(diasAccion) || diasAccion.length === 0) {
      return res.status(400).json({
        error: 'diasAccion debe ser un arreglo no vacío',
        detalle: 'Ej: ["LU","MA","MI","JU","VI"]'
      });
    }

    const diasValidos = ['LU', 'MA', 'MI', 'JU', 'VI', 'SA', 'DO'];
    for (const d of diasAccion) {
      if (!diasValidos.includes(d)) {
        return res.status(400).json({
          error: `Dia inválido en diasAccion: ${d}`
        });
      }
    }

    if (!horaInicio || !horaFin) {
      return res.status(400).json({ error: 'horaInicio y horaFin son obligatorias' });
    }

    if (vehiculo.zonaSegura && !forzarSobreEscritura) {
      return res.status(409).json({
        error: 'Zona Segura ya configurada',
        detalle: 'Envía forzarSobreEscritura=true para reemplazarla'
      });
    }

    if (!vehiculo.traccarDeviceId) {
      return res.status(409).json({ error: 'Vehiculo sin traccarDeviceId' });
    }

    const pos = await obtenerUltimaPosicionTraccar(vehiculo.traccarDeviceId);
    const centro = { lat: pos.lat, lon: pos.lon };

    const radioCliente = limite;
    const radioInterno = limite + 10;

    const zonaSegura = {
      nombre: nombre || 'Zona Segura',
      centro,
      radio_cliente_m: radioCliente,
      radio_interno_m: radioInterno,
      diasSemana: diasAccion,
      horaInicio,
      horaFin,
      activo: !!activo,
      ultimaAlertaActiva: false
    };

    vehiculo.zonaSegura = zonaSegura;
    vehiculo.actualizadoEn = new Date().toISOString();
    guardarVehiculos(vehiculos);

    return res.json({
      ok: true,
      vehiculoId,
      contratoId: vehiculo.contratoId,
      zonaSegura,
      lejos_de_zona: false,
      distancia_m: 0,
      mensaje: zonaSegura.activo
        ? 'Zona Segura configurada y activada correctamente.'
        : 'Zona Segura configurada pero desactivada.'
    });
  } catch (err) {
    console.error('Error configurando Zona Segura:', err);
    return res.status(500).json({
      error: 'Error configurando Zona Segura',
      detalle: err.message
    });
  }
});

app.get('/api/vehiculos/:vehiculoId/zona-segura', (req, res) => {
  const { vehiculoId } = req.params;
  const vehiculos = cargarVehiculos();
  const vehiculo = vehiculos[vehiculoId];

  if (!vehiculo) {
    return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  if (!vehiculo.zonaSegura) {
    return res.status(404).json({ error: 'Zona Segura no configurada' });
  }

  return res.json({
    vehiculoId,
    contratoId: vehiculo.contratoId,
    zonaSegura: vehiculo.zonaSegura
  });
});

app.post('/api/vehiculos/:vehiculoId/zona-segura/desactivar', (req, res) => {
  const { vehiculoId } = req.params;
  const vehiculos = cargarVehiculos();
  const vehiculo = vehiculos[vehiculoId];

  if (!vehiculo) {
    return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
  }

  if (!vehiculo.zonaSegura) {
    return res.status(404).json({ error: 'Zona Segura no configurada' });
  }

  vehiculo.zonaSegura.activo = false;
  vehiculo.zonaSegura.ultimaAlertaActiva = false;
  vehiculo.actualizadoEn = new Date().toISOString();
  guardarVehiculos(vehiculos);

  return res.json({
    ok: true,
    vehiculoId,
    contratoId: vehiculo.contratoId,
    zonaSegura: vehiculo.zonaSegura,
    mensaje: 'Zona Segura desactivada correctamente'
  });
});

app.post('/api/vehiculos/:vehiculoId/zona-segura/activar', (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({
        error: 'Vehiculo no encontrado en el Orquestador'
      });
    }

    if (!vehiculo.zonaSegura) {
      return res.status(409).json({
        error: 'Zona Segura no configurada',
        detalle: 'Primero configura una Zona Segura con POST /api/vehiculos/:vehiculoId/zona-segura'
      });
    }

    vehiculo.zonaSegura.activo = true;
    vehiculo.zonaSegura.ultimaAlertaActiva = false;
    vehiculo.actualizadoEn = new Date().toISOString();

    guardarVehiculos(vehiculos);

    return res.json({
      ok: true,
      vehiculoId,
      contratoId: vehiculo.contratoId,
      zonaSegura: vehiculo.zonaSegura,
      mensaje: 'Zona Segura activada correctamente'
    });
  } catch (err) {
    console.error('Error activando Zona Segura', err);
    return res.status(500).json({
      error: 'Error interno activando Zona Segura',
      detalle: err.message
    });
  }
});

app.get('/api/vehiculos/:vehiculoId/check-zona-segura', async (req, res) => {
  try {
    const { vehiculoId } = req.params;
    const vehiculos = cargarVehiculos();
    const vehiculo = vehiculos[vehiculoId];

    if (!vehiculo) {
      return res.status(404).json({ error: 'Vehiculo no configurado en el Orquestador' });
    }

    const zona = vehiculo.zonaSegura;
    if (!zona) {
      return res.json({
        vehiculoId,
        contratoId: vehiculo.contratoId,
        tiene_zona_segura: false
      });
    }

    if (!vehiculo.traccarDeviceId) {
      return res.status(409).json({ error: 'Vehiculo sin traccarDeviceId' });
    }

    const pos = await obtenerUltimaPosicionTraccar(vehiculo.traccarDeviceId);
    const dtLocal = DateTime.fromISO(pos.local);
    const aplicaVentana = zona.activo && estaEnVentanaHorario(zona, dtLocal);
    const dist = distanciaMetros(zona.centro.lat, zona.centro.lon, pos.lat, pos.lon);
    const fuera = dist > zona.radio_interno_m;

    return res.json({
      vehiculoId,
      contratoId: vehiculo.contratoId,
      tiene_zona_segura: true,
      zona_activa: zona.activo,
      aplica_ventana: aplicaVentana,
      fuera_de_zona: fuera,
      distancia_m: dist,
      hora_local: pos.local,
      zonaSegura: zona
    });
  } catch (err) {
    console.error('Error en check-zona-segura:', err);
    return res.status(500).json({
      error: 'Error evaluando Zona Segura',
      detalle: err.message
    });
  }
});

// ---------- Motor de Zona Segura ----------

const ORQ_EVENT_URL = process.env.ORQ_EVENT_URL || null;
const ZONA_SEGURA_INTERVALO_SEGUNDOS = parseInt(
  process.env.ZONA_SEGURA_INTERVALO_SEGUNDOS || '60',
  10
);

async function evaluarZonaSeguraParaVehiculo(vehiculoId, vehiculo) {
  const zona = vehiculo.zonaSegura;
  if (!zona || !zona.activo) return;
  if (!vehiculo.traccarDeviceId) return;
  if (!ORQ_EVENT_URL) return;

  try {
    const pos = await obtenerUltimaPosicionTraccar(vehiculo.traccarDeviceId);
    const dtLocal = DateTime.fromISO(pos.local);
    const aplicaVentana = estaEnVentanaHorario(zona, dtLocal);
    const dist = distanciaMetros(zona.centro.lat, zona.centro.lon, pos.lat, pos.lon);
    const fuera = dist > zona.radio_interno_m;

    let huboCambio = false;

    if (aplicaVentana && fuera) {
      if (!zona.ultimaAlertaActiva) {
        const payload = {
          vehiculoId,
          contratoId: vehiculo.contratoId,
          evento: 'FUERA_DE_ZONA_SEGURA',
          distancia_m: dist,
          horaEvento: dtLocal.toISO(),
          zonaSegura: {
            nombre: zona.nombre,
            centro: zona.centro,
            radio_cliente_m: zona.radio_cliente_m,
            radio_interno_m: zona.radio_interno_m,
            diasSemana: zona.diasSemana,
            horaInicio: zona.horaInicio,
            horaFin: zona.horaFin
          }
        };
        try {
          await axios.post(`${ORQ_EVENT_URL}/eventos/zona-segura`, payload);
        } catch (postErr) {
          console.error(
            'Error notificando salida de Zona Segura al Orquestador:',
            postErr.message
          );
        }
        zona.ultimaAlertaActiva = true;
        huboCambio = true;
      }
    } else {
      if (zona.ultimaAlertaActiva) {
        zona.ultimaAlertaActiva = false;
        huboCambio = true;
      }
    }

    if (huboCambio) {
      const vehiculos = cargarVehiculos();
      if (vehiculos[vehiculoId] && vehiculos[vehiculoId].zonaSegura) {
        vehiculos[vehiculoId].zonaSegura.ultimaAlertaActiva = zona.ultimaAlertaActiva;
        guardarVehiculos(vehiculos);
      }
    }
  } catch (err) {
    console.error(`Error evaluando Zona Segura para ${vehiculoId}:`, err.message);
  }
}

async function motorZonaSegura() {
  try {
    const vehiculos = cargarVehiculos();
    const ids = Object.keys(vehiculos);
    for (const vehiculoId of ids) {
      const vehiculo = vehiculos[vehiculoId];
      if (vehiculo && vehiculo.zonaSegura && vehiculo.zonaSegura.activo) {
        await evaluarZonaSeguraParaVehiculo(vehiculoId, vehiculo);
      }
    }
  } catch (err) {
    console.error('Error en motorZonaSegura:', err.message);
  }
}

if (ZONA_SEGURA_INTERVALO_SEGUNDOS > 0) {
  console.log(
    'Motor de Zona Segura activo. Intervalo:',
    ZONA_SEGURA_INTERVALO_SEGUNDOS,
    'segundos.'
  );
  setInterval(() => {
    motorZonaSegura().catch((err) =>
      console.error('Error en ejecución de motorZonaSegura:', err.message)
    );
  }, ZONA_SEGURA_INTERVALO_SEGUNDOS * 1000);
} else {
  console.log('Motor de Zona Segura DESACTIVADO por configuración.');
}

// ---------- Arranque ----------

app.listen(PORT, () => {
  console.log(`AMA Orquestador escuchando en puerto ${PORT}`);
});
