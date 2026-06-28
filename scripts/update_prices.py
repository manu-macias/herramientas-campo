#!/usr/bin/env python3
"""
update_prices.py — actualiza prices.json con la serie DIARIA de soja y dólar.

- Dólar Oficial (BCRA): valor de hoy desde dolarapi.com; la primera vez se
  backfillea la historia diaria completa desde ArgentinaDatos (dolares/oficial).
- Soja pizarra Rosario ($/tn): valor de hoy scrapeado de BCR. No hay una fuente
  gratis con historia diaria, así que se siembra con anclas mensuales y la serie
  se densifica un punto por día de acá en adelante.

prices.json conserva los campos snapshot (soja, dolar, fecha) por compatibilidad
y agrega "history": [{fecha, soja, dolar}, ...] que es lo que grafica la web.

Corre sin dependencias (Python 3, solo stdlib). Lo usa el GitHub Action y se
puede correr a mano: python3 scripts/update_prices.py
"""

import urllib.request, re, json, datetime, os

HERE = os.path.dirname(os.path.abspath(__file__))
PRICES = os.path.join(HERE, "..", "prices.json")
DAYS = 400

# API de la Cámara Arbitral de la BCR. Devuelve la pizarra DIARIA de soja, lo que
# permite armar la serie histórica diaria (antes solo teníamos anclas mensuales).
# Límite: máx. 1 semana por consulta → iteramos semana a semana.
# Credenciales públicas, expuestas en el widget de acabase.com.ar.
BCR_LOGIN   = "https://api.bcr.com.ar/gix/v1.0/Login"
BCR_PRECIOS = "https://api.bcr.com.ar/gix/v1.0/PreciosCamara"
BCR_API_KEY = "A6D9A60F-2A13-F111-9448-00155D09E215"
BCR_SECRET  = "6cbaeddacc47754da031c0f1cac97074429285a1ad30c16767b710521fd4d144"
ID_SOJA     = 21

# Anclas históricas de soja (pizarra Rosario $/tn) para que el gráfico no
# arranque vacío. Solo se usan si todavía no están en la historia.
SOJA_SEED = {
    "2025-03-15": 329000, "2025-04-15": 314000, "2025-05-15": 310000,
    "2025-06-15": 322000, "2025-07-15": 335000, "2025-08-15": 389000,
    "2025-09-15": 436000, "2025-10-15": 482000, "2025-11-15": 485000,
    "2025-12-15": 495000, "2026-01-15": 480000, "2026-02-15": 466000,
    "2026-03-15": 484000, "2026-04-15": 431000, "2026-05-15": 455000,
    "2026-06-15": 470000,
}


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 agro"})
    return urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8")


def soja_hoy():
    html = fetch("https://www.cac.bcr.com.ar/es/precios-de-pizarra")
    m = re.search(r'board-soja.*?<div class="price">\s*\$([\d.,]+)', html, re.DOTALL)
    if not m:
        raise ValueError("No se encontró el precio de soja en BCR")
    return int(m.group(1).replace(".", "").split(",")[0])


def dolar_hoy():
    data = json.loads(fetch("https://dolarapi.com/v1/dolares/oficial"))
    return int(data["venta"])


def dolar_backfill():
    """Historia diaria del dólar oficial desde ArgentinaDatos → {fecha: valor}."""
    arr = json.loads(fetch("https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial"))
    cutoff = (datetime.date.today() - datetime.timedelta(days=DAYS)).isoformat()
    out = {}
    for d in arr:
        if d.get("fecha", "") >= cutoff and d.get("venta"):
            out[d["fecha"]] = round(d["venta"])
    return out


def bcr_login():
    """Token Bearer de la API de la Cámara Arbitral (BCR)."""
    req = urllib.request.Request(BCR_LOGIN, method="POST", data=b"", headers={
        "accept": "application/json", "api_key": BCR_API_KEY, "secret": BCR_SECRET,
    })
    d = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8"))
    return d["data"]["token"]  # "Bearer eyJ..."


def bcr_soja_semana(token, desde, hasta):
    """Pizarra de soja para un rango de ≤ 7 días → {fecha: precio_int}."""
    url = (f"{BCR_PRECIOS}?idGrano={ID_SOJA}"
           f"&fechaConcertacionDesde={desde}&fechaConcertacionHasta={hasta}&page=1")
    req = urllib.request.Request(url, headers={"accept": "*/*", "Authorization": token})
    d = json.loads(urllib.request.urlopen(req, timeout=30).read().decode("utf-8"))
    out = {}
    for it in (d.get("data") or []):
        fecha  = (it.get("fecha_Cotizacion_Dolar") or "")[:10]
        precio = it.get("precio_Cotizacion")
        if fecha and precio:
            out[fecha] = int(round(precio))
    return out


