# TreinoNanoGpt

PWA móvil, local y sin dependencias para capturar una sesión de entrenamiento: cronómetro, cuenta atrás, intervalos, contador de series y notas con timestamps automáticos.

## Estructura

- `index.html`: interfaz accesible de una sola vista y diálogo de copia manual.
- `styles.css`: diseño mobile-first, tema oscuro, zonas táctiles grandes y adaptación a pantallas más amplias.
- `app.js`: timers basados en timestamps absolutos, notas, series, persistencia, Wake Lock, sonido y exportación.
- `manifest.json`: metadatos de instalación PWA.
- `service-worker.js`: caché offline del shell estático.
- `assets/images/original/logotreinonanogpt-original.png`: copia intacta del logo fuente aportado por el usuario.
- `assets/images/brand/logo-header.png`: versión optimizada para el encabezado.
- `assets/images/brand/splash-1080x1920.png`: composición vertical para pantalla de inicio.
- `assets/images/icons/`: favicon e iconos PWA normales y maskable, derivados sin deformar el símbolo.

## Probar localmente

La app debe servirse por HTTP; abrir `index.html` directamente no permite probar correctamente el service worker.

Con Python 3, desde esta carpeta:

```bash
python -m http.server 8080
```

Abrir `http://localhost:8080`. Para probar desde un teléfono en la misma red se puede usar la IP local de la computadora, pero Wake Lock, portapapeles y service workers suelen requerir HTTPS fuera de `localhost`. GitHub Pages proporciona HTTPS.

## Publicar en GitHub Pages

1. Crear un repositorio en GitHub y subir todos los archivos de esta carpeta a la raíz de la rama principal.
2. En GitHub, abrir **Settings → Pages**.
3. En **Build and deployment**, elegir **Deploy from a branch**.
4. Seleccionar la rama principal y la carpeta `/ (root)`, y guardar.
5. Abrir la URL HTTPS que muestra GitHub Pages.

Las rutas son relativas, por lo que funciona tanto en un dominio propio como en una ruta de proyecto del tipo `usuario.github.io/repositorio/`, sin cambios adicionales.

## Instalar en Android / Chrome

1. Abrir la URL publicada con Chrome en Android.
2. Abrir el menú de Chrome.
3. Elegir **Instalar aplicación** o **Agregar a pantalla principal**.
4. Confirmar. TreinoNanoGpt se abrirá después en modo independiente, sin barra del navegador.

La opción de instalación puede tardar unos segundos en aparecer durante la primera visita mientras Chrome registra el service worker.

## Comportamiento técnico

- **Timers robustos:** `setInterval` solo refresca la pantalla. El tiempo real se calcula desde timestamps absolutos (`Date.now()`), incluidos deadlines de countdown e intervalos. Si Android suspende la pestaña, al regresar se reconstruye el tiempo correcto y se saltan las fases ya transcurridas.
- **Autoguardado:** estado de sesión, borrador, notas, series, configuraciones y timers se guardan en `localStorage`. Un timer en marcha conserva sus timestamps y se recupera al reabrir.
- **Wake Lock:** se solicita únicamente al iniciar o reanudar un timer, se libera al pausar/finalizar y se vuelve a solicitar al regresar al foreground. Algunos modos de ahorro de batería o versiones de Chrome pueden rechazarlo; el timer sigue funcionando correctamente.
- **Sonido:** el `AudioContext` se crea o reactiva tras tocar Iniciar/Reanudar, como exige Chrome Android. Cada WORK comienza con tres pitidos agudos de 950 Hz y cada REST con dos pitidos graves de 650 Hz; duran 250 ms y se separan 150 ms. El final conserva su secuencia propia.
- **Portapapeles:** primero usa Clipboard API. Si el navegador la rechaza, se abre un diálogo con todo el resumen seleccionado para copiar manualmente.
- **Nueva sesión:** exige mantener pulsado el botón durante dos segundos, también con Enter o Espacio desde teclado. Al completarse elimina la sesión local actual; no afecta ningún otro dato del teléfono o navegador.

## Limitaciones conocidas

- No hay notificaciones en segundo plano. Si Chrome está completamente cerrado, el final de un timer se detecta al volver a abrir la app; el tiempo mostrado será correcto, pero no puede sonar mientras estaba cerrada.
- Los sistemas Android pueden liberar Wake Lock por ahorro de batería. La app lo vuelve a pedir al recuperar visibilidad.
- Borrar los datos del sitio desde Android/Chrome elimina la sesión guardada.
- El dictado depende del teclado Samsung (o del teclado elegido) y escribe en el campo como texto normal; la app no solicita acceso al micrófono.

## Actualizar sin romper el caché

Cada vez que se publique una versión con cambios en archivos estáticos:

1. Cambiar `CACHE_NAME` en `service-worker.js`, por ejemplo de `treino-nano-gpt-v1` a `treino-nano-gpt-v2`.
2. Agregar a `APP_SHELL` cualquier archivo estático nuevo y quitar los eliminados.
3. Publicar todos los archivos juntos.

El service worker nuevo precarga la versión completa, toma control y elimina cachés anteriores. La navegación intenta primero la red y usa el HTML guardado solo cuando no hay conexión; los demás recursos se sirven rápido desde caché y se actualizan en segundo plano.
