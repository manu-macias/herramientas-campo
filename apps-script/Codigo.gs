// ============================================================================
//  Apps Script de la planilla VENTAS — lectura (doGet) + escritura (doPost)
//  Pegar TODO esto en: la planilla → Extensiones → Apps Script, y redeployar
//  (Implementar → Administrar implementaciones → editar → Nueva versión).
//  La URL /exec no cambia si editás la implementación existente.
// ============================================================================

const TOKEN = "campo-soja-2026";
// Hash SHA-256 de la contraseña del sitio (el mismo PASS_HASH del index.html).
// Sirve para validar las escrituras: el cliente manda la contraseña en texto,
// acá se la hashea y se compara. Solo el hash (irreversible) queda en el código.
const PASS_HASH = "019fc34a361b7237613ea6b59669379602c0657b59f2dd59ecdfeb13c444349f";

const MESES_CAMP = ["JUN","JUL","AGO","SEP","OCT","NOV","DIC","ENE","FEB","MAR","ABR","MAY"];

function doGet(e) {
  if (e.parameter.token !== TOKEN) {
    return json({ error: "Unauthorized" });
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("VENTAS");
  const rows = sheet.getDataRange().getValues();
  return json({
    version:     "ventas-6",          // marca para verificar que el deploy tomó el código nuevo
    ventas:      parseVentas(rows),
    precios:     parsePrecios(rows),
    facturado:   parseFacturacion(),  // { total, ultimoMes:{mes,importe}, porMes }
    movimientos: parseMovimientos(),  // log de ventas individuales (para tickets de reparto)
    actualizado: new Date().toISOString()
  });
}

// ---- Escritura: registrar una venta (socio + mes + toneladas, se SUMA) -------
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (sha256hex(String(body.secret || "")) !== PASS_HASH) return json({ error: "Contraseña inválida" });
    if (body.op === "asignar_fecha") return asignarFecha(body);
    if (body.op !== "registrar_venta") return json({ error: "Operación no soportada" });

    const socio = String(body.socio || "").trim();
    const mes   = String(body.mes || "").trim().toUpperCase();
    const tn    = Number(body.tn);
    const mi    = MESES_CAMP.indexOf(mes);
    if (!socio || socio === "TOTAL") return json({ error: "Socio inválido" });
    if (mi < 0)                      return json({ error: "Mes inválido" });
    if (!(tn > 0))                   return json({ error: "Toneladas inválidas" });

    const lock = LockService.getScriptLock();
    lock.waitLock(20000); // evita que dos cargas simultáneas se pisen
    try {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("VENTAS");
      const rows  = sheet.getDataRange().getValues();

      // Fila del socio (mismo rango que parseVentas: índices 2..9)
      let sr = -1;
      for (let i = 2; i <= 9; i++) {
        if (rows[i] && String(rows[i][0]).trim() === socio) { sr = i; break; }
      }
      if (sr < 0) return json({ error: "No encontré al socio en la planilla" });

      const monthCol = 2 + mi; // 0-indexed; col 2 = JUN ... col 13 = MAY
      const nuevo = redondear(parsNum(rows[sr][monthCol]) + tn);
      sheet.getRange(sr + 1, monthCol + 1).setValue(nuevo); // getRange es 1-indexed
      SpreadsheetApp.flush();

      const rows2 = sheet.getDataRange().getValues();

      // Recalcular "resto" del socio (solo si la celda no es una fórmula)
      if (sheet.getRange(sr + 1, 15).getFormula() === "") {
        let sum = 0;
        for (let c = 2; c <= 13; c++) sum += parsNum(rows2[sr][c]);
        sheet.getRange(sr + 1, 15).setValue(redondear(parsNum(rows2[sr][1]) - sum));
      }

      // Recalcular fila TOTAL (solo celdas que no sean fórmulas)
      let tr = -1;
      for (let j = 2; j <= 9; j++) {
        if (rows2[j] && String(rows2[j][0]).trim() === "TOTAL") { tr = j; break; }
      }
      if (tr >= 0) {
        for (let c = 1; c <= 14; c++) {           // col 1 = stock, 2..13 = meses, 14 = resto
          if (sheet.getRange(tr + 1, c + 1).getFormula() !== "") continue;
          let s = 0;
          for (let k = 2; k <= 9; k++) { if (k === tr) continue; s += parsNum(rows2[k][c]); }
          sheet.getRange(tr + 1, c + 1).setValue(redondear(s));
        }
      }
      SpreadsheetApp.flush();

      // Registro de facturación: guardamos el PRECIO de soja del día en que se
      // registra la venta, así la facturación queda exacta aunque el precio
      // cambie después. El cliente manda el precio que está viendo (prices.json).
      const precio  = parsNum(body.precio);
      if (precio > 0) {
        const importe = redondear(tn * precio);
        const fsh = facturacionSheet();
        const now = new Date();
        const fecha = Utilities.formatDate(now, "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
        fsh.appendRow([now.toISOString(), fecha, socio, mes, tn, precio, importe]);
        SpreadsheetApp.flush();
      }

      const fresh = sheet.getDataRange().getValues();
      return json({
        ok: true,
        ventas:      parseVentas(fresh),
        precios:     parsePrecios(fresh),
        facturado:   parseFacturacion(),
        movimientos: parseMovimientos(),
        actualizado: new Date().toISOString()
      });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json({ error: String(err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// SHA-256 hex (lowercase) — debe coincidir con crypto.subtle del navegador.
function sha256hex(str) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ((b & 0xff).toString(16)).padStart(2, "0"); }).join("");
}

function redondear(n) { return Math.round(n * 100) / 100; }

function parseVentas(rows) {
  const SOCIOS = ["MANU","MARTI","TOMÁS","ANDREA","ANÍBAL","COMUNES","CAMPO","TOTAL"];
  const result = [];
  for (let i = 2; i <= 9; i++) {
    const r = rows[i];
    if (!r || !SOCIOS.includes(String(r[0]).trim())) continue;
    result.push({
      nombre: String(r[0]).trim(),
      stock:  parsNum(r[1]),
      ventas: [r[2],r[3],r[4],r[5],r[6],r[7],r[8],r[9],r[10],r[11],r[12],r[13]].map(parsNum),
      resto:  parsNum(r[14])
    });
  }
  return result;
}

function parsePrecios(rows) {
  const result = [];
  const MESES = ["ENE","FEB","MAR","ABR","MAY","JUN","JUL","AGO","SEP","OCT","NOV","DIC"];
  const START_YEAR = 2025;
  const START_MONTH = 2; // MAR = índice 2 en MESES
  let count = 0;
  for (let i = 58; i < rows.length; i++) {
    const r = rows[i];
    const mes = String(r[0] || "").trim().toUpperCase();
    if (!MESES.includes(mes)) continue;
    const dolar = parsNum(r[1]);
    const soja  = parsNum(r[2]);
    if (!dolar || !soja) continue;
    const absMonth = START_MONTH + count;
    const year = START_YEAR + Math.floor(absMonth / 12);
    result.push({ mes: mes + " " + year, dolar, soja });
    count++;
  }
  return result;
}

function parsNum(v) {
  if (v === "" || v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  return Number(String(v).replace(/[$\s]/g,"").replace(/\./g,"").replace(",",".")) || 0;
}

// ============================================================================
//  FACTURACIÓN — log de ventas con el precio capturado en el momento.
//  Hoja "FACTURACION": timestamp | fecha | socio | mes | tn | precio_soja | importe
// ============================================================================

const CAMP_START_YEAR = 2026; // campaña JUN 2026 → MAY 2027

function facturacionSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("FACTURACION");
  if (!sh) {
    sh = ss.insertSheet("FACTURACION");
    sh.appendRow(["timestamp", "fecha", "socio", "mes", "tn", "precio_soja", "importe"]);
  }
  return sh;
}

// Suma la facturación del log: total + por mes + último mes con ventas.
function parseFacturacion() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("FACTURACION");
  if (!sh || sh.getLastRow() < 2) return { total: 0, ultimoMes: null, porMes: {} };
  const rows = sh.getDataRange().getValues();
  let total = 0;
  const porMes = {};
  for (let i = 1; i < rows.length; i++) { // salteamos el encabezado
    const mes     = String(rows[i][3] || "").trim().toUpperCase();
    const importe = parsNum(rows[i][6]);
    if (!importe) continue;
    total += importe;
    porMes[mes] = (porMes[mes] || 0) + importe;
  }
  // "último mes" = el mes más avanzado de la campaña que tenga facturación.
  let ultimoMes = null;
  for (let mi = MESES_CAMP.length - 1; mi >= 0; mi--) {
    const m = MESES_CAMP[mi];
    if (porMes[m]) { ultimoMes = { mes: m, importe: redondear(porMes[m]) }; break; }
  }
  return { total: redondear(total), ultimoMes, porMes };
}

// Log de ventas individuales para los tickets de reparto. La fecha es el día en
// que se registró la venta; el ticket se liquida en el frontend con la
// cotización del día hábil SIGUIENTE (prices.json tiene la serie diaria).
function parseMovimientos() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("FACTURACION");
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++) { // salteamos el encabezado
    const socio = String(rows[i][2] || "").trim();
    const tn    = parsNum(rows[i][4]);
    if (!socio || !(tn > 0)) continue;
    out.push({
      fecha:   fechaISO(rows[i][1]),
      socio:   socio,
      mes:     String(rows[i][3] || "").trim().toUpperCase(),
      tn:      tn,
      precio:  parsNum(rows[i][5]),
      importe: parsNum(rows[i][6])
    });
  }
  return out;
}