def soja_backfill_bcr(dias):
    """Serie DIARIA de soja pizarra (BCR), iterando de a 1 semana (límite de la API)."""
    token = bcr_login()
    out = {}
    hoy = datetime.date.today()
    cur = hoy - datetime.timedelta(days=dias)
    while cur <= hoy:
        fin = min(cur + datetime.timedelta(days=6), hoy)
        try:
            out.update(bcr_soja_semana(token, cur.isoformat(), fin.isoformat()))
        except Exception as e:
            print(f"  ✗ soja semana {cur}: {e}")
        cur = fin + datetime.timedelta(days=1)
    return out


def load():
    try:
        with open(PRICES) as f:
            return json.load(f)
    except Exception:
        return {}


def main():
    prev = load()
    # history previa → dict por fecha {fecha: {"soja":..,"dolar":..}}
    hist = {}
    for p in prev.get("history", []):
        hist[p["fecha"]] = {"soja": p.get("soja"), "dolar": p.get("dolar")}

    def put(fecha, soja=None, dolar=None):
        e = hist.setdefault(fecha, {"soja": None, "dolar": None})
        if soja is not None:  e["soja"] = soja
        if dolar is not None: e["dolar"] = dolar

    # Backfill de dólar (solo si la historia está vacía o casi).
    if len([p for p in hist.values() if p.get("dolar")]) < 30:
        try:
            for fecha, val in dolar_backfill().items():
                put(fecha, dolar=val)
            print(f"✓ backfill dólar: {len(hist)} días")
        except Exception as e:
            print(f"✗ backfill dólar: {e}")

    # Serie DIARIA de soja desde la API de la Cámara Arbitral (BCR). Si todavía
    # hay pocos puntos hacemos backfill completo; si ya está densa, solo
    # refrescamos las últimas 2 semanas (mucho más barato).
    soja_serie = {}
    soja_points = len([p for p in hist.values() if p.get("soja")])
    try:
        dias = DAYS if soja_points < 60 else 14
        soja_serie = soja_backfill_bcr(dias)
        for fecha, val in soja_serie.items():
            put(fecha, soja=val)
        print(f"✓ soja BCR API: {len(soja_serie)} días (backfill {dias}d)")
    except Exception as e:
        print(f"✗ soja BCR API: {e}")
        # Fallback: anclas mensuales + scrape del HTML para hoy.
        for fecha, val in SOJA_SEED.items():
            put(fecha, soja=val)
        try:
            put(datetime.date.today().isoformat(), soja=soja_hoy())
        except Exception as e2:
            print(f"✗ soja hoy (scrape): {e2}")

    # Dólar oficial de hoy.
    today = datetime.date.today().isoformat()
    try:
        put(today, dolar=dolar_hoy())
    except Exception as e:
        print(f"✗ dólar hoy: {e}")

    # Recorta ventana y ordena.
    cutoff = (datetime.date.today() - datetime.timedelta(days=DAYS)).isoformat()
    history = [
        {"fecha": f, "soja": hist[f]["soja"], "dolar": hist[f]["dolar"]}
        for f in sorted(hist) if f >= cutoff
    ]

    # Snapshot "actual" = último valor conocido de cada serie.
    soja  = next((h["soja"]  for h in reversed(history) if h["soja"]),  prev.get("soja"))
    dolar = next((h["dolar"] for h in reversed(history) if h["dolar"]), prev.get("dolar"))

    out = {
        "soja": soja,
        "dolar": dolar,
        "fecha": today,
        "fuentes": {
            "soja": "https://api.bcr.com.ar/gix/v1.0/PreciosCamara (Cámara Arbitral BCR, serie diaria) · fallback: scrape pizarra",
            "dolar": "https://dolarapi.com/v1/dolares/oficial (Dólar Oficial BCRA) · historia: ArgentinaDatos",
        },
        "history": history,
    }
    with open(PRICES, "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    sd = sum(1 for p in history if p["dolar"])
    ss = sum(1 for p in history if p["soja"])
    print(f"→ prices.json: {len(history)} días (dólar {sd}, soja {ss}) · hoy soja ${soja:,} dólar ${dolar:,}")


if __name__ == "__main__":
    main()
