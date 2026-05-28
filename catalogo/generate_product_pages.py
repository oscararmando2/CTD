#!/usr/bin/env python3
"""
Generador de páginas individuales por producto para SEO.

Lee `catalogo.csv` y genera un archivo HTML por producto en
`catalogo/p/{code}/index.html` con:
- Metadata SEO completa (title, description, OG, Twitter)
- JSON-LD Product structured data (rich snippets en Google)
- UI consistente con el catálogo principal
- Link directo a WhatsApp para cotización
- Link de regreso al catálogo y a la categoría

También genera `sitemap.xml` en la raíz del repo con todos los URLs.

Uso:
    cd CTD/catalogo
    python3 generate_product_pages.py

Idempotente: borra y regenera /p/ completo en cada corrida.
"""

import csv
import shutil
import html
import json
import re
import unicodedata
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent          # CTD/catalogo
REPO_ROOT = ROOT.parent                          # CTD
CSV_PATH = ROOT / 'catalogo.csv'
P_DIR = ROOT / 'p'
SITE_BASE = 'https://centraltradedist.com'       # cambia si tu dominio cambia
WHATSAPP = '19133688814'

CAT_EMOJI = {
    'Frutas y Vegetales Frescos':'🥬','Bebidas':'🥤','Lácteos':'🧀','Carnicería':'🥩',
    'Refrigerados':'❄️','Congelados':'🧊','Abarrotes':'🛒','Granos':'🌾',
    'Harinas':'🌾','Condimentos':'🌶️','Conservas':'🥫','Galletas':'🍪',
    'Dulces':'🍬','Snacks y Botanas':'🥨'
}