// Sheets puede devolver la columna fecha como Date (aunque se guardó como texto).
function fechaISO(v) {
  if (v instanceof Date) return Utilities.formatDate(v, "America/Argentina/Buenos_Aires", "yyyy-MM-dd");
  return String(v || "").trim();
}

// Asigna / corrige la fecha REAL de venta y recalcula precio e importe con la
// cotización T+1 que manda el cliente (pizarra del día hábil siguiente, de
// prices.json). Dos modos según el body:
//   - Backfill: { mes } → toca solo las filas de ese mes que NO tienen fecha.
//   - Editar ticket ya generado: { desde:"yyyy-mm-dd" } → toca las filas cuya
//     fecha actual sea `desde` y las mueve a la nueva `fecha`.
function asignarFecha(body) {
  const fecha  = String(body.fecha || "").trim();
  const precio = parsNum(body.precio);
  const desde  = String(body.desde || "").trim();
  const mes    = String(body.mes || "").trim().toUpperCase();
  const editar = /^\d{4}-\d{2}-\d{2}$/.test(desde);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha))       return json({ error: "Fecha inválida (yyyy-mm-dd)" });
  if (!editar && MESES_CAMP.indexOf(mes) < 0)   return json({ error: "Mes inválido" });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = facturacionSheet();
    const rows = sh.getDataRange().getValues();
    let n = 0;
    for (let i = 1; i < rows.length; i++) { // salteamos el encabezado
      const fechaFila = fechaISO(rows[i][1]);
      if (editar) {
        if (fechaFila !== desde) continue;                       // solo la venta de esa fecha
      } else {
        if (String(rows[i][3] || "").trim().toUpperCase() !== mes) continue;
        if (/^\d{4}-\d{2}-\d{2}$/.test(fechaFila)) continue;     // backfill: solo filas sin fecha
      }
      sh.getRange(i + 1, 2).setValue(fecha);
      if (precio > 0) {
        const tn = parsNum(rows[i][4]);
        sh.getRange(i + 1, 6).setValue(precio);
        sh.getRange(i + 1, 7).setValue(redondear(tn * precio));
      }
      n++;
    }
    SpreadsheetApp.flush();
    return json({ ok: true, corregidas: n, movimientos: parseMovimientos(), facturado: parseFacturacion() });
  } finally {
    lock.releaseLock();
  }
}

