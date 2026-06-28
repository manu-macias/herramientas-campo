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
const PASS_HASH = "7dca3a2295651cd47867174d10fd26f1c0f6b0bc09393552309c4c9a5fdbee94";

const MESES_CAMP = ["JUN","JUL","AGO","SEP","OCT","NOV","DIC","ENE","FEB","MAR","ABR","MAY"];

function doGet(e) {
  if (e.parameter.token !== TOKEN) {
    return json({ error: "Unauthorized" });
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("VENTAS");
  const rows = sheet.getDataRange().getValues();
  return json({
    version:     "ventas-2",          // marca para verificar que el deploy tomó el código nuevo
    ventas:      parseVentas(rows),
    precios:     parsePrecios(rows),
    actualizado: new Date().toISOString()
  });
}

// ---- Escritura: registrar una venta (socio + mes + toneladas, se SUMA) -------
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.op !== "registrar_venta") return json({ error: "Operación no soportada" });
    if (sha256hex(String(body.secret || "")) !== PASS_HASH) return json({ error: "Contraseña inválida" });

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

      const fresh = sheet.getDataRange().getValues();
      return json({
        ok: true,
        ventas:      parseVentas(fresh),
        precios:     parsePrecios(fresh),
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
