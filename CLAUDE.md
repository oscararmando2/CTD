# CLAUDE.md — Central Trade Distribution (CTD)

Convenciones del sitio para que cualquier sesión mantenga la misma línea sin re-explicar.

## Qué es

Sitio web de **Central Trade Distribution (CTD)** — distribuidora mayorista de alimentos latinos en Kansas City. La home (`index.html`) es una **película cinemática** controlada por scroll: una sola secuencia a pantalla completa que cuenta la historia de la empresa (camión → carga → bodega → logo → carretera) y sobre ella aparecen los mensajes de venta, las marcas y el contacto. **La web termina en el beat 09/09** (formulario de contacto); las demás secciones fueron retiradas.

## Stack

- **HTML estático** + **Tailwind CSS por CDN** (`cdn.tailwindcss.com`) + **JavaScript vanilla** (sin build, sin framework).
- **Swiper** (CDN) para carruseles — casi sin uso tras el recorte.
- **Google Fonts** (permitido): Bricolage Grotesque, Hanken Grotesk, IBM Plex Mono.
- Verificación headless con **puppeteer-core** manejando el Chrome del sistema (ver más abajo).
- **No hay paso de build.** Se edita el HTML/CSS/JS directamente y se despliega tal cual.

## Repo y despliegue

- Repo: **`oscararmando2/CTD`** (local en `/Users/oscar/Desktop/CTD`). Los PRs de CTD van a este repo, no a XELA.
- **Producción**: `centraltradedist.com` publica desde **`main`** vía Vercel. Para que algo salga en vivo, **hay que mergear a `main`** (ojo con cachés del host).
- Preview: cada rama tiene su deploy de Vercel (detrás del login de Vercel del dueño).
- Commits: mensajes en español, imperativo, con `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Estructura de carpetas

```
index.html            # Home: la película cinemática (único contenido)
productos.html        # Catálogo (página aparte)
catalogo/             # Assets del catálogo (necesita <base href="/catalogo/">)
assets/
  hero/
    cine.css          # Estilos de la película (scope .cine, tokens, captions, beats)
    cine.js           # Motor: scroll-scrub, pin, HUD, revelados, formulario 09
    hero-0X-*.mp4      # Clips de la secuencia (01 imagen, 02/04/05/06/07/08 video)
    hero-0X-*.jpg      # Pósters de precarga e imágenes fijas
  brands/
    *-logo.png         # Logos de marca (La Finca, Yeya, La Costeña, Diana)
    carretera-bg*.mp4  # Video de carretera en loop (desktop + móvil ligero)
    carretera-poster.jpg
CurvedLoop.*, LogoLoop.*  # Componentes viejos, ya no usados en la home
```

## Sistema de diseño (la película)

Todo vive bajo el scope **`.cine`** en `assets/hero/cine.css`. Tokens:

```css
--cine-negro:#0F0D0A;  --cine-carton:#BE8A4F;  --cine-rojo:#D8331B;
--cine-verde:#2E8B3D;  --cine-oro:#F2A31E;      --cine-hueso:#F6F2E9;
--cine-ease:cubic-bezier(0.23,1,0.32,1);   /* la curva de TODA la película */
```

**Colores de marca del sitio** (clases Tailwind custom, definidas en el `<style>` de index.html):
`ctd-red #db2c1a` · `ctd-orange #f89429` · `ctd-green #247232`.

**Tipografía:**
- **Bricolage Grotesque** (800/600) → titulares, marcas, valores. Es la voz display de todo.
- **Hanken Grotesk** (400/500/700) → subtítulos y cuerpo.
- **IBM Plex Mono** (500) → etiquetas tipo HUD (mayúsculas, `letter-spacing:.2em`, color `--cine-oro`).
- Nunca Inter/Poppins/Montserrat.

**Ritmo y curva:** una sola curva (`--cine-ease`). Entradas = opacidad + desplazamiento vertical **corto** (~20–24px). Nada de escalas grandes, rotaciones ni efectos extra.

**Contraste:** texto blanco (`--cine-hueso`) sobre video, siempre con viñeta/scrim oscuro detrás (`.cine-scrim` a la izquierda para los lower-thirds; `.cine-marca-scrim` central para las marcas) y `text-shadow`.

## Arquitectura de la película

`<section id="inicio" class="cine">` contiene un **pin** (`.cine-pin`, `position:sticky; top:0; height:100dvh`) dentro de una sección altísima (`.cine.is-ready{height:NNNNvh}`). El scroll dentro de esa altura mueve todo. Reglas de oro:

- **Progreso global `p`** (0→1) = cuánto se ha scrolleado la sección. **`pc = p/CS`** = progreso dentro de la fase de clips (`CS` = fracción del pin que ocupan los clips).
- **Ritmo constante:** ~**130vh por beat**. Al agregar un beat se sube la altura total (`is-ready`) y se recalculan las fracciones; nunca se acelera/ralentiza un beat existente.
- **Clips (01–06):** revelado **monotónico** — cada clip aparece ENCIMA del anterior (que se queda a opacidad 1), así la imagen base no se asoma en las transiciones. Cada clip scrubbea su `currentTime` con el scroll (`IN`/`SC` en `pc`).
- **Carretera:** al terminar los clips, un video de carretera **corre solo en loop** (no ligado al scroll) y se funde encima; sobre él van las marcas y el contacto.
- **Marcas (07/07):** bloques `.cine-marca` centrados, repartidos parejo en `[MS0, MEND]`; cada uno entra/sostiene/sale con hueco. Escala solo con N marcas.
- **Contacto (08/08) y Formulario (09/09):** `.cine-contacto` y `.cine-form-beat` (cajones glass transparentes sobre la carretera). Interactivos solo cuando están visibles (`visibility` + `pointer-events` por scroll).
- **HUD:** contador `NN / TOTAL` abajo a la derecha (`.cine-hud-idx`), avanza por beat.
- **Carga progresiva:** solo el primer clip precarga (`preload=auto`); los demás en **cadena** (`preload=none` + JS) mientras se ve el anterior. Póster siempre presente → nunca pantalla negra.

**Sistema de captions (lower-thirds):** los mensajes de venta son `.cine-cover` (abajo-izquierda), manejados por índice en cine.js con el arreglo `covers` + ventanas `COVW` (en `pc`). Variantes: `.is-statement` (frase larga), `.is-cats` (lista). **Para agregar un caption:** añade un `.cine-cover` en el HTML y su ventana `[in, plena, sale-in, sale-out]` en `COVW`. Solo uno visible a la vez.

## Patrones / cómo se hacen las cosas aquí

- **i18n:** un solo elemento con `data-lang-es="…"` y `data-lang-en="…"`; el texto ES va como contenido por defecto. `switchLanguage(lang)` intercambia el `textContent`. **Todo texto nuevo lleva ambos atributos.**
- **Solo scroll vertical:** `html,body{overflow-x:clip}` (fallback `hidden`). Nunca dejar que la página se mueva de lado; si aparece overflow, se diagnostica el elemento culpable.
- **Pantalla completa:** el header fijo está oculto (`nav.fixed.z-50{display:none}`), `theme-color:#0F0D0A` y `viewport-fit=cover`. El pin usa `100dvh` para llenar exacto el viewport móvil sin huecos.
- **Responsive/móvil:** `object-fit:cover` en todos los videos; versión móvil ligera del video de carretera; reglas específicas `@media (max-width:640/720px)`.
- **Accesibilidad:** `prefers-reduced-motion` siempre soportado → sin pin, contenido apilado y visible, video estático (póster). Focus visible (`:focus-visible` con `--cine-oro`). Si un video no carga, fondo sólido oscuro.
- **Videos:** re-encode con **ffmpeg** (`ffmpeg-static` vía npm, solo dev). Clips scrubbeados: `-c:v libx264 -crf 19 -preset slow -g 6 -keyint_min 6 -sc_threshold 0 -pix_fmt yuv420p -movflags +faststart -an`. Fondo en loop: CRF ~23; variante móvil ~CRF 28 a 540p. Siempre generar **póster** (`.jpg`). Renombrar archivos **sin acentos ni espacios, minúsculas** (Vercel).
- **Logos:** recortar el relleno transparente (`PIL im.getbbox()`) para que llenen su caja; verificar que lean sobre fondo oscuro y claro antes de usarlos.
- **Verificación headless:** el Browser pane de la app throttlea rAF y da frames negros/estáticos. Usar **puppeteer-core** con el Chrome del sistema (`/Applications/Google Chrome.app/...`) para scrollear a puntos, leer opacidades/currentTime/HUD y tomar screenshots. En headless el video a veces no pinta el frame tras un seek: el **timing (HUD) es la fuente de verdad**, no el fondo del screenshot. Añadir un warm-up (scroll al fondo y de regreso) antes de medir.

## Al terminar un cambio de la película

1. Verificar headless: el beat correcto aparece a opacidad plena con su HUD correcto; sin overflow horizontal; reduced-motion apila y muestra.
2. Commit + push a la rama de trabajo; esperar el deploy de Vercel.
3. Dar la URL de preview. Para producción, mergear a `main`.
