# Links de la agenda de manicurista (Netlify)

Sitio estático mínimo: no hay build ni HTML, solo `_redirects`.

| URL | Destino |
|-----|---------|
| <https://demo-manicurista-agenda.netlify.app/> | app pública de reservas |
| <https://demo-manicurista-agenda.netlify.app/admin> | panel de administración |

El parámetro `authuser=0` evita el bug de multi-cuenta de Google, que reescribe
la URL con `/u/N/` y muestra "No se pudo abrir el archivo en este momento".
El redirect es 302 para que el navegador no cachee el destino de Google.

## Actualizar el destino

Si cambia la URL del deployment de Apps Script, editá `_redirects` con la URL
nueva y volvé a desplegar:

```bash
netlify deploy --dir netlify-site --prod --site 0b06c391-0f58-4301-8dfa-993d623bedc2
```

## Notas

- No es un iframe: el navegador sale de Netlify y termina en Google.
- No hace falta `XFrameOptionsMode.ALLOWALL` ni tocar el `doGet`.
- El QR de la agenda debe apuntar a `https://demo-manicurista-agenda.netlify.app/`.
