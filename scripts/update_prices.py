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

    # Semilla de soja (anclas mensuales).
    for fecha, val in SOJA_SEED.items():
        put(fecha, soja=val)

    today = datetime.date.today().isoformat()
    soja = prev.get("soja")
    dolar = prev.get("dolar")
    try:
        soja = soja_hoy()
    except Exception as e:
        print(f"✗ soja hoy: {e}")
    try:
        dolar = dolar_hoy()
    except Exception as e:
        print(f"✗ dólar hoy: {e}")
    put(today, soja=soja, dolar=dolar)

    # Recorta ventana y ordena.
    cutoff = (datetime.date.today() - datetime.timedelta(days=DAYS)).isoformat()
    history = [
        {"fecha": f, "soja": hist[f]["soja"], "dolar": hist[f]["dolar"]}
        for f in sorted(hist) if f >= cutoff
    ]

    out = {
        "soja": soja,
        "dolar": dolar,
        "fecha": today,
        "fuentes": {
            "soja": "https://www.cac.bcr.com.ar/es/precios-de-pizarra",
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