def slug(s):
    s = unicodedata.normalize('NFD', str(s))
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn').lower()
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def render_page(p, all_products):
    """Genera el HTML de una página individual de producto."""
    fb = CAT_EMOJI.get(p['Category'], '📦')
    cat_slug = slug(p['Category'])
    page_title = f"{p['Name']} · CTD Catálogo"
    desc = f"{p['Name']}"
    if p['Brand']: desc += f" — Marca {p['Brand']}"
    if p['Package']: desc += f", {p['Package']}"
    desc += f". Categoría: {p['Category']}. Disponible al mayoreo en Central Trade Distribution, Kansas City."

    page_url = f"{SITE_BASE}/catalogo/p/{p['Code']}/"
    image_url = p['ImageURL'] or f"{SITE_BASE}/CTDLOGO.PNG"

    # Mensaje de WhatsApp pre-llenado
    wa_msg = f"Hola CTD, me interesa cotizar este producto:\n\n• {p['Name']}"
    if p['Brand']: wa_msg += f" ({p['Brand']})"
    if p['Code']: wa_msg += f"\n  Código: {p['Code']}"
    from urllib.parse import quote
    wa_url = f"https://wa.me/{WHATSAPP}?text={quote(wa_msg)}"

    # JSON-LD para Google rich snippets
    jsonld = {
        "@context": "https://schema.org/",
        "@type": "Product",
        "name": p['Name'],
        "description": desc,
        "category": p['Category'],
        "sku": p['Code'],
        "url": page_url,
    }
    if p['Brand']: jsonld['brand'] = {"@type": "Brand", "name": p['Brand']}
    if image_url: jsonld['image'] = image_url
    if p['Barcode']: jsonld['gtin'] = p['Barcode']
    if p['Stock'] == 'in_stock':
        jsonld['offers'] = {
            "@type": "Offer",
            "availability": "https://schema.org/InStock",
            "priceCurrency": "USD",
            "seller": {"@type": "Organization", "name": "Central Trade Distribution"}
        }

    # Otros productos de la misma categoría (sidebar "related")
    related = [r for r in all_products if r['Category'] == p['Category'] and r['Code'] != p['Code']][:6]

    related_html = ''.join([f'''
        <a href="../{r['Code']}/" class="related-card">
            <div class="related-img">
                {f'<img src="{html.escape(r["ImageURL"])}" alt="" loading="lazy" onerror="this.outerHTML=\'<span style=&quot;font-size:1.6rem;opacity:0.4;&quot;>{fb}</span>\'">' if r['ImageURL'] else f'<span style="font-size:1.6rem;opacity:0.4;">{fb}</span>'}
            </div>
            <div class="related-name">{html.escape(r['Name'])}</div>
        </a>''' for r in related])

    stock_html = ''
    if p['Stock'] == 'out_of_stock':
        stock_html = '<span class="stock-pill out">Agotado</span>'
    elif p['Stock'] == 'low':
        stock_html = '<span class="stock-pill low">Pocas piezas</span>'
    else:
        stock_html = '<span class="stock-pill in">Disponible</span>'

    img_html = (f'<img src="{html.escape(image_url)}" alt="{html.escape(p["Name"])}" '
                f'onerror="this.outerHTML=\'<div class=&quot;img-fallback&quot;>{fb}</div>\'">') \
        if p['ImageURL'] else f'<div class="img-fallback">{fb}</div>'

    return f'''<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{html.escape(page_title)}</title>
<meta name="description" content="{html.escape(desc)}">
<link rel="canonical" href="{page_url}">
<link rel="icon" href="../../../CTDLOGO.PNG">

<!-- Open Graph -->
<meta property="og:type" content="product">
<meta property="og:title" content="{html.escape(p['Name'])}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:image" content="{html.escape(image_url)}">
<meta property="og:url" content="{page_url}">
<meta property="og:site_name" content="Central Trade Distribution">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{html.escape(p['Name'])}">
<meta name="twitter:description" content="{html.escape(desc)}">
<meta name="twitter:image" content="{html.escape(image_url)}">

<!-- JSON-LD Product structured data -->
<script type="application/ld+json">{json.dumps(jsonld, ensure_ascii=False, indent=2)}</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root {{
    --green: #247232; --green-dark: #1a5526; --green-50: #e8f3ea; --green-100: #d0e7d4;
    --whatsapp: #25d366; --whatsapp-dk: #1da851; --red: #db2c1a;
    --text: #1a2e1f; --muted: #7a8a7e; --bg: #f5faf6; --border: #e3ede5;
    --sombra: 0 2px 8px rgba(36,114,50,0.06), 0 8px 24px rgba(36,114,50,0.04);
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: 'Inter', system-ui, sans-serif;
    color: var(--text); background: var(--bg);
    -webkit-font-smoothing: antialiased; line-height: 1.5;
  }}
  a {{ color: inherit; text-decoration: none; }}
  img {{ display: block; max-width: 100%; }}

  /* Top bar */
  .top-bar {{ background: white; border-bottom: 1px solid var(--border); padding: 14px 20px; }}
  .top-bar-inner {{ max-width: 1100px; margin: 0 auto; display: flex; align-items: center; gap: 14px; }}
  .logo-link {{ display: flex; align-items: center; gap: 10px; font-weight: 800; color: var(--green); font-size: 0.9rem; }}
  .logo-link img {{ height: 32px; }}
  .crumb {{ color: var(--muted); font-size: 0.85rem; font-weight: 500; }}
  .crumb a {{ color: var(--green); }}
  .crumb::before {{ content: '/'; margin: 0 8px; color: var(--border); }}

  /* Layout principal */
  main {{ max-width: 1100px; margin: 0 auto; padding: 30px 20px 60px; }}

  .product-wrap {{
    background: white; border-radius: 20px;
    box-shadow: var(--sombra); overflow: hidden;
    display: grid; grid-template-columns: 1fr 1fr;
  }}
  @media (max-width: 780px) {{ .product-wrap {{ grid-template-columns: 1fr; }} }}

  .product-img-side {{
    background: #fafdfa; padding: 36px;
    display: flex; align-items: center; justify-content: center;
    min-height: 320px;
  }}
  .product-img-side img {{ max-width: 100%; max-height: 420px; object-fit: contain; }}
  .img-fallback {{
    width: 140px; height: 140px; border-radius: 50%;
    background: var(--green-50); color: var(--green); opacity: 0.5;
    display: flex; align-items: center; justify-content: center;
    font-size: 3.5rem;
  }}

  .product-info-side {{ padding: 36px 32px; display: flex; flex-direction: column; }}
  .cat-tag {{
    display: inline-block; font-size: 0.72rem;
    background: var(--green-50); color: var(--green);
    padding: 5px 10px; border-radius: 6px;
    font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    margin-bottom: 12px; align-self: flex-start;
  }}
  .cat-tag a {{ color: inherit; }}
  h1 {{
    font-size: clamp(1.5rem, 3.5vw, 2rem); font-weight: 800;
    line-height: 1.2; margin-bottom: 14px; letter-spacing: -0.01em;
  }}
  .stock-pill {{
    display: inline-block; padding: 5px 12px; border-radius: 999px;
    font-size: 0.75rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    margin-bottom: 16px;
  }}
  .stock-pill.in {{ background: #e6f7ea; color: var(--green); border: 1px solid var(--green-100); }}
  .stock-pill.out {{ background: #fee; color: var(--red); border: 1px solid #fbb; }}
  .stock-pill.low {{ background: #fff3e0; color: #c66100; border: 1px solid #ffd197; }}

  .attrs {{
    display: grid; grid-template-columns: 1fr 1fr;
    gap: 12px 20px; margin: 18px 0 26px;
    padding: 18px 0; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  }}
  .attr-label {{
    font-size: 0.7rem; color: var(--muted); text-transform: uppercase;
    letter-spacing: 0.06em; font-weight: 700; margin-bottom: 3px;
  }}
  .attr-value {{ font-size: 0.95rem; font-weight: 600; }}

  .actions {{ display: flex; gap: 10px; margin-top: auto; flex-wrap: wrap; }}
  .btn {{
    flex: 1; min-width: 0;
    padding: 14px 18px; border-radius: 12px; border: none;
    font-size: 0.95rem; font-weight: 700;
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    transition: all 0.18s; cursor: pointer; white-space: nowrap; font-family: inherit;
  }}
  .btn-wa {{ background: var(--whatsapp); color: white; box-shadow: 0 4px 12px rgba(37,211,102,0.35); }}
  .btn-wa:hover {{ background: var(--whatsapp-dk); transform: translateY(-2px); }}
  .btn-back {{ background: white; color: var(--green); border: 2px solid var(--green-100); }}
  .btn-back:hover {{ background: var(--green-50); border-color: var(--green); }}

  /* Related */
  .related-title {{
    margin: 50px 0 20px;
    font-size: 1.2rem; font-weight: 800; color: var(--text);
  }}
  .related-grid {{
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px;
  }}
  .related-card {{
    background: white; border-radius: 12px; overflow: hidden;
    box-shadow: var(--sombra); border: 1px solid var(--border);
    transition: all 0.15s; display: flex; flex-direction: column;
  }}
  .related-card:hover {{ transform: translateY(-2px); border-color: var(--green-100); }}
  .related-img {{
    aspect-ratio: 1; background: white;
    display: flex; align-items: center; justify-content: center;
    padding: 10px;
  }}
  .related-img img {{ max-width: 100%; max-height: 100%; object-fit: contain; }}
  .related-name {{
    padding: 10px;
    font-size: 0.8rem; font-weight: 700;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; line-height: 1.3;
  }}

  footer {{
    background: var(--green-dark); color: rgba(255,255,255,0.85);
    text-align: center; padding: 30px 20px; margin-top: 50px;
  }}
  footer p {{ font-size: 0.85rem; margin: 4px 0; }}
  footer a {{ color: white; font-weight: 600; }}
</style>
</head>
<body>

<div class="top-bar">
  <div class="top-bar-inner">
    <a href="../../../" class="logo-link">
      <img src="../../../CTDLOGO.PNG" alt="CTD">
      <span>CENTRAL TRADE DISTRIBUTION</span>
    </a>
    <span class="crumb"><a href="../../">Catálogo</a></span>
    <span class="crumb"><a href="../../#cat-{cat_slug}">{html.escape(p['Category'])}</a></span>
  </div>
</div>

<main>
  <div class="product-wrap">
    <div class="product-img-side">{img_html}</div>
    <div class="product-info-side">
      <span class="cat-tag"><a href="../../#cat-{cat_slug}">{html.escape(p['Category'])}</a></span>
      <h1>{html.escape(p['Name'])}</h1>
      {stock_html}
      <div class="attrs">
        {f'<div><div class="attr-label">Marca</div><div class="attr-value">{html.escape(p["Brand"])}</div></div>' if p['Brand'] else ''}
        {f'<div><div class="attr-label">Presentación</div><div class="attr-value">{html.escape(p["Package"])}</div></div>' if p['Package'] else ''}
        {f'<div><div class="attr-label">Código</div><div class="attr-value">{html.escape(p["Code"])}</div></div>' if p['Code'] else ''}
        {f'<div><div class="attr-label">Código de barras</div><div class="attr-value">{html.escape(p["Barcode"])}</div></div>' if p['Barcode'] else ''}
      </div>
      <div class="actions">
        <a href="../../" class="btn btn-back">← Volver al catálogo</a>
        <a href="{wa_url}" target="_blank" rel="noopener" class="btn btn-wa">💬 Cotizar por WhatsApp</a>
      </div>
    </div>
  </div>

  {f'<h2 class="related-title">Otros productos en {html.escape(p["Category"])}</h2><div class="related-grid">{related_html}</div>' if related else ''}
</main>

<footer>
  <p><strong>Central Trade Distribution</strong></p>
  <p>Distribuidora mayorista de alimentos latinos en Kansas City</p>
  <p style="opacity:0.7; font-size: 0.78rem; margin-top: 10px;">
    <a href="../../">Ver catálogo completo</a> · <a href="../../../#contacto">Contacto</a>
  </p>
</footer>

</body>
</html>
'''


