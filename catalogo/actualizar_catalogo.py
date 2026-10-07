#!/usr/bin/env python3
"""
Actualiza catalogo.csv desde el export de productos de InSitu.

    python3 catalogo/actualizar_catalogo.py "/ruta/Products (14).xlsx"

InSitu es la fuente de la verdad para nombre, empaque, foto, codigo de barras y
marca. La CATEGORIA no: la del export viene en ingles y mas cruda, asi que la
del catalogo web se conserva y solo se asigna cuando el producto es nuevo.

Que se deja fuera a proposito:
  - Prefijo "CR-": son el mismo producto dado de alta por segunda vez (40 de 46
    tienen gemelo exacto ya en el catalogo). Meterlos duplicaria el catalogo.
  - Hidden = 1.
  - Los codigos 1 y 2 ("Services" y "Hours"), que no son productos.
"""
import csv, re, sys, unicodedata
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parent
CSV = ROOT / 'catalogo.csv'
COLS = ['Name', 'Category', 'Brand', 'ImageURL', 'Code', 'Barcode', 'Package', 'Stock']
NO_PRODUCTO = {'1', '2'}

CATEGORIA = {
    'Beverages': 'Bebidas', 'Carniceria': 'Carnicería', 'Condiments': 'Condimentos',
    'Cookies': 'Galletas', 'Dairy': 'Lácteos', 'Dry Goods': 'Abarrotes',
    'Flour': 'Harinas', 'Frozen': 'Congelados', 'Grains': 'Granos',
    'PO Vida': 'Frutas y Vegetales Frescos', 'Preserves': 'Conservas',
    'Refrigerados': 'Refrigerados', 'Snacks': 'Snacks y Botanas',
    'Sweets': 'Dulces', 'Household': 'Veladoras',
}
# Para los que vienen sin categoria en el export
POR_NOMBRE = [('COOKIE', 'Galletas'), ('TEA', 'Bebidas'), ('VELA', 'Veladoras')]


def norm(t):
    t = unicodedata.normalize('NFKD', str(t or '').lower())
    t = ''.join(c for c in t if not unicodedata.combining(c))
    t = re.sub(r'^cr-\s*', '', t)
    return re.sub(r'[^a-z0-9]+', ' ', t).strip()


def empaque(u):
    u = (u or '').strip()
    m = re.match(r'^case\s*(\d+)$', u, re.I)
    return f'Caja x{m.group(1)}' if m else u


def limpiar(n):
    """El export trae comillas sueltas y espacios dobles en los nombres nuevos."""
    return re.sub(r'\s+', ' ', str(n or '').replace('"', '')).strip()


def categoria(e):
    c = CATEGORIA.get(str(e['Category_Name']).strip())
    if c:
        return c
    nom = str(e['Name']).upper()
    for clave, cat in POR_NOMBRE:
        if clave in nom:
            return cat
    return 'Abarrotes'


def main(ruta):
    filas = list(csv.DictReader(open(CSV, encoding='utf-8')))
    actual = {r['Code']: r for r in filas}

    ws = openpyxl.load_workbook(ruta, data_only=True).active
    hdr = [str(c.value or '') for c in next(ws.iter_rows(max_row=1))]
    ix = {h: i for i, h in enumerate(hdr) if h}
    exp = {}
    for r in ws.iter_rows(min_row=2, values_only=True):
        c = str(r[ix['Code']] or '').strip()
        if c:
            exp[c] = {h: ('' if r[ix[h]] is None else str(r[ix[h]]).strip()) for h in ix}

    usable = {c: e for c, e in exp.items()
              if str(e['Hidden'] or '0') != '1'
              and c not in NO_PRODUCTO
              and not str(e['Name']).upper().startswith('CR-')}

    nuevos, cambios, bajas = [], [], []
    for c, e in usable.items():
        datos = {
            'Name': limpiar(e['Name']),
            'Brand': str(e['Brand_Name']).strip(),
            'ImageURL': e['PhotoURL'],
            'Code': c,
            'Barcode': e['Barcode2'] or e['Barcode'],
            'Package': empaque(e['Unit of Measurement']),
            'Stock': 'in_stock',
        }
        if c in actual:
            r = actual[c]
            for k, v in datos.items():
                if v and r.get(k, '') != v:
                    cambios.append((c, k, r.get(k, ''), v))
                    r[k] = v
        else:
            datos['Category'] = categoria(e)
            nuevos.append(datos)

    for c in list(actual):
        if c not in exp:
            bajas.append((c, actual[c]['Name']))
            del actual[c]

    salida = [actual[r['Code']] for r in filas if r['Code'] in actual] + nuevos
    salida.sort(key=lambda r: (r['Category'], r['Name'].upper()))
    with open(CSV, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        for r in salida:
            w.writerow({k: r.get(k, '') for k in COLS})

    print(f"\n  Catálogo anterior : {len(filas)}")
    print(f"  Catálogo nuevo    : {len(salida)}")
    print(f"  Altas             : {len(nuevos)}")
    print(f"  Bajas             : {len(bajas)}")
    print(f"  Campos corregidos : {len(cambios)}")
    from collections import Counter
    print('\n  Altas por categoría:')
    for k, n in Counter(r['Category'] for r in nuevos).most_common():
        print(f'      {k:<30} {n}')
    if bajas:
        print('\n  Bajas (ya no están en InSitu):')
        for c, n in bajas:
            print(f'      {c:<6} {n[:56]}')
    if cambios:
        print('\n  Campos corregidos por tipo:', dict(Counter(k for _, k, _, _ in cambios)))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else sys.exit('uso: actualizar_catalogo.py <Products.xlsx>'))
