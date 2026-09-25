#!/usr/bin/env python3
"""
Cruza la lista semanal de produce con el catalogo de InSitu y deja el archivo
que /IA lee para conocer el costo real de esta semana.

    python3 IA/tools/produce_a_insitu.py produce-w40/semana-40.json "Products (12).xlsx"

Por que existe: el produce cambia de precio cada semana, pero InSitu guarda el
costo con el que se dio de alta el producto. En la W40 habia 9 articulos cuyo
costo real ya superaba el precio de venta de InSitu, y la IA los proponia como
especiales porque veia un costo viejo mas barato.

Solo se exportan los cruces SEGUROS. Se descarta:
  - PLU que en la lista de produce corresponde a dos productos distintos
    (4644 es Malanga Blanca y Malanga Coco a la vez).
  - Empaques que no coinciden (produce cotiza media caja: 20 LB contra Case40).
Los descartados se imprimen para revisarlos a mano.
"""
import json, re, sys
from pathlib import Path
import openpyxl


def cantidad(txt):
    m = re.search(r"(\d+(?:\.\d+)?)", str(txt or ""))
    return float(m.group(1)) if m else None


def main(ruta_semana, ruta_excel, salida="IA/produce-precios.json"):
    datos = json.loads(Path(ruta_semana).read_text(encoding="utf-8"))
    prods = datos["productos"]

    ws = openpyxl.load_workbook(ruta_excel, data_only=True).active
    hdr = [str(c.value or "") for c in next(ws.iter_rows(max_row=1))]
    ix = {h: i for i, h in enumerate(hdr)}
    porPlu = {}
    for r in ws.iter_rows(min_row=2, values_only=True):
        plu = str(r[ix["Barcode2"]] or "").strip()
        if plu:
            porPlu.setdefault(plu, []).append(r)

    vecesPlu = {}
    for p in prods:
        if p["plu"]:
            vecesPlu[p["plu"]] = vecesPlu.get(p["plu"], 0) + 1

    items, ambiguos, desiguales, sinCruce = {}, [], [], []
    for p in prods:
        plu = p["plu"]
        if not plu or plu not in porPlu:
            if plu:
                sinCruce.append(p["descripcion"])
            continue
        if vecesPlu[plu] > 1:
            ambiguos.append((plu, p["descripcion"]))
            continue
        r = porPlu[plu][0]
        a = cantidad(p["pack_wt"])
        b = cantidad(r[ix["Unit of Measurement"]]) or cantidad(r[ix["Name"]])
        if not (a and b and abs(a - b) < 0.01):
            desiguales.append((p["descripcion"], p["pack_wt"],
                               str(r[ix["Unit of Measurement"]]), str(r[ix["Name"]])))
            continue
        items[str(r[ix["Code"]])] = {
            "plu": plu,
            "nombre": p["descripcion"],
            "pack": p["pack_wt"],
            "costo": p["costo"],
            "precio": p["precio"],
        }

    out = {
        "semana": datos["semana"],
        "rango": datos["rango"],
        "items": items,
    }
    Path(salida).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\nSEMANA {datos['semana']} · {datos['rango']}")
    print(f"  Cruces seguros exportados : {len(items)}")
    print(f"  PLU ambiguo (2 productos) : {len(ambiguos)}")
    for plu, d in ambiguos:
        print(f"      - {plu} · {d}")
    print(f"  Empaque distinto          : {len(desiguales)}")
    for d, pa, pb, nom in desiguales:
        print(f"      - {d}: produce {pa} vs InSitu {pb} ({nom})")
    print(f"  Con PLU pero sin cruce    : {len(sinCruce)}")
    print(f"\n  -> {salida}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("uso: produce_a_insitu.py <semana-NN.json> <Products.xlsx> [salida]")
    main(*sys.argv[1:])