def main():
    # Leer productos del CSV
    with open(CSV_PATH, encoding='utf-8') as f:
        products = list(csv.DictReader(f))

    # Limpiar carpeta /p/ anterior
    if P_DIR.exists():
        shutil.rmtree(P_DIR)
    P_DIR.mkdir(parents=True, exist_ok=True)

    # Generar página por producto
    generated = 0
    for p in products:
        code = p['Code'].strip()
        if not code:
            continue
        page_dir = P_DIR / code
        page_dir.mkdir(parents=True, exist_ok=True)
        html_out = render_page(p, products)
        (page_dir / 'index.html').write_text(html_out, encoding='utf-8')
        generated += 1

    # Generar sitemap.xml en raíz del repo (incluye páginas existentes + productos)
    today = datetime.now().strftime('%Y-%m-%d')
    urls = [
        f'{SITE_BASE}/',
        f'{SITE_BASE}/catalogo/',
        f'{SITE_BASE}/productos.html',
        f'{SITE_BASE}/PARTNERS.html',
        f'{SITE_BASE}/PROMOS.html',
    ]
    for p in products:
        if p['Code'].strip():
            urls.append(f"{SITE_BASE}/catalogo/p/{p['Code']}/")

    sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n'
    sitemap += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    for u in urls:
        priority = '1.0' if u.endswith('/catalogo/') else '0.8' if '/catalogo/p/' in u else '0.7'
        sitemap += f'  <url>\n    <loc>{u}</loc>\n    <lastmod>{today}</lastmod>\n    <priority>{priority}</priority>\n  </url>\n'
    sitemap += '</urlset>\n'

    (REPO_ROOT / 'sitemap.xml').write_text(sitemap, encoding='utf-8')

    # robots.txt — apunta al sitemap
    robots = f"User-agent: *\nAllow: /\nSitemap: {SITE_BASE}/sitemap.xml\n"
    (REPO_ROOT / 'robots.txt').write_text(robots, encoding='utf-8')

    print(f"✅ Generadas {generated} páginas de producto en catalogo/p/")
    print(f"✅ Generado sitemap.xml con {len(urls)} URLs")
    print(f"✅ Generado robots.txt")


if __name__ == '__main__':
    main()
