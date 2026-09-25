#!/usr/bin/env python3
"""
Cruza la lista semanal de produce con el catalogo de InSitu y deja el archivo
que /IA lee para conocer el costo real de esta semana.

    python3 IA/tools/produce_a_insitu.py produce-w40/semana-40.json \
            produce-w40/40-2026-D.xlsx "Products (12).xlsx"

Por que existe: el produce cambia de precio cada semana, pero InSitu guarda el
costo con el que se dio de alta el producto, y la IA proponia especiales sobre
costos viejos.

Como se cruza, en este orden:
  1. UPC de A&N contra el codigo de barras de InSitu. Es la llave buena: 20
     productos de InSitu traen el UPC de A&N, a veces pegado al PLU en el mismo
     campo ("4644/8-64590-00018").
  2. Nombre normalizado + cantidad del empaque.
El PLU solo NO sirve: el 4644 es Malanga Blanca (35 LB) y Malanga Coco (40 LB)
a la vez, y el 4612 es el jengibre normal y el organico.

Se exige que el empaque coincida. Los que no coinciden suelen ser de otro
proveedor (Kalil Enterprise vende la caja doble: 40 LB donde A&N da 20 LB), asi
que no son el mismo articulo y no se deben pisar.
"""
import json, re, sys, unicodedata
from pathlib import Path
import openpyxl


def norm(t):
    t = unicodedata.normalize("NFKD", str(t or "").lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r"\b\d+\s*(lb|ct|oz|c)\b", " ", t)      # quita el empaque del nombre
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def cant(t):
    m = re.search(r"(\d+(?:\.\d+)?)", str(t or ""))
    return float(m.group(1)) if m else None


def solo_digitos(t):
    return re.sub(r"\D", "", str(t or ""))


def leer_an(ruta):
    """UPC de A&N por (plu, nombre normalizado)."""
    ws = openpyxl.load_workbook(ruta, data_only=True).active
    rows = [[("" if c is None else str(c).strip()) for c in r] for r in ws.iter_rows(values_only=True)]
    hi = next(i for i, r in enumerate(rows) if "PLU" in r and any("DESCRIPTION" in x for x in r))
    H = rows[hi]; ix = {h: i for i, h in enumerate(H) if h}
    out = {}
    for r in rows[hi + 1:]:
        d = r[ix["DESCRIPTION"]]
        if not d:
            continue
        upc = solo_digitos(r[ix.get("UPC BARCODE", -1)]) if "UPC BARCODE" in ix else ""
        if upc:
            out[norm(d)] = upc
    return out


def main(ruta_semana, ruta_an, ruta_insitu, salida="IA/produce-precios.json"):
    datos = json.loads(Path(ruta_semana).read_text(encoding="utf-8"))
    prods = datos["productos"]
    upcAN = leer_an(ruta_an)

    ws = openpyxl.load_workbook(ruta_insitu, data_only=True).active
    hdr = [str(c.value or "") for c in next(ws.iter_rows(max_row=1))]
    ix = {h: i for i, h in enumerate(hdr)}
    porUpc, porNombre = {}, {}
    for r in ws.iter_rows(min_row=2, values_only=True):
        if str(r[ix["Hidden"]] or "0") == "1":
            continue
        code = str(r[ix["Code"]] or "").strip()
        nom = str(r[ix["Name"]] or "")
        pack = cant(r[ix["Unit of Measurement"]]) or cant(nom)
        reg = {"code": code, "nombre": nom, "pack": pack}
        # el campo puede traer "4644/8-64590-00018": se parten y se indexan todos
        for campo in ("Barcode", "Barcode2"):
            for trozo in re.split(r"[/,;]", str(r[ix[campo]] or "")):
                d = solo_digitos(trozo)
                if len(d) >= 11:
                    porUpc.setdefault(d, []).append(reg)
        porNombre.setdefault(norm(nom), []).append(reg)

    items, sin = {}, []
    for p in prods:
        a = cant(p["pack_wt"])
        # Se juntan los candidatos de las dos vias y se queda el primero cuyo
        # empaque cuadre. Un UPC puede apuntar a mas de un articulo, asi que
        # tomar el primero a ciegas cruzaba productos que no eran.
        cands = []
        upc = upcAN.get(norm(p["descripcion"]))
        if upc:
            cands += [(r, "upc") for r in porUpc.get(upc, [])]
        cands += [(r, "nombre+empaque") for r in porNombre.get(norm(p["descripcion"]), [])]

        cand = via = None
        for r, v in cands:
            b = r["pack"]
            if a and b and abs(a - b) < 0.01:
                cand, via = r, v
                break
        if cand is None:
            detalle = ""
            if cands:
                packs = sorted({str(r["pack"]) for r, _ in cands if r["pack"]})
                detalle = f" (produce {p['pack_wt']} · InSitu {'/'.join(packs)} · {cands[0][0]['nombre']})"
            sin.append(p["descripcion"] + detalle)
            continue
        items[cand["code"]] = {
            "plu": p["plu"], "nombre": p["descripcion"], "pack": p["pack_wt"],
            "costo": p["costo"], "precio": p["precio"], "via": via,
        }

    Path(salida).write_text(json.dumps(
        {"semana": datos["semana"], "rango": datos["rango"], "items": items},
        ensure_ascii=False, indent=2), encoding="utf-8")

    porVia = {}
    for v in items.values():
        porVia[v["via"]] = porVia.get(v["via"], 0) + 1
    print(f"\nSEMANA {datos['semana']} · {datos['rango']}")
    print(f"  Productos en la lista : {len(prods)}")
    print(f"  Cruzados con InSitu   : {len(items)}  {porVia}")
    print(f"  Sin cruce             : {len(sin)}")
    for d in sin:
        print(f"      - {d}")
    print(f"\n  -> {salida}")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit("uso: produce_a_insitu.py <semana-NN.json> <NN-2026-D.xlsx> <Products.xlsx> [salida]")
    main(*sys.argv[1:])