// Backfill OPCIONAL para las ventas ya cargadas (que no tienen precio guardado).
// Usa el precio MENSUAL de la tabla de precios — es lo mejor disponible para el
// histórico, ya que no se capturó el precio exacto del día. Corré esto UNA vez
// desde el editor (Ejecutar → backfillFacturacion). Reescribe todo el log.
function backfillFacturacion() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = ss.getSheetByName("VENTAS").getDataRange().getValues();
  const ventas  = parseVentas(rows);
  const precios = parsePrecios(rows);
  const priceByKey = {};
  precios.forEach(p => { priceByKey[p.mes] = p.soja; });
  // Fallback: si un mes todavía no tiene precio mensual (ej. meses futuros),
  // usamos el último precio mensual conocido en vez de valuar a $0.
  const ultimoPrecio = precios.length ? precios[precios.length - 1].soja : 0;

  const fsh = facturacionSheet();
  if (fsh.getLastRow() > 1) fsh.deleteRows(2, fsh.getLastRow() - 1); // limpia, deja header
  const stamp = new Date().toISOString();
  let n = 0;
  ventas.forEach(v => {
    if (v.nombre === "TOTAL") return;
    v.ventas.forEach((tn, mi) => {
      if (!(tn > 0)) return;
      const mes   = MESES_CAMP[mi];
      const year  = CAMP_START_YEAR + (mi >= 7 ? 1 : 0); // ENE..MAY son del año siguiente
      const precio = priceByKey[mes + " " + year] || ultimoPrecio;
      fsh.appendRow([stamp, "backfill", v.nombre, mes, tn, precio, redondear(tn * precio)]);
      n++;
    });
  });
  Logger.log("Backfill listo: " + n + " filas.");
}
